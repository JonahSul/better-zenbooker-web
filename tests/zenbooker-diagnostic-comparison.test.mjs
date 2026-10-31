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
const apiCore = await loadTs('lib/zenbooker-api-core.ts', {
  './zenbooker-core': providerCore,
  './zenbooker-provider-diagnostic': providerDiagnostic,
});
const storeTypes = await loadTs('lib/zenbooker-reconciliation-store.ts');
const apiService = await loadTs('lib/zenbooker-api-service.ts', {
  './zenbooker-api-core': apiCore,
  './zenbooker-core': providerCore,
  './zenbooker-reconciliation-store': storeTypes,
});

const safeKeys = [
  'bodyFormat', 'category', 'contentTypeFamily', 'fieldTypes', 'observedCode',
  'provenance', 'recognizedParameter', 'reportedStatus', 'rootType',
];

function containsSensitiveText(value) {
  const json = JSON.stringify(value);
  for (const marker of [
    'PRIVATE_DIAGNOSTIC_SENTINEL', 'DO_NOT_PERSIST', 'secret-field-name',
    'https://private.invalid', 'raw provider rejection', 'Authorization: Bearer',
  ]) assert.equal(json.includes(marker), false, `diagnostic leaked ${marker}`);
}

test('bounded diagnostic parses JSON media and refuses to interpret JSON-looking plain text', async () => {
  const mislabeled = await providerDiagnostic.inspectRejectedResponse(new Response(JSON.stringify({
    error: { message: 'Missing required parameter: cursor.' },
    secret_field_name: 'DO_NOT_PERSIST',
  }), { status: 400, headers: { 'content-type': 'application/json' } }));
  assert.equal(mislabeled.contentTypeFamily, 'json');
  assert.equal(mislabeled.bodyFormat, 'json');
  assert.equal(mislabeled.rootType, 'object');
  assert.equal(mislabeled.category, 'parameter_validation');
  assert.equal(mislabeled.recognizedParameter, 'cursor');
  assert.equal(mislabeled.fieldTypes['error.message'], 'string');
  assert.deepEqual(Object.keys(mislabeled).sort(), [...safeKeys].sort());
  assert.equal(Object.hasOwn(mislabeled.fieldTypes, 'secret_field_name'), false);
  containsSensitiveText(mislabeled);

  const jsonLookingText = await providerDiagnostic.inspectRejectedResponse(new Response(JSON.stringify({ error: { message: 'Missing required parameter: cursor.' }, secret_field_name: 'DO_NOT_PERSIST' }), {
    status: 400, headers: { 'content-type': 'text/plain' },
  }));
  assert.equal(jsonLookingText.contentTypeFamily, 'text');
  assert.equal(jsonLookingText.bodyFormat, 'text');
  assert.equal(jsonLookingText.rootType, 'not_parsed');
  assert.equal(jsonLookingText.fieldTypes['error.message'], 'missing');
  assert.equal(jsonLookingText.category, 'unclassified');
  containsSensitiveText(jsonLookingText);

  const recognizedText = await providerDiagnostic.inspectRejectedResponse(new Response('  Unauthorized.  ', {
    status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' },
  }));
  assert.equal(recognizedText.contentTypeFamily, 'text');
  assert.equal(recognizedText.bodyFormat, 'text');
  assert.equal(recognizedText.category, 'authentication');
  assert.equal(recognizedText.recognizedParameter, 'authorization');
  assert.equal(recognizedText.rootType, 'not_parsed');
  containsSensitiveText(recognizedText);

  const unrecognizedText = await providerDiagnostic.inspectRejectedResponse(new Response(
    'Private account 7742 rejected: https://private.invalid/?token=PRIVATE_DIAGNOSTIC_SENTINEL',
    { status: 400, headers: { 'content-type': 'text/plain' } },
  ));
  assert.equal(unrecognizedText.category, 'unclassified');
  assert.equal(unrecognizedText.recognizedParameter, null);
  containsSensitiveText(unrecognizedText);
});

