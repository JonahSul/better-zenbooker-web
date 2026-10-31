import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const zod = require('zod/v3');

async function loadTs(relativePath, imports = {}) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (Object.hasOwn(imports, specifier)) return imports[specifier];
    if (specifier === './input-budget') return inputBudget;
    if (specifier === 'zod/v3') return zod;
    throw new Error(`Unexpected import from ${relativePath}: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}
const inputBudget = await loadTs('lib/input-budget.ts');

const providerCore = await loadTs('lib/zenbooker-core.ts');
const providerDiagnostic = await loadTs('lib/zenbooker-provider-diagnostic.ts');
const core = await loadTs('lib/zenbooker-api-core.ts', {
  './zenbooker-core': providerCore,
  './zenbooker-provider-diagnostic': providerDiagnostic,
});
const storeModule = await loadTs('lib/zenbooker-reconciliation-store.ts');
const serviceModule = await loadTs('lib/zenbooker-api-service.ts', {
  './zenbooker-api-core': core,
  './zenbooker-core': providerCore,
  './zenbooker-reconciliation-store': storeModule,
});

const requestKey = '3e77a78e-5ee2-4c2d-9259-977fb938e40a';
const otherRequestKey = '6d6554f2-5544-4c78-8892-e84cb9c15063';
const generation = 'fixture-generation-a';
const runtimeBase = {
  generation,
  credentialRevision: 7,
  presence: { present: true, source: 'encrypted_local' },
  locallyReadable: true,
  legacyGates: { readEnabled: false, writeEnabled: false, sendingEnabled: false },
};

function page({ resource = 'services', hasMore = false, nextCursor = null, count = 1 } = {}) {
  if (resource === 'jobs') {
    return {
      schemaStatus: 'unverified', count, hasMore, nextCursor,
      fieldTypes: {
        results: 'array', count: 'number', has_more: 'boolean', next_cursor: 'number',
        'results[].service_id': 'missing', 'results[].name': 'missing',
        'results[].is_visible': 'missing', 'results[].job_id': 'string',
        'results[].status': 'string', 'results[].timeslot': 'object',
      }, observations: [],
    };
  }
  return {
    schemaStatus: 'validated', count, hasMore, nextCursor,
    fieldTypes: {
      results: 'array', count: 'number', has_more: 'boolean', next_cursor: 'number',
      'results[].service_id': 'string', 'results[].name': 'string',
      'results[].is_visible': 'boolean', 'results[].job_id': 'missing',
      'results[].status': 'missing', 'results[].timeslot': 'missing',
    },
    observations: [{ id: 'svc_fixture_1', name: 'Fixture service', visible: true }],
  };
}

function makeStore() {
  const runs = new Map();
  const calls = [];
  return {
    calls,
    async start(input) {
      calls.push(['start', input]);
      const prior = [...runs.values()].find(run => run.requestKey === input.requestKey);
      if (prior) return prior;
      const run = {
        id: `${String(runs.size + 1).padStart(8, '0')}-0000-4000-8000-${String(runs.size + 1).padStart(12, '0')}`, kind: input.kind ?? 'refresh', resource: input.resource,
        revision: 1, status: 'ready', pages: 0, rows: 0, nextCursor: '0', lastCursor: null,
        window: input.window ?? null, filters: {}, historyComplete: false, lastError: null,
        generation: input.generation, credentialRevision: input.credentialRevision,
        requestKeys: [], cursorHistory: [], diagnostics: null, requestKey: input.requestKey,
      };
      runs.set(run.id, run);
      return run;
    },
    async get(id) { return runs.get(id); },
    async claim(id, expectedRevision, key, currentGeneration) {
      calls.push(['claim', id, expectedRevision, key, currentGeneration]);
      const run = runs.get(id);
      if (run.requestKeys.includes(key)) return { run, claimed: false };
      if (run.revision !== expectedRevision || run.generation !== currentGeneration) throw new Error('run_conflict');
      const claimed = { ...run, revision: run.revision + 1, status: 'running', requestKeys: [...run.requestKeys, key] };
      runs.set(id, claimed);
      return { run: claimed, claimed: true };
    },
    async commit(id, revision, key, currentGeneration, result) {
      calls.push(['commit', id, revision, key, currentGeneration, result]);
      const run = runs.get(id);
      if (run.revision !== revision || run.requestKeys.at(-1) !== key || run.generation !== currentGeneration) throw new Error('run_conflict');
      const next = {
        ...run,
        revision: run.revision + 1,
        status: result.schemaStatus !== 'validated' ? 'blocked' : result.hasMore ? 'partial' : 'ended',
        pages: run.pages + 1, rows: run.rows + result.count,
        lastCursor: run.nextCursor, nextCursor: result.nextCursor,
        lastError: result.schemaStatus !== 'validated' ? 'schema_unverified' : null,
        diagnostics: { schemaStatus: result.schemaStatus, count: result.count, hasMore: result.hasMore, fieldTypes: result.fieldTypes },
      };
      runs.set(id, next);
      return next;
    },
    async fail(id, revision, key, currentGeneration, errorCode) {
      calls.push(['fail', id, revision, key, currentGeneration, errorCode]);
      const run = runs.get(id);
      const safeErrors = ['network', 'timeout', 'http_rejected', 'invalid_response', 'unconfigured', 'cursor_invalid', 'credential_changed'];
      const diagnostics = arguments.length > 5 ? arguments[5] : undefined;
      const next = { ...run, revision: run.revision + 1, status: 'error', lastError: safeErrors.includes(errorCode) ? errorCode : 'unavailable', ...(diagnostics ? { diagnostics } : {}) };
      runs.set(id, next);
      return next;
    },
    async finishCheck(id, revision, key, currentGeneration, diagnostics) {
      calls.push(['finishCheck', id, revision, key, currentGeneration, diagnostics]);
      const run = runs.get(id);
      const next = { ...run, revision: revision + 1, status: 'ended', pages: 2, diagnostics };
      runs.set(id, next);
      return next;
    },
    async status(currentGeneration) {
      calls.push(['status', currentGeneration]);
      const rows = [...runs.values()].filter(run => run.generation === currentGeneration).reverse();
      return { lastCheck: rows.find(run => run.kind === 'check') ?? null, lastRun: rows.find(run => run.kind === 'refresh') ?? null, observationCount: 1 };
    },
  };
}

function service({ store = makeStore(), fetchPage, resolve = async () => ({ ...runtimeBase, client: { page: fetchPage } }), now = () => Date.parse('2026-10-30T12:00:00.000Z') } = {}) {
  return { api: new serviceModule.ZenbookerApiService(store, resolve, now), store };
}

test('status is network-free and keeps key presence/readability separate from existing booking gates', async () => {
  const store = makeStore();
  let pageCalls = 0;
  const api = new serviceModule.ZenbookerApiService(store, async () => ({
    ...runtimeBase, client: { page: async () => { pageCalls += 1; throw new Error('should not call provider'); } },
  }));
  const result = await api.status();
  assert.equal(pageCalls, 0);
  assert.equal(result.keyPresent, true);
  assert.equal(result.locallyReadable, true);
  assert.deepEqual(result.legacyGates, { readEnabled: false, writeEnabled: false, sendingEnabled: false });
  assert.equal(result.historyComplete, false);
  assert.equal(result.sourceMeaning.includes('not complete history'), true);
  assert.equal(JSON.stringify(result).includes(generation), false);
});

test('explicit check performs exactly one bounded GET per resource and stores only fixed diagnostics', async () => {
  const store = makeStore();
  const calls = [];
  const api = service({
    store,
    fetchPage: async (resource, input) => { calls.push({ resource, input }); return page({ resource }); },
  }).api;

  const run = await api.check({ requestKey });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.resource).sort(), ['jobs', 'services']);
  assert.deepEqual(calls.map(call => call.input.limit), [1, 1]);
  assert.equal(calls.every(call => call.input.cursor === '0'), true);
  const jobsCall = calls.find(call => call.resource === 'jobs');
  assert.equal(Date.parse(jobsCall.input.window.to) - Date.parse(jobsCall.input.window.from), 86_400_000);
  assert.equal(run.status, 'ended');
  assert.equal(run.pages, 2);
  assert.equal(Object.hasOwn(run, 'generation'), false);
  assert.equal(Object.hasOwn(run, 'credentialRevision'), false);
  assert.equal(Object.hasOwn(run, 'requestKeys'), false);
  assert.equal(JSON.stringify(run).includes('Fixture service'), false);
  assert.equal(JSON.stringify(run).includes('private@example'), false);
  const finished = store.calls.find(call => call[0] === 'finishCheck');
  assert.deepEqual(Object.keys(finished[5]).sort(), ['jobs', 'requestCount', 'services']);
  assert.equal(finished[5].requestCount, 2);
  const from = jobsCall.input.window.from;
  const to = jobsCall.input.window.to;
  assert.deepEqual(finished[5].services, {
    status: 'succeeded', schemaStatus: 'validated', outcome: 'validated', observedCount: 1, importedCount: 0,
    count: 1, hasMore: false, fieldTypes: page().fieldTypes,
    filters: { cursor: '0', limit: 1 },
  });
  assert.deepEqual(finished[5].jobs, {
    status: 'succeeded', schemaStatus: 'unverified', outcome: 'schema_unverified', observedCount: 1, importedCount: 0,
    count: 1, hasMore: false, fieldTypes: page({ resource: 'jobs' }).fieldTypes,
    window: { from, to },
    filters: { cursor: '0', limit: 1, created_after: from, created_before: to, sort_by: 'creation_date' },
  });
  assert.equal(JSON.stringify(finished[5]).includes('job_fixture_1'), false);
});

test('check retains the completed service result when job diagnostics fail and identifies the failed resource', async () => {
  const store = makeStore();
  const sentinel = 'RAW_JOB_SENTINEL_9c2a';
  const api = service({
    store,
    fetchPage: async (resource) => {
      if (resource === 'services') return page({ resource: 'services' });
      const error = new core.ApiDiagnosticError({
        stage: 'pagination_validation', code: 'invalid_response',
        fieldTypes: { results: 'array', count: 'number', has_more: 'boolean', next_cursor: 'missing', 'results[].created': 'string' },
      });
      error.message = sentinel;
      error.sentinel = sentinel;
      throw error;
    },
  }).api;

  const run = await api.check({ requestKey });
  assert.equal(run.status, 'error');
  assert.equal(run.lastError, 'invalid_response');
  assert.equal(run.pages, 0);
  assert.equal(run.rows, 0);
  assert.deepEqual(run.diagnostics, {
    requestCount: 2,
    failedResource: 'jobs',
    services: {
      status: 'succeeded', schemaStatus: 'validated', outcome: 'validated', observedCount: 1, importedCount: 0,
      count: 1, hasMore: false, fieldTypes: page().fieldTypes,
      filters: { cursor: '0', limit: 1 },
    },
    jobs: {
      status: 'failed', importedCount: 0,
      error: { code: 'invalid_response', stage: 'pagination_validation', fieldTypes: errorFieldTypes() },
      window: run.diagnostics.jobs.window,
      filters: run.diagnostics.jobs.filters,
    },
  });
  assert.equal(JSON.stringify(run).includes(sentinel), false);
  assert.equal(JSON.stringify(run).includes('RAW_JOB_SENTINEL'), false);
  assert.equal(JSON.stringify(run).includes('arbitrary'), false);
});

function errorFieldTypes() {
  return { results: 'array', count: 'number', has_more: 'boolean', next_cursor: 'missing', 'results[].created': 'string' };
}

test('refresh failure preserves prior pages, rows, cursor, and imports; transport has no invented field shape', async () => {
  const store = makeStore();
  const api = service({
    store,
    fetchPage: async (_resource, input) => input.cursor === '0'
      ? page({ hasMore: true, nextCursor: '40', count: 2 })
      : (() => { throw Object.assign(new Error('network'), { code: 'network', privateText: 'TRANSPORT_PRIVATE_SENTINEL' }); })(),
  }).api;
  const started = await api.refresh({ action: 'start', requestKey, resource: 'services' });
  const before = { pages: started.pages, rows: started.rows, nextCursor: started.nextCursor, lastCursor: started.lastCursor };
  const failed = await api.refresh({
    action: 'continue', requestKey: otherRequestKey, runId: started.id, expectedRunRevision: started.revision,
  });
  assert.equal(failed.status, 'error');
  assert.equal(failed.lastError, 'network');
  assert.deepEqual({ pages: failed.pages, rows: failed.rows, nextCursor: failed.nextCursor, lastCursor: failed.lastCursor }, before);
  assert.deepEqual(failed.diagnostics, {
    failedResource: 'services', importedCount: 0,
    error: { code: 'network' },
  });
  assert.equal(JSON.stringify(failed).includes('fieldTypes'), false);
  assert.equal(JSON.stringify(failed).includes('TRANSPORT_PRIVATE_SENTINEL'), false);
  assert.equal(store.calls.filter(call => call[0] === 'commit').length, 1, 'only the first successful page is committed');
});

test('typed HTTP rejections project only status and fixed classification, and request-key replay does not fetch again', async () => {
  const expected = [
    [100, 'other_http_rejection'], [301, 'redirect'], [401, 'unauthorized'], [403, 'forbidden'],
    [404, 'not_found'], [429, 'rate_limited'], [400, 'request_rejected'], [418, 'request_rejected'],
    [503, 'upstream_error'], [599, 'upstream_error'],
  ];
  let requestNumber = 100;
  for (const [status, classification] of expected) {
    const store = makeStore();
    let calls = 0;
    const api = service({
      store,
      fetchPage: async () => {
        calls += 1;
        const error = new providerCore.ProviderError('http_rejected', status);
        error.message = 'Bearer HTTP_PRIVATE_SENTINEL https://private.invalid/body';
        error.body = 'BODY_PRIVATE_SENTINEL';
        error.headers = { authorization: 'HEADER_PRIVATE_SENTINEL' };
        throw error;
      },
    }).api;
    const key = `00000000-0000-4000-8000-${String(requestNumber++).padStart(12, '0')}`;
    const failed = await api.refresh({ action: 'start', requestKey: key, resource: 'services' });
    assert.equal(failed.status, 'error');
    assert.deepEqual(failed.diagnostics, {
      failedResource: 'services', importedCount: 0,
      error: { code: 'http_rejected', httpStatus: status, classification },
    });
    const serialized = JSON.stringify(failed);
    for (const sentinel of ['HTTP_PRIVATE_SENTINEL', 'https://private.invalid', 'BODY_PRIVATE_SENTINEL', 'HEADER_PRIVATE_SENTINEL']) {
      assert.equal(serialized.includes(sentinel), false);
    }

    const replay = await api.refresh({ action: 'start', requestKey: key, resource: 'services' });
    assert.equal(calls, 1, `same-key replay for status ${status} must not retry the provider`);
    assert.equal(replay.id, failed.id);
    assert.equal(replay.revision, failed.revision);
  }
});

test('HTTP rejection classification handles absent or invalid status without exposing status values from other error codes', async () => {
  const cases = [undefined, 99, 600, '503', Number.NaN];
  let requestNumber = 200;
  for (const status of cases) {
    const api = service({
      fetchPage: async () => { throw new providerCore.ProviderError('http_rejected', status); },
    }).api;
    const key = `00000000-0000-4000-8000-${String(requestNumber++).padStart(12, '0')}`;
    const result = await api.refresh({ action: 'start', requestKey: key, resource: 'services' });
    assert.deepEqual(result.diagnostics.error, {
      code: 'http_rejected', httpStatus: null, classification: 'other_http_rejection',
    });
  }

  const otherApi = service({
    fetchPage: async () => { throw new providerCore.ProviderError('network', 503); },
  }).api;
  const other = await otherApi.refresh({
    action: 'start', requestKey: '00000000-0000-4000-8000-000000000299', resource: 'services',
  });
  assert.deepEqual(other.diagnostics.error, { code: 'network' });

  const untypedApi = service({
    fetchPage: async () => {
      const error = new Error('untyped provider failure');
      error.code = 'http_rejected';
      error.status = 503;
      throw error;
    },
  }).api;
  const untyped = await untypedApi.refresh({
    action: 'start', requestKey: '00000000-0000-4000-8000-000000000301', resource: 'services',
  });
  assert.deepEqual(untyped.diagnostics.error, { code: 'unavailable' });
});

test('services HTTP rejection still checks one bounded jobs page and imports nothing', async () => {
  const store = makeStore();
  const calls = [];
  const api = service({
    store,
    fetchPage: async (resource) => {
      calls.push(resource);
      throw new providerCore.ProviderError('http_rejected', 403);
    },
  }).api;
  const result = await api.check({ requestKey: '00000000-0000-4000-8000-000000000300' });
  assert.deepEqual(calls, ['services', 'jobs']);
  assert.equal(result.status, 'error');
  assert.equal(result.pages, 0);
  assert.equal(result.rows, 0);
  assert.deepEqual(result.diagnostics, {
    requestCount: 2,
    failedResource: 'services',
    services: {
      status: 'failed', importedCount: 0,
      error: { code: 'http_rejected', httpStatus: 403, classification: 'forbidden' },
      filters: { cursor: '0', limit: 1 },
    },
    jobs: {
      status: 'failed', importedCount: 0,
      error: { code: 'http_rejected', httpStatus: 403, classification: 'forbidden' },
      window: result.diagnostics.jobs.window,
      filters: result.diagnostics.jobs.filters,
    },
  });
});

test('opt-in provider diagnostic is persisted safely and same-key replay does not fetch again', async () => {
  const store = makeStore();
  const diagnostic = {
    contentTypeFamily: 'json', bodyFormat: 'json', rootType: 'object',
    reportedStatus: 401,
    fieldTypes: {
      code: 'missing', message: 'missing', error: 'object', 'error.code': 'string',
      'error.message': 'string', 'error.status': 'number', 'response.code': 'missing', 'response.message': 'missing',
    },
    observedCode: 'MISSING_PARAMETER', provenance: 'recognized_cross_endpoint_literal',
    category: 'parameter_validation', recognizedParameter: 'limit',
  };
  let pageCalls = 0;
  const api = service({
    store,
    fetchPage: async () => {
      pageCalls += 1;
      throw new core.ApiHttpDiagnosticError(400, diagnostic);
    },
  }).api;
  const key = '00000000-0000-4000-8000-000000000343';
  const failed = await api.refresh({ action: 'start', requestKey: key, resource: 'services' });
  assert.deepEqual(failed.diagnostics.error, {
    code: 'http_rejected', httpStatus: 400, classification: 'request_rejected',
    providerDiagnostic: diagnostic,
  });
  assert.equal(failed.diagnostics.error.httpStatus, 400);
  assert.equal(failed.diagnostics.error.providerDiagnostic.reportedStatus, 401);
  const serialized = JSON.stringify(failed);
  for (const sentinel of ['PRIVATE', 'Authorization: Bearer', 'https://']) assert.equal(serialized.includes(sentinel), false);

  const replay = await api.refresh({ action: 'start', requestKey: key, resource: 'services' });
  assert.equal(replay.id, failed.id);
  assert.equal(replay.revision, failed.revision);
  assert.equal(pageCalls, 1);
});

test('missing or unreadable key fails closed without provider traffic or a run', async () => {
  for (const runtime of [
    { ...runtimeBase, presence: { present: false, source: 'missing' } },
    { ...runtimeBase, locallyReadable: false },
  ]) {
    const store = makeStore();
    let calls = 0;
    const api = new serviceModule.ZenbookerApiService(store, async () => ({
      ...runtime, client: { page: async () => { calls += 1; return page(); } },
    }));
    await assert.rejects(api.check({ requestKey }), /unconfigured/);
    assert.equal(calls, 0);
    assert.equal(store.calls.some(call => call[0] === 'start'), false);
  }
});

test('refresh reads exactly one page per call and continuation uses the returned cursor without guessing', async () => {
  const store = makeStore();
  const calls = [];
  const api = service({
    store,
    fetchPage: async (resource, input) => {
      calls.push({ resource, input });
      return calls.length === 1
        ? page({ hasMore: true, nextCursor: '40', count: 2 })
        : page({ count: 1 });
    },
  }).api;

  const first = await api.refresh({ action: 'start', requestKey, resource: 'services' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].resource, 'services');
  assert.equal(calls[0].input.cursor, '0');
  assert.equal(first.status, 'partial');
  assert.equal(first.lastCursor, '0');
  assert.equal(first.nextCursor, '40');
  assert.equal(first.historyComplete, false);

  const second = await api.refresh({
    action: 'continue', requestKey: otherRequestKey, runId: first.id, expectedRunRevision: first.revision,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].input.cursor, '40');
  assert.equal(second.status, 'ended');
  assert.equal(second.nextCursor, null);
  assert.equal(second.rows, 3);
  assert.equal(second.historyComplete, false);
  assert.equal(calls.every(call => !call.input.url && !call.input.filters), true);
});

test('unverified job pages stop import and expose no job, customer, or amount values', async () => {
  const store = makeStore();
  const calls = [];
  const api = service({
    store,
    fetchPage: async (resource, input) => {
      calls.push({ resource, input });
      return page({ resource: 'jobs' });
    },
  }).api;
  const run = await api.refresh({
    action: 'start', requestKey, resource: 'jobs',
    window: { from: '2026-10-01T00:00:00Z', to: '2026-10-31T00:00:00Z' },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].resource, 'jobs');
  assert.deepEqual(calls[0].input.window, { from: '2026-10-01T00:00:00Z', to: '2026-10-31T00:00:00Z' });
  assert.equal(run.status, 'blocked');
  assert.equal(run.lastError, 'schema_unverified');
  assert.equal(run.rows, 1);
  assert.equal(store.calls.filter(call => call[0] === 'commit').length, 1);
  assert.deepEqual(store.calls.find(call => call[0] === 'commit')[5].observations, []);
});

test('same request key replay does not make another provider request', async () => {
  const store = makeStore();
  let calls = 0;
  const api = service({ store, fetchPage: async () => { calls += 1; return page(); } }).api;
  const first = await api.refresh({ action: 'start', requestKey, resource: 'services' });
  assert.equal(calls, 1);
  const replay = await api.refresh({ action: 'start', requestKey, resource: 'services' });
  assert.equal(calls, 1);
  assert.equal(replay.id, first.id);
  assert.equal(replay.revision, first.revision);
});

test('provider exception text is reduced to a fixed error code before readback', async () => {
  const store = makeStore();
  let calls = 0;
  const api = service({
    store,
    fetchPage: async () => { calls += 1; throw new Error('Bearer fake-secret provider-response-private-sentinel'); },
  }).api;
  const run = await api.refresh({ action: 'start', requestKey, resource: 'services' });
  assert.equal(calls, 1);
  assert.equal(run.status, 'error');
  assert.equal(run.lastError, 'unavailable');
  assert.equal(JSON.stringify(run).includes('fake-secret'), false);
  assert.equal(JSON.stringify(run).includes('private-sentinel'), false);
});

test('credential generation changing during a request prevents page commit', async () => {
  const store = makeStore();
  let resolveCalls = 0;
  let commits = 0;
  let failures = 0;
  const originalCommit = store.commit.bind(store);
  store.commit = async (...args) => { commits += 1; return originalCommit(...args); };
  const originalFail = store.fail.bind(store);
  store.fail = async (...args) => { failures += 1; return originalFail(...args); };
  const api = new serviceModule.ZenbookerApiService(store, async () => {
    resolveCalls += 1;
    return {
      ...runtimeBase,
      generation: resolveCalls === 1 ? generation : 'fixture-generation-b',
      client: { page: async () => page() },
    };
  });
  const result = await api.refresh({ action: 'start', requestKey, resource: 'services' });
  assert.equal(resolveCalls, 2, 'generation is rechecked after provider response');
  assert.equal(commits, 0);
  assert.equal(failures, 1);
  assert.equal(result.status, 'error');
  assert.equal(result.lastError, 'credential_changed');
});
