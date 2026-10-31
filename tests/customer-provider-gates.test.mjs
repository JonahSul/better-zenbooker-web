import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

async function loadCustomerApi({ disabledModules = ['booking', 'notifications'] } = {}) {
  const source = await readFile(path.join(root, 'lib/customer-api.ts'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const state = { moduleChecks: [], challenges: 0, emailCalls: 0, logoutCalls: 0, exports: 0, eraseCalls: 0 };
  const modules = {
    'zod/v3': require('zod/v3'),
    './admin-auth-core': {
      cookieValue: (request, name) => request.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1) ?? null,
      sha256: async value => value,
      randomOpaque: () => 'd'.repeat(64),
    },
    './admin-auth-server': {
      safeJson: (body, status = 200, headers = {}) => Response.json(body, { status, headers }),
      readSmallBody: async request => await new Response(request.body).text(),
      rejected: async (_request, message, status) => Response.json({ error: message }, { status }),
    },
    './customer-auth-core': {
      CUSTOMER_SESSION_COOKIE: '__Host-customer_session', CUSTOMER_BROWSER_COOKIE: '__Host-customer_browser',
      randomOpaque: () => 'e'.repeat(64), normalizeEmail: value => value.trim().toLowerCase(),
    },
    './customer-runtime': {
      customerStore: () => ({
        async beginChallenge() { state.challenges++; return { id: '10000000-0000-4000-8000-000000000001', code: '123456', expiresAt: Date.now() + 600000 }; },
        async invalidateChallenge() {}, async logout() { state.logoutCalls++; },
        async session() { return { id: 'customer-fixture', email: 'customer@example.test' }; },
        async export() { state.exports++; return { records: [] }; },
        async erase() { state.eraseCalls++; return { erased: true }; },
      }),
      async resolvedBookingRuntime() { return { sendingEnabled: true, emailToken: 'synthetic-token', emailAccountId: '0'.repeat(32), settings: { config: { emailFrom: 'owner@example.test' } } }; },
    },
    './customer-email': { async sendCustomerOtp() { state.emailCalls++; return { acceptance: 'queued' }; } },
    './module-config': { async assertModule(_env, module) { state.moduleChecks.push(module); if (disabledModules.includes(module)) throw new Error('module disabled'); } },
    'cloudflare:workers': { env: { DB: {}, INSTALLATION_ID: 'qa-installation' } },
  };
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (Object.hasOwn(modules, specifier)) return modules[specifier];
    throw new Error(`Unexpected customer API dependency: ${specifier}`);
  }, loaded, loaded.exports);
  return { api: loaded.exports, state };
}

function post(path, body, extra = {}) {
  return new Request(`https://app.example.test${path}`, {
    method: 'POST', headers: { origin: 'https://app.example.test', 'content-type': 'application/json', ...extra },
    body: JSON.stringify(body),
  });
}

test('customer OTP honors both booking and notification gates before challenge creation or email dispatch', async () => {
  for (const disabledModule of ['booking', 'notifications']) {
    const { api, state } = await loadCustomerApi({ disabledModules: [disabledModule] });
    const response = await api.customerAuthRoute('start', post('/api/customer/auth/start', { email: 'customer@example.test' }));
    assert.notEqual(response.status, 200);
    assert.ok(state.moduleChecks.includes(disabledModule), `gate should check ${disabledModule}`);
    assert.equal(state.challenges, 0, 'disabled provider must not create an OTP challenge');
    assert.equal(state.emailCalls, 0, 'disabled provider must make zero email calls');
  }
});

test('customer OTP dispatch occurs only after both module gates are ready', async () => {
  const { api, state } = await loadCustomerApi({ disabledModules: [] });
  const response = await api.customerAuthRoute('start', post('/api/customer/auth/start', { email: 'customer@example.test' }));
  assert.equal(response.status, 200);
  assert.deepEqual(state.moduleChecks, ['booking', 'notifications']);
  assert.equal(state.challenges, 1);
  assert.equal(state.emailCalls, 1);
});

test('customer logout, export, and local erase stay available independently of email gates', async () => {
  const { api, state } = await loadCustomerApi({ disabledModules: ['booking', 'notifications'] });
  assert.equal((await api.customerAuthRoute('logout', post('/api/customer/auth/logout', {}))).status, 200);
  assert.equal((await api.customerSessionRoute(post('/api/customer/session', { action: 'export', confirm: true }, { cookie: '__Host-customer_session=fixture' }))).status, 200);
  assert.equal((await api.customerSessionRoute(post('/api/customer/session', { action: 'erase_local', confirm: true }, { cookie: '__Host-customer_session=fixture' }))).status, 200);
  assert.equal(state.logoutCalls, 1);
  assert.equal(state.exports, 1);
  assert.equal(state.eraseCalls, 1);
  assert.equal(state.emailCalls, 0);
  assert.equal(state.moduleChecks.length, 0);
});