test('JSON diagnostic conflicts and malformed JSON stay unclassified and expose no raw text', async () => {
  const conflicts = await providerDiagnostic.inspectRejectedResponse(Response.json({
    code: 'MISSING_PARAMETER',
    message: 'Unauthorized',
    error: { code: 'OPERATION_ERROR', message: 'Missing required parameter: limit.' },
    private: 'PRIVATE_DIAGNOSTIC_SENTINEL',
  }, { status: 400 }));
  assert.equal(conflicts.observedCode, null);
  assert.equal(conflicts.provenance, null);
  assert.equal(conflicts.category, 'unclassified');
  assert.equal(conflicts.recognizedParameter, null);
  containsSensitiveText(conflicts);

  const malformedText = 'Unauthorized {"account":"PRIVATE_DIAGNOSTIC_SENTINEL"';
  const malformed = await providerDiagnostic.inspectRejectedResponse(new Response(malformedText, {
    status: 400, headers: { 'content-type': 'application/json' },
  }));
  assert.equal(malformed.contentTypeFamily, 'json');
  assert.equal(malformed.bodyFormat, 'invalid_json');
  assert.equal(malformed.rootType, 'not_parsed');
  assert.equal(malformed.category, 'unclassified', 'text fallback must match the entire trimmed body');
  containsSensitiveText(malformed);

  const malformedRecognized = await providerDiagnostic.inspectRejectedResponse(new Response('Unauthorized', {
    status: 400, headers: { 'content-type': 'application/json' },
  }));
  assert.equal(malformedRecognized.bodyFormat, 'invalid_json');
  assert.equal(malformedRecognized.category, 'authentication');
  assert.equal(malformedRecognized.fieldTypes.message, 'missing');
  containsSensitiveText(malformedRecognized);
});

test('reader enforces 8 KiB and 1 second bounds without awaiting cancellation', async () => {
  const exact = `{"message":"${'x'.repeat(8192 - Buffer.byteLength('{"message":""}'))}"}`;
  assert.equal(Buffer.byteLength(exact), 8192);
  const atLimit = await providerDiagnostic.inspectRejectedResponse(new Response(exact, {
    status: 400, headers: { 'content-type': 'application/json' },
  }));
  assert.equal(atLimit.bodyFormat, 'json');

  let oversizedCancelled = false;
  const oversized = await providerDiagnostic.inspectRejectedResponse({
    headers: new Headers({ 'content-type': 'application/json' }),
    body: { getReader: () => ({
      read: async () => ({ done: false, value: new Uint8Array(8193) }),
      cancel: () => { oversizedCancelled = true; return new Promise(() => {}); },
      releaseLock() {},
    }) },
  });
  assert.equal(oversized.bodyFormat, 'oversized');
  assert.equal(oversizedCancelled, true);

  let timedOutCancelled = false;
  const started = Date.now();
  const stalled = await providerDiagnostic.inspectRejectedResponse({
    headers: new Headers({ 'content-type': 'application/json' }),
    body: { getReader: () => ({
      read: () => new Promise(() => {}),
      cancel: () => { timedOutCancelled = true; return new Promise(() => {}); },
      releaseLock() {},
    }) },
  });
  assert.ok(Date.now() - started < 2500, 'diagnostic reader deadline is bounded');
  assert.equal(timedOutCancelled, true);
  assert.equal(stalled.bodyFormat, 'unavailable');
  containsSensitiveText(stalled);
});

const requestKey = 'a2d8a978-2ea4-4ab3-a24b-6f1111111111';
const generation = 'diagnostic-generation-a';
const fixedWindow = { from: '2026-10-29T12:00:00.000Z', to: '2026-10-30T12:00:00.000Z' };

function syntheticPage(resource) {
  return {
    schemaStatus: resource === 'services' ? 'validated' : 'unverified',
    count: 0, hasMore: false, nextCursor: null,
    fieldTypes: { results: 'array', count: 'number', cursor: 'number', has_more: 'boolean', next_cursor: 'null', 'results[].created': 'missing' },
    observations: [],
  };
}

