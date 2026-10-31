import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const base = process.env.TEST_ELEMENT_MEASUREMENT_D1_BASE_URL ?? '';
const token = process.env.TEST_ELEMENT_MEASUREMENT_D1_TOKEN ?? '';
const config = process.env.TEST_ELEMENT_MEASUREMENT_D1_CONFIG ?? '';
const persist = process.env.TEST_ELEMENT_MEASUREMENT_D1_PERSIST ?? '';
const dbName = process.env.TEST_ELEMENT_MEASUREMENT_D1_NAME ?? '';
const workspace = process.env.TEST_ELEMENT_MEASUREMENT_D1_WORKSPACE ?? '';
const expected = {
  base: 'http://127.0.0.1:8806',
  token: 'local-element-measurement-fixture-20261030',
  config: '.sites-runtime/element-measurement-fixture/wrangler.json',
  persist: '.wrangler/element-measurement-local-02',
  dbName: 'site-creator-d1',
  workspace: 'element-measurement-local-workspace',
};
const provided = [base, token, config, persist, dbName, workspace].some(Boolean);
const configured = [base, token, config, persist, dbName, workspace].every(Boolean);
if (provided && (!configured || base !== expected.base || token !== expected.token || config !== expected.config || persist !== expected.persist || dbName !== expected.dbName || workspace !== expected.workspace)) {
  throw new Error('Element measurement D1 acceptance requires the exact dedicated loopback fixture contract.');
}
const enabled = configured;
const now = 1_800_000_000_000;
const grants = {
  analytics: { hash: 'a'.repeat(64), revision: 1, expiresAt: now + 30 * 86400000 },
  experiment: { hash: 'b'.repeat(64), revision: 1, expiresAt: now + 15 * 60 * 1000 },
  foreign: { hash: 'c'.repeat(64), revision: 1, expiresAt: now + 30 * 86400000 },
};

async function call(action, input) {
  const response = await fetch(base, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ action, ...(input === undefined ? {} : { input }) }),
  });
  let data;
  try { data = await response.json(); } catch { throw new Error(`Element measurement fixture returned non-JSON (${response.status}).`); }
  return { status: response.status, data };
}

