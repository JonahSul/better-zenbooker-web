import test from 'node:test';
import assert from 'node:assert/strict';

const base = process.env.TEST_ZENBOOKER_API_D1_BASE_URL ?? '';
const token = process.env.TEST_ZENBOOKER_API_D1_FIXTURE_TOKEN ?? '';
const config = process.env.TEST_ZENBOOKER_API_D1_CONFIG ?? '';
const persist = process.env.TEST_ZENBOOKER_API_D1_PERSIST ?? '';
const dbName = process.env.TEST_ZENBOOKER_API_D1_NAME ?? '';
const parsed = base ? new URL(base) : null;
const enabled = !!parsed && parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1'
  && parsed.port === '8797' && !!token
  && config.replaceAll('\\', '/') === '.sites-runtime/zenbooker-api-store-fixture/wrangler.json'
  && ['.wrangler/zenbooker-api-store-local-01', '.wrangler/zenbooker-api-store-local-02', '.wrangler/zenbooker-api-store-local-03', '.wrangler/zenbooker-api-store-local-04'].includes(persist.replaceAll('\\', '/'))
  && dbName === 'site-creator-d1';

if (base && !enabled) throw new Error('Zenbooker reconciliation D1 tests require the dedicated local fixture paths.');

async function call(body) {
  const response = await fetch(`${base}/__qa/store`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/json',
      'x-qa-zenbooker-api-store': token,
      connection: 'close',
    },
    body: JSON.stringify(body),
  });
  let result;
  try { result = await response.json(); }
  catch { throw new Error(`Local reconciliation fixture returned non-JSON (${response.status}).`); }
  return { status: response.status, result };
}

const suite = enabled ? test : test.skip;
const generation = 'local-gen-a';
const request = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function safePage({ schemaStatus = 'validated', id = 'svc_local_1', name = 'Synthetic service', hasMore = false, nextCursor = null, count = 1, observations } = {}) {
  return {
    schemaStatus,
    count,
    hasMore,
    nextCursor,
    fieldTypes: {
      results: 'array', count: 'number', has_more: 'boolean', next_cursor: 'number',
      'results[].service_id': schemaStatus === 'validated' ? 'string' : 'missing',
      'results[].name': schemaStatus === 'validated' ? 'string' : 'missing',
      'results[].is_visible': schemaStatus === 'validated' ? 'boolean' : 'missing',
      'results[].job_id': schemaStatus === 'unverified' ? 'string' : 'missing',
      'results[].status': schemaStatus === 'unverified' ? 'string' : 'missing',
      'results[].timeslot': schemaStatus === 'unverified' ? 'object' : 'missing',
    },
    observations: observations ?? (schemaStatus === 'validated' ? [{ id, name, visible: true }] : []),
  };
}

