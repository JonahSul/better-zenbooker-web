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
  && /\.wrangler\/service-offerings-local-0[1-3]$/i.test(persist.replaceAll('\\', '/'))
  && dbName === 'site-creator-d1';
if (base && !enabled) throw new Error('Service-offerings D1 proof requires the dedicated loopback fixture and exact isolated paths.');

async function call(action, extra = {}) {
  const response = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-QA-Service-Offerings': token, Connection: 'close' },
    body: JSON.stringify({ action, ...extra }),
  });
  let body;
  try { body = await response.json(); } catch { throw new Error(`Offering fixture returned non-JSON (${response.status}).`); }
  return { status: response.status, body };
}

const actor = 'synthetic-owner-subject';
const offeringA = '4d2dc7c8-5a8f-4a8b-8cdf-b6c5d0b0df10';
const offeringB = '6445dd99-9ac5-47bd-aa6f-f99e3110d9b2';
const idA = 'Owner-reviewed fall service';
const idB = 'Owner-reviewed spring service';
const entry = (offeringId, name) => ({ offeringId, name, providerServiceId: null, providerIdVerified: false });
const uuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const draftInput = (number, expectedRevision, row) => ({
  requestKey: uuid(number), expectedRevision, source: 'owner_review', offerings: [row],
});

test('ServiceOfferingStore actual local D1 enforces owner-review publication CAS, expiry, workspace isolation and atomic audit', {
  skip: !enabled && 'Set TEST_SERVICE_OFFERINGS_D1_* for the fresh isolated local 0027-migration fixture only.',
}, async () => {
  const before = (await call('counts')).body;
  const initialA = await call('public', { workspace: 'a' });
  const initialB = await call('public', { workspace: 'b' });
  assert.deepEqual(initialA.body.offerings, []);
  assert.deepEqual(initialB.body.offerings, []);

  const unverifiedSource = await call('draft', {
    workspace: 'a', actor, input: { ...draftInput(1, 0, entry(offeringA, idA)), source: 'validated_api' },
  });
  assert.equal(unverifiedSource.status, 409);
  assert.equal(unverifiedSource.body.error, 'validated_catalog_unavailable');

  assert.equal((await call('audit-failure', { enabled: true })).status, 200);
  const auditFailure = await call('draft', { workspace: 'b', actor, input: draftInput(2, 0, entry(offeringB, idB)) });
  assert.equal(auditFailure.status, 409);
  assert.equal(auditFailure.body.error, 'fixture_failure');
  assert.equal((await call('audit-failure', { enabled: false })).status, 200);
  assert.deepEqual((await call('counts')).body, before, 'failed audit must roll back pointer and snapshot writes');

  const contenders = await Promise.all([
    call('draft', { workspace: 'b', actor, input: draftInput(3, 0, entry(offeringB, idB)) }),
    call('draft', { workspace: 'b', actor, input: draftInput(4, 0, entry(offeringA, 'Concurrent alternative')) }),
  ]);
  const winnerIndex = contenders.findIndex(result => result.status === 200);
  assert.ok(winnerIndex >= 0);
  assert.equal(contenders.filter(result => result.status === 200).length, 1);
  assert.equal(contenders.filter(result => result.status !== 200).length, 1);
  const winnerInput = draftInput(winnerIndex === 0 ? 3 : 4, 0, winnerIndex === 0 ? entry(offeringB, idB) : entry(offeringA, 'Concurrent alternative'));
  const winner = contenders[winnerIndex].body;
  assert.equal((await call('draft', { workspace: 'b', actor, input: winnerInput })).body.duplicate, true);
  assert.deepEqual((await call('public', { workspace: 'b' })).body.offerings, [], 'saved drafts are not public until explicitly published');

  const draftAInput = draftInput(5, 0, entry(offeringA, idA));
  const draftA = await call('draft', { workspace: 'a', actor, input: draftAInput });
  assert.equal(draftA.status, 200);
  assert.equal(draftA.body.revision, 1);
  const draftPublic = await call('public', { workspace: 'a' });
  assert.deepEqual(draftPublic.body.offerings, []);

  const publishInput = { requestKey: uuid(6), expectedRevision: 1, snapshotId: draftA.body.snapshotId, expectedSnapshotRevision: 1 };
  const published = await call('publish', { workspace: 'a', actor, input: publishInput });
  assert.equal(published.status, 200);
  assert.equal(published.body.revision, 2);
  assert.equal((await call('publish', { workspace: 'a', actor, input: publishInput })).body.duplicate, true);
  const live = await call('public', { workspace: 'a' });
  assert.equal(live.body.revision, 2);
  assert.equal(live.body.offerings.length, 1);
  assert.equal(live.body.offerings[0].offeringId, offeringA);
  assert.equal(live.body.offerings[0].name, idA);
  assert.equal(live.body.offerings[0].providerServiceId, null);
  assert.equal(Object.hasOwn(live.body.offerings[0], 'price'), false);
  assert.equal(Object.hasOwn(live.body.offerings[0], 'availability'), false);

  const selected = await call('resolve', { workspace: 'a', offeringId: offeringA, offeringsRevision: live.body.revision });
  assert.equal(selected.status, 200);
  assert.equal(selected.body.providerServiceId, null);
  const staleSelection = await call('resolve', { workspace: 'a', offeringId: offeringA, offeringsRevision: 1 });
  assert.equal(staleSelection.status, 409);
  const foreign = await call('resolve', { workspace: 'b', offeringId: offeringA, offeringsRevision: 0 });
  assert.equal(foreign.status, 409);

  assert.equal((await call('advance', { milliseconds: 7 * 86400000 })).status, 200);
  const expired = await call('public', { workspace: 'a' });
  assert.deepEqual(expired.body.offerings, []);
  assert.equal(expired.body.expiresAt, null);
  const expiredSelection = await call('resolve', { workspace: 'a', offeringId: offeringA, offeringsRevision: live.body.revision });
  assert.equal(expiredSelection.status, 409);

  const withdrawn = await call('withdraw', { workspace: 'a', actor, input: { requestKey: uuid(7), expectedRevision: 2 } });
  assert.equal(withdrawn.status, 200);
  assert.equal(withdrawn.body.revision, 3);
  assert.equal((await call('public', { workspace: 'a' })).body.offerings.length, 0);

  const after = (await call('counts')).body;
  assert.equal(after.snapshots - before.snapshots, 2, 'only one concurrent draft and the owner-reviewed draft persist');
  assert.equal(after.audit - before.audit, 4, 'only successful draft, publish and withdraw operations are audited');
  assert.equal(after.pointers - before.pointers, 2, 'each workspace has its own pointer');
  const statusB = await call('status', { workspace: 'b' });
  assert.equal(statusB.body.revision, 1);
  assert.equal(statusB.body.snapshots.length, 1);
});
