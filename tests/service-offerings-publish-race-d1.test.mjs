import test from 'node:test';
import assert from 'node:assert/strict';

const base = process.env.TEST_SERVICE_OFFERINGS_D1_BASE_URL ?? '';
const token = process.env.TEST_SERVICE_OFFERINGS_D1_TOKEN ?? '';
const config = process.env.TEST_SERVICE_OFFERINGS_D1_CONFIG ?? '';
const persist = process.env.TEST_SERVICE_OFFERINGS_D1_PERSIST ?? '';
const dbName = process.env.TEST_SERVICE_OFFERINGS_D1_NAME ?? '';
const parsed = base ? new URL(base) : null;
const enabled = !!parsed && parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1'
  && parsed.port === '8799' && !!token
  && /\.sites-runtime\/service-offerings-fixture\/wrangler\.json$/i.test(config.replaceAll('\\', '/'))
  && /\.wrangler\/service-offerings-local-0[2-3]$/i.test(persist.replaceAll('\\', '/'))
  && dbName === 'site-creator-d1';
if (base && !enabled) throw new Error('Publication-race proof requires its exact fresh loopback offering fixture.');

async function call(action, extra = {}) {
  const response = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-QA-Service-Offerings': token, Connection: 'close' },
    body: JSON.stringify({ action, ...extra }),
  });
  let body;
  try { body = await response.json(); } catch { throw new Error(`Offering race fixture returned non-JSON (${response.status}).`); }
  return { status: response.status, body };
}

const actor = 'synthetic-owner-subject';
const offering = '4d2dc7c8-5a8f-4a8b-8cdf-b6c5d0b0df10';
const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const entry = { offeringId: offering, name: 'Synthetic reviewed offering', providerServiceId: null, providerIdVerified: false };