const uuid = n => `e1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = value => createHash('sha256').update(value).digest('hex');
function descriptor({ route = '/contact', at = now, workspaceId = 'element-measurement-local-workspace', snapshot = 'a' } = {}) {
  return {
    purpose: 'element-document-v1', workspaceId, route,
    snapshotHash: snapshot.repeat(64), assetManifestHash: 'b'.repeat(64),
    rendererVersion: 'fixture-renderer-v1', registryVersion: 'element-v2',
    issuedAt: at, expiresAt: at + 30 * 60 * 1000,
  };
}
function registration({ key, route = '/contact', workspaceName = 'primary', grant = grants.analytics, at = now, snapshot = 'a', association } = {}) {
  const value = descriptor({ route, at, workspaceId: workspaceName === 'primary' ? 'element-measurement-local-workspace' : 'element-measurement-foreign-workspace', snapshot });
  return {
    workspace: workspaceName, documentKey: uuid(key), descriptor: value,
    descriptorHash: digest(JSON.stringify(value)), grant,
    ...(association ? { association } : {}),
  };
}

test('ElementMeasurementStore one-run local D1 lifecycle enforces tenant, grant, expiry, quotas, aggregation, withdrawal and GA4-property CAS', {
  skip: !enabled && 'Set TEST_ELEMENT_MEASUREMENT_D1_* only for the fresh dedicated local D1 fixture.',
}, async () => {
  const initialized = await call('init');
  assert.equal(initialized.status, 200);
  assert.equal(initialized.data.ready, true);
  assert.equal(initialized.data.migrations, 32);
  assert.equal(initialized.data.tablesPresent, true);
  assert.deepEqual(initialized.data.counts, { documents: 0, events: 0, propertyRows: 0, propertyAudits: 0 });

  const contact = await call('register', registration({ key: 1 }));
  assert.equal(contact.status, 200);
  assert.match(contact.data.documentId, /^[0-9a-f-]{36}$/i);
  assert.equal(contact.data.expiresAt, now + 30 * 60 * 1000);
  const replay = await call('register', registration({ key: 1 }));
  assert.deepEqual(replay.data, contact.data, 'same current grant/key/descriptor returns the existing document before quota admission');
  const conflict = await call('register', registration({ key: 1, snapshot: 'f' }));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error, 'document_conflict');

  const firstEvents = await call('record', { workspace: 'primary', documentId: contact.data.documentId, grant: grants.analytics, events: [
    { elementId: 'contact_form', kind: 'view' }, { elementId: 'contact_form', kind: 'action' },
  ] });
  assert.deepEqual(firstEvents.data, { accepted: 2, duplicates: 0 });
  assert.deepEqual((await call('record', { workspace: 'primary', documentId: contact.data.documentId, grant: grants.analytics, events: [{ elementId: 'contact_form', kind: 'view' }] })).data, { accepted: 0, duplicates: 1 });
  const wrongRoute = await call('record', { workspace: 'primary', documentId: contact.data.documentId, grant: grants.analytics, events: [{ elementId: 'home_book_header', kind: 'action' }] });
  assert.equal(wrongRoute.status, 409);
  assert.equal(wrongRoute.data.error, 'invalid_document');

  const contactSourceId = uuid(100);
  assert.deepEqual((await call('seed-source', { kind: 'contact', id: contactSourceId, workspace: 'primary' })).data, { id: contactSourceId, kind: 'contact', workspace: 'primary' });
  const sourceHash = digest('element-outcome:v1:synthetic-contact-source');
  assert.deepEqual((await call('outcome', { workspace: 'primary', documentId: contact.data.documentId, kind: 'contact_received', sourceHash, sourceId: contactSourceId, grant: grants.analytics })).data, { accepted: 1 });
  assert.deepEqual((await call('outcome', { workspace: 'primary', documentId: contact.data.documentId, kind: 'contact_received', sourceHash, sourceId: contactSourceId, grant: grants.analytics })).data, { accepted: 0 }, 'source hash and outcome kind are deduplicated');
  const secondContactSourceId = uuid(105);
  await call('seed-source', { kind: 'contact', id: secondContactSourceId, workspace: 'primary' });
  const secondSourceHash = digest('element-outcome:v1:second-synthetic-contact-source');
  assert.deepEqual((await call('outcome', { workspace: 'primary', documentId: contact.data.documentId, kind: 'contact_received', sourceHash: secondSourceHash, sourceId: secondContactSourceId, grant: grants.analytics })).data, { accepted: 1 }, 'distinct durable contacts can be attributed to the same document');
  assert.deepEqual((await call('outcome', { workspace: 'primary', documentId: contact.data.documentId, kind: 'contact_received', sourceHash: secondSourceHash, sourceId: secondContactSourceId, grant: grants.analytics })).data, { accepted: 0 }, 'replaying one durable source does not duplicate its outcome');
  const foreignSourceId = uuid(101);
  await call('seed-source', { kind: 'contact', id: foreignSourceId, workspace: 'foreign' });
  assert.deepEqual((await call('outcome', { workspace: 'primary', documentId: contact.data.documentId, kind: 'contact_received', sourceHash: digest('foreign-source'), sourceId: foreignSourceId, grant: grants.analytics })).data, { accepted: 0 }, 'a foreign source cannot be joined into a primary workspace outcome');
  const deletedSourceId = uuid(102);
  await call('seed-source', { kind: 'contact', id: deletedSourceId, workspace: 'primary', deleted: true });
  assert.deepEqual((await call('outcome', { workspace: 'primary', documentId: contact.data.documentId, kind: 'contact_received', sourceHash: digest('deleted-source'), sourceId: deletedSourceId, grant: grants.analytics })).data, { accepted: 0 }, 'a deleted durable source cannot produce a measurement outcome');

  const associated = await call('register', registration({ key: 2, route: '/', grant: grants.analytics, association: { hash: grants.experiment.hash, revision: 1, versionId: uuid(200), compositionId: uuid(201) } }));
  assert.equal(associated.status, 200);
  assert.deepEqual((await call('record', { workspace: 'primary', documentId: associated.data.documentId, grant: grants.analytics, events: [{ elementId: 'home_book_hero', kind: 'view' }, { elementId: 'home_book_hero', kind: 'action' }] })).data, { accepted: 2, duplicates: 0 });
  const demoSourceId = uuid(103);
  await call('seed-source', { kind: 'demo', id: demoSourceId, workspace: 'primary' });
  assert.deepEqual((await call('outcome', { workspace: 'primary', documentId: associated.data.documentId, kind: 'demo_request_received', sourceHash: digest('synthetic-demo-source'), sourceId: demoSourceId, grant: grants.analytics })).data, { accepted: 1 });
  const expiredDemoSourceId = uuid(104);
  await call('seed-source', { kind: 'demo', id: expiredDemoSourceId, workspace: 'primary', expired: true });
  assert.deepEqual((await call('outcome', { workspace: 'primary', documentId: associated.data.documentId, kind: 'demo_request_received', sourceHash: digest('expired-demo-source'), sourceId: expiredDemoSourceId, grant: grants.analytics })).data, { accepted: 0 }, 'expired inquiry source cannot be joined to a demo outcome');
  const splitWindow = await call('register', registration({ key: 10, route: '/contact', snapshot: '6' }));
  assert.equal(splitWindow.status, 200);
  assert.deepEqual((await call('record', { workspace: 'primary', documentId: splitWindow.data.documentId, grant: grants.analytics, events: [{ elementId: 'contact_form', kind: 'view' }] })).data, { accepted: 1, duplicates: 0 });
  const associationState = await call('state');
  const associationRow = associationState.data.documents.find(row => row.id === associated.data.documentId);
  assert.equal(associationRow.experiment_grant_hash, grants.experiment.hash);
  await call('clock', { now: now + 90_000 });
  assert.deepEqual((await call('record', { workspace: 'primary', documentId: splitWindow.data.documentId, grant: grants.analytics, events: [{ elementId: 'contact_form', kind: 'action' }] })).data, { accepted: 1, duplicates: 0 });
  const beforeExperimentWithdrawal = await call('state');
  await call('clock', { now: now + 2 * 60_000 });
  const splitReport = await call('report', { workspace: 'primary', window: { from: now + 60_000, to: now + 2 * 60_000, route: '/contact' } });
  const splitAggregate = splitReport.data.rows.find(row => row.elementId === 'contact_form');
  assert.equal(splitAggregate.viewedDocuments, 0);
  assert.equal(splitAggregate.actionDocuments, 1);
  assert.equal(splitAggregate.actionsWithPriorView, 0, 'a view before the report window is not prior-view exposure in the window cohort');
  assert.equal(splitAggregate.actionsWithoutPriorView, 1);
  assert.equal(splitAggregate.actionRate, null, 'cross-window activity cannot create a numerator without an in-window denominator');
  const contextualReport = await call('report', { workspace: 'primary', window: { from: now, to: now + 2 * 60_000 } });
  const contextualContactRows = contextualReport.data.rows.filter(row => row.elementId === 'contact_form');
  assert.equal(contextualContactRows.length, 2, 'snapshots remain separate report cohorts');
  for (const snapshot of ['a', '6']) {
    const row = contextualContactRows.find(candidate => candidate.snapshotHash === snapshot.repeat(64));
    assert.ok(row, `contact snapshot ${snapshot} is reported independently`);
    assert.equal(row.viewedDocuments, 1);
    assert.equal(row.actionsWithPriorView, 1);
    assert.equal(row.actionsWithoutPriorView, 0);
  }
  const associatedAggregate = contextualReport.data.rows.find(row => row.elementId === 'home_book_hero');
  assert.equal(associatedAggregate.experimentVersionId, uuid(200));
  assert.equal(associatedAggregate.compositionId, uuid(201));
  await call('clock', { now: now + 16 * 60 * 1000 });
  const expiredExperimentReport = await call('report', { workspace: 'primary', window: { from: now, to: now + 16 * 60 * 1000 } });
  const baselineAfterExpiry = expiredExperimentReport.data.rows.find(row => row.elementId === 'home_book_hero');
  assert.equal(baselineAfterExpiry.experimentVersionId, null, 'expired experiment context is suppressed while Analytics baseline remains reportable');
  assert.equal(baselineAfterExpiry.viewedDocuments, 1);
  const noExperiment = { ...grants.experiment, revision: 2 };
  await call('seed-grant', { hash: noExperiment.hash, revision: noExperiment.revision, analytics: 0, experiments: 0, expiresAt: noExperiment.expiresAt });
  const experimentWithdrawal = await call('withdraw-experiments', { workspace: 'primary', hash: grants.experiment.hash, revision: 1, limit: 100 });
  assert.deepEqual(experimentWithdrawal.data, { clearedAssociations: 1, remaining: false });
  const afterExperimentWithdrawal = await call('state');
  assert.equal(afterExperimentWithdrawal.data.documents.find(row => row.id === associated.data.documentId).experiment_grant_hash, null);
  assert.equal(afterExperimentWithdrawal.data.events.length, beforeExperimentWithdrawal.data.events.length, 'experiment withdrawal preserves baseline event rows');

  const foreignDoc = await call('register', registration({ key: 3, route: '/contact', workspaceName: 'foreign', grant: grants.foreign, snapshot: 'c' }));
  assert.equal(foreignDoc.status, 200);
  assert.deepEqual((await call('record', { workspace: 'foreign', documentId: foreignDoc.data.documentId, grant: grants.foreign, events: [{ elementId: 'contact_form', kind: 'view' }] })).data, { accepted: 1, duplicates: 0 });
  const primaryCannotRecord = await call('record', { workspace: 'primary', documentId: foreignDoc.data.documentId, grant: grants.foreign, events: [{ elementId: 'contact_form', kind: 'view' }] });
  assert.equal(primaryCannotRecord.data.error, 'invalid_document');
  const primaryCannotWithdrawForeign = await call('withdraw-analytics', { workspace: 'primary', hash: grants.foreign.hash, revision: 1, limit: 100 });
  assert.deepEqual(primaryCannotWithdrawForeign.data, { deletedDocuments: 0, remaining: false });

  const expiredDoc = await call('register', registration({ key: 4, route: '/contact', snapshot: 'd' }));
  await call('clock', { now: now + 31 * 60 * 1000 });
  const expiredWrite = await call('record', { workspace: 'primary', documentId: expiredDoc.data.documentId, grant: grants.analytics, events: [{ elementId: 'contact_form', kind: 'action' }] });
  assert.equal(expiredWrite.data.error, 'invalid_document');
  const report = await call('report', { workspace: 'primary', window: { from: now, to: now + 31 * 60 * 1000, route: '/contact' } });
  assert.equal(report.status, 200);
  assert.equal(report.data.outcomes.find(row => row.kind === 'contact_received')?.count, 2);
  assert.equal(report.data.outcomes.find(row => row.kind === 'demo_request_received'), undefined, 'contact route report excludes the home-route demo outcome');
  const contactAggregates = report.data.rows.filter(row => row.elementId === 'contact_form');
  assert.equal(contactAggregates.length, 2);
  assert.equal(contactAggregates.reduce((total, row) => total + row.viewedDocuments, 0), 2);
  assert.equal(contactAggregates.reduce((total, row) => total + row.actionsWithPriorView, 0), 2);
  assert.equal(contactAggregates.reduce((total, row) => total + row.actionsWithoutPriorView, 0), 0);
  assert.equal(report.data.googleReceipt, 'unverified');
  assert.doesNotMatch(JSON.stringify(report.data), /documentId|sourceHash|visitor|email|phone|message|customer|session/i);

  await call('seed-rate', { workspace: 'primary', kind: 'register', grant: grants.analytics, attempts: 29 });
  const concurrencyInputs = [registration({ key: 5, route: '/contact', snapshot: 'e', at: now + 31 * 60 * 1000 }), registration({ key: 6, route: '/contact', snapshot: 'f', at: now + 31 * 60 * 1000 })];
  const concurrent = await Promise.all(concurrencyInputs.map(input => call('register', input)));
  assert.equal(concurrent.filter(item => item.status === 200).length, 1);
  assert.equal(concurrent.filter(item => item.status === 429).length, 1, 'one concurrent registration wins the 30-document hourly quota');
  const winnerIndex = concurrent.findIndex(item => item.status === 200);
  const rateReplay = await call('register', concurrencyInputs[winnerIndex]);
  assert.equal(rateReplay.status, 200, 'same-key replay remains available at the hourly cap');
  await call('seed-rate', { workspace: 'primary', kind: 'events', grant: grants.analytics, attempts: 599 });
  const entryCapDoc = concurrent.find(item => item.status === 200).data.documentId;
  assert.deepEqual((await call('record', { workspace: 'primary', documentId: entryCapDoc, grant: grants.analytics, events: [{ elementId: 'contact_form', kind: 'view' }] })).data, { accepted: 1, duplicates: 0 });
  const overEntryCap = await call('record', { workspace: 'primary', documentId: entryCapDoc, grant: grants.analytics, events: [{ elementId: 'contact_form', kind: 'action' }] });
  assert.equal(overEntryCap.status, 429, '600 submitted event entries are admitted; the next entry is rejected');

  await call('clock', { now: now + 3 * 60 * 60 * 1000 });
  await call('seed-rate', { workspace: 'primary', kind: 'register', grant: grants.analytics, attempts: 29 });
  const futureHourSuccess = await call('register', registration({ key: 8, route: '/contact', at: now + 3 * 60 * 60 * 1000, snapshot: '8' }));
  assert.equal(futureHourSuccess.status, 200);
  const futureRate = (await call('state')).data.rates.filter(row => row.key.includes(':element-register:'));
  await call('clock', { now: now + 31 * 60 * 1000 });
  const delayedOldHour = await call('register', registration({ key: 9, route: '/contact', at: now + 31 * 60 * 1000, snapshot: '7' }));
  assert.equal(delayedOldHour.status, 429, 'a delayed request from an older hour cannot reset the newer quota window');
  assert.deepEqual((await call('state')).data.rates.filter(row => row.key.includes(':element-register:')), futureRate);

  const nativeProperty = await call('property-read', { workspace: 'primary', nativeId: '1234567890123' });
  assert.deepEqual(nativeProperty.data, { revision: 0, propertyId: '1234567890123', source: 'native' });
  const savedProperty = await call('property-save', { workspace: 'primary', value: { expectedRevision: 0, propertyId: '1234567890123' } });
  assert.equal(savedProperty.status, 200);
  assert.equal(savedProperty.data.revision, 1);
  assert.match(savedProperty.data.auditId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual((await call('property-read', { workspace: 'primary', nativeId: '987654321' })).data, { revision: 1, propertyId: '1234567890123', source: 'persisted' });
  const clearedProperty = await call('property-save', { workspace: 'primary', value: { expectedRevision: 1, propertyId: null } });
  assert.deepEqual({ revision: clearedProperty.data.revision, propertyId: clearedProperty.data.propertyId, source: clearedProperty.data.source }, { revision: 2, propertyId: null, source: 'persisted' });
  const beforeStale = await call('state');
  assert.equal((await call('property-save', { workspace: 'primary', value: { expectedRevision: 1, propertyId: '1234567890123' } })).data.error, 'configuration_changed');
  assert.equal((await call('state')).data.counts.propertyAudits, beforeStale.data.counts.propertyAudits);
  await call('arm-property-audit-failure');
  const auditFailure = await call('property-save', { workspace: 'primary', value: { expectedRevision: 2, propertyId: '1234567890123' } });
  assert.equal(auditFailure.status, 500);
  assert.equal(auditFailure.data.error, 'fixture_failure', 'the synthetic trigger fails the real D1 audit batch; it is not a normal stale-CAS conflict');
  const afterRollback = await call('property-read', { workspace: 'primary', nativeId: '1234567890123' });
  assert.deepEqual(afterRollback.data, { revision: 2, propertyId: null, source: 'persisted' }, 'an audit failure rolls the settings write back and persisted null suppresses native fallback');
  assert.equal((await call('state')).data.counts.propertyAudits, beforeStale.data.counts.propertyAudits, 'failed audit adds no audit row');

  await call('seed-grant', { hash: grants.analytics.hash, revision: 2, analytics: 0, experiments: 0, expiresAt: now + 30 * 86400000 });
  const ratesBeforeStaleGrant = (await call('state')).data.rates;
  const staleGrantWrite = await call('register', registration({ key: 7, route: '/contact', at: now + 31 * 60 * 1000, snapshot: '9' }));
  assert.equal(staleGrantWrite.data.error, 'invalid_document', 'a newly constructed descriptor still cannot register under a revoked Analytics revision');
  assert.deepEqual((await call('state')).data.rates, ratesBeforeStaleGrant, 'rejected stale grant does not consume the rate counter');
  const analyticsWithdrawal = await call('withdraw-analytics', { workspace: 'primary', hash: grants.analytics.hash, revision: 1, limit: 100 });
  assert.equal(analyticsWithdrawal.status, 200);
  assert.equal(analyticsWithdrawal.data.remaining, false);
  const finalState = await call('state');
  assert.equal(finalState.data.documents.length, 0, 'revoked analytics data is removed child-first in the bounded workspace cleanup');
  assert.equal(finalState.data.events.length, 0);
  assert.deepEqual(finalState.data.foreignCounts, { documents: 1, events: 1 }, 'primary cleanup never reports or removes another workspace document or event');
  const primaryBeforeForeignPrune = finalState.data.counts;
  await call('clock', { now: now + 31 * 86400000 });
  const foreignPruned = await call('prune', { workspace: 'foreign', limit: 100 });
  assert.deepEqual(foreignPruned.data, { deletedDocuments: 1, remaining: false }, 'bounded retention cleanup removes the expired foreign-workspace document and its child event');
  const secondForeignPrune = await call('prune', { workspace: 'foreign', limit: 100 });
  assert.deepEqual(secondForeignPrune.data, { deletedDocuments: 0, remaining: false });
  const afterForeignPrune = await call('state');
  assert.deepEqual(afterForeignPrune.data.foreignCounts, { documents: 0, events: 0 });
  assert.equal(afterForeignPrune.data.counts.propertyRows, primaryBeforeForeignPrune.propertyRows);
  assert.equal(afterForeignPrune.data.counts.propertyAudits, primaryBeforeForeignPrune.propertyAudits);
  const primaryPruned = await call('prune', { workspace: 'primary', limit: 100 });
  assert.deepEqual(primaryPruned.data, { deletedDocuments: 0, remaining: false });
});
