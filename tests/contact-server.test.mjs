import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const messageId = 'd5000000-0000-4000-8000-000000000001';
const requestKey = 'd6000000-0000-4000-8000-000000000001';
const scheduledWork = [];

async function loadTs(relativePath, mocks = {}) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (specifier === 'zod/v3') return require('zod/v3');
    if (Object.hasOwn(mocks, specifier)) return mocks[specifier];
    throw new Error(`Unexpected import in ${relativePath}: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const core = await loadTs('lib/contact-core.ts');
const capturedMeasurements = [];
const storeCalls = [];
const store = {
  async submit(input, eligibility) {
    storeCalls.push({ input, eligibility });
    return { received: true, id: messageId, created: true };
  },
};
const server = await loadTs('lib/contact-server.ts', {
  'cloudflare:workers': { env: {}, waitUntil(promise) { scheduledWork.push(Promise.resolve(promise)); } },
  './runtime-secrets': { SITE_PROJECT_ID: 'fixture-workspace' },
  './admin-auth-server': {
    async readSmallBody(request, maxBytes) {
      const raw = await request.text();
      return Buffer.byteLength(raw) <= maxBytes ? raw : null;
    },
    safeJson(raw) { try { return JSON.parse(raw); } catch { return null; } },
  },
  './contact-core': core,
  './element-measurement-core': { ELEMENT_DOCUMENT_HEADER: 'X-Measurement-Document' },
  './element-measurement-server': {
    async captureElementOutcome(request, kind, sourceId) {
      capturedMeasurements.push({ documentId: request.headers.get('X-Measurement-Document'), kind, sourceId });
    },
  },
  './contact-store': { ContactStore: class ContactStore {} },
  './contact-notification-server': {
    contactNotificationService: () => ({
      async eligibility() { return { eligible: false, configRevision: 0, configFingerprint: null, credentialGeneration: null }; },
      async dispatch() { throw new Error('disabled notifications must not dispatch'); },
    }),
  },
});

function postRequest(value, { origin = 'https://site.invalid', contentType = 'application/json', documentId } = {}) {
  const headers = { origin, 'content-type': contentType };
  if (documentId) headers['X-Measurement-Document'] = documentId;
  return new Request('https://site.invalid/api/contact/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify(value),
  });
}

const valid = {
  requestKey,
  name: 'Casey Customer',
  email: 'casey@example.invalid',
  message: 'Please call about spring service.',
};

test('public contact config exposes only the public email and intake availability', async () => {
  const response = await server.contactPublicConfigRoute(
    new Request('https://site.invalid/api/contact/config'),
    { publicEmail: 'hello@example.invalid', available: true },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { email: 'hello@example.invalid', available: true });
  const unavailable = await server.contactPublicConfigRoute(
    new Request('https://site.invalid/api/contact/config'),
    { publicEmail: null, available: false },
  );
  assert.deepEqual(await unavailable.json(), { email: null, available: false });
});

test('successful submission returns only the durable receipt, not an email-delivery claim', async () => {
  storeCalls.length = 0;
  const response = await server.contactMessagesRoute(postRequest(valid), {
    store,
    eligibility: async () => ({ eligible: false, configRevision: 0, configFingerprint: null, credentialGeneration: null }),
    dispatchNew: async () => { throw new Error('disabled notifications must not dispatch'); },
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    received: true,
    id: messageId,
    created: true,
    message: 'Thanks—we’ve received your message.',
  });
  assert.equal(storeCalls.length, 1);
  assert.deepEqual(storeCalls[0].input, valid);
});

test('invalid, extra-field and cross-origin requests fail before persistence without echoing contact text', async () => {
  storeCalls.length = 0;
  const sentinel = 'PRIVATE_CONTACT_SENTINEL_95a1';
  const malformed = await server.contactMessagesRoute(postRequest({ ...valid, message: sentinel, bcc: 'secret@example.invalid' }), { store });
  assert.equal(malformed.status, 400);
  const malformedBody = await malformed.text();
  assert.ok(!malformedBody.includes(sentinel));
  const crossOrigin = await server.contactMessagesRoute(postRequest(valid, { origin: 'https://attacker.invalid' }), { store });
  assert.equal(crossOrigin.status, 403);
  assert.equal(storeCalls.length, 0);
});

test('a changed or unavailable request receives a fixed conflict response with no submitted data', async () => {
  const conflictStore = { async submit() { throw new Error('request_conflict'); } };
  const response = await server.contactMessagesRoute(postRequest(valid), { store: conflictStore });
  assert.equal(response.status, 409);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), { error: 'This request changed or is no longer available.' });
  assert.ok(!body.includes(valid.email) && !body.includes(valid.message));
});

test('typed rate rejection is a bounded 429 and does not schedule delivery work', async () => {
  scheduledWork.length = 0;
  let attempted = 0;
  const response = await server.contactMessagesRoute(postRequest(valid), {
    store: { async submit() { attempted += 1; throw new core.ContactRateLimitError(3700); } },
    eligibility: async () => ({ eligible: true, policyEligible: true, configRevision: 2, configFingerprint: 'a'.repeat(64), credentialGeneration: 'b'.repeat(64) }),
    dispatchNew: async () => { throw new Error('a rejected receipt cannot dispatch'); },
    waitUntil: promise => scheduledWork.push(Promise.resolve(promise)),
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '3600');
  assert.deepEqual(await response.json(), { error: 'Please wait before sending another message.' });
  assert.equal(attempted, 1);
  assert.equal(scheduledWork.length, 0);
});

test('only a newly saved policy-eligible message may start the sender refresh path', async () => {
  scheduledWork.length = 0;
  let submissions = 0;
  const dispatches = [];
  const refreshableStore = {
    async submit() {
      submissions += 1;
      return { received: true, id: messageId, created: submissions === 1 };
    },
    async outboxForSource(sourceType, sourceId) {
      assert.equal(sourceType, 'contact');
      assert.equal(sourceId, messageId);
      return { id: 'd9000000-0000-4000-8000-000000000001', revision: 1 };
    },
  };
  const deps = {
    store: refreshableStore,
    eligibility: async () => ({
      eligible: false,
      policyEligible: true,
      refreshSender: true,
      attentionReason: 'sender_check_required',
      configRevision: 3,
      configFingerprint: 'a'.repeat(64),
      credentialGeneration: 'b'.repeat(64),
    }),
    dispatchNew: async id => { dispatches.push(id); },
    waitUntil: promise => scheduledWork.push(Promise.resolve(promise)),
  };

  const first = await server.contactMessagesRoute(postRequest(valid), deps);
  assert.equal(first.status, 201);
  assert.equal((await first.json()).message, 'Thanks—we’ve received your message.');
  assert.equal(scheduledWork.length, 1);
  await Promise.all(scheduledWork.splice(0));
  assert.deepEqual(dispatches, ['d9000000-0000-4000-8000-000000000001']);

  const replay = await server.contactMessagesRoute(postRequest(valid), deps);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).created, false);
  assert.equal(scheduledWork.length, 0);
  assert.equal(submissions, 2);
  assert.equal(dispatches.length, 1, 'same-key replay never refreshes sender proof or dispatches again');
});

test('optional outcome capture runs only for a new durable receipt with the current document header', async () => {
  scheduledWork.length = 0;
  capturedMeasurements.length = 0;
  const secondKey = 'd6000000-0000-4000-8000-000000000002';
  const thirdKey = 'd6000000-0000-4000-8000-000000000003';
  let calls = 0;
  const outcomeStore = {
    async submit(input) {
      calls += 1;
      const id = input.requestKey === secondKey ? 'd5000000-0000-4000-8000-000000000002' : input.requestKey === thirdKey ? 'd5000000-0000-4000-8000-000000000003' : messageId;
      return { received: true, id, created: calls !== 2 };
    },
  };
  const deps = {
    store: outcomeStore,
    eligibility: async () => ({ eligible: false, configRevision: 0, configFingerprint: null, credentialGeneration: null }),
    waitUntil: promise => scheduledWork.push(Promise.resolve(promise)),
    async captureOutcome(request, kind, sourceId) {
      capturedMeasurements.push({ documentId: request.headers.get('X-Measurement-Document'), kind, sourceId });
      if (sourceId === 'd5000000-0000-4000-8000-000000000003') throw new Error('optional measurement failure');
    },
  };
  const documentId = 'd7000000-0000-4000-8000-000000000001';
  const first = await server.contactMessagesRoute(postRequest(valid, { documentId }), deps);
  assert.equal(first.status, 201);
  assert.equal((await first.json()).message, 'Thanks—we’ve received your message.');
  await Promise.all(scheduledWork.splice(0));
  assert.deepEqual(capturedMeasurements, [{ documentId, kind: 'contact_received', sourceId: messageId }]);

  const replay = await server.contactMessagesRoute(postRequest(valid, { documentId }), deps);
  assert.equal(replay.status, 200);
  await Promise.all(scheduledWork.splice(0));
  assert.equal(capturedMeasurements.length, 1, 'idempotent replay never creates another outcome');

  const withoutHeader = await server.contactMessagesRoute(postRequest({ ...valid, requestKey: secondKey }), deps);
  assert.equal(withoutHeader.status, 201);
  await Promise.all(scheduledWork.splice(0));
  assert.equal(capturedMeasurements.length, 1, 'a receipt without the registered document header has no measurement outcome');

  const captureFailure = await server.contactMessagesRoute(postRequest({ ...valid, requestKey: thirdKey }, { documentId }), deps);
  assert.equal(captureFailure.status, 201);
  await Promise.all(scheduledWork.splice(0));
  assert.equal((await captureFailure.json()).message, 'Thanks—we’ve received your message.', 'measurement failure does not alter the durable receipt');
  assert.equal(capturedMeasurements.length, 2);
});
