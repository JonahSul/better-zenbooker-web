import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const source = await readFile(path.join(root, 'lib/booking-continuity.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', compiled)((specifier) => {
  if (specifier === 'zod/v3') return require(specifier);
  throw new Error(`Unexpected booking-continuity import: ${specifier}`);
}, loaded, loaded.exports);
const { BOOKING_CONTINUITY_KEY, saveBookingContinuity, takeBookingContinuity } = loaded.exports;
const readinessSource = await readFile(path.join(root, 'lib/support-thread-readiness.ts'), 'utf8');
const readinessCompiled = ts.transpileModule(readinessSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const readinessLoaded = { exports: {} };
new Function('require', 'module', 'exports', readinessCompiled)(specifier => {
  throw new Error(`Unexpected support-thread-readiness import: ${specifier}`);
}, readinessLoaded, readinessLoaded.exports);
const { confirmSupportThread, isReadySupportThread } = readinessLoaded.exports;

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

const threadId = '21212121-2121-4212-8212-212121212121';
const offeringId = '32323232-3232-4232-8232-323232323232';
const conversation = { threadId, revision: 0 };
const currentOfferings = { revision: 9, offerings: [{ offeringId }] };
const readyThread = confirmSupportThread({ id: threadId, revision: 0, expires_at: 20_000, deleted_at: null, turns: [] }, threadId, 2_000);
const ownedConversation = { threadId: readyThread.id, revision: readyThread.revision, expiresAt: readyThread.expires_at, serverLoaded: true };

test('continuity stores only bounded draft, route and allowlisted offering identifiers for ten minutes', () => {
  const storage = memoryStorage();
  const value = {
    returnTo: 'support-booking',
    text: 'Unsent demo question',
    conversation,
    offeringId,
    offeringsRevision: 9,
  };
  assert.deepEqual(saveBookingContinuity(storage, value, 1000), { saved: true, reason: 'saved' });
  const serialized = storage.getItem(BOOKING_CONTINUITY_KEY);
  assert.equal(serialized.length <= 8192, true);
  const stored = JSON.parse(serialized);
  assert.equal(stored.expiresAt, 601_000);
  assert.deepEqual(stored.input, value);
  for (const secret of ['customer@gmail.com', 'PHOTO_SENTINEL', 'https://widget.zenbooker.com', 'google-subject-sentinel']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('a valid owned conversation and current offering restore once without auto-submitting', () => {
  const storage = memoryStorage();
  saveBookingContinuity(storage, { returnTo: 'support-booking', text: 'Draft only', conversation, offeringId, offeringsRevision: 9 }, 1000);

  assert.deepEqual(takeBookingContinuity(storage, {
    returnTo: 'support-booking', ownedConversation, offerings: currentOfferings,
  }, 2000), {
    restored: true, text: 'Draft only', returnTo: 'support-booking', selectionRestored: true, offeringId, offeringsRevision: 9,
  });
  assert.deepEqual(takeBookingContinuity(storage, {
    returnTo: 'support-booking', ownedConversation, offerings: currentOfferings,
  }, 2001), { restored: false, reason: 'missing' });
});

test('a server-confirmed live revision-zero SupportStore thread is ready, while placeholders and stale ownership are not', () => {
  assert.equal(isReadySupportThread(readyThread, 2_000), true);
  assert.equal(readyThread.revision, 0);
  assert.throws(() => confirmSupportThread({ id: threadId, revision: 0, expires_at: 0 }, threadId, 2_000), /Conversation unavailable/);
  assert.throws(() => confirmSupportThread({ id: threadId, revision: 0, expires_at: 20_000, deleted_at: 3_000 }, threadId, 2_000), /Conversation unavailable/);
  assert.throws(() => confirmSupportThread({ id: threadId, revision: 0, expires_at: 20_000 }, offeringId, 2_000), /Conversation unavailable/);
  assert.equal(isReadySupportThread({ id: threadId, revision: 0, expires_at: 20_000 }, 2_000), false,
    'a client-created or unconfirmed thread placeholder is not server-verified ownership');
  assert.equal(isReadySupportThread({ ...readyThread, expires_at: 2_000 }, 2_000), false);
  assert.equal(isReadySupportThread({ ...readyThread, deleted_at: 2_000 }, 2_000), false);
});

test('foreign, changed, revoked, wrong-route or expired conversation drafts are consumed and not restored', () => {
  const cases = [
    ['foreign conversation', { returnTo: 'support-booking', ownedConversation: null, offerings: currentOfferings }, 2000, 'conversation_changed'],
    ['changed revision', { returnTo: 'support-booking', ownedConversation: { ...ownedConversation, revision: 1 }, offerings: currentOfferings }, 2000, 'conversation_changed'],
    ['unconfirmed thread', { returnTo: 'support-booking', ownedConversation: { threadId, revision: 0, expiresAt: 20_000 }, offerings: currentOfferings }, 2000, 'conversation_changed'],
    ['expired thread', { returnTo: 'support-booking', ownedConversation: { ...ownedConversation, expiresAt: 2_000 }, offerings: currentOfferings }, 2000, 'conversation_changed'],
    ['revoked context', { returnTo: 'support-booking', ownedConversation, revoked: true, offerings: currentOfferings }, 2000, 'revoked'],
    ['wrong route', { returnTo: 'book', ownedConversation, offerings: currentOfferings }, 2000, 'wrong_context'],
    ['expired draft', { returnTo: 'support-booking', ownedConversation, offerings: currentOfferings }, 601_000, 'expired'],
  ];
  for (const [label, context, now, reason] of cases) {
    const storage = memoryStorage();
    saveBookingContinuity(storage, { returnTo: 'support-booking', text: 'Private unsent draft', conversation }, 1000);
    assert.deepEqual(takeBookingContinuity(storage, context, now), { restored: false, reason }, label);
    assert.equal(storage.getItem(BOOKING_CONTINUITY_KEY), null, `${label} must consume the saved copy`);
  }
});

test('an outdated offering drops only the service choice while preserving a current owned draft', () => {
  const storage = memoryStorage();
  saveBookingContinuity(storage, { returnTo: 'support-booking', text: 'Draft', conversation, offeringId, offeringsRevision: 8 }, 1000);

  assert.deepEqual(takeBookingContinuity(storage, {
    returnTo: 'support-booking', ownedConversation, offerings: currentOfferings,
  }, 2000), { restored: true, text: 'Draft', returnTo: 'support-booking', selectionRestored: false });
});

test('oversize, unowned and identity, photo or URL-bearing continuity inputs are rejected', () => {
  const storage = memoryStorage();
  assert.deepEqual(saveBookingContinuity(storage, { returnTo: 'support-booking', text: 'unowned draft' }, 1000), {
    saved: false, reason: 'unowned_draft',
  });
  assert.deepEqual(saveBookingContinuity(storage, { returnTo: 'book', text: 'x'.repeat(4001), conversation }, 1000), {
    saved: false, reason: 'invalid',
  });
  for (const extra of [
    { customerEmail: 'customer@gmail.com' },
    { profile: { name: 'Customer Fixture', email: 'customer@gmail.com' } },
    { accountSnapshot: { customer: { authenticated: true } } },
    { photoIds: ['photo-sentinel'] },
    { iframeUrl: 'https://widget.zenbooker.com/' },
    { providerFields: { jobId: 'provider-sentinel' } },
  ]) {
    assert.deepEqual(saveBookingContinuity(storage, { returnTo: 'book', text: 'ok', conversation, ...extra }, 1000), {
      saved: false, reason: 'invalid',
    });
  }
  assert.equal(storage.getItem(BOOKING_CONTINUITY_KEY), null);
});

test('storage refusal and malformed stored data fail closed without blocking guest navigation', () => {
  const denied = {
    getItem() { throw new Error('storage denied'); },
    setItem() { throw new Error('storage denied'); },
    removeItem() { throw new Error('storage denied'); },
  };
  assert.deepEqual(saveBookingContinuity(denied, { returnTo: 'book', conversation }), { saved: false, reason: 'storage_unavailable' });
  assert.deepEqual(takeBookingContinuity(denied, { returnTo: 'book', offerings: { revision: 0, offerings: [] } }), { restored: false, reason: 'storage_unavailable' });

  const storage = memoryStorage();
  storage.setItem(BOOKING_CONTINUITY_KEY, JSON.stringify({ version: 1, expiresAt: 999_999, input: { returnTo: 'book', text: '', iframeUrl: 'https://widget.zenbooker.com/' } }));
  assert.deepEqual(takeBookingContinuity(storage, { returnTo: 'book', offerings: { revision: 0, offerings: [] } }, 1000), { restored: false, reason: 'invalid' });
  assert.equal(storage.getItem(BOOKING_CONTINUITY_KEY), null);
});
