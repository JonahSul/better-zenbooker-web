import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { loadAbuseCore } from './fixtures/load-ts-test-module.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
process.env.NEXT_PUBLIC_HOSTED_BOOKING_URL ??= 'https://widget.zenbooker.com/book/test-business?embed=true';
process.env.NEXT_PUBLIC_BUSINESS_PHONE ??= '+1 303 555 0123';
const source = await readFile(path.join(root, 'lib/support-core.ts'), 'utf8');
const abuseCore = await loadAbuseCore(root);
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', js)(specifier => {
  if (specifier === 'zod/v3') return require('zod/v3');
  if (specifier === './visitor-abuse-core') return abuseCore;
  throw new Error(`Unexpected support-core dependency: ${specifier}`);
}, loaded, loaded.exports);
const support = loaded.exports;

test('visitor request contracts are strict and bounded without accepting identity or provider fields', () => {
  const valid = {
    requestKey: 'visitor-request-key-0001',
    message: 'When should I schedule a fall blowout?',
  };
  assert.equal(support.supportChatInput.parse(valid).message, valid.message);
  assert.throws(() => support.supportChatInput.parse({ ...valid, email: 'visitor@example.invalid' }));
  assert.throws(() => support.supportChatInput.parse({ ...valid, userId: 'site-owner' }));
  assert.throws(() => support.supportChatInput.parse({ ...valid, provider: 'zenbooker' }));
  assert.throws(() => support.supportChatInput.parse({ ...valid, requestKey: 'short' }));
  assert.throws(() => support.supportChatInput.parse({ ...valid, message: 'x'.repeat(4001) }));
});

test('visitor preference writes accept bounded answer style and installation-defined interest IDs', () => {
  const preference = {
    revision: 0,
    remember: true,
    answerLength: 'short',
    serviceInterests: ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'],
  };
  assert.deepEqual(support.supportPreferenceInput.parse(preference), preference);
  assert.throws(() => support.supportPreferenceInput.parse({ ...preference, answerLength: 'long' }));
  assert.throws(() => support.supportPreferenceInput.parse({ ...preference, serviceInterests: ['not-a-service-id'] }));
  assert.throws(() => support.supportPreferenceInput.parse({ ...preference, revision: -1 }));
  assert.throws(() => support.supportPreferenceInput.parse({ ...preference, contact: 'visitor@example.invalid' }));
});

test('feedback is bound to a known turn and cannot carry free-form text', () => {
  const feedback = {
    threadId: 'e1469ad0-4986-46f3-beb4-a0cdb6ed2d63',
    turnId: '8d7f490c-63c0-47b4-8f58-90987a5b5ff8',
    vote: 'down',
    reason: 'unclear',
  };
  assert.deepEqual(support.supportFeedbackInput.parse(feedback), feedback);
  assert.throws(() => support.supportFeedbackInput.parse({ ...feedback, reason: 'email me at x@example.com' }));
  assert.throws(() => support.supportFeedbackInput.parse({ ...feedback, message: 'secret customer note' }));
  assert.throws(() => support.supportFeedbackInput.parse({ ...feedback, threadId: 'not-a-uuid' }));
});

test('model tool registry contains public search, own visitor memory, escalation and the scoped abuse report tool', () => {
  assert.deepEqual(support.supportToolNames, [
    'public_kb.search', 'own_memory.read', 'own_memory.update', 'own_memory.delete', 'support.escalate', 'visitor.abuse_report',
  ]);
  assert.equal(support.supportToolArguments['public_kb.search'].safeParse({ query: 'service area' }).success, true);
  assert.equal(support.supportToolArguments['public_kb.search'].safeParse({ query: 'x', url: 'https://evil.example' }).success, false);
  assert.equal(support.supportToolArguments['own_memory.read'].safeParse({}).success, true);
  assert.equal(support.supportToolArguments['own_memory.read'].safeParse({ visitorId: 'other' }).success, false);
  assert.equal(support.supportToolArguments['own_memory.delete'].safeParse({ revision: 1 }).success, true);
  assert.equal(support.supportToolArguments['support.escalate'].safeParse({ reason: 'urgent' }).success, true);
  assert.equal(support.supportToolArguments['support.escalate'].safeParse({ reason: 'send_email' }).success, false);
  assert.equal(support.supportToolArguments['visitor.abuse_report'].safeParse({ reason: 'targeted_harassment', evidence: 'A bounded current-user quote.' }).success, true);
  assert.equal(support.supportToolArguments['visitor.abuse_report'].safeParse({ reason: 'targeted_harassment', evidence: 'A bounded current-user quote.', ip: '203.0.113.1' }).success, false);
  assert.equal(support.supportToolArguments['admin.inquiries.list'], undefined);
  assert.equal(support.supportToolArguments['booking.create'], undefined);
});