suite('real local D1 persists bounded API runs and only allowlisted service observations', async () => {
  const initial = await call({ op: 'init' });
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.result, { ready: true, runs: 0, observations: 0 });
  const baseline = await call({ op: 'inspect' });
  assert.equal(baseline.status, 200);
  assert.equal(baseline.result.runs, 0);
  assert.equal(baseline.result.observations, 0);
  assert.deepEqual(baseline.result.unrelatedDomainTables, ['appointments', 'customers', 'hosted_booking_references', 'inquiries']);

  const created = await call({
    op: 'start', requestKey: request(1), resource: 'services', generation,
    credentialRevision: 1,
  });
  assert.equal(created.status, 200);
  const firstRun = created.result.run;
  assert.match(firstRun.id, /^[0-9a-f-]{36}$/i);
  assert.equal(firstRun.status, 'ready');
  assert.equal(firstRun.nextCursor, '0');
  assert.equal(firstRun.historyComplete, false);
  assert.equal(Object.hasOwn(firstRun, 'generation'), false);
  assert.equal(Object.hasOwn(firstRun, 'credentialRevision'), false);
  assert.equal(Object.hasOwn(firstRun, 'requestKeys'), false);

  const replayStart = await call({
    op: 'start', requestKey: request(1), resource: 'services', generation,
    credentialRevision: 1,
  });
  assert.equal(replayStart.status, 200);
  assert.equal(replayStart.result.run.id, firstRun.id);
  assert.equal(replayStart.result.run.revision, firstRun.revision);

  const claimed = await call({
    op: 'claim', runId: firstRun.id, expectedRevision: firstRun.revision,
    requestKey: request(2), generation,
  });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.result.claimed, true);
  const claimRevision = claimed.result.run.revision;

  const firstCommit = await call({
    op: 'commit', runId: firstRun.id, claimRevision, requestKey: request(2), generation,
    page: safePage({ id: 'svc_local_1', name: 'Synthetic service one', hasMore: true, nextCursor: '50' }),
  });
  assert.equal(firstCommit.status, 200);
  assert.equal(firstCommit.result.run.status, 'partial');
  assert.equal(firstCommit.result.run.pages, 1);
  assert.equal(firstCommit.result.run.rows, 1);
  assert.equal(firstCommit.result.run.lastCursor, '0');
  assert.equal(firstCommit.result.run.nextCursor, '50');

  const stale = await call({
    op: 'claim', runId: firstRun.id, expectedRevision: firstRun.revision,
    requestKey: request(3), generation,
  });
  assert.equal(stale.status, 500, 'stale continuation must not be accepted');
  assert.deepEqual(stale.result, { error: 'fixture_operation_failed' });

  const continuation = await call({
    op: 'claim', runId: firstRun.id, expectedRevision: firstCommit.result.run.revision,
    requestKey: request(3), generation,
  });
  assert.equal(continuation.status, 200);
  assert.equal(continuation.result.claimed, true);
  const finalPage = await call({
    op: 'commit', runId: firstRun.id, claimRevision: continuation.result.run.revision,
    requestKey: request(3), generation,
    page: safePage({ id: 'svc_local_2', name: 'Synthetic service two' }),
  });
  assert.equal(finalPage.status, 200);
  assert.equal(finalPage.result.run.status, 'ended');
  assert.equal(finalPage.result.run.pages, 2);
  assert.equal(finalPage.result.run.rows, 2);
  assert.equal(finalPage.result.run.historyComplete, false);

  const replayClaim = await call({
    op: 'claim', runId: firstRun.id, expectedRevision: continuation.result.run.revision,
    requestKey: request(3), generation,
  });
  assert.equal(replayClaim.status, 200);
  assert.equal(replayClaim.result.claimed, false);
  assert.equal(replayClaim.result.run.revision, finalPage.result.run.revision);

  const db = await call({ op: 'inspect' });
  assert.equal(db.status, 200);
  assert.equal(db.result.runs, 1);
  assert.equal(db.result.observations, 2);
  assert.equal(db.result.otherRuns, 0);
  assert.equal(db.result.otherObservations, 0);
  assert.equal(db.result.sensitiveObservationMatches, 0);
  assert.equal(db.result.nonAllowlistedObservationCount, 0);
  assert.deepEqual(db.result.unrelatedDomainRowCounts, baseline.result.unrelatedDomainRowCounts);
  const readback = await call({ op: 'get', runId: firstRun.id });
  assert.equal(readback.status, 200);
  assert.equal(readback.result.run.status, 'ended');
  assert.equal(JSON.stringify(readback.result).includes(generation), false);
  assert.equal(JSON.stringify(readback.result).includes('requestKeys'), false);
});

