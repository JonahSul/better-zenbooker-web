import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { enabledModuleFixture } from './fixtures/module-config-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const zod = require('zod/v3');
const { env: bookingEnv, moduleConfig: bookingModules } = enabledModuleFixture('booking');

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
const providerPolicy = await loadTs('lib/provider-policy.ts', {
  'cloudflare:workers': { env: bookingEnv },
  './module-config': bookingModules,
});

// Compare only the transport contract from the pinned Zenbooker repository
// baseline (89de4d8): fixed URL, auth header, method, redirect, cache and body.
// The observation adapter intentionally adds a GET Content-Type header; it
// must not change the shared booking client's GET/POST/cancel behavior.
const provider = await loadTs('lib/zenbooker-core.ts');
const providerDiagnostic = await loadTs('lib/zenbooker-provider-diagnostic.ts');
const apiCore = await loadTs('lib/zenbooker-api-core.ts', {
  './zenbooker-core': provider,
  './zenbooker-provider-diagnostic': providerDiagnostic,
});
const fakeProject = 'request-parity-fixture-project';
const fakeKey = 'synthetic-request-parity-key';
const fakeCredentialStore = {
  statement(sql, ...bindings) {
    assert.equal(sql, 'SELECT revision FROM app_credential_state WHERE project_id=?');
    assert.deepEqual(bindings, [fakeProject]);
    return { first: async () => ({ revision: 3 }) };
  },
  presence: async () => ({ present: true, source: 'native' }),
  resolve: async () => ({ value: fakeKey }),
};
const server = await loadTs('lib/zenbooker-api-server.ts', {
  'cloudflare:workers': { env: { DB: {} } },
  './provider-policy': providerPolicy,
  './runtime-secrets': {
    credentialStore: () => fakeCredentialStore,
    secretRuntime: () => ({ SITE_OWNER_USER_ID: 'synthetic-owner', ZENBOOKER_API_KEY: fakeKey }),
    SITE_PROJECT_ID: fakeProject,
  },
  './booking-settings': {
    BookingSettingsStore: class { async read() { return { config: { readEnabled: false, writeEnabled: false, sendingEnabled: false } }; } },
    bookingProviderFingerprint: async () => 'synthetic-generation',
  },
  './zenbooker-api-core': apiCore,
  './zenbooker-reconciliation-store': { ZenbookerReconciliationStore: class {} },
  './zenbooker-api-service': { ZenbookerApiService: class {} },
  './admin-auth-server': { getGoogleAdmin: async () => null, readSmallBody: async () => '', rejected: () => new Response(null), safeJson: value => Response.json(value) },
});

const headersOf = init => new Headers(init.headers);

test('active runtime observation GET adds only JSON Content-Type and preserves pinned transport behavior', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (requests.length === 1) {
      return Response.json({
        error: { message: 'Invalid parameter cursor', status: 401 },
        private: 'PARITY_PRIVATE_SENTINEL',
      }, { status: 400 });
    }
    return Response.json({ ok: true });
  };

  try {
    // This is the actual runtime resolver, which constructs the active
    // observation client with rejected-response diagnostics enabled.
    const runtime = await server.resolveZenbookerApiRuntime();
    await assert.rejects(runtime.client.page('services', { cursor: '0', limit: 1 }), error => {
      assert.ok(error instanceof apiCore.ApiHttpDiagnosticError);
      assert.equal(error.code, 'http_rejected');
      assert.equal(error.status, 400, 'outer HTTP status remains authoritative');
      assert.equal(error.providerDiagnostic.reportedStatus, 401, 'body status remains a separate provider claim');
      assert.equal(error.providerDiagnostic.category, 'parameter_validation');
      assert.equal(JSON.stringify(error.providerDiagnostic).includes('PARITY_PRIVATE_SENTINEL'), false);
      return true;
    });

    // Exercise the shared legacy transport methods through the real client.
    const legacy = new provider.ZenbookerClient(fakeKey, globalThis.fetch);
    await legacy.request('/services?cursor=0&limit=1', 'GET');
    await legacy.request('/jobs', 'POST', { fixture: 'synthetic' });
    await legacy.cancel('job_fixture_1');

    assert.equal(requests.length, 4);
    const [observation, legacyGet, legacyPost, legacyCancel] = requests;
    for (const item of requests) {
      const url = new URL(item.url);
      assert.equal(url.origin, 'https://api.zenbooker.com');
      assert.equal(url.searchParams.has('key'), false);
      const headers = headersOf(item.init);
      assert.equal(headers.get('authorization'), `Bearer ${fakeKey}`);
      assert.equal(item.init.redirect, 'manual');
      assert.equal(item.init.cache, 'no-store');
      assert.ok(item.init.signal instanceof AbortSignal);
    }

    const observedUrl = new URL(observation.url);
    assert.equal(observedUrl.pathname, '/v1/services');
    assert.deepEqual([...observedUrl.searchParams.entries()], [['cursor', '0'], ['limit', '1']]);
    assert.equal(observation.init.method, 'GET');
    assert.equal(observation.init.body, undefined);
    assert.equal(headersOf(observation.init).get('content-type'), 'application/json');

    assert.equal(legacyGet.init.method, 'GET');
    assert.equal(legacyGet.init.body, undefined);
    assert.equal(headersOf(legacyGet.init).get('content-type'), null);
    assert.equal(new URL(legacyGet.url).pathname, '/v1/services');
    assert.equal(new URL(legacyGet.url).search, '?cursor=0&limit=1');

    assert.equal(legacyPost.init.method, 'POST');
    assert.equal(headersOf(legacyPost.init).get('content-type'), 'application/json');
    assert.equal(legacyPost.init.body, JSON.stringify({ fixture: 'synthetic' }));
    assert.equal(new URL(legacyPost.url).pathname, '/v1/jobs');

    assert.equal(legacyCancel.init.method, 'POST');
    assert.equal(legacyCancel.init.body, undefined);
    assert.equal(headersOf(legacyCancel.init).get('content-type'), null);
    assert.equal(new URL(legacyCancel.url).pathname, '/v1/jobs/job_fixture_1/cancel');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
