import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { enabledModuleFixture } from './fixtures/module-config-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { env: notificationEnv, moduleConfig: notificationModules } = enabledModuleFixture('notifications');

async function loadTs(relativePath, mocks = {}) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (Object.hasOwn(mocks, specifier)) return mocks[specifier];
    if (specifier === 'zod/v3') return require('zod/v3');
    throw new Error(`Unexpected import in ${relativePath}: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const transport = await loadTs('lib/contact-email-transport.ts', {
  'cloudflare:workers': { env: notificationEnv },
  './module-config': notificationModules,
});
const envelope = {
  accountId: 'a'.repeat(32),
  token: 'local-synthetic-email-token-only',
  from: 'notifications@example.invalid',
  to: 'to@example.invalid',
  bcc: 'bcc@example.invalid',
  replyTo: 'reply@example.invalid',
  subject: 'A new contact message',
  text: 'A private synthetic message body.',
  html: '<p>A private synthetic message body.</p>',
};

function cloudflareResponse(result, { success = true, status = 200 } = {}) {
  return Response.json({ success, result }, { status });
}

test('transport sends one fixed Cloudflare POST and keeps BCC only in the server request', async () => {
  let calls = 0;
  let request;
  const result = await transport.sendContactEmail(envelope, async (url, init) => {
    calls++;
    request = { url: String(url), init };
    return cloudflareResponse({
      message_id: 'FixtureMessage123',
      delivered: [envelope.to],
      queued: [],
      permanent_bounces: [],
      suppressed_recipients: [],
    });
  });
  assert.equal(calls, 1);
  assert.equal(request.url, `https://api.cloudflare.com/client/v4/accounts/${envelope.accountId}/email/sending/send`);
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.redirect, 'manual');
  assert.equal(request.init.cache, 'no-store');
  assert.equal(request.init.headers.Authorization, `Bearer ${envelope.token}`);
  assert.equal(request.init.headers['Content-Type'], 'application/json');
  const body = JSON.parse(request.init.body);
  assert.deepEqual(body, {
    to: envelope.to,
    from: envelope.from,
    bcc: envelope.bcc,
    reply_to: envelope.replyTo,
    subject: envelope.subject,
    text: envelope.text,
    html: envelope.html,
  });
  assert.deepEqual(result, { state: 'delivered', providerMessageId: 'FixtureMessage123' });
  assert.ok(!JSON.stringify(result).includes(envelope.bcc));
  assert.ok(!JSON.stringify(result).includes(envelope.token));
  assert.ok(!JSON.stringify(result).includes(envelope.text));
});

test('queue, bounce, and contradictory recipient evidence are classified without returning provider arrays', async () => {
  const queued = await transport.sendContactEmail(envelope, async () => cloudflareResponse({
    message_id: 'FixtureQueued123', delivered: [], queued: [envelope.to], permanent_bounces: [], suppressed_recipients: [],
  }));
  assert.deepEqual(queued, { state: 'queued', providerMessageId: 'FixtureQueued123' });
  const bounce = await transport.sendContactEmail(envelope, async () => cloudflareResponse({
    message_id: 'FixtureBounce123', delivered: [], queued: [], permanent_bounces: [envelope.to], suppressed_recipients: [],
  }));
  assert.deepEqual(bounce, { state: 'failed', providerMessageId: 'FixtureBounce123' });
  const contradictory = await transport.sendContactEmail(envelope, async () => cloudflareResponse({
    message_id: 'FixtureConflicting123', delivered: [envelope.to], queued: [envelope.to],
    permanent_bounces: [], suppressed_recipients: [],
  }));
  assert.deepEqual(contradictory, { state: 'unknown', providerMessageId: 'FixtureConflicting123' });
});

test('documented optional suppressed_recipients is optional and classifies only a primary-recipient suppression as failed', async () => {
  let calls = 0;
  const deliveredWithoutSuppressionField = await transport.sendContactEmail(envelope, async () => {
    calls++;
    return cloudflareResponse({
      message_id: 'FixtureNoSuppression123',
      delivered: [envelope.to], queued: [], permanent_bounces: [],
    });
  });
  assert.deepEqual(deliveredWithoutSuppressionField, { state: 'delivered', providerMessageId: 'FixtureNoSuppression123' });

  const suppressedPrimary = await transport.sendContactEmail(envelope, async () => {
    calls++;
    return cloudflareResponse({
      message_id: 'FixtureSuppressed123',
      delivered: [], queued: [], permanent_bounces: [], suppressed_recipients: [envelope.to],
    });
  });
  assert.deepEqual(suppressedPrimary, { state: 'failed', providerMessageId: 'FixtureSuppressed123' });
  assert.equal(calls, 2, 'each invocation makes one request and the optional response field creates no retry');
  assert.ok(!JSON.stringify(suppressedPrimary).includes(envelope.to));
});

test('HTTP rejection is terminal failed; network and malformed success are unknown with no retry', async () => {
  let calls = 0;
  const rejected = await transport.sendContactEmail(envelope, async () => {
    calls++;
    return new Response('synthetic reject', { status: 503 });
  });
  assert.deepEqual(rejected, { state: 'failed', providerMessageId: null });
  const network = await transport.sendContactEmail(envelope, async () => {
    calls++;
    throw new TypeError('synthetic network failure');
  });
  assert.deepEqual(network, { state: 'unknown', providerMessageId: null });
  assert.equal(calls, 2, 'transport makes at most one attempt per invocation');
  const malformed = await transport.sendContactEmail(envelope, async () => cloudflareResponse({ message_id: envelope.bcc }));
  assert.equal(malformed.state, 'unknown');
  assert.equal(malformed.providerMessageId, null, 'unrecognized/unsafe provider identifiers are not exposed');
});

test('oversized provider response is bounded and canceled without retaining body data', async () => {
  let canceled = false;
  const bytes = new Uint8Array(17000).fill(65);
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(bytes); },
    cancel() { canceled = true; },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const result = await transport.sendContactEmail(envelope, async () => response);
  assert.deepEqual(result, { state: 'unknown', providerMessageId: null });
  assert.equal(canceled, true);
});