suite('real local D1 blocks undocumented jobs and repeated cursors without importing observations', async () => {
  const requestKey = request(11);
  const made = await call({
    op: 'start', requestKey, resource: 'jobs', generation, credentialRevision: 1,
    window: { from: '2026-10-01T00:00:00Z', to: '2026-10-31T00:00:00Z' },
  });
  assert.equal(made.status, 200);
  const claimed = await call({ op: 'claim', runId: made.result.run.id, expectedRevision: made.result.run.revision, requestKey: request(12), generation });
  const blocked = await call({
    op: 'commit', runId: made.result.run.id, claimRevision: claimed.result.run.revision,
    requestKey: request(12), generation,
    page: safePage({ schemaStatus: 'unverified' }),
  });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.result.run.status, 'blocked');
  assert.equal(blocked.result.run.lastError, 'schema_unverified');
  assert.equal(blocked.result.run.historyComplete, false);

  const repeated = await call({ op: 'start', requestKey: request(13), resource: 'services', generation, credentialRevision: 1 });
  const repeatedClaim = await call({ op: 'claim', runId: repeated.result.run.id, expectedRevision: 1, requestKey: request(14), generation });
  const rejected = await call({
    op: 'commit', runId: repeated.result.run.id, claimRevision: repeatedClaim.result.run.revision,
    requestKey: request(14), generation,
    page: safePage({ id: 'svc_repeat', hasMore: true, nextCursor: '0' }),
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.result.run.status, 'error');
  assert.equal(rejected.result.run.lastError, 'cursor_invalid');
  const db = await call({ op: 'inspect' });
  assert.equal(db.result.observations, 2, 'blocked and repeated-cursor runs do not create imported observations');
});

suite('real local D1 marks noncanonical cursors as failure and rejects over-limit pages before commit', async () => {
  const baseline = await call({ op: 'inspect' });
  assert.equal(baseline.status, 200);
  const made = await call({ op: 'start', requestKey: request(60), resource: 'services', generation, credentialRevision: 1 });
  assert.equal(made.status, 200);
  const claimed = await call({ op: 'claim', runId: made.result.run.id, expectedRevision: made.result.run.revision, requestKey: request(61), generation });
  assert.equal(claimed.status, 200);
  const invalidCursor = await call({
    op: 'commit', runId: made.result.run.id, claimRevision: claimed.result.run.revision, requestKey: request(61), generation,
    page: safePage({ hasMore: true, nextCursor: '01' }),
  });
  assert.equal(invalidCursor.status, 200);
  assert.equal(invalidCursor.result.run.status, 'error');
  assert.equal(invalidCursor.result.run.lastError, 'cursor_invalid');
  assert.equal(invalidCursor.result.run.pages, 0);
  assert.equal(invalidCursor.result.run.rows, 0);
  const afterCursor = await call({ op: 'get', runId: made.result.run.id });
  assert.equal(afterCursor.result.run.status, 'error');
  assert.equal(afterCursor.result.run.revision, invalidCursor.result.run.revision);

  const tooMany = await call({ op: 'start', requestKey: request(62), resource: 'services', generation, credentialRevision: 1 });
  const tooManyClaim = await call({ op: 'claim', runId: tooMany.result.run.id, expectedRevision: tooMany.result.run.revision, requestKey: request(63), generation });
  const overLimit = await call({
    op: 'commit', runId: tooMany.result.run.id, claimRevision: tooManyClaim.result.run.revision, requestKey: request(63), generation,
    page: safePage({ count: 101, observations: [], hasMore: false }),
  });
  assert.equal(overLimit.status, 500);
  assert.deepEqual(overLimit.result, { error: 'fixture_operation_failed' });
  const afterLimit = await call({ op: 'get', runId: tooMany.result.run.id });
  assert.equal(afterLimit.result.run.status, 'running');
  assert.equal(afterLimit.result.run.revision, tooManyClaim.result.run.revision);

  const after = await call({ op: 'inspect' });
  assert.equal(after.result.observations, baseline.result.observations);
});

