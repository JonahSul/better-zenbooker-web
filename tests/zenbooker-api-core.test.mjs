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

const booking = await loadTs('lib/zenbooker-core.ts');
const providerDiagnostic = await loadTs('lib/zenbooker-provider-diagnostic.ts');
const api = await loadTs('lib/zenbooker-api-core.ts', {
  './zenbooker-core': booking,
  './zenbooker-provider-diagnostic': providerDiagnostic,
});
const requestKey = '9e8b1c8b-3f24-4a95-9872-14b10e089e27';

test('API check and refresh inputs are strict, bounded, and do not accept caller URLs or filters', () => {
  assert.equal(api.apiCheckInputSchema.safeParse({ requestKey }).success, true);
  assert.equal(api.apiCheckInputSchema.safeParse({ requestKey, url: 'https://attacker.invalid' }).success, false);
  assert.equal(api.apiCheckInputSchema.safeParse({ requestKey, resource: 'customers' }).success, false);

  const start = {
    action: 'start', requestKey, resource: 'services',
  };
  assert.equal(api.apiRefreshInputSchema.safeParse(start).success, true);
  assert.equal(api.apiRefreshInputSchema.safeParse({ ...start, filters: { limit: 10000 } }).success, false);
  assert.equal(api.apiRefreshInputSchema.safeParse({ ...start, resource: 'customers' }).success, false);
  assert.equal(api.apiRefreshInputSchema.safeParse({
    action: 'start', requestKey, resource: 'jobs',
    window: { from: '2026-01-01T00:00:00Z', to: '2026-02-02T00:00:00Z' },
  }).success, false, 'job windows over 31 days must be rejected');
  assert.equal(api.apiRefreshInputSchema.safeParse({
    action: 'start', requestKey, resource: 'jobs',
    window: { from: '2026-01-01T00:00:00-07:00', to: '2026-01-02T00:00:00Z' },
  }).success, false, 'job windows must be explicitly UTC');
  assert.equal(api.apiRefreshInputSchema.safeParse({
    action: 'continue', requestKey, runId: 'not-a-uuid', expectedRunRevision: 1,
  }).success, false);
  assert.equal(api.apiRefreshInputSchema.safeParse({
    action: 'continue', requestKey, runId: 'e87e04d2-f91b-42b0-9b9a-9a9537bcba22', expectedRunRevision: 0,
  }).success, false, 'continuation must carry a positive CAS revision');
});

test('API page transport is fixed-origin GET with header-only bearer, manual redirect and no body', async () => {
  const calls = [];
  const client = new api.ZenbookerApiClient('fixture-zenbooker-secret-not-real', async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({
      count: 1, results: [{ service_id: 'svc_fixture_1', name: 'Fixture', is_visible: true }],
      has_more: false, next_cursor: null,
    });
  });

  await client.page('services', { cursor: '40', limit: 100 });

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(new URL(url).origin, 'https://api.zenbooker.com');
  assert.equal(new URL(url).searchParams.get('cursor'), '40');
  assert.equal(new URL(url).searchParams.get('limit'), '100');
  assert.equal(url.includes('fixture-zenbooker-secret-not-real'), false);
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.cache, 'no-store');
  assert.equal(init.body, undefined);
  assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-zenbooker-secret-not-real');
  assert.ok(init.signal instanceof AbortSignal);
});

test('page transport rejects redirects, oversized or malformed JSON without exposing response contents', async () => {
  let calls = 0;
  const redirected = new api.ZenbookerApiClient('fixture-secret-not-real', async (_url, init) => {
    calls += 1;
    assert.equal(init.redirect, 'manual');
    return new Response('provider-body-private-sentinel', {
      status: 302, headers: { Location: 'https://attacker.invalid/steal' },
    });
  });
  await assert.rejects(redirected.page('services', {}), (error) => {
    assert.equal(typeof error.code, 'string');
    assert.equal(String(error).includes('provider-body-private-sentinel'), false);
    assert.equal(String(error).includes('attacker.invalid'), false);
    return true;
  });
  assert.equal(calls, 1);

  for (const body of ['{not-json}', 'x'.repeat(300_000)]) {
    const client = new api.ZenbookerApiClient('fixture-secret-not-real', async () => new Response(body));
    await assert.rejects(client.page('services', {}), (error) => {
      assert.equal(typeof error.code, 'string');
      assert.equal(String(error).includes('x'.repeat(200)), false);
      assert.equal(String(error).includes('not-json'), false);
      return true;
    });
  }
});

