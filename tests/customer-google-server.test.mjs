import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { enabledModuleFixture } from './fixtures/module-config-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { env: googleProviderEnv, moduleConfig: googleProviderModules } = enabledModuleFixture('google');
const origin = 'https://demo.example.test';
const clientId = 'customer-route-qa.apps.googleusercontent.com';
const fixedConfig = { clientId, clientSecret: 'synthetic-google-secret', fingerprint: 'a'.repeat(64), revision: 7 };
const identity = { subject: 'synthetic-google-subject', name: 'Customer Fixture', email: 'customer@gmail.com', expiresAt: Date.now() + 900_000 };
const knownSession = 'c'.repeat(64);
const knownBrowser = 'd'.repeat(64);
const nonce = 'e'.repeat(64);
const verifier = 'synthetic-pkce-verifier-long-enough-for-the-route-fixture-0123456789';
const hostedFixtureUrl = 'https://booking.example.test/checkout';
const hostedFixtureServiceId = 'fixture-service-123';
let opaqueSequence = 10;

process.env.NEXT_PUBLIC_HOSTED_BOOKING_URL = hostedFixtureUrl;
process.env.NEXT_PUBLIC_HOSTED_SERVICE_IDS = hostedFixtureServiceId;
process.env.NEXT_PUBLIC_BUSINESS_SOURCE_URL = 'https://business.example.test/services';

function cookieValue(request, name) {
  return request.headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
}

