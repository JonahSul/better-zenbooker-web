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
const authHelpers = {
  readSmallBody: async request => {
    const text = await request.text();
    if (text.length > 8192) throw new Error('body_too_large');
    return text;
  },
  safeJson: (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } }),
  rejected: (_request, message, status = 403) => Response.json({ error: message }, { status, headers: { 'Cache-Control': 'private, no-store' } }),
};
const credentialStateProbe = { statements: [], writes: 0, settingsReads: 0 };
const enabledModules = enabledModuleFixture('booking');
const providerPolicyFixture = { gatedFetch: (module, fetcher = fetch) => async (...args) => {
  await enabledModules.moduleConfig.assertModule(enabledModules.env, module);
  return fetcher(...args);
} };
const missingCredentialStore = {
  statement(sql, ...bindings) {
    credentialStateProbe.statements.push({ sql, bindings });
    return {
      first: async () => null,
      run: async () => { credentialStateProbe.writes += 1; throw new Error('unexpected write'); },
    };
  },
};
const server = await loadTs('lib/zenbooker-api-server.ts', {
  'cloudflare:workers': { env: {} },
  './runtime-secrets': { credentialStore: () => missingCredentialStore, secretRuntime: () => ({ SITE_OWNER_USER_ID: 'fixture-owner', ZENBOOKER_API_KEY: 'synthetic-key-never-real' }), SITE_PROJECT_ID: 'fixture-project' },
  './booking-settings': { BookingSettingsStore: class { async read() { credentialStateProbe.settingsReads += 1; throw new Error('must fail before booking settings'); } }, bookingProviderFingerprint: async () => 'fixture-fingerprint' },
  './zenbooker-api-core': core,
  './zenbooker-reconciliation-store': storeModule,
  './zenbooker-api-service': serviceModule,
  './provider-policy': providerPolicyFixture,
  './admin-auth-server': { ...authHelpers, getGoogleAdmin: async () => null },
});

const origin = 'https://admin.fixture.invalid';
function request(operation, { method = 'POST', url = `/api/admin/zenbooker/${operation}`, body = {}, requestOrigin = origin } = {}) {
  return new Request(new URL(url, origin), {
    method,
    headers: {
      ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}),
      ...(requestOrigin === null ? {} : { origin: requestOrigin }),
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
}

test('API runtime fails closed on missing credential state with a SELECT-only lookup', async () => {
  credentialStateProbe.statements.length = 0;
  credentialStateProbe.writes = 0;
  credentialStateProbe.settingsReads = 0;
  await assert.rejects(server.resolveZenbookerApiRuntime(), /credential_boundary_unavailable/);
  assert.deepEqual(credentialStateProbe.statements, [{
    sql: 'SELECT revision FROM app_credential_state WHERE project_id=?',
    bindings: ['fixture-project'],
  }]);
  assert.equal(credentialStateProbe.writes, 0);
  assert.equal(credentialStateProbe.settingsReads, 0);
});

test('protected Zenbooker API endpoints require verified administration, POST, HTTPS, same-origin, and query-free requests', async () => {
  const calls = [];
  const deps = {
    ownerId: 'fixture-owner',
    getAdmin: async () => null,
    service: {
      status: async () => { calls.push('status'); return { keyPresent: false }; },
      check: async () => { calls.push('check'); return { status: 'ended' }; },
      refresh: async () => { calls.push('refresh'); return { status: 'partial' }; },
    },
  };

  const unauthenticated = await server.zenbookerApiOwnerRoute(request('check', { body: { requestKey: '0c85487b-8daf-4072-a74b-f93d33ca0551' } }), 'check', deps);
  assert.equal(unauthenticated.status, 403);
  deps.getAdmin = async () => ({ siteUserId: 'synthetic-installation', subject: 'verified-google-admin' });

  for (const bad of [
    request('check', { method: 'GET' }),
    request('check', { requestOrigin: 'https://attacker.fixture.invalid' }),
    request('check', { requestOrigin: null }),
    request('check', { url: 'http://admin.fixture.invalid/api/admin/zenbooker/check', requestOrigin: 'http://admin.fixture.invalid' }),
    request('check', { url: '/api/admin/zenbooker/check?debug=1' }),
  ]) {
    const denied = await server.zenbookerApiOwnerRoute(bad, 'check', deps);
    assert.equal(denied.status, 403);
  }
  assert.deepEqual(calls, []);
});

test('protected route validates strict operation bodies before invoking the service and never returns cacheable data', async () => {
  const calls = [];
  const deps = {
    ownerId: 'fixture-owner',
    getAdmin: async () => ({ siteUserId: 'fixture-owner' }),
    service: {
      status: async () => { calls.push(['status']); return { keyPresent: true, lastRun: null }; },
      check: async input => { calls.push(['check', input]); return { id: 'fixture-run-id', status: 'ended' }; },
      refresh: async input => { calls.push(['refresh', input]); return { id: 'fixture-run-id', status: 'partial' }; },
    },
  };
  const invalid = await server.zenbookerApiOwnerRoute(request('check', { body: { requestKey: 'f3cd0757-03d4-4dbb-8c54-f2036994c3a7', url: 'https://attacker.invalid' } }), 'check', deps);
  assert.equal(invalid.status, 400);
  assert.equal(calls.length, 0);

  const status = await server.zenbookerApiOwnerRoute(request('status'), 'status', deps);
  assert.equal(status.status, 200);
  assert.equal(status.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await status.json(), { keyPresent: true, lastRun: null });

  const checkInput = { requestKey: 'f3cd0757-03d4-4dbb-8c54-f2036994c3a7' };
  const checked = await server.zenbookerApiOwnerRoute(request('check', { body: checkInput }), 'check', deps);
  assert.equal(checked.status, 200);
  assert.deepEqual(calls.at(-1), ['check', checkInput]);

  const refreshInput = {
    action: 'start', requestKey: '4a0a2fd3-b0c0-4a10-9bca-a9324eab00df', resource: 'jobs',
    window: { from: '2026-10-01T00:00:00Z', to: '2026-10-30T00:00:00Z' },
  };
  const refreshed = await server.zenbookerApiOwnerRoute(request('refresh', { body: refreshInput }), 'refresh', deps);
  assert.equal(refreshed.status, 200);
  assert.deepEqual(calls.at(-1), ['refresh', refreshInput]);
  assert.equal(calls.some(call => JSON.stringify(call).includes('attacker.invalid')), false);
});