test('ServiceOfferingStore actual local D1 rejects expired/stale publishes without writes and serializes publish CAS', {
  skip: !enabled && 'Set TEST_SERVICE_OFFERINGS_D1_* for a fresh service-offerings-local-02 or -03 fixture only.',
}, async () => {
  const migrations = await call('init');
  assert.equal(migrations.status, 200);
  assert.equal(migrations.body.ready, true);
  assert.equal(migrations.body.migrations, 30);
  const before = (await call('counts')).body;
  const initialNow = Date.now();
  assert.equal((await call('clock/set', { now: initialNow })).status, 200);

  const expiredAt = initialNow + 5_000;
  const expiredDraft = await call('draft', {
    workspace: 'a', actor,
    input: { requestKey: uuid(101), expectedRevision: 0, source: 'owner_review', expiresAt: expiredAt, offerings: [entry] },
  });
  assert.equal(expiredDraft.status, 200);
  const afterExpiredDraft = (await call('counts')).body;
  assert.equal(afterExpiredDraft.snapshots - before.snapshots, 1);
  assert.equal(afterExpiredDraft.audit - before.audit, 1);
  assert.equal(afterExpiredDraft.pointers - before.pointers, 1);

  assert.equal((await call('clock/set', { now: expiredAt })).status, 200);
  const expiredPublish = await call('publish', {
    workspace: 'a', actor,
    input: { requestKey: uuid(102), expectedRevision: 1, snapshotId: expiredDraft.body.snapshotId, expectedSnapshotRevision: 1 },
  });
  assert.equal(expiredPublish.status, 409);
  assert.equal(expiredPublish.body.error, 'draft_changed');
  assert.deepEqual((await call('counts')).body, afterExpiredDraft, 'an expired draft cannot change pointer, snapshot or audit state');
  const retainedExpiredDraft = await call('status', { workspace: 'a' });
  assert.equal(retainedExpiredDraft.body.revision, 1);
  assert.equal(retainedExpiredDraft.body.snapshots.find(row => row.id === expiredDraft.body.snapshotId).status, 'draft');

  const validNow = expiredAt + 1;
  const validExpiresAt = validNow + 60_000;
  assert.equal((await call('clock/set', { now: validNow })).status, 200);
  const validDraft = await call('draft', {
    workspace: 'a', actor,
    input: { requestKey: uuid(103), expectedRevision: 1, source: 'owner_review', expiresAt: validExpiresAt, offerings: [entry] },
  });
  assert.equal(validDraft.status, 200);
  const beforeFailedPublish = (await call('counts')).body;

  assert.equal((await call('audit-failure', { enabled: true })).status, 200);
  const auditFailure = await call('publish', {
    workspace: 'a', actor,
    input: { requestKey: uuid(104), expectedRevision: 2, snapshotId: validDraft.body.snapshotId, expectedSnapshotRevision: 1 },
  });
  assert.equal(auditFailure.status, 409);
  assert.equal(auditFailure.body.error, 'fixture_failure');
  assert.equal((await call('audit-failure', { enabled: false })).status, 200);
  assert.deepEqual((await call('counts')).body, beforeFailedPublish, 'audit failure rolls back pointer and snapshot publication');
  const stillDraft = await call('status', { workspace: 'a' });
  assert.equal(stillDraft.body.revision, 2);
  assert.equal(stillDraft.body.snapshots.find(row => row.id === validDraft.body.snapshotId).status, 'draft');

  const contenders = await Promise.all([
    call('publish', { workspace: 'a', actor, input: { requestKey: uuid(105), expectedRevision: 2, snapshotId: validDraft.body.snapshotId, expectedSnapshotRevision: 1 } }),
    call('publish', { workspace: 'a', actor, input: { requestKey: uuid(106), expectedRevision: 2, snapshotId: validDraft.body.snapshotId, expectedSnapshotRevision: 1 } }),
  ]);
  assert.equal(contenders.filter(result => result.status === 200).length, 1);
  assert.equal(contenders.filter(result => result.status === 409).length, 1);
  const afterWinner = (await call('counts')).body;
  assert.equal(afterWinner.snapshots, before.snapshots + 2);
  assert.equal(afterWinner.audit, before.audit + 3, 'only the two drafts and one successful publish are audited');
  assert.equal(afterWinner.pointers, before.pointers + 1);
  const publishedStatus = await call('status', { workspace: 'a' });
  assert.equal(publishedStatus.body.revision, 3);
  assert.equal(publishedStatus.body.snapshots.find(row => row.id === validDraft.body.snapshotId).status, 'published');

  const stalePublish = await call('publish', {
    workspace: 'a', actor,
    input: { requestKey: uuid(107), expectedRevision: 2, snapshotId: validDraft.body.snapshotId, expectedSnapshotRevision: 1 },
  });
  assert.equal(stalePublish.status, 409);
  assert.deepEqual((await call('counts')).body, afterWinner, 'stale pointer/snapshot revision cannot add an operation audit');

  assert.equal((await call('clock/set', { now: validExpiresAt })).status, 200);
  const afterExpiry = await call('public', { workspace: 'a' });
  assert.deepEqual(afterExpiry.body.offerings, [], 'expired published snapshot is no longer offered');
  assert.equal(afterExpiry.body.expiresAt, null);
  assert.deepEqual((await call('counts')).body, afterWinner, 'expiry affects read eligibility without rewriting retained history');

  const readBoundaryBase = validExpiresAt + 10;
  const readBoundaryExpiry = readBoundaryBase + 5_000;
  assert.equal((await call('clock/set', { now: readBoundaryBase })).status, 200);
  const readBoundaryDraft = await call('draft', {
    workspace: 'a', actor,
    input: { requestKey: uuid(108), expectedRevision: 3, source: 'owner_review', expiresAt: readBoundaryExpiry, offerings: [entry] },
  });
  assert.equal(readBoundaryDraft.status, 200);
  const beforeReadBoundaryPublish = (await call('counts')).body;
  const expiredDuringRead = await call('publish-clock-boundary', {
    workspace: 'a', actor, kind: 'after_eligible_read', milliseconds: 5_001,
    input: { requestKey: uuid(109), expectedRevision: 4, snapshotId: readBoundaryDraft.body.snapshotId, expectedSnapshotRevision: 1 },
  });
  assert.equal(expiredDuringRead.status, 409);
  assert.ok(['draft_changed', 'offerings_changed'].includes(expiredDuringRead.body.error));
  assert.deepEqual(expiredDuringRead.body.clockBoundary, {
    before: readBoundaryBase, after: readBoundaryBase + 5_001, advanceCount: 1,
  }, 'the local D1 hook advances exactly once after the eligibility row is read');
  assert.deepEqual((await call('counts')).body, beforeReadBoundaryPublish, 'expiry between eligibility read and operation timestamp leaves all writes at zero');
  const expiredByRace = await call('status', { workspace: 'a' });
  assert.equal(expiredByRace.body.revision, 4);
  assert.equal(expiredByRace.body.snapshots.find(row => row.id === readBoundaryDraft.body.snapshotId).status, 'draft');

  const bindBoundaryBase = readBoundaryExpiry + 100;
  const bindBoundaryExpiry = bindBoundaryBase + 5_000;
  assert.equal((await call('clock/set', { now: bindBoundaryBase })).status, 200);
  const bindBoundaryDraft = await call('draft', {
    workspace: 'a', actor,
    input: { requestKey: uuid(110), expectedRevision: 4, source: 'owner_review', expiresAt: bindBoundaryExpiry, offerings: [entry] },
  });
  assert.equal(bindBoundaryDraft.status, 200);
  const beforeBindBoundaryPublish = (await call('counts')).body;
  const publishedAcrossClockBoundary = await call('publish-clock-boundary', {
    workspace: 'a', actor, kind: 'after_pointer_bind', milliseconds: 5_001,
    input: { requestKey: uuid(111), expectedRevision: 5, snapshotId: bindBoundaryDraft.body.snapshotId, expectedSnapshotRevision: 1 },
  });
  assert.equal(publishedAcrossClockBoundary.status, 200, 'all statements use the captured operation timestamp even when fixture time advances after CAS binding');
  assert.deepEqual(publishedAcrossClockBoundary.body.clockBoundary, {
    before: bindBoundaryBase, after: bindBoundaryBase + 5_001, advanceCount: 1,
  }, 'the local D1 hook advances exactly once after the pointer CAS is bound');
  const afterBindBoundaryPublish = (await call('counts')).body;
  assert.equal(afterBindBoundaryPublish.snapshots, beforeBindBoundaryPublish.snapshots);
  assert.equal(afterBindBoundaryPublish.audit, beforeBindBoundaryPublish.audit + 1);
  assert.equal(afterBindBoundaryPublish.pointers, beforeBindBoundaryPublish.pointers, 'the existing single pointer row is updated atomically');
  const expiredPublished = await call('status', { workspace: 'a' });
  assert.equal(expiredPublished.body.revision, 6);
  assert.equal(expiredPublished.body.snapshotId, bindBoundaryDraft.body.snapshotId);
  assert.equal(expiredPublished.body.snapshots.find(row => row.id === bindBoundaryDraft.body.snapshotId).status, 'published');
  assert.deepEqual((await call('public', { workspace: 'a' })).body.offerings, [], 'a consistent commit may be expired on a subsequent later read');
  assert.deepEqual((await call('counts')).body, afterBindBoundaryPublish);
});