async function sha256(value) {
  const digest = new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function randomOpaque() {
  opaqueSequence += 1;
  return opaqueSequence.toString(16).padStart(64, '0');
}

async function loadTs(relativePath, imports) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((specifier) => {
    if (Object.hasOwn(imports, specifier)) return imports[specifier];
    if (specifier === 'zod/v3' || specifier === 'jose') return require(specifier);
    throw new Error(`Unexpected import from ${relativePath}: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const hostedCore = await loadTs('lib/hosted-booking-core.ts', { zod: require('zod/v3') });
const coreSource = await readFile(path.join(root, 'lib/customer-google-core.ts'), 'utf8');
const coreJs = ts.transpileModule(coreSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const coreModule = { exports: {} };
new Function('require', 'module', 'exports', coreJs)((specifier) => {
  if (specifier === 'zod/v3' || specifier === 'jose') return require(specifier);
  if (specifier === './site-config') return { DEMO_ORIGIN: origin };
  if (specifier === './hosted-booking-core') return hostedCore;
  throw new Error(`Unexpected customer core import: ${specifier}`);
}, coreModule, coreModule.exports);
const customerCore = coreModule.exports;

const transactions = new Map();
let currentSession = null;
let consumeCalls = 0;
let issueCalls = 0;
let revokeCalls = [];
let decorateCalls = [];
let nextResolveConfigs = null;
let consumeIntentCalls = 0;
let lastIntentReturnTo = 'book';
let lastBrowserHash = null;
const revokedFamilies = new Set();
class CustomerGoogleFamilyRevokedError extends Error {}

const fakeStore = {
  now: () => Date.now(),
  async createState(browserHash, input, configFingerprint) {
    if (revokedFamilies.has(browserHash)) throw new CustomerGoogleFamilyRevokedError('Customer sign-in unavailable');
    lastBrowserHash = browserHash;
    const normalized = customerCore.normalizeCustomerGoogleConnect(
      typeof input === 'string' ? { returnTo: input } : input,
    );
    const transaction = {
      state: randomOpaque(),
      nonce,
      verifier,
      browserHash,
      purpose: normalized.purpose,
      returnContext: normalized.returnContext,
      returnTo: normalized.returnTo,
      visitRef: normalized.visitRef ?? null,
      configFingerprint,
      consumed: false,
    };
    transactions.set(transaction.state, transaction);
    return { state: transaction.state, nonce: transaction.nonce, verifier: transaction.verifier };
  },
  async consumeState(rawState, browserHash, fingerprint) {
    consumeCalls += 1;
    const transaction = transactions.get(rawState);
    if (!transaction || transaction.consumed || transaction.browserHash !== browserHash || transaction.configFingerprint !== fingerprint) return null;
    transaction.consumed = true;
    if (transaction.revoked) return null;
    lastIntentReturnTo = transaction.returnTo;
    return {
      stateHash: await sha256(rawState),
      nonceHash: await sha256(transaction.nonce),
      verifier: transaction.verifier,
      purpose: transaction.purpose,
      returnContext: transaction.returnContext,
      returnTo: transaction.returnTo,
      visitRef: transaction.visitRef,
      expiresAt: Date.now() + 600_000,
    };
  },
  async issueSession(value, fingerprint, expectedConfigRevision, stateHash) {
    issueCalls += 1;
    assert.deepEqual(value, identity);
    assert.equal(fingerprint, fixedConfig.fingerprint);
    assert.equal(expectedConfigRevision, fixedConfig.revision);
    assert.equal(typeof stateHash, 'string');
    if (revokedFamilies.has(lastBrowserHash)) throw new CustomerGoogleFamilyRevokedError('Customer sign-in unavailable');
    currentSession = { token: knownSession, identity: value, fingerprint, expiresAt: Math.min(value.expiresAt, Date.now() + 3_600_000), intentReturnTo: lastIntentReturnTo, intentExpiresAt: Math.min(value.expiresAt, Date.now() + 300_000), intentConsumed: false, browserHash: lastBrowserHash, revoked: false };
    return { token: currentSession.token, expiresAt: currentSession.expiresAt };
  },
  async session(token, fingerprint) {
    if (!currentSession || currentSession.revoked || token !== currentSession.token || fingerprint !== currentSession.fingerprint || currentSession.expiresAt <= Date.now()) return null;
    return { ...currentSession.identity, expiresAt: currentSession.expiresAt, prefillPending: !currentSession.intentConsumed && currentSession.intentExpiresAt > Date.now(), prefillReturnTo: currentSession.intentReturnTo };
  },
  async consumePrefillIntent(token, fingerprint, returnTo) {
    consumeIntentCalls += 1;
    if (!currentSession || currentSession.revoked || token !== currentSession.token || fingerprint !== currentSession.fingerprint || currentSession.expiresAt <= Date.now()) return false;
    if (currentSession.intentConsumed || currentSession.intentExpiresAt <= Date.now() || currentSession.intentReturnTo !== returnTo) return false;
    currentSession.intentConsumed = true;
    return true;
  },
  async revoke(token, browserHash) {
    revokeCalls.push({ token, browserHash });
    const families = new Set([browserHash, currentSession?.token === token ? currentSession.browserHash : null].filter(Boolean));
    for (const family of families) revokedFamilies.add(family);
    if (currentSession && (currentSession.token === token || families.has(currentSession.browserHash))) currentSession.revoked = true;
    for (const transaction of transactions.values()) if (families.has(transaction.browserHash)) { transaction.consumed = true; transaction.revoked = true; }
  },
};

async function loadServer() {
  const source = await readFile(path.join(root, 'lib/customer-google-server.ts'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  const imports = {
    'cloudflare:workers': { env: { ...googleProviderEnv, DB: null } },
    'zod/v3': require('zod/v3'),
    './provider-policy': await loadTs('lib/provider-policy.ts', {
      'cloudflare:workers': { env: googleProviderEnv },
      './module-config': googleProviderModules,
    }),
    './encrypted-value': { validEncryptionKey: value => typeof value === 'string' && value.length > 0 },
    './support-api': { supportVisitor: async () => null },
    jose: require('jose'),
    zod: require('zod/v3'),
    './admin-auth-core': { cookieValue, randomOpaque, sha256, allowedAdminEmail: () => false },
    './admin-auth-server': { readSmallBody: async request => {
      const reader = request.body?.getReader();
      if (!reader) return '';
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 8192) { await reader.cancel(); throw new Error('Body too large'); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return new TextDecoder().decode(bytes);
    } },
    './runtime-secrets': {
      resolveAdminOidcConfig: async () => ({ clientId, clientSecret: fixedConfig.clientSecret }),
      adminConfigFingerprint: async () => fixedConfig.fingerprint,
      secretRuntime: () => ({ APP_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 0x53).toString('base64') }),
      SITE_PROJECT_ID: 'synthetic-workspace',
    },
    './customer-google-store': { CustomerGoogleStore: class {}, CustomerGoogleFamilyRevokedError },
    './customer-account-store': { CustomerAccountStore: class {} },
    './customer-google-core': customerCore,
    './hosted-offering-selection': { resolveHostedOffering: async () => ({ providerServiceId: null }) },
    './hosted-booking-api': { hostedHandoffRoute: async () => new Response('{}', { status: 200 }) },
    './purpose-consent-server': { currentAnalyticsGrant: async () => null },
  };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (Object.hasOwn(imports, specifier)) return imports[specifier];
    throw new Error(`Unexpected customer server import: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const server = await loadServer();

function request(path, { method = 'GET', body, cookies = [], originHeader = undefined } = {}) {
  const headers = new Headers();
  if (method !== 'GET') headers.set('Content-Type', 'application/json');
  if (originHeader !== null) headers.set('Origin', originHeader ?? origin);
  if (cookies.length) headers.set('Cookie', cookies.join('; '));
  return new Request(new URL(path, origin), {
    method,
    headers,
    ...(method === 'GET' ? {} : { body: body === undefined ? '{}' : JSON.stringify(body) }),
  });
}

async function connect(returnTo = 'book', extra = {}) {
  const response = await server.customerGoogleRoute('connect', request('/api/customer/google/connect', {
    method: 'POST',
    body: { returnTo, ...extra },
  }), { store: fakeStore, resolveConfig: async () => fixedConfig });
  return { response, data: await response.json() };
}

function jwtPayload(nonceValue) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({ nonce: nonceValue })}.synthetic-signature`;
}

function cookiePair(header, name) {
  const match = header?.match(new RegExp(`(?:^|,\\s*)${name}=([^;,]*)`));
  return match ? `${name}=${match[1]}` : null;
}

function reset() {
  transactions.clear();
  currentSession = null;
  consumeCalls = 0;
  consumeIntentCalls = 0;
  issueCalls = 0;
  revokeCalls = [];
  decorateCalls = [];
  nextResolveConfigs = null;
  lastIntentReturnTo = 'book';
  lastBrowserHash = null;
  revokedFamilies.clear();
}

test('customer connect uses a separate browser-bound transaction and never returns profile or secret data', async () => {
  reset();
  const { response, data } = await connect('support-booking');
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(data), ['authorizationUrl']);
  const auth = new URL(data.authorizationUrl);
  const oauthCookie = cookiePair(response.headers.get('set-cookie'), '__Host-customer_google_oauth');
  assert.ok(oauthCookie);
  assert.match(oauthCookie, /^__Host-customer_google_oauth=[0-9a-f]{64}$/);
  const browser = oauthCookie.split('=')[1];
  const transaction = transactions.get(auth.searchParams.get('state'));
  assert.ok(transaction);
  assert.equal(transaction.browserHash, await sha256(browser));
  assert.notEqual(transaction.browserHash, browser);
  assert.equal(auth.searchParams.get('nonce'), transaction.nonce);
  assert.equal(transaction.returnTo, 'support-booking');
  assert.equal(transaction.configFingerprint, fixedConfig.fingerprint);
  assert.match(response.headers.get('set-cookie'), /Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600/);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.doesNotMatch(JSON.stringify(data), /client_secret|customer@gmail|Customer Fixture|verifier|id_token/i);
});

test('revoked browser-family connect clears only that OAuth cookie and allows another browser family', async () => {
  reset();
  revokedFamilies.add(await sha256(knownBrowser));
  const revoked = await server.customerGoogleRoute('connect', request('/api/customer/google/connect', {
    method: 'POST', body: { returnTo: 'book' }, cookies: [`__Host-customer_google_oauth=${knownBrowser}`],
  }), { store: fakeStore, resolveConfig: async () => fixedConfig });
  assert.equal(revoked.status, 503);
  assert.equal((await revoked.json()).error.includes('guest'), true);
  const cleared = revoked.headers.get('set-cookie') ?? '';
  assert.match(cleared, /__Host-customer_google_oauth=; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=0/);
  assert.doesNotMatch(cleared, /__Host-customer_google_session=|__Host-admin_session=/);
  assert.equal(issueCalls, 0);

  const otherBrowser = 'f'.repeat(64);
  const other = await server.customerGoogleRoute('connect', request('/api/customer/google/connect', {
    method: 'POST', body: { returnTo: 'book' }, cookies: [`__Host-customer_google_oauth=${otherBrowser}`],
  }), { store: fakeStore, resolveConfig: async () => fixedConfig });
  assert.equal(other.status, 200);
  assert.equal(cookiePair(other.headers.get('set-cookie'), '__Host-customer_google_oauth')?.split('=')[1], otherBrowser);
});

test('callback consumes state once, verifies the nonce-bound identity, and sets only the customer-prefill session', async () => {
  reset();
  const connected = await connect('support-booking');
  const auth = new URL(connected.data.authorizationUrl);
  const oauthCookie = cookiePair(connected.response.headers.get('set-cookie'), '__Host-customer_google_oauth');
  const rawBrowser = oauthCookie.split('=')[1];
  let exchanges = 0;
  let verifications = 0;
  const dependencies = {
    store: fakeStore,
    resolveConfig: async () => fixedConfig,
    exchangeToken: async (actualConfig, code, actualVerifier) => {
      exchanges += 1;
      assert.deepEqual(actualConfig, fixedConfig);
      assert.equal(code, 'synthetic-oauth-code');
      assert.equal(actualVerifier, verifier);
      return jwtPayload(nonce);
    },
    verifyToken: async (token, actualConfig, actualNonce) => {
      verifications += 1;
      assert.equal(token, jwtPayload(nonce));
      assert.deepEqual(actualConfig, fixedConfig);
      assert.equal(actualNonce, nonce);
      return identity;
    },
  };
  const callback = await server.customerGoogleRoute('callback', request(`/api/customer/google/callback?state=${auth.searchParams.get('state')}&code=synthetic-oauth-code`, {
    cookies: [oauthCookie, '__Host-admin_session=' + 'a'.repeat(64), '__Host-customer_session=' + 'b'.repeat(64)],
    originHeader: null,
  }), dependencies);
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get('location'), '/?support=booking&account=signed_in');
  assert.equal(callback.headers.get('cache-control'), 'private, no-store');
  assert.equal(callback.headers.get('referrer-policy'), 'no-referrer');
  assert.doesNotMatch(callback.headers.get('location'), /code=|state=|nonce=|gmail|Customer Fixture/);
  const setCookies = callback.headers.get('set-cookie') ?? '';
  assert.match(setCookies, new RegExp(`__Host-customer_google_oauth=${rawBrowser}; Path=\\/; Secure; HttpOnly; SameSite=Lax; Max-Age=\\d+`));
  assert.match(setCookies, new RegExp(`__Host-customer_google_session=${knownSession}; Path=\\/; Secure; HttpOnly; SameSite=Lax; Max-Age=\\d+`));
  assert.doesNotMatch(setCookies, /__Host-admin_session=|__Host-customer_session=/);
  assert.equal(exchanges, 1);
  assert.equal(verifications, 1);
  assert.equal(issueCalls, 1);
  assert.equal(transactions.get(auth.searchParams.get('state')).consumed, true);
  assert.notEqual(rawBrowser, transactions.get(auth.searchParams.get('state')).browserHash);
  const status = await server.customerGoogleRoute('status', request('/api/customer/google/status', {
    cookies: [`__Host-customer_google_session=${knownSession}`],
  }), { store: fakeStore, resolveConfig: async () => fixedConfig });
  assert.deepEqual(await status.json(), {
    configured: true, authenticated: true, profile: { name: identity.name, email: identity.email },
    expiresAt: identity.expiresAt, prefillPending: true, prefillReturnTo: 'support-booking', adminEligible: false,
  });
});

test('wrong-browser and replay callbacks cannot issue a session; provider errors return fixed outcomes', async () => {
  reset();
  const connected = await connect('book');
  const auth = new URL(connected.data.authorizationUrl);
  const oauthCookie = cookiePair(connected.response.headers.get('set-cookie'), '__Host-customer_google_oauth');
  const exchangeToken = async () => { throw new Error('exchange must not run'); };
  const wrongBrowser = await server.customerGoogleRoute('callback', request(`/api/customer/google/callback?state=${auth.searchParams.get('state')}&code=synthetic-oauth-code`, {
    cookies: [`__Host-customer_google_oauth=${'f'.repeat(64)}`],
    originHeader: null,
  }), { store: fakeStore, resolveConfig: async () => fixedConfig, exchangeToken });
  assert.equal(wrongBrowser.status, 303);
  assert.equal(wrongBrowser.headers.get('location'), '/book?account=unavailable');
  assert.equal(wrongBrowser.headers.get('set-cookie'), null);
  assert.equal(issueCalls, 0);
  assert.equal(transactions.get(auth.searchParams.get('state')).consumed, false);

  const denied = await server.customerGoogleRoute('callback', request(`/api/customer/google/callback?state=${auth.searchParams.get('state')}&error=access_denied&error_description=provider-secret-sentinel`, {
    cookies: [oauthCookie], originHeader: null,
  }), { store: fakeStore, resolveConfig: async () => fixedConfig, exchangeToken });
  assert.equal(denied.headers.get('location'), '/book?account=denied');
  assert.equal(denied.headers.get('set-cookie'), null);
  assert.equal((denied.headers.get('set-cookie') ?? '').includes('provider-secret-sentinel'), false);
  assert.equal(issueCalls, 0);

  const replay = await server.customerGoogleRoute('callback', request(`/api/customer/google/callback?state=${auth.searchParams.get('state')}&code=synthetic-oauth-code`, {
    cookies: [oauthCookie], originHeader: null,
  }), { store: fakeStore, resolveConfig: async () => fixedConfig, exchangeToken });
  assert.equal(replay.headers.get('location'), '/book?account=unavailable');
  assert.equal(replay.headers.get('set-cookie'), null);
  assert.equal(issueCalls, 0);
});

test('a client-secret/config revision change between verification and session issuance denies sign-in', async () => {
  reset();
  const connected = await connect('book');
  const auth = new URL(connected.data.authorizationUrl);
  const oauthCookie = cookiePair(connected.response.headers.get('set-cookie'), '__Host-customer_google_oauth');
  let configReads = 0;
  const rotated = { ...fixedConfig, fingerprint: 'b'.repeat(64), revision: fixedConfig.revision + 1 };
  const response = await server.customerGoogleRoute('callback', request(`/api/customer/google/callback?state=${auth.searchParams.get('state')}&code=synthetic-oauth-code`, {
    cookies: [oauthCookie], originHeader: null,
  }), {
    store: fakeStore,
    resolveConfig: async () => (++configReads === 1 ? fixedConfig : rotated),
    exchangeToken: async () => jwtPayload(nonce),
    verifyToken: async () => identity,
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/book?account=unavailable');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(issueCalls, 0);
});

test('status is read-only and exposes only the signed-in customer’s verified name/email', async () => {
  reset();
  currentSession = { token: knownSession, identity, fingerprint: fixedConfig.fingerprint, expiresAt: identity.expiresAt };
  const before = { issueCalls, revokeCalls: revokeCalls.length, transactionCount: transactions.size };
  const response = await server.customerGoogleRoute('status', request('/api/customer/google/status', {
    cookies: [`__Host-customer_google_session=${knownSession}`, `__Host-admin_session=${'a'.repeat(64)}`],
  }), { store: fakeStore, resolveConfig: async () => fixedConfig });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    configured: true,
    authenticated: true,
    profile: { name: identity.name, email: identity.email },
    expiresAt: identity.expiresAt,
    prefillPending: false,
    prefillReturnTo: null,
    adminEligible: false,
  });
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual({ issueCalls, revokeCalls: revokeCalls.length, transactionCount: transactions.size }, before);
});

test('prefill requires same-origin plus the customer session and accepts no caller-supplied PII', async () => {
  reset();
  currentSession = { token: knownSession, identity, fingerprint: fixedConfig.fingerprint, expiresAt: identity.expiresAt };
  const base = customerCore.buildCustomerGooglePrefillUrl({ name: identity.name, email: identity.email }, { serviceId: hostedFixtureServiceId, placement: 'booking' });
  const reference = 'app_ref_v1_' + '9'.repeat(32);
  const decorated = base + '&utm_content=' + reference;
  const decorateUrl = async (_request, url, input) => { decorateCalls.push({ url, input }); return decorated; };
  const validBody = { serviceId: hostedFixtureServiceId, placement: 'booking', intent: 'manual', returnTo: 'book' };
  const noOrigin = await server.customerGoogleRoute('prefill', request('/api/customer/google/prefill', { method: 'POST', body: validBody, originHeader: null }), {
    store: fakeStore, resolveConfig: async () => fixedConfig, decorateUrl,
  });
  assert.equal(noOrigin.status, 403);
  const guest = await server.customerGoogleRoute('prefill', request('/api/customer/google/prefill', { method: 'POST', body: validBody }), {
    store: { ...fakeStore, async session() { return null; } }, resolveConfig: async () => fixedConfig, decorateUrl,
  });
  assert.equal(guest.status, 401);
  assert.equal(decorateCalls.length, 0);

  const forged = await server.customerGoogleRoute('prefill', request('/api/customer/google/prefill', {
    method: 'POST',
    body: { ...validBody, customer_name: 'forged-name-sentinel', customer_email: 'forged@example.invalid', url: 'https://attacker.invalid/' },
    cookies: [`__Host-customer_google_session=${knownSession}`],
  }), { store: fakeStore, resolveConfig: async () => fixedConfig, decorateUrl });
  assert.equal(forged.status, 400);
  assert.equal(decorateCalls.length, 0);
  assert.doesNotMatch(await forged.text(), /forged-name-sentinel|forged@example.invalid/);

  const accepted = await server.customerGoogleRoute('prefill', request('/api/customer/google/prefill', {
    method: 'POST', body: validBody, cookies: [`__Host-customer_google_session=${knownSession}`],
  }), { store: fakeStore, resolveConfig: async () => fixedConfig, decorateUrl });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get('cache-control'), 'private, no-store');
  const result = await accepted.json();
  assert.deepEqual(Object.keys(result).sort(), ['expiresAt', 'url']);
  assert.equal(result.url, decorated);
  assert.equal(result.expiresAt, identity.expiresAt);
  assert.equal(new URL(result.url).searchParams.has('expiresAt'), false, 'expiry limits the local authorization session and is not sent to the provider');
  assert.equal(decorateCalls[0].url, base);
  assert.deepEqual({ serviceId: decorateCalls[0].input.serviceId, placement: decorateCalls[0].input.placement }, { serviceId: validBody.serviceId, placement: validBody.placement });
  assert.equal(new URL(result.url).searchParams.get('customer_email'), identity.email);
  assert.equal(new URL(result.url).searchParams.get('customer_name'), identity.name);
  assert.equal(new URL(result.url).searchParams.get('utm_content'), reference);
  assert.equal(Object.hasOwn(result, 'subject'), false);
  assert.equal(JSON.stringify(result).includes('forged-name-sentinel'), false);
});

test('the default-off feature gate keeps guest booking available and blocks Google connect, callback exchange, and prefill', async () => {
  reset();
  const guestStatus = await server.customerGoogleRoute('status', request('/api/customer/google/status'), {
    store: fakeStore, resolveConfig: async () => null,
  });
  assert.equal(guestStatus.status, 200);
  assert.deepEqual(await guestStatus.json(), {
    configured: false, authenticated: false, profile: null, expiresAt: null,
    prefillPending: false, prefillReturnTo: null, adminEligible: false,
  });
  assert.equal(guestStatus.headers.get('set-cookie'), null);

  const connectResponse = await server.customerGoogleRoute('connect', request('/api/customer/google/connect', {
    method: 'POST', body: { returnTo: 'book' },
  }), { store: fakeStore, resolveConfig: async () => null });
  assert.equal(connectResponse.status, 503);

  const callback = await server.customerGoogleRoute('callback', request('/api/customer/google/callback?state=' + 'f'.repeat(64) + '&code=synthetic-code', {
    cookies: [`__Host-customer_google_oauth=${knownBrowser}`], originHeader: null,
  }), {
    store: fakeStore, resolveConfig: async () => null,
    exchangeToken: async () => { throw new Error('disabled callback must not exchange'); },
  });
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get('location'), '/book?account=unavailable');
  assert.equal(issueCalls, 0);

  const prefill = await server.customerGoogleRoute('prefill', request('/api/customer/google/prefill', {
    method: 'POST', body: { placement: 'booking', intent: 'manual', returnTo: 'book' },
    cookies: [`__Host-customer_google_session=${knownSession}`],
  }), { store: fakeStore, resolveConfig: async () => null });
  assert.equal(prefill.status, 503);
  assert.equal(decorateCalls.length, 0);
});

test('OAuth-return intent is callback-created, return-destination-bound, and consumed before decoration', async () => {
  reset();
  currentSession = {
    token: knownSession, identity, fingerprint: fixedConfig.fingerprint, expiresAt: identity.expiresAt,
    intentReturnTo: 'support-booking', intentExpiresAt: Date.now() + 300_000, intentConsumed: false,
  };
  const body = { placement: 'booking', intent: 'oauth-return', returnTo: 'support-booking' };
  let decoratorSawClaim = false;
  const decorateUrl = async (_request, url) => {
    decoratorSawClaim = currentSession.intentConsumed;
    decorateCalls.push(url);
    return url;
  };
  const accepted = await server.customerGoogleRoute('prefill', request('/api/customer/google/prefill', {
    method: 'POST', body, cookies: [`__Host-customer_google_session=${knownSession}`],
  }), { store: fakeStore, resolveConfig: async () => fixedConfig, decorateUrl });
  assert.equal(accepted.status, 200);
  assert.equal(decoratorSawClaim, true);
  assert.equal(consumeIntentCalls, 1);
  assert.equal((await accepted.json()).expiresAt, identity.expiresAt);

  const replay = await server.customerGoogleRoute('prefill', request('/api/customer/google/prefill?account=signed_in', {
    method: 'POST', body, cookies: [`__Host-customer_google_session=${knownSession}`],
  }), { store: fakeStore, resolveConfig: async () => fixedConfig, decorateUrl });
  assert.equal(replay.status, 409);
  assert.equal(decorateCalls.length, 1);
});

test('OAuth-return mismatch, expiry, and simultaneous claims cannot release two URLs', async () => {
  reset();
  currentSession = {
    token: knownSession, identity, fingerprint: fixedConfig.fingerprint, expiresAt: identity.expiresAt,
    intentReturnTo: 'book', intentExpiresAt: Date.now() + 300_000, intentConsumed: false,
  };
  const mismatched = await server.customerGoogleRoute('prefill', request('/api/customer/google/prefill', {
    method: 'POST', body: { placement: 'booking', intent: 'oauth-return', returnTo: 'support-booking' },
    cookies: [`__Host-customer_google_session=${knownSession}`],
  }), { store: fakeStore, resolveConfig: async () => fixedConfig, decorateUrl: async (_request, url) => { decorateCalls.push(url); return url; } });
  assert.equal(mismatched.status, 409);
  assert.equal(decorateCalls.length, 0);

  currentSession.intentReturnTo = 'support-booking';
  currentSession.intentExpiresAt = Date.now() - 1;
  const expired = await server.customerGoogleRoute('prefill', request('/api/customer/google/prefill', {
    method: 'POST', body: { placement: 'booking', intent: 'oauth-return', returnTo: 'support-booking' },
    cookies: [`__Host-customer_google_session=${knownSession}`],
  }), { store: fakeStore, resolveConfig: async () => fixedConfig, decorateUrl: async (_request, url) => { decorateCalls.push(url); return url; } });
  assert.equal(expired.status, 409);
  assert.equal(decorateCalls.length, 0);

  currentSession.intentExpiresAt = Date.now() + 300_000;
  const responses = await Promise.all([1, 2].map(() => server.customerGoogleRoute('prefill', request('/api/customer/google/prefill', {
    method: 'POST', body: { placement: 'booking', intent: 'oauth-return', returnTo: 'support-booking' },
    cookies: [`__Host-customer_google_session=${knownSession}`],
  }), { store: fakeStore, resolveConfig: async () => fixedConfig, decorateUrl: async (_request, url) => { decorateCalls.push(url); return url; } })));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  assert.equal(decorateCalls.length, 1);
});

test('manual contact prefill is a distinct explicit action and does not consume callback intent', async () => {
  reset();
  currentSession = {
    token: knownSession, identity, fingerprint: fixedConfig.fingerprint, expiresAt: identity.expiresAt,
    intentReturnTo: 'book', intentExpiresAt: Date.now() - 1, intentConsumed: false,
  };
  const response = await server.customerGoogleRoute('prefill', request('/api/customer/google/prefill', {
    method: 'POST', body: { placement: 'booking', intent: 'manual', returnTo: 'book' },
    cookies: [`__Host-customer_google_session=${knownSession}`],
  }), { store: fakeStore, resolveConfig: async () => fixedConfig, decorateUrl: async (_request, url) => url });
  assert.equal(response.status, 200);
  assert.equal(consumeIntentCalls, 0);
});

test('initial booking prefill uses any current verified customer session without consuming OAuth intent or mutating the auth family', async () => {
  reset();
  currentSession = { token: knownSession, identity, fingerprint: fixedConfig.fingerprint, expiresAt: identity.expiresAt };
  const before = { issueCalls, consumeIntentCalls, revokeCalls: revokeCalls.length, transactions: transactions.size };
  const body = { placement: 'booking', intent: 'initial-booking', returnTo: 'book' };
  const response = await server.customerGoogleRoute('prefill', request('/api/customer/google/prefill', {
    method: 'POST', body, cookies: [`__Host-customer_google_session=${knownSession}`],
  }), {
    store: fakeStore, resolveConfig: async () => fixedConfig,
    decorateUrl: async (_request, url) => url,
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('set-cookie'), null);
  const result = await response.json();
  assert.deepEqual(Object.keys(result).sort(), ['expiresAt', 'url']);
  const destination = new URL(result.url);
  assert.equal(destination.searchParams.get('customer_name'), identity.name);
  assert.equal(destination.searchParams.get('customer_email'), identity.email);
  assert.equal(destination.searchParams.has('phone'), false);
  assert.equal(destination.searchParams.has('customer_phone'), false);
  assert.equal(consumeIntentCalls, before.consumeIntentCalls);
  assert.equal(issueCalls, before.issueCalls);
  assert.equal(revokeCalls.length, before.revokeCalls);
  assert.equal(transactions.size, before.transactions);
});

test('logout revokes only customer Google state/session cookies and leaves Admin/legacy OTP cookies alone', async () => {
  reset();
  currentSession = { token: knownSession, identity, fingerprint: fixedConfig.fingerprint, expiresAt: identity.expiresAt };
  const response = await server.customerGoogleRoute('logout', request('/api/customer/google/logout', {
    method: 'POST', body: {}, cookies: [
      `__Host-customer_google_session=${knownSession}`,
      `__Host-customer_google_oauth=${knownBrowser}`,
      `__Host-admin_session=${'a'.repeat(64)}`,
      `__Host-customer_session=${'b'.repeat(64)}`,
    ],
  }), { store: fakeStore });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { signedOut: true });
  assert.deepEqual(revokeCalls, [{ token: knownSession, browserHash: await sha256(knownBrowser) }]);
  const setCookie = response.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /__Host-customer_google_session=; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=0/);
  assert.match(setCookie, /__Host-customer_google_oauth=; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=0/);
  assert.doesNotMatch(setCookie, /__Host-admin_session=|__Host-customer_session=/);
});