suite('real local D1 stops the ten-page/1000-object run at its hard bound', async () => {
  const made = await call({ op: 'start', requestKey: request(30), resource: 'services', generation, credentialRevision: 1 });
  assert.equal(made.status, 200);
  let run = made.result.run;
  for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
    const key = request(31 + pageIndex);
    const claimed = await call({ op: 'claim', runId: run.id, expectedRevision: run.revision, requestKey: key, generation });
    assert.equal(claimed.status, 200);
    assert.equal(claimed.result.claimed, true);
    const observations = Array.from({ length: 100 }, (_value, itemIndex) => ({
      id: `svc_cap_${String(pageIndex).padStart(2, '0')}_${String(itemIndex).padStart(3, '0')}`,
      name: 'Synthetic bounded service', visible: true,
    }));
    const committed = await call({
      op: 'commit', runId: run.id, claimRevision: claimed.result.run.revision, requestKey: key, generation,
      page: safePage({ count: 100, observations, hasMore: true, nextCursor: String(pageIndex + 1) }),
    });
    assert.equal(committed.status, 200);
    run = committed.result.run;
  }
  assert.equal(run.status, 'bounded');
  assert.equal(run.pages, 10);
  assert.equal(run.rows, 1000);
  assert.equal(run.historyComplete, false);
  const rejected = await call({ op: 'claim', runId: run.id, expectedRevision: run.revision, requestKey: request(50), generation });
  assert.equal(rejected.status, 500);
  assert.deepEqual(rejected.result, { error: 'fixture_operation_failed' });
  const db = await call({ op: 'inspect' });
  assert.equal(db.result.observations, 1002);
});

suite('real local D1 run ownership and credential revision guard prevent cross-workspace and stale commits', async () => {
  const before = await call({ op: 'inspect' });
  const made = await call({ op: 'start', requestKey: request(21), resource: 'services', generation, credentialRevision: 1 });
  assert.equal(made.status, 200);
  const foreign = await call({ op: 'get', workspace: 'other', runId: made.result.run.id });
  assert.equal(foreign.status, 500);
  assert.deepEqual(foreign.result, { error: 'fixture_operation_failed' });

  const claimed = await call({ op: 'claim', runId: made.result.run.id, expectedRevision: made.result.run.revision, requestKey: request(22), generation });
  assert.equal(claimed.status, 200);
  assert.deepEqual(await call({ op: 'rotate', revision: 2 }), { status: 200, result: { changed: true } });
  const staleCommit = await call({
    op: 'commit', runId: made.result.run.id, claimRevision: claimed.result.run.revision,
    requestKey: request(22), generation,
    page: safePage({ id: 'svc_must_not_persist', name: 'Synthetic stale credential service' }),
  });
  assert.equal(staleCommit.status, 500);
  const db = await call({ op: 'inspect' });
  assert.equal(db.result.observations, before.result.observations);
  assert.equal(db.result.otherRuns, 0);
  assert.equal(db.result.otherObservations, 0);
});

suite('credential revision read stays read-only when a workspace state row is absent', async () => {
  const result = await call({ op: 'missingCredentialRevision' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.result, { revision: null, before: 0, after: 0 });
});

suite('real local D1 persists only bounded failed-page diagnostics without advancing the run', async () => {
  const sentinel = 'PRIVATE_PROVIDER_VALUE_SENTINEL';
  const made = await call({
    op: 'start', requestKey: request(70), resource: 'services', generation, credentialRevision: 2,
  });
  assert.equal(made.status, 200);
  const claimed = await call({
    op: 'claim', runId: made.result.run.id, expectedRevision: made.result.run.revision,
    requestKey: request(71), generation,
  });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.result.claimed, true);
  const diagnostics = {
    failedResource: 'services', importedCount: 0,
    error: {
      code: 'invalid_response', stage: 'envelope_validation',
      fieldTypes: { root: 'object', cursor: 'missing', next_cursor: 'missing', 'results[].created': 'string' },
    },
  };
  const failed = await call({
    op: 'fail', runId: made.result.run.id, claimRevision: claimed.result.run.revision,
    requestKey: request(71), generation, errorCode: 'invalid_response', diagnostics,
  });
  assert.equal(failed.status, 200);
  assert.equal(failed.result.run.status, 'error');
  assert.equal(failed.result.run.lastError, 'invalid_response');
  assert.equal(failed.result.run.pages, 0);
  assert.equal(failed.result.run.rows, 0);
  assert.equal(failed.result.run.nextCursor, '0');
  assert.deepEqual(failed.result.run.diagnostics, diagnostics);
  assert.equal(JSON.stringify(failed.result).includes(sentinel), false);

  const readback = await call({ op: 'get', runId: made.result.run.id });
  assert.equal(readback.status, 200);
  assert.deepEqual(readback.result.run.diagnostics, diagnostics);
  assert.equal(readback.result.run.pages, 0);
  assert.equal(readback.result.run.rows, 0);
  assert.equal(readback.result.run.nextCursor, '0');
});

