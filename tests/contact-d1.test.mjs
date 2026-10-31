import test from 'node:test';
import assert from 'node:assert/strict';

const base = process.env.TEST_CONTACT_D1_BASE_URL ?? '';
const token = process.env.TEST_CONTACT_D1_TOKEN ?? '';
const config = process.env.TEST_CONTACT_D1_CONFIG ?? '';
const persist = process.env.TEST_CONTACT_D1_PERSIST ?? '';
const dbName = process.env.TEST_CONTACT_D1_NAME ?? '';
const workspace = process.env.TEST_CONTACT_D1_WORKSPACE ?? '';
const expected = {
  base: 'http://127.0.0.1:8803',
  token: 'local-contact-fixture-20261030',
  config: '.sites-runtime/contact-fixture/wrangler.json',
  persist: '.wrangler/contact-local-01',
  dbName: 'site-creator-d1',
  workspace: 'contact-local-workspace',
};
const provided = [base, token, config, persist, dbName, workspace].some(Boolean);
const configured = [base, token, config, persist, dbName, workspace].every(Boolean);
if (provided && (!configured || base !== expected.base || token !== expected.token || config !== expected.config || persist !== expected.persist || dbName !== expected.dbName || workspace !== expected.workspace)) {
  throw new Error('Contact D1 acceptance requires the exact dedicated loopback fixture contract.');
}
const enabled = configured;

async function call(action, extra = {}) {
  const response = await fetch(base, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ action, ...extra }),
  });
  let data;
  try { data = await response.json(); } catch { throw new Error(`Contact fixture returned non-JSON (${response.status}).`); }
  return { status: response.status, data };
}

