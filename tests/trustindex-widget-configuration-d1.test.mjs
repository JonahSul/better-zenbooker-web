import test from 'node:test';
import assert from 'node:assert/strict';

const baseUrl = process.env.TEST_TRUSTINDEX_CONFIG_D1_BASE_URL;
const token = process.env.TEST_TRUSTINDEX_CONFIG_D1_TOKEN;
const configPath = process.env.TEST_TRUSTINDEX_CONFIG_D1_CONFIG;
const persistPath = process.env.TEST_TRUSTINDEX_CONFIG_D1_PERSIST;
const databaseName = process.env.TEST_TRUSTINDEX_CONFIG_D1_NAME;
const workspaceId = process.env.TEST_TRUSTINDEX_CONFIG_D1_WORKSPACE;
const expectedFixture = {
  baseUrl: 'http://127.0.0.1:8802',
  token: 'local-trustindex-config-fixture-20261030',
  configPath: '.sites-runtime/trustindex-config-fixture/wrangler.json',
  persistPath: '.wrangler/trustindex-config-local-01',
  databaseName: 'site-creator-d1',
  workspaceId: 'trustindex-config-local-workspace',
};
const provided = [baseUrl, token, configPath, persistPath, databaseName, workspaceId].some(Boolean);
const configured = [baseUrl, token, configPath, persistPath, databaseName, workspaceId].every(Boolean);
if (provided && (!configured || baseUrl !== expectedFixture.baseUrl || token !== expectedFixture.token || configPath !== expectedFixture.configPath || persistPath !== expectedFixture.persistPath || databaseName !== expectedFixture.databaseName || workspaceId !== expectedFixture.workspaceId)) {
  throw new Error('Trustindex D1 tests require the exact dedicated loopback fixture contract.');
}
const enabled = configured;
const nativeReviewsUrl = 'https://www.trustindex.io/reviews/example.invalid';