suite('real local D1 persists fixed HTTP rejection diagnostics before a fixture response failure', async () => {
  const before = await call({ op: 'inspect' });
  assert.equal(before.status, 200);
  const made = await call({
    op: 'start', requestKey: request(80), resource: 'services', generation, credentialRevision: 2,
  });
  assert.equal(made.status, 200);
  const claimed = await call({
    op: 'claim', runId: made.result.run.id, expectedRevision: made.result.run.revision,
    requestKey: request(81), generation,
  });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.result.claimed, true);
  assert.equal(claimed.result.run.status, 'running');
  assert.equal(claimed.result.run.pages, 0);
  assert.equal(claimed.result.run.rows, 0);
  assert.equal(claimed.result.run.nextCursor, '0');
  const diagnostics = {
    failedResource: 'services', importedCount: 0,
    error: {
      code: 'http_rejected', httpStatus: 403, classification: 'forbidden',
      providerDiagnostic: {
        contentTypeFamily: 'json', bodyFormat: 'json', rootType: 'object', reportedStatus: 401,
        fieldTypes: {
          code: 'missing', message: 'missing', error: 'object', 'error.code': 'string',
          'error.message': 'string', 'error.status': 'number', 'response.code': 'missing', 'response.message': 'missing',
        },
        observedCode: 'MISSING_PARAMETER', provenance: 'recognized_cross_endpoint_literal',
        category: 'parameter_validation', recognizedParameter: 'cursor',
      },
    },
  };
  const failed = await call({
    op: 'fail', runId: made.result.run.id, claimRevision: claimed.result.run.revision,
    requestKey: request(81), generation, errorCode: 'http_rejected', diagnostics,
  });
  assert.ok(
    failed.status === 200 || (failed.status === 500 && failed.result?.error === 'fixture_operation_failed'),
    'only the known local fixture failure response is accepted, and only after durable readback below',
  );

  const readback = await call({ op: 'get', runId: made.result.run.id });
  assert.equal(readback.status, 200);
  assert.equal(readback.result.run.status, 'error');
  assert.equal(readback.result.run.revision, 3);
  assert.equal(readback.result.run.lastError, 'http_rejected');
  assert.equal(readback.result.run.pages, 0);
  assert.equal(readback.result.run.rows, 0);
  assert.equal(readback.result.run.nextCursor, '0');
  assert.equal(readback.result.run.lastCursor, null);
  assert.deepEqual(readback.result.run.diagnostics, diagnostics);

  const after = await call({ op: 'inspect' });
  assert.equal(after.status, 200);
  assert.equal(after.result.runs, before.result.runs + 1);
  assert.equal(after.result.observations, before.result.observations);
  assert.equal(after.result.otherRuns, before.result.otherRuns);
  assert.equal(after.result.otherObservations, before.result.otherObservations);
  assert.deepEqual(after.result.unrelatedDomainRowCounts, before.result.unrelatedDomainRowCounts);
});
