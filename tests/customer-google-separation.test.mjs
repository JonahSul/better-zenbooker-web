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
const { env: customerApiEnv, moduleConfig: customerApiModules } = enabledModuleFixture('booking', 'notifications');
const googleCookie = '__Host-customer_google_session=' + 'c'.repeat(64);
const googleSessionProfile = { id: 'customer-row-matching-email', email: 'customer@gmail.com' };
const observedLegacyTokens = [];
const legacyStore = {
  async session(token) {
    observedLegacyTokens.push(token);
    return token === 'otp-session-fixture' ? googleSessionProfile : null;
  },
};

async function loadTs(relativePath, imports) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (Object.hasOwn(imports, specifier)) return imports[specifier];
    if (specifier === './input-budget') return inputBudget;
    if (specifier === 'zod/v3') return require(specifier);
    throw new Error(`Unexpected import from ${relativePath}: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}
const inputBudget = await loadTs('lib/input-budget.ts');

function cookieValue(request, name) {
  return request.headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
}

function request(path, cookie) {
  const headers = new Headers();
  if (cookie) headers.set('cookie', cookie);
  return new Request(new URL(path, 'https://demo.example.test'), { headers });
}

const safeJson = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } });
const rejected = (_request, error, status) => safeJson({ error }, status);
const customerApi = await loadTs('lib/customer-api.ts', {
  zod: require('zod/v3'),
  'cloudflare:workers': { env: customerApiEnv },
  './module-config': customerApiModules,
  './admin-auth-core': { cookieValue, sha256: async () => '0'.repeat(64) },
  './admin-auth-server': { safeJson, readSmallBody: async () => '', rejected },
  './customer-auth-core': {
    CUSTOMER_SESSION_COOKIE: '__Host-customer_session',
    CUSTOMER_BROWSER_COOKIE: '__Host-customer_browser',
    randomOpaque: () => '1'.repeat(64),
    normalizeEmail: email => email.trim().toLowerCase(),
  },
  './customer-runtime': {
    customerStore: () => legacyStore,
    resolvedBookingRuntime: async () => { throw new Error('not needed for identity checks'); },
  },
  './customer-email': { sendCustomerOtp: async () => { throw new Error('not called'); } },
});

const bookingApi = await loadTs('lib/booking-api.ts', {
  zod: require('zod/v3'),
  './appointment-presentation': { appointmentPresentation: () => ({}) },
  './experiment-runtime': { inquiryAttribution: async () => null },
  './admin-auth-server': { safeJson, rejected, readSmallBody: async () => '' },
  './admin-auth-core': { sha256: async () => '0'.repeat(64) },
  './customer-auth-core': { randomOpaque: () => '1'.repeat(64) },
  './customer-api': customerApi,
  './customer-runtime': {
    bookingStore: () => { throw new Error('appointment store must not be touched without legacy OTP identity'); },
    resolvedBookingRuntime: async () => { throw new Error('provider runtime must not be touched without legacy OTP identity'); },
  },
  './booking-store': {
    bookingContextInput: require('zod/v3').z.object({}),
    bookingConfirmation: require('zod/v3').z.object({}),
    appointmentChange: require('zod/v3').z.object({}),
  },
});

async function loadAdminAuthServer() {
  return loadTs('lib/admin-auth-server.ts', {
    './admin-auth-diagnostic': {
      AdminTokenExchangeError: class AdminTokenExchangeError extends Error {},
      encodeAdminAuthDiagnostic: () => '',
      unavailableDiagnostic: () => null,
      oauthError: () => 'other',
    },
    './admin-outcome': { knownAdminOutcome: () => false },
    './runtime-secrets': {
      credentialStore: () => ({}),
      resolveAdminOidcConfig: async () => ({ clientId: 'admin.apps.googleusercontent.com', clientSecret: 'synthetic-admin-secret' }),
      adminConfigFingerprint: async () => 'a'.repeat(64),
      SITE_PROJECT_ID: 'synthetic-workspace',
    },
    'drizzle-orm': { and: () => ({}), eq: () => ({}), gt: () => ({}), lte: () => ({}) },
    'next/headers': { headers: async () => new Headers() },
    '../app/chatgpt-auth': { getChatGPTUser: async () => ({ userId: 'synthetic-sites-user' }) },
    '../db': { getDb: () => { throw new Error('Admin DB must not be queried without the Admin cookie'); } },
    '../db/schema': { adminOauthStates: {}, adminSessions: {}, adminAudit: {} },
    './admin-auth-core': {
      exchangeAdminCode: async () => '', adminAuthorizationUrl: () => '', allowedAdminEmail: () => true,
      cookieValue, randomOpaque: () => '2'.repeat(64), sha256: async () => '3'.repeat(64), verifyGoogleAdminToken: async () => ({}),
    },
    jose: { decodeJwt: () => ({}) },
  });
}
const adminAuth = await loadAdminAuthServer();

test('Google prefill session cookie cannot authenticate legacy customer session or appointment routes by matching email', async () => {
  observedLegacyTokens.length = 0;
  const googleOnly = request('/api/customer/session', googleCookie);
  assert.equal(await customerApi.customerIdentity(googleOnly), null);
  assert.deepEqual(observedLegacyTokens, [null], 'legacy session lookup receives no token from the Google cookie');

  const status = await customerApi.customerSessionRoute(googleOnly);
  assert.deepEqual(await status.json(), { authenticated: false });
  assert.equal(status.status, 200);

  const appointments = await bookingApi.appointmentsRoute('list', request('/api/appointments', googleCookie));
  assert.equal(appointments.status, 401);
  assert.deepEqual(await appointments.json(), { error: 'Customer sign-in required.' });

  const admin = await adminAuth.getGoogleAdmin(request('/api/admin/tools', googleCookie));
  assert.equal(admin, null, 'customer Google session does not satisfy the distinct Admin cookie/session check');
});

test('existing email OTP session continues to resolve the legacy customer relationship', async () => {
  observedLegacyTokens.length = 0;
  const result = await customerApi.customerIdentity(request('/api/customer/session', '__Host-customer_session=otp-session-fixture'));
  assert.deepEqual(result, googleSessionProfile);
  assert.deepEqual(observedLegacyTokens, ['otp-session-fixture']);

  const adminCookieOnly = await customerApi.customerIdentity(request('/api/customer/session', '__Host-admin_session=' + 'a'.repeat(64)));
  assert.equal(adminCookieOnly, null);
});