async function call(path, { method = 'GET', body } = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: { Authorization: `Bearer ${token}`, Connection: 'close', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let data;
  try { data = await response.json(); } catch { throw new Error('Local Trustindex config fixture returned invalid JSON.'); }
  return { status: response.status, data };
}

test('real local D1 CAS audits exactly one concurrent winner and preserves explicit disable over native fallback', { skip: !enabled }, async () => {
  const initial = await call('/__qa/init');
  assert.equal(initial.status, 200);
  assert.equal(initial.data.ready, true);
  assert.ok(initial.data.migrationCount > 0);
  assert.equal(initial.data.tablesPresent, true);
  assert.equal(initial.data.settingRows, 0);
  assert.equal(initial.data.auditRows, 0);

  const state0 = await call('/__qa/state');
  assert.deepEqual(state0.data, {
    config: { revision: 0, enabled: true, badgeWidgetId: 'NativeBadge987', listWidgetId: 'NativeList654', reviewsUrl: nativeReviewsUrl, source: 'native' },
    rowCount: 0, audits: [], storedValueJson: null,
  }, 'read-only status uses the synthetic native fallback and creates neither a setting nor audit');

  const bodyA = { expectedRevision: 0, enabled: true, badgeWidgetId: 'FixtureBadge123', listWidgetId: 'FixtureList456', reviewsUrl: 'https://www.trustindex.io/reviews/fixture.invalid' };
  const bodyB = { expectedRevision: 0, enabled: true, badgeWidgetId: 'OtherBadge789', listWidgetId: 'OtherList012', reviewsUrl: 'https://www.trustindex.io/reviews/other.invalid' };
  const results = await Promise.all([
    call('/__qa/save', { method: 'POST', body: bodyA }),
    call('/__qa/save', { method: 'POST', body: bodyB }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const winner = results.find((result) => result.status === 200);
  assert.deepEqual(Object.keys(winner.data).sort(), ['auditId', 'badgeWidgetId', 'enabled', 'listWidgetId', 'revision', 'source']);
  assert.deepEqual({ revision: winner.data.revision, enabled: winner.data.enabled, source: winner.data.source }, { revision: 1, enabled: true, source: 'persisted' });
  assert.ok([bodyA.badgeWidgetId, bodyB.badgeWidgetId].includes(winner.data.badgeWidgetId));
  const winnerBody = winner.data.badgeWidgetId === bodyA.badgeWidgetId ? bodyA : bodyB;
  assert.equal(winner.data.listWidgetId, winnerBody.listWidgetId);

  let state = (await call('/__qa/state')).data;
  assert.deepEqual(state.config, { revision: 1, enabled: true, badgeWidgetId: winnerBody.badgeWidgetId, listWidgetId: winnerBody.listWidgetId, reviewsUrl: winnerBody.reviewsUrl, source: 'persisted' });
  assert.equal(state.rowCount, 1);
  assert.equal(state.audits.length, 1, 'the winning configuration CAS and audit insert commit together');
  assert.equal(state.audits[0].id, winner.data.auditId);
  assert.equal(state.audits[0].google_subject, 'verified-google-subject-fixture', 'actor is fixture-derived, not request supplied');
  assert.equal(state.audits[0].action, 'reviews.widget_configuration_save');
  assert.deepEqual(JSON.parse(state.audits[0].target), { workspaceId: 'trustindex-config-local-workspace', revision: 1, enabled: true, badgeWidgetId: winnerBody.badgeWidgetId, listWidgetId: winnerBody.listWidgetId, reviewsUrl: winnerBody.reviewsUrl });
  const stored = JSON.parse(state.storedValueJson);
  assert.deepEqual(Object.keys(stored).sort(), ['badgeWidgetId', 'enabled', 'listWidgetId', 'reviewsUrl', 'writeToken']);
  assert.ok(stored.writeToken);
  assert.equal(JSON.stringify(winner.data).includes(stored.writeToken), false, 'private CAS token is not returned');

  const beforeStale = state;
  assert.equal((await call('/__qa/save', { method: 'POST', body: { expectedRevision: 0, enabled: true, badgeWidgetId: 'StaleBadge123', listWidgetId: 'StaleList456', reviewsUrl: null } })).status, 409);
  state = (await call('/__qa/state')).data;
  assert.deepEqual(state, beforeStale, 'stale save changes neither settings nor audit history');

  const disabled = await call('/__qa/save', { method: 'POST', body: { expectedRevision: 1, enabled: false, badgeWidgetId: null, listWidgetId: null, reviewsUrl: null } });
  assert.equal(disabled.status, 200);
  assert.deepEqual({ revision: disabled.data.revision, enabled: disabled.data.enabled, badgeWidgetId: disabled.data.badgeWidgetId, listWidgetId: disabled.data.listWidgetId, reviewsUrl: disabled.data.reviewsUrl, source: disabled.data.source }, { revision: 2, enabled: false, badgeWidgetId: null, listWidgetId: null, reviewsUrl: null, source: 'persisted' });
  state = (await call('/__qa/state')).data;
  assert.deepEqual(state.config, { revision: 2, enabled: false, badgeWidgetId: null, listWidgetId: null, reviewsUrl: null, source: 'persisted' }, 'explicit persisted disable/null fallback beats native values');
  assert.equal(state.rowCount, 1);
  assert.equal(state.audits.length, 2);
  assert.equal(state.audits[1].id, disabled.data.auditId);
  assert.deepEqual(JSON.parse(state.audits[1].target), { workspaceId: 'trustindex-config-local-workspace', revision: 2, enabled: false, badgeWidgetId: null, listWidgetId: null, reviewsUrl: null });

  assert.equal((await call('/__qa/arm-audit-failure', { method: 'POST' })).status, 200);
  const beforeFailure = (await call('/__qa/state')).data;
  assert.equal((await call('/__qa/save', { method: 'POST', body: { expectedRevision: 2, enabled: true, badgeWidgetId: 'RollbackBadge123', listWidgetId: 'RollbackList456', reviewsUrl: null } })).status, 400);
  assert.deepEqual((await call('/__qa/state')).data, beforeFailure, 'audit failure rolls back the settings CAS');

  assert.equal((await call('/__qa/seed-invalid', { method: 'POST' })).status, 200);
  const invalidPersisted = await call('/__qa/state');
  assert.deepEqual(invalidPersisted.data.config, { revision: 3, enabled: false, badgeWidgetId: null, listWidgetId: null, reviewsUrl: null, source: 'persisted' }, 'invalid stored data fails closed instead of restoring native widget IDs or URL');
  assert.equal(invalidPersisted.data.audits.length, 2);
});