test('provider output is normalized from choices content and unknown tool names fail closed', () => {
  const normalized = support.normalizeSupportModelResult({
    choices: [{ message: { content: 'Check your service area on the hosted booking page.', tool_calls: [] } }],
    usage: { prompt_tokens: 233, completion_tokens: 18, total_tokens: 251 },
  });
  assert.equal(normalized.reply.answer, 'Check your service area on the hosted booking page.');
  assert.deepEqual(normalized.reply.toolCalls, []);
  assert.equal(normalized.usage.prompt_tokens, 233);
  assert.throws(() => support.normalizeSupportModelResult({
    choices: [{ message: { content: null, tool_calls: [{ function: { name: 'admin.inquiries.list', arguments: '{}' } }] } }],
  }));
  assert.throws(() => support.normalizeSupportModelResult({
    choices: [{ message: { tool_calls: [{ function: { name: 'own_memory.read', arguments: '{bad json' } }] } }],
  }));
});

test('visitor text redaction removes contact details, URLs, markup and token-like strings', () => {
  const redacted = support.redactSupportText(
    'Call (406) 555-0112 or email visitor@example.invalid; see https://evil.example/a. Bearer abcdefghijklmnopqrstuvwxyz0123456789 <b>note</b>',
  );
  assert.equal(redacted.includes('visitor@example.invalid'), false);
  assert.equal(redacted.includes('https://evil.example'), false);
  assert.equal(redacted.includes('abcdefghijklmnopqrstuvwxyz0123456789'), false);
  assert.equal(redacted.includes('<b>'), false);
  assert.equal(redacted.includes('note'), true);
  assert.equal(redacted.length <= 16000, true);
});

test('bearer secrets are removed whole before numeric redaction can split them', () => {
  const credential = 'Bearer qaFixtureSecretA1B2C3D4E5F6G7H8J9K0LmNoPqRsTuv';
  const redacted = support.redactSupportText(`A normal question remains readable. ${credential}`);
  assert.match(redacted, /A normal question remains readable/);
  assert.equal(redacted.includes(credential), false);
  assert.equal(/Bearer\s+qaFixtureSecret/i.test(redacted), false);
});

test('support actions use only the installation-configured booking and phone destinations', () => {
  const bookingOnly = support.supportActions();
  assert.equal(bookingOnly.length, 1);
  assert.equal(bookingOnly[0].url, 'https://widget.zenbooker.com/book/test-business?embed=true');
  const withContact = support.supportActions(true);
  assert.equal(withContact.length, 2);
  assert.equal(withContact[1].url, 'tel:+13035550123');
});

test('public knowledge edits bind a reviewed source and accept HTTPS provenance metadata only', () => {
  const document = {
    revision: 0,
    title: 'Finding your service area',
    body: 'Enter your address on the hosted booking page to check service availability.',
    source: 'owner_reviewed',
    sourceUrl: 'https://example.test/',
  };
  assert.equal(support.kbEditInput.parse(document).source, 'owner_reviewed');
  assert.equal(support.kbEditInput.parse({ ...document, sourceUrl: 'https://docs.example.test/owner-provided-source' }).sourceUrl, 'https://docs.example.test/owner-provided-source');
  assert.throws(() => support.kbEditInput.parse({ ...document, sourceUrl: 'http://docs.example.test/' }));
  assert.throws(() => support.kbEditInput.parse({ ...document, sourceUrl: 'https://user:pass@docs.example.test/' }));
  assert.throws(() => support.kbEditInput.parse({ ...document, title: 'x' }));
  assert.throws(() => support.kbEditInput.parse({ ...document, unchecked: true }));
});

test('public answer cleanup is bounded and model-call settings are explicit and capped', () => {
  assert.equal(support.publicSupportAnswer('sample text '.repeat(700)).length, 6000);
  assert.equal(support.supportConfigInput.parse({ revision: 0, enabled: false, dailyModelCalls: 100 }).enabled, false);
  assert.throws(() => support.supportConfigInput.parse({ revision: 0, enabled: true, dailyModelCalls: 101 }));
  assert.throws(() => support.supportConfigInput.parse({ revision: 0, enabled: true, dailyModelCalls: 10, model: 'arbitrary' }));
});

test('visitor escalation and memory writes require explicit intent', () => {
  assert.equal(support.explicitPreferenceIntent('Please remember I prefer short answers.'), true);
  assert.equal(support.explicitPreferenceIntent('Do not remember my address.'), false);
  assert.equal(support.explicitPreferenceIntent('What if you remember this?'), false);
  assert.equal(support.escalationAllowed('Please let me speak to a person.', 'requested_contact', false), true);
  assert.equal(support.escalationAllowed('I need a person.', 'requested_contact', false), true);
  assert.equal(support.escalationAllowed('I have a question.', 'requested_contact', false), false);
  assert.equal(support.escalationAllowed('There is a burst pipe.', 'urgent', false), true);
  assert.equal(support.escalationAllowed('I have a question.', 'self_help_failed', false), false);
  assert.equal(support.escalationAllowed('That did not help.', 'self_help_failed', true), true);
});