test('provider body diagnostics are opt-in for GET rejections and do not change request shape', async () => {
  const body = JSON.stringify({
    error: { code: 'MISSING_PARAMETER', message: 'Missing required parameter: cursor', status: 401 },
    account: 'PRIVATE_ACCOUNT_SENTINEL',
    private_reason: 'PRIVATE_BODY_SENTINEL',
  });
  const makeResponse = () => new Response(body, {
    status: 400,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
  const requests = [];
  const defaultClient = new api.ZenbookerApiClient('fixture-secret-not-real', async (url, init) => {
    requests.push({ url: String(url), init });
    return makeResponse();
  });
  await assert.rejects(defaultClient.page('services', { cursor: '0', limit: 1 }), (error) => {
    assert.equal(error.code, 'http_rejected');
    assert.equal(error.status, 400);
    assert.equal(Object.hasOwn(error, 'providerDiagnostic'), false);
    return true;
  });

  const diagnosticClient = new api.ZenbookerApiClient('fixture-secret-not-real', async (url, init) => {
    requests.push({ url: String(url), init });
    return makeResponse();
  }, { rejectedResponseDiagnostics: true });
  await assert.rejects(diagnosticClient.page('services', { cursor: '0', limit: 1 }), (error) => {
    assert.ok(error instanceof api.ApiHttpDiagnosticError);
    assert.equal(error.code, 'http_rejected');
    assert.equal(error.status, 400);
    assert.deepEqual(error.providerDiagnostic, {
      contentTypeFamily: 'json', bodyFormat: 'json', rootType: 'object', reportedStatus: 401,
      fieldTypes: {
        code: 'missing', message: 'missing', error: 'object', 'error.code': 'string',
        'error.message': 'string', 'error.status': 'number', 'response.code': 'missing', 'response.message': 'missing',
      },
      observedCode: 'MISSING_PARAMETER',
      provenance: 'recognized_cross_endpoint_literal',
      category: 'parameter_validation', recognizedParameter: 'cursor',
    });
    const serialized = JSON.stringify(error.providerDiagnostic);
    assert.equal(serialized.includes('PRIVATE_ACCOUNT_SENTINEL'), false);
    assert.equal(serialized.includes('PRIVATE_BODY_SENTINEL'), false);
    assert.equal(String(error).includes('PRIVATE_BODY_SENTINEL'), false);
    return true;
  });

  assert.equal(requests.length, 2);
  for (const { url, init } of requests) {
    assert.equal(new URL(url).origin, 'https://api.zenbooker.com');
    assert.equal(new URL(url).pathname, '/v1/services');
    assert.equal(new URL(url).searchParams.get('cursor'), '0');
    assert.equal(new URL(url).searchParams.get('limit'), '1');
    assert.equal(url.includes('fixture-secret-not-real'), false);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.body, undefined);
    assert.deepEqual([...new Headers(init.headers).keys()], ['authorization', 'content-type']);
  }
});

test('concurrent opt-in rejected responses keep their diagnostics isolated', async () => {
  const messages = ['Unauthorized', 'limit must be an integer'];
  const client = new api.ZenbookerApiClient('fixture-secret-not-real', async () => {
    const message = messages.shift();
    return Response.json({ error: { message } }, { status: 400 });
  }, { rejectedResponseDiagnostics: true });
  const results = await Promise.all([
    client.page('services', { cursor: '0', limit: 1 }).catch((error) => error.providerDiagnostic),
    client.page('services', { cursor: '0', limit: 1 }).catch((error) => error.providerDiagnostic),
  ]);
  assert.equal(results[0].category, 'authentication');
  assert.equal(results[0].recognizedParameter, 'authorization');
  assert.equal(results[1].category, 'parameter_validation');
  assert.equal(results[1].recognizedParameter, 'limit');
});

test('page limits and resource names are bounded before transport', async () => {
  let calls = 0;
  const client = new api.ZenbookerApiClient('fixture-secret-not-real', async () => {
    calls += 1;
    return Response.json({ count: 0, results: [], has_more: false, next_cursor: null });
  });
  for (const [resource, input] of [
    ['customers', {}],
    ['services', { limit: 101 }],
    ['jobs', { limit: 0, window: { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' } }],
    ['services', { cursor: '00' }],
    ['services', { cursor: 'opaque' }],
    ['jobs', {}],
    ['services', { window: { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' } }],
  ]) {
    await assert.rejects(client.page(resource, input));
  }
  assert.equal(calls, 0);
});

test('provider cannot exceed the requested one-record discovery page size', async () => {
  let calls = 0;
  const client = new api.ZenbookerApiClient('fixture-secret-not-real', async (url) => {
    calls += 1;
    assert.equal(new URL(String(url)).searchParams.get('limit'), '1');
    return Response.json({
      count: 2, has_more: false, next_cursor: null,
      results: [
        { service_id: 'svc_fixture_1', name: 'Synthetic one', is_visible: true },
        { service_id: 'svc_fixture_2', name: 'Synthetic two', is_visible: true },
      ],
    });
  });

  await assert.rejects(client.page('services', { cursor: '0', limit: 1 }), (error) => {
    assert.equal(typeof error.code, 'string');
    assert.equal(String(error).includes('Synthetic'), false);
    return true;
  });
  assert.equal(calls, 1);
});

test('job discovery uses a recent-created window while refresh uses the documented scheduled-date window', async () => {
  const requests = [];
  const client = new api.ZenbookerApiClient('fixture-secret-not-real', async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json({ count: 0, results: [], has_more: false, next_cursor: null });
  });
  const window = { from: '2026-10-29T00:00:00Z', to: '2026-10-30T00:00:00Z' };

  await client.page('jobs', { cursor: '0', limit: 1, window, mode: 'discovery' });
  await client.page('jobs', { cursor: '40', limit: 100, window });

  const discovery = new URL(requests[0].url);
  assert.equal(discovery.pathname, '/v1/jobs');
  assert.equal(discovery.searchParams.get('created_after'), window.from);
  assert.equal(discovery.searchParams.get('created_before'), window.to);
  assert.equal(discovery.searchParams.get('sort_by'), 'creation_date');
  assert.equal(discovery.searchParams.get('cursor'), '0');
  assert.equal(discovery.searchParams.get('limit'), '1');
  assert.equal(discovery.searchParams.has('sort_order'), false);

  const refresh = new URL(requests[1].url);
  assert.equal(refresh.searchParams.get('start_date_min'), window.from);
  assert.equal(refresh.searchParams.get('start_date_max'), window.to);
  assert.equal(refresh.searchParams.get('sort_by'), 'start_time');
  assert.equal(refresh.searchParams.get('cursor'), '40');
  assert.equal(refresh.searchParams.get('limit'), '100');
  assert.equal(refresh.searchParams.has('created_after'), false);
  assert.equal(requests.every(item => item.init.method === 'GET' && item.init.body === undefined), true);
});

test('service observations are allowlisted while undocumented job shapes remain unverified and unimportable', () => {
  const services = api.inspectApiPage('services', {
    count: 1,
    has_more: false,
    next_cursor: null,
    results: [{
      service_id: 'svc_fixture_1', name: 'Fixture service', is_visible: true,
      private_price_sentinel: 'PRIVATE_PRICE_SENTINEL',
    }],
  });
  assert.equal(services.schemaStatus, 'validated');
  assert.equal(services.count, 1);
  assert.equal(services.hasMore, false);
  assert.equal(services.nextCursor, null);
  assert.deepEqual(services.observations, [{ id: 'svc_fixture_1', name: 'Fixture service', visible: true }]);
  assert.equal(JSON.stringify(services).includes('PRIVATE_PRICE_SENTINEL'), false);
  assert.deepEqual(Object.keys(services.fieldTypes).sort(), [
    'count', 'cursor', 'has_more', 'next_cursor', 'results', 'root', 'results[].canceled',
    'results[].created', 'results[].end_date', 'results[].end_time', 'results[].id',
    'results[].is_visible', 'results[].job_id', 'results[].name',
    'results[].service_id', 'results[].services', 'results[].start_date',
    'results[].start_time', 'results[].status', 'results[].timezone',
    'results[].timeslot', 'results[].timeslot.end', 'results[].timeslot.start',
    'results[].timeslot.type',
  ].sort());
  assert.equal(services.fieldTypes['results[].service_id'], 'string');
  assert.equal(services.fieldTypes['results[].is_visible'], 'boolean');
  assert.equal(services.fieldTypes['results[].job_id'], 'missing');
  assert.equal(services.fieldTypes['results[].id'], 'missing');
  assert.equal(services.fieldTypes['results[].timeslot.start'], 'missing');
  assert.equal(services.fieldTypes.root, 'object');
  assert.equal(services.fieldTypes.cursor, 'missing');
  assert.equal(services.fieldTypes['results[].created'], 'missing');

  const jobs = api.inspectApiPage('jobs', {
    count: 1,
    has_more: false,
    next_cursor: null,
    results: [{ job_id: 'job_fixture_1', customer: { email: 'private@example.invalid' }, total: 123.45 }],
  });
  assert.equal(jobs.schemaStatus, 'unverified');
  assert.equal(jobs.count, 1);
  assert.deepEqual(jobs.observations, []);
  const serialized = JSON.stringify(jobs);
  assert.equal(serialized.includes('private@example.invalid'), false);
  assert.equal(serialized.includes('123.45'), false);
  assert.equal(serialized.includes('job_fixture_1'), false);
});

test('pagination metadata validates count and uses the exact numeric next cursor', () => {
  const first = api.inspectApiPage('services', {
    count: 2, has_more: true, next_cursor: 80,
    results: [
      { service_id: 'svc_1', name: 'A', is_visible: true },
      { service_id: 'svc_2', name: 'B', is_visible: false },
    ],
  });
  assert.equal(first.count, 2);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextCursor, '80');
  assert.deepEqual(first.observations, [
    { id: 'svc_1', name: 'A', visible: true },
    { id: 'svc_2', name: 'B', visible: false },
  ]);

  for (const body of [
    { count: -1, has_more: true, next_cursor: 80, results: [] },
    { count: 1, has_more: true, next_cursor: null, results: [] },
    { count: 0, has_more: true, next_cursor: '80', results: [] },
    { count: 0, has_more: true, next_cursor: -1, results: [] },
    { count: 0, has_more: true, next_cursor: Number.MAX_SAFE_INTEGER + 1, results: [] },
    { count: 1, has_more: false, next_cursor: 90, results: [] },
    { count: 101, has_more: false, next_cursor: null, results: Array(101).fill({ service_id: 'svc', name: 'x', is_visible: true }) },
  ]) {
    assert.throws(() => api.inspectApiPage('services', body));
  }
});

test('invalid envelope evidence is fixed, type-only, and bounded to the first 100 rows', () => {
  const sentinel = 'RAW_PROVIDER_SENTINEL_7f3d';
  const invalid = {
    cursor: sentinel,
    results: Array.from({ length: 101 }, (_value, index) => ({
      created: index === 100 ? 987654 : '2026-10-30T00:00:00Z',
      arbitrary_private_key: sentinel,
    })),
    count: 101,
    has_more: true,
    // Missing next_cursor is the failure; `cursor` is also inspected safely.
  };

  assert.throws(() => api.inspectApiPage('services', invalid), (error) => {
    assert.equal(error.code, 'invalid_response');
    assert.deepEqual(error.diagnostic, {
      stage: 'envelope_validation',
      code: 'invalid_response',
      fieldTypes: {
        root: 'object',
        cursor: 'string',
        results: 'array',
        count: 'number',
        has_more: 'boolean',
        next_cursor: 'missing',
        'results[].service_id': 'missing',
        'results[].name': 'missing',
        'results[].is_visible': 'missing',
        'results[].job_id': 'missing',
        'results[].status': 'missing',
        'results[].id': 'missing',
        'results[].created': 'string',
        'results[].canceled': 'missing',
        'results[].timezone': 'missing',
        'results[].start_date': 'missing',
        'results[].end_date': 'missing',
        'results[].start_time': 'missing',
        'results[].end_time': 'missing',
        'results[].services': 'missing',
        'results[].timeslot': 'missing',
        'results[].timeslot.start': 'missing',
        'results[].timeslot.end': 'missing',
        'results[].timeslot.type': 'missing',
      },
    });
    const diagnostic = JSON.stringify(error.diagnostic);
    assert.equal(diagnostic.includes(sentinel), false);
    assert.equal(diagnostic.includes('987654'), false, 'row 101 is outside the inspection bound');
    assert.equal(diagnostic.includes('arbitrary_private_key'), false);
    return true;
  });

  for (const malformed of [
    { results: [], count: 0, has_more: false },
    { results: 'not-an-array', count: 0, has_more: false, next_cursor: null },
    { results: [], count: '0', has_more: false, next_cursor: null },
    { results: [], count: 0, has_more: 'false', next_cursor: null },
  ]) {
    assert.throws(() => api.inspectApiPage('services', malformed), error => {
      assert.equal(error.code, 'invalid_response');
      assert.ok(error.diagnostic);
      return true;
    });
  }
});