function makeRunStore() {
  const runs = new Map();
  const calls = [];
  return {
    calls,
    async start(input) {
      calls.push(['start', input]);
      const existing = [...runs.values()].find(run => run.requestKey === input.requestKey);
      if (existing) return existing;
      const run = {
        id: '9aa5c4fc-b564-4ceb-89ec-5b1111111111', kind: 'check', resource: 'check',
        revision: 1, status: 'ready', pages: 0, rows: 0, nextCursor: '0', lastCursor: null,
        window: null, filters: {}, historyComplete: false, lastError: null,
        generation: input.generation, credentialRevision: input.credentialRevision,
        requestKeys: [], cursorHistory: [], diagnostics: null, requestKey: input.requestKey,
        createdAt: 1, updatedAt: 1,
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
    async finishCheck(id, revision, key, currentGeneration, diagnostics) {
      calls.push(['finishCheck', id, revision, key, currentGeneration, diagnostics]);
      const run = runs.get(id);
      const finished = { ...run, revision: revision + 1, status: 'ended', pages: 2, diagnostics, updatedAt: 2 };
      runs.set(id, finished);
      return finished;
    },
    async fail(id, revision, key, currentGeneration, errorCode, diagnostics) {
      calls.push(['fail', id, revision, key, currentGeneration, errorCode, diagnostics]);
      const run = runs.get(id);
      const failed = { ...run, revision: revision + 1, status: 'error', lastError: errorCode, diagnostics, updatedAt: 2 };
      runs.set(id, failed);
      return failed;
    },
  };
}

function makeRuntime({ responses, generationAt = () => generation, locallyReadableAt = () => true }) {
  const pageCalls = [];
  let resolveCount = 0;
  const resolve = async () => {
    const index = resolveCount++;
    return {
      generation: generationAt(index), credentialRevision: 3,
      presence: { present: true, source: 'encrypted_local' },
      locallyReadable: locallyReadableAt(index),
      legacyGates: { readEnabled: false, writeEnabled: false, sendingEnabled: false },
      client: { page: async (resource, input) => {
        pageCalls.push({ resource, input });
        const outcome = responses[resource]?.shift() ?? { page: syntheticPage(resource) };
        if (outcome.error) throw outcome.error;
        return outcome.page ?? syntheticPage(resource);
      } },
    };
  };
  return { resolve, pageCalls, get resolveCount() { return resolveCount; } };
}

function makeCheckService(runtime, store = makeRunStore()) {
  const now = () => Date.parse(fixedWindow.to);
  return { api: new apiService.ZenbookerApiService(store, runtime.resolve, now), store };
}

function assertNoImport(run) {
  assert.equal(run.pages, 0);
  assert.equal(run.rows, 0);
  assert.equal(run.diagnostics.services?.importedCount ?? 0, 0);
  assert.equal(run.diagnostics.jobs?.importedCount ?? 0, 0);
}

test('check persists both resource outcomes when services fails first, but preserves the first error', async () => {
  const sentinel = 'PRIVATE_DIAGNOSTIC_SENTINEL';
  const serviceError = new apiCore.ApiHttpDiagnosticError(400, await providerDiagnostic.inspectRejectedResponse(
    Response.json({ error: { message: 'Missing required parameter: cursor.' }, secret: sentinel }, { status: 400 }),
  ));
  serviceError.message = sentinel;
  const runtime = makeRuntime({ responses: {
    services: [{ error: serviceError }],
    jobs: [{ page: syntheticPage('jobs') }],
  } });
  const { api, store } = makeCheckService(runtime);
  const run = await api.check({ requestKey });

  assert.deepEqual(runtime.pageCalls.map(call => call.resource), ['services', 'jobs']);
  assert.equal(run.status, 'error');
  assert.equal(run.lastError, 'http_rejected');
  assert.equal(run.pages, 0);
  assert.equal(run.rows, 0);
  assert.equal(run.diagnostics.requestCount, 2);
  assert.equal(run.diagnostics.failedResource, 'services');
  assert.equal(run.diagnostics.services.status, 'failed');
  assert.equal(run.diagnostics.services.importedCount, 0);
  assert.equal(run.diagnostics.services.filters.cursor, '0');
  assert.equal(run.diagnostics.jobs.status, 'succeeded');
  assert.equal(run.diagnostics.jobs.importedCount, 0);
  assert.deepEqual(run.diagnostics.jobs.window, fixedWindow);
  assert.deepEqual(run.diagnostics.jobs.filters, {
    cursor: '0', limit: 1, created_after: fixedWindow.from,
    created_before: fixedWindow.to, sort_by: 'creation_date',
  });
  assert.equal(store.calls.filter(call => call[0] === 'fail').length, 1);
  assert.equal(store.calls.some(call => call[0] === 'finishCheck'), false);
  assertNoImport(run);
  containsSensitiveText(run);
});

test('check preserves the first failure when both resources fail and still records the second bounded outcome', async () => {
  const runtime = makeRuntime({ responses: {
    services: [{ error: new providerCore.ProviderError('http_rejected', 403) }],
    jobs: [{ error: new apiCore.ApiDiagnosticError({
      stage: 'envelope_validation', code: 'invalid_response',
      fieldTypes: { root: 'object', results: 'array', count: 'number', has_more: 'boolean', next_cursor: 'missing' },
    }) }],
  } });
  const { api, store } = makeCheckService(runtime);
  const run = await api.check({ requestKey });
  assert.deepEqual(runtime.pageCalls.map(call => call.resource), ['services', 'jobs']);
  assert.equal(run.lastError, 'http_rejected');
  assert.equal(run.diagnostics.failedResource, 'services');
  assert.equal(run.diagnostics.requestCount, 2);
  assert.equal(run.diagnostics.services.error.classification, 'forbidden');
  assert.equal(run.diagnostics.jobs.status, 'failed');
  assert.equal(run.diagnostics.jobs.error.code, 'invalid_response');
  assert.equal(run.diagnostics.jobs.error.stage, 'envelope_validation');
  assert.equal(store.calls.filter(call => call[0] === 'fail').length, 1);
  assert.equal(store.calls.some(call => call[0] === 'finishCheck'), false);
  assertNoImport(run);
  containsSensitiveText(run);
});

test('check records service success and job failure without committing a page or replacing its diagnostics', async () => {
  const runtime = makeRuntime({ responses: {
    services: [{ page: syntheticPage('services') }],
    jobs: [{ error: new providerCore.ProviderError('network') }],
  } });
  const { api, store } = makeCheckService(runtime);
  const run = await api.check({ requestKey });
  assert.deepEqual(runtime.pageCalls.map(call => call.resource), ['services', 'jobs']);
  assert.equal(run.lastError, 'network');
  assert.equal(run.diagnostics.requestCount, 2);
  assert.equal(run.diagnostics.failedResource, 'jobs');
  assert.equal(run.diagnostics.services.status, 'succeeded');
  assert.equal(run.diagnostics.jobs.status, 'failed');
  assert.equal(run.diagnostics.jobs.error.code, 'network');
  assert.deepEqual(run.diagnostics.jobs.window, fixedWindow);
  assert.equal(store.calls.filter(call => call[0] === 'fail').length, 1);
  assertNoImport(run);
});

test('check finishes only after both bounded requests succeed and records zero imports', async () => {
  const runtime = makeRuntime({ responses: {
    services: [{ page: syntheticPage('services') }],
    jobs: [{ page: syntheticPage('jobs') }],
  } });
  const { api, store } = makeCheckService(runtime);
  const run = await api.check({ requestKey });
  assert.equal(run.status, 'ended');
  assert.equal(run.diagnostics.requestCount, 2);
  assert.equal(Object.hasOwn(run.diagnostics, 'failedResource'), false);
  assert.equal(run.diagnostics.services.status, 'succeeded');
  assert.equal(run.diagnostics.jobs.status, 'succeeded');
  assert.equal(run.diagnostics.services.importedCount, 0);
  assert.equal(run.diagnostics.jobs.importedCount, 0);
  assert.equal(store.calls.filter(call => call[0] === 'finishCheck').length, 1);
  assert.equal(store.calls.some(call => call[0] === 'fail'), false);
  assert.deepEqual(runtime.pageCalls.map(call => call.resource), ['services', 'jobs']);
  assert.equal(run.pages, 2, 'the check records two observations, not imported provider rows');
});

test('credential change or loss after services prevents the jobs call and records a not-attempted reason', async () => {
  for (const scenario of [
    { reason: 'credential_changed', generationAt: index => index === 0 ? generation : 'generation-b', locallyReadableAt: () => true },
    { reason: 'unavailable', generationAt: () => generation, locallyReadableAt: index => index === 0 },
  ]) {
    const runtime = makeRuntime({
      responses: { services: [{ page: syntheticPage('services') }] },
      generationAt: scenario.generationAt,
      locallyReadableAt: scenario.locallyReadableAt,
    });
    const { api, store } = makeCheckService(runtime);
    const run = await api.check({ requestKey });
    assert.deepEqual(runtime.pageCalls.map(call => call.resource), ['services']);
    assert.equal(run.status, 'error');
    assert.equal(run.lastError, scenario.reason);
    assert.equal(run.diagnostics.requestCount, 1);
    assert.equal(run.diagnostics.failedResource, 'jobs');
    assert.equal(run.diagnostics.services.status, 'succeeded');
    assert.deepEqual(run.diagnostics.jobs, {
      status: 'not_attempted', importedCount: 0, reason: scenario.reason,
      filters: { cursor: '0', limit: 1, created_after: fixedWindow.from, created_before: fixedWindow.to, sort_by: 'creation_date' },
      window: fixedWindow,
    });
    assert.equal(store.calls.filter(call => call[0] === 'fail').length, 1);
    assertNoImport(run);
  }
});

test('check replay of a stored run makes no provider requests', async () => {
  const runtime = makeRuntime({ responses: {
    services: [{ page: syntheticPage('services') }],
    jobs: [{ page: syntheticPage('jobs') }],
  } });
  const { api } = makeCheckService(runtime);
  const first = await api.check({ requestKey });
  const callsAfterFirst = runtime.pageCalls.length;
  const replay = await api.check({ requestKey });
  assert.equal(callsAfterFirst, 2);
  assert.equal(runtime.pageCalls.length, callsAfterFirst);
  assert.equal(replay.id, first.id);
  assert.equal(replay.revision, first.revision);
});