const uuid = number => `d7000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const input = (number, message) => ({
  requestKey: uuid(number),
  name: 'Fixture Customer',
  email: 'customer@example.invalid',
  message,
});

test('ContactStore actual local D1 keeps durable receipts, one blocked intent, redacted model projection, revisioned deletion and atomic rollback', {
  skip: !enabled && 'Set TEST_CONTACT_D1_* only for the fresh dedicated local D1 fixture.',
}, async () => {
  const initialized = await call('init');
  assert.equal(initialized.status, 200);
  assert.equal(initialized.data.ready, true);
  assert.equal(initialized.data.migrations, 31);
  assert.equal(initialized.data.tablesPresent, true);
  assert.deepEqual(initialized.data.counts, { messages: 0, outbox: 0, audit: 0, configurationRows: 0, senderEvidenceRows: 0, otherMessages: 0, otherOutbox: 0 });

  const foreign = await call('seed-foreign');
  assert.equal(foreign.status, 200);
  assert.equal(foreign.data.created, true);
  const foreignRead = await call('foreign-read-attempt', { id: foreign.data.id });
  assert.equal(foreignRead.status, 200);
  assert.equal(foreignRead.data.message, null, 'the fixed other-workspace row is not readable through the primary workspace store');
  const foreignDelete = await call('foreign-delete-attempt', { input: { id: foreign.data.id, expectedRevision: 1 } });
  assert.equal(foreignDelete.status, 409);
  assert.equal(foreignDelete.data.error, 'message_unavailable');
  const foreignAfter = (await call('foreign-list')).data.messages;
  assert.equal(foreignAfter.length, 1);
  assert.equal(foreignAfter[0].revision, 1, 'a cross-workspace delete attempt leaves the foreign row unchanged');

  const sentinel = 'PRIVATE_MESSAGE_SENTINEL_4f39';
  const firstInput = input(1, sentinel);
  const created = await call('submit', { input: firstInput });
  assert.equal(created.status, 200);
  assert.deepEqual(created.data, { received: true, id: created.data.id, created: true });
  assert.match(created.data.id, /^[0-9a-f-]{36}$/i);

  const firstOutbox = (await call('outbox')).data.outbox;
  assert.equal(firstOutbox.length, 1);
  assert.equal(firstOutbox[0].state, 'blocked', 'default-off contact submission creates an intent that is blocked, not skipped or queued');
  assert.equal(firstOutbox[0].event, 'contact.message_created');
  assert.equal(firstOutbox[0].sourceId, created.data.id);
  assert.equal(Object.hasOwn(firstOutbox[0], 'email'), false);
  assert.equal(Object.hasOwn(firstOutbox[0], 'bcc'), false);
  const blockedClaim = await call('claim', { input: {
    id: firstOutbox[0].id,
    expectedRevision: firstOutbox[0].revision,
    configRevision: 0,
    configFingerprint: 'a'.repeat(64),
    credentialGeneration: 'b'.repeat(64),
  } });
  assert.equal(blockedClaim.status, 200);
  assert.equal(blockedClaim.data.claimed, false);
  assert.equal(blockedClaim.data.state, 'blocked');

  const replay = await call('submit', { input: firstInput });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data, { received: true, id: created.data.id, created: false });
  assert.equal((await call('outbox')).data.outbox.length, 1, 'same-key replay does not make another notification intent');
  const conflict = await call('submit', { input: { ...firstInput, message: 'Different fixture text' } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error, 'request_conflict');
  assert.equal((await call('counts')).data.messages, 1);

  const privateList = (await call('list')).data.messages;
  assert.equal(privateList.length, 1);
  assert.equal(privateList[0].message, sentinel);
  const projected = await call('model-list');
  assert.equal(projected.data.count, 1);
  assert.equal(JSON.stringify(projected.data).includes(sentinel), false);
  assert.equal(JSON.stringify(projected.data).includes(firstInput.email), false);
  assert.deepEqual(Object.keys(projected.data.messages[0]).sort(), ['createdAt', 'expiresAt', 'id', 'revision', 'status']);
  assert.equal(projected.data.resultLink, '/admin/inquiries');

  const status = await call('status', { input: { id: created.data.id, expectedRevision: 1, status: 'read' } });
  assert.equal(status.status, 200);
  assert.equal(status.data.revision, 2);
  assert.equal(status.data.status, 'read');
  const erased = await call('erase', { input: { id: created.data.id, expectedRevision: 2 } });
  assert.equal(erased.status, 200);
  assert.equal(erased.data.revision, 3);
  assert.equal(erased.data.status, 'deleted');
  assert.deepEqual((await call('list')).data.messages, []);
  assert.deepEqual(await call('model-list').then(result => result.data), { count: 0, messages: [], resultLink: '/admin/inquiries' });
  assert.equal((await call('outbox')).data.outbox[0].state, 'canceled');
  const erasedReplay = await call('submit', { input: firstInput });
  assert.equal(erasedReplay.status, 409);
  assert.equal(erasedReplay.data.error, 'message_unavailable');
  assert.equal((await call('counts')).data.messages, 1, 'erasure retains only the minimal replay fence row');

  const secondInput = input(2, 'A second synthetic inquiry for bounded expiry cleanup.');
  const second = await call('submit', { input: secondInput });
  assert.equal(second.data.created, true);
  assert.equal((await call('advance', { milliseconds: 30 * 86400000 })).status, 200);
  const expiredRead = await call('read', { id: second.data.id });
  assert.equal(expiredRead.data.message, null);
  const pruned = await call('prune', { limit: 100 });
  assert.equal(pruned.status, 200);
  assert.equal(pruned.data.erased, 1);
  assert.equal(pruned.data.canceledOutbox, 1);

  assert.equal((await call('policy-eligible', { value: true })).status, 200);
  const routeInput = input(3, 'A new synthetic receipt eligible for a one-time sender refresh attempt.');
  const routeCreated = await call('route-submit', { input: routeInput });
  assert.equal(routeCreated.status, 200);
  assert.equal(routeCreated.data.status, 201);
  assert.equal(routeCreated.data.body.message, 'Thanks—we’ve received your message.');
  assert.equal(routeCreated.data.scheduledCount, 1);
  assert.equal(routeCreated.data.dispatchCount, 1, 'a new policy-eligible receipt may start the bounded sender refresh path');
  const routeReplay = await call('route-submit', { input: routeInput });
  assert.equal(routeReplay.data.status, 200);
  assert.equal(routeReplay.data.body.created, false);
  assert.equal(routeReplay.data.scheduledCount, 0);
  assert.equal(routeReplay.data.dispatchCount, 0, 'route replay does not refresh or dispatch again');

  const beforeFailure = await call('counts');
  assert.equal((await call('arm-outbox-failure', { enabled: true })).status, 200);
  const rolledBack = await call('submit', { input: input(4, 'Rollback sentinel should not persist.') });
  assert.equal(rolledBack.status, 409);
  assert.equal(rolledBack.data.error, 'fixture_failure');
  assert.deepEqual((await call('counts')).data, beforeFailure.data, 'failure inserting the outbox intent rolls back the message insert too');

  const senderConfig = await call('notification-config', { input: {
    expectedRevision: 0, enabled: false, events: [], from: 'notifications@example.invalid',
    zoneId: 'a'.repeat(32), subdomainId: 'b'.repeat(32),
  } });
  assert.equal(senderConfig.status, 200);
  assert.equal(senderConfig.data.revision, 1);
  const senderBinding = { configRevision: 1, senderRevision: 1, fingerprint: 'c'.repeat(64), credentialSource: 'encrypted', credentialGeneration: 'd'.repeat(64) };
  assert.deepEqual((await call('sender-evidence')).data, { senderRevision: 1, evidence: null });

  const contenders = await Promise.all([
    call('sender-claim', { binding: senderBinding }),
    call('sender-claim', { binding: senderBinding }),
  ]);
  assert.ok(contenders.every(result => result.status === 200));
  assert.equal(contenders.filter(result => result.data.claimed).length, 1, 'only one contender acquires the 30-second sender-refresh lease');
  assert.equal(contenders.filter(result => !result.data.claimed).length, 1);
  const firstLease = contenders.find(result => result.data.claimed).data;
  assert.equal(typeof firstLease.token, 'string');

  assert.equal((await call('advance', { milliseconds: 30001 })).status, 200);
  const afterExpiry = await call('sender-claim', { binding: senderBinding });
  assert.equal(afterExpiry.status, 200);
  assert.equal(afterExpiry.data.claimed, true, 'an expired lease can be acquired by a current contender');
  assert.deepEqual((await call('sender-finish', { token: firstLease.token, binding: senderBinding })).data, { saved: false, auditId: null }, 'an expired lease cannot write evidence');
  const finishedLease = await call('sender-finish', { token: afterExpiry.data.token, binding: senderBinding });
  assert.equal(finishedLease.status, 200);
  assert.equal(finishedLease.data.saved, true, 'the current lease can finish without inventing a sender proof');
  assert.equal(typeof finishedLease.data.auditId, 'string');
  assert.deepEqual((await call('sender-evidence')).data, { senderRevision: 1, evidence: null });

  const seededProof = await call('seed-synthetic-sender-evidence', { binding: senderBinding });
  assert.equal(seededProof.status, 200);
  const proofRead = await call('sender-evidence');
  assert.deepEqual(proofRead.data, { senderRevision: 1, evidence: { domainEnabled: true, checkedAt: proofRead.data.evidence.checkedAt, expiresAt: proofRead.data.evidence.expiresAt, checkedConfigRevision: 1 } });
  assert.equal(JSON.stringify(proofRead.data).includes('notifications@example.invalid'), false, 'the fixture readback does not expose sender address');

  const toggled = await call('notification-config', { input: {
    expectedRevision: 1, enabled: true, events: ['contact.message_created'], from: 'notifications@example.invalid',
    zoneId: 'a'.repeat(32), subdomainId: 'b'.repeat(32),
  } });
  assert.equal(toggled.status, 200);
  assert.equal(toggled.data.revision, 2);
  assert.equal((await call('sender-evidence')).data.evidence.domainEnabled, true, 'changing only enabled/events preserves the fresh sender evidence');

  const changedSender = await call('notification-config', { input: {
    expectedRevision: 2, enabled: true, events: ['contact.message_created'], from: 'changed@example.invalid',
    zoneId: 'a'.repeat(32), subdomainId: 'b'.repeat(32),
  } });
  assert.equal(changedSender.status, 200);
  assert.equal(changedSender.data.revision, 3);
  const invalidated = await call('sender-evidence');
  assert.deepEqual(invalidated.data, { senderRevision: 2, evidence: null }, 'sender identity changes invalidate previously recorded evidence');
  const staleLease = await call('sender-claim', { binding: senderBinding });
  assert.equal(staleLease.status, 409);
  assert.equal(staleLease.data.error, 'configuration_changed', 'a stale config/credential binding cannot claim a refresh');
});
