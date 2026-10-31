import test from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createLocalJWKSet } from 'jose';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireFromTest = createRequire(import.meta.url);
const siteOrigin = 'https://demo.example.test';
process.env.OWNER_EMAILS ??= 'owner@business.example.test';
const browserOwner = 'browser:' + 'a'.repeat(64);
const browserOther = 'browser:' + 'b'.repeat(64);
const currentUser = { value: { userId: browserOwner, email: 'owner@business.example.test', displayName: 'Visitor', fullName: null } };

const tables = {
  adminOauthStates: { stateHash: 'stateHash', siteUserId: 'siteUserId', nonceHash: 'nonceHash', expiresAt: 'expiresAt' },
  adminSessions: { sessionHash: 'sessionHash', siteUserId: 'siteUserId', googleSubject: 'googleSubject', email: 'email', configFingerprint: 'configFingerprint', expiresAt: 'expiresAt', createdAt: 'createdAt' },
  adminAudit: { id: 'id', googleSubject: 'googleSubject', action: 'action', target: 'target', createdAt: 'createdAt' },
};
const schema = {
  adminOauthStates: Object.fromEntries(Object.entries(tables.adminOauthStates).map(([key, name]) => [key, { name }])),
  adminSessions: Object.fromEntries(Object.entries(tables.adminSessions).map(([key, name]) => [key, { name }])),
  adminAudit: Object.fromEntries(Object.entries(tables.adminAudit).map(([key, name]) => [key, { name }])),
};
const rows = new Map([[schema.adminOauthStates, []], [schema.adminSessions, []], [schema.adminAudit, []]]);
const credentialBoundary = { project_id: 'qa-project', revision: 0, sealed_at: null, operation_token: null };
let credentialBatchCount = 0;
let rotateDuringNextBatch = false;
let resolverFailure = null;
let userLookupFailure = null;
const columnName = (column) => column.name;
const operators = {
  eq: (column, value) => ({ op: 'eq', column: columnName(column), value }),
  gt: (column, value) => ({ op: 'gt', column: columnName(column), value }),
  lte: (column, value) => ({ op: 'lte', column: columnName(column), value }),
  and: (...conditions) => ({ op: 'and', conditions }),
};
function matches(row, condition) {
  if (condition.op === 'and') return condition.conditions.every((item) => matches(row, item));
  const value = row[condition.column];
  if (condition.op === 'eq') return value === condition.value;
  if (condition.op === 'gt') return value > condition.value;
  if (condition.op === 'lte') return value <= condition.value;
  return false;
}
function fakeDb() {
  return {
    delete(table) {
      return { where(condition) {
        const saved = rows.get(table);
        const removed = saved.filter((row) => matches(row, condition));
        rows.set(table, saved.filter((row) => !matches(row, condition)));
        const result = { returning: async () => removed };
        result.then = (resolve, reject) => Promise.resolve(removed).then(resolve, reject);
        return result;
      } };
    },
    insert(table) {
      return { values: async (value) => { rows.get(table).push(structuredClone(value)); } };
    },
    select() {
      return { from(table) { return { where(condition) { return { limit: async (count) => rows.get(table).filter((row) => matches(row, condition)).slice(0, count) }; } }; } };
    },
  };
}

const credentialFixture = {
  async state() { return structuredClone(credentialBoundary); },
  statement(sql, ...values) { return { sql, values }; },
  db: {
    async batch(statements) {
      credentialBatchCount += 1;
      assert.equal(statements.length, 2, 'seal and Site-bound admin session are one D1 batch');
      assert.match(statements[0].sql, /UPDATE app_credential_state SET sealed_at=COALESCE\(sealed_at,\?\),operation_token=\? WHERE project_id=\? AND revision=\?/);
      assert.match(statements[1].sql, /INSERT INTO admin_sessions[\s\S]*WHERE EXISTS\(SELECT 1 FROM app_credential_state[\s\S]*operation_token=\?/);
      const seal = statements[0].values;
      const session = statements[1].values;
      const race = rotateDuringNextBatch;
      rotateDuringNextBatch = false;
      if (race) credentialBoundary.revision += 1;
      const accepted = seal[2] === credentialBoundary.project_id && seal[3] === credentialBoundary.revision
        && session[7] === credentialBoundary.project_id && session[8] === seal[1];
      if (!accepted) return [{ meta: { changes: 0 } }, { meta: { changes: 0 } }];
      credentialBoundary.sealed_at ??= seal[0];
      credentialBoundary.operation_token = seal[1];
      rows.get(schema.adminSessions).push({
        sessionHash: session[0], siteUserId: session[1], googleSubject: session[2], email: session[3],
        configFingerprint: session[4], expiresAt: session[5], createdAt: session[6],
      });
      return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
    },
  },
};

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyResolver = createLocalJWKSet({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'flow-key', alg: 'RS256', use: 'sig' }] });
function signIdToken(nonce, overrides = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'flow-key' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'https://accounts.google.com',
    aud: 'qa-admin-client.apps.googleusercontent.com',
    sub: 'google-flow-subject',
    email: 'owner@business.example.test',
    email_verified: true,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900,
    nonce,
    ...overrides,
  })).toString('base64url');
  const input = `${header}.${payload}`;
  return `${input}.${createSign('RSA-SHA256').update(input).end().sign(privateKey).toString('base64url')}`;
}

async function loadCore() {
  const diagnosticSource = await readFile(path.join(root, 'lib/admin-auth-diagnostic.ts'), 'utf8');
  const diagnosticJs = ts.transpileModule(diagnosticSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const diagnosticModule = { exports: {} };
  new Function('require', 'module', 'exports', diagnosticJs)(() => { throw new Error('Unexpected diagnostic import'); }, diagnosticModule, diagnosticModule.exports);
  const source = await readFile(path.join(root, 'lib/admin-auth-core.ts'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = { exports: {} };
  const mocks = (specifier) => {
    if (specifier === 'jose') return requireFromTest(specifier);
    if (specifier === './admin-auth-diagnostic') return diagnosticModule.exports;
    if (specifier === './site-config') return { DEMO_ORIGIN: siteOrigin };
    throw new Error(`Unexpected core import: ${specifier}`);
  };
  new Function('require', 'module', 'exports', js)(mocks, loaded, loaded.exports);
  return { core: loaded.exports, diagnostic: diagnosticModule.exports };
}

const loadedCore = await loadCore();
const core = loadedCore.core;
const diagnostic = loadedCore.diagnostic;
async function loadServer() {
  const budgetSource = await readFile(path.join(root, 'lib/input-budget.ts'), 'utf8');
  const budgetJs = ts.transpileModule(budgetSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const budgetModule = { exports: {} };
  new Function('require', 'module', 'exports', budgetJs)(() => { throw new Error('Unexpected input-budget import'); }, budgetModule, budgetModule.exports);
  const source = await readFile(path.join(root, 'lib/admin-auth-server.ts'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const loaded = { exports: {} };
  const mocks = (specifier) => {
    if (specifier === 'cloudflare:workers') return { env: { ADMIN_GOOGLE_CLIENT_ID: 'qa-admin-client.apps.googleusercontent.com', ADMIN_GOOGLE_CLIENT_SECRET: 'test-only-secret' } };
    if (specifier === 'drizzle-orm') return operators;
    if (specifier === 'next/headers') return { headers: async () => new Headers() };
    if (specifier === '../app/chatgpt-auth') return { getChatGPTUser: async () => { if (userLookupFailure) throw userLookupFailure; return currentUser.value; } };
    if (specifier === '../db') return { getDb: fakeDb };
    if (specifier === '../db/schema') return schema;
    if (specifier === './admin-auth-core') return core;
    if (specifier === './input-budget') return budgetModule.exports;
    if (specifier === './admin-auth-diagnostic') return diagnostic;
    if (specifier === './admin-outcome') return { knownAdminOutcome: value => ['signed_in','invalid_identity','provider_unavailable','configuration_changed','denied','invalid_state','missing_code','site_sign_in_required','setup_required'].includes(value) };
    if (specifier === './runtime-secrets') return {
      credentialStore: () => credentialFixture,
      resolveAdminOidcConfig: async () => { if (resolverFailure) throw resolverFailure; return { clientId: 'qa-admin-client.apps.googleusercontent.com', clientSecret: 'test-only-secret' }; },
      adminConfigFingerprint: async (config) => core.sha256(`admin-oidc:v1:qa-project:${config.clientId}:${config.clientSecret}`),
      SITE_PROJECT_ID: 'qa-project',
    };
    if (specifier === 'jose') return requireFromTest(specifier);
    throw new Error(`Unexpected server import: ${specifier}`);
  };
  new Function('require', 'module', 'exports', js)(mocks, loaded, loaded.exports);
  return loaded.exports;
}

const server = await loadServer();
function request(url, method = 'GET', extra = {}) {
  const headers = new Headers(extra.headers ?? {});
  if (method !== 'GET') headers.set('origin', siteOrigin);
  if (method !== 'GET' && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Request(new URL(url, siteOrigin), { method, headers, ...(method === 'GET' ? {} : { body: extra.body ?? '{}' }) });
}
async function connect() {
  const response = await server.adminAuthRoute('connect', request('/api/admin/auth/connect', 'POST'));
  assert.equal(response.status, 200);
  return (await response.json()).authorizationUrl;
}
function stateFrom(authUrl) { return new URL(authUrl).searchParams.get('state'); }
function nonceFrom(authUrl) { return new URL(authUrl).searchParams.get('nonce'); }
function callback(state, query = 'code=fake-code') { return request(`/api/admin/auth/callback?state=${encodeURIComponent(state)}&${query}`); }

test('mocked signed OIDC callback creates browser-bound hashed session; local logout revokes it', async () => {
  rows.set(schema.adminOauthStates, []);
  rows.set(schema.adminSessions, []);
  credentialBoundary.revision = 0;
  credentialBoundary.sealed_at = null;
  credentialBoundary.operation_token = null;
  credentialBatchCount = 0;
  rotateDuringNextBatch = false;
  currentUser.value.userId = 'browser:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const authUrl = await connect();
  const state = stateFrom(authUrl);
  const nonce = nonceFrom(authUrl);
  assert.match(state, /^[0-9a-f]{64}$/);
  assert.match(nonce, /^[0-9a-f]{64}$/);
  assert.notEqual(rows.get(schema.adminOauthStates)[0].stateHash, state);
  assert.notEqual(rows.get(schema.adminOauthStates)[0].nonceHash, nonce);
  const idToken = signIdToken(nonce);
  const dependencies = {
    exchangeToken: async (_config, code) => { assert.equal(code, 'fake-code'); return idToken; },
    verifyToken: (token, config, actualNonce) => core.verifyGoogleAdminToken(token, config, actualNonce, keyResolver),
  };
  const result = await server.adminAuthRoute('callback', callback(state), dependencies);
  assert.equal(result.status, 303);
  assert.equal(result.headers.get('location'), '/admin?auth=signed_in');
  assert.doesNotMatch(result.headers.get('location'), /state|code|nonce/);
  assert.equal(result.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(result.headers.get('cache-control'), 'private, no-store');
  const setCookie = result.headers.get('set-cookie');
  assert.match(setCookie, /^__Host-admin_session=[0-9a-f]{64}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
  const sessionToken = setCookie.match(/^__Host-admin_session=([0-9a-f]{64})/)[1];
  assert.equal(rows.get(schema.adminSessions).length, 1);
  assert.equal(rows.get(schema.adminAudit).some(row => row.action === 'google_auth.diagnostic'), false, 'successful sign-in creates no failure diagnostic');
  assert.equal(rows.get(schema.adminAudit).some(row => row.action === 'google_auth.signed_in'), true);
  assert.equal(credentialBatchCount, 1);
  assert.ok(credentialBoundary.sealed_at, 'only the verified callback seals the bootstrap boundary');
  assert.notEqual(rows.get(schema.adminSessions)[0].sessionHash, sessionToken);
  assert.equal(rows.get(schema.adminSessions)[0].googleSubject, 'google-flow-subject');
  assert.equal(rows.get(schema.adminSessions)[0].siteUserId, 'browser:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(rows.get(schema.adminOauthStates).length, 0);

  const sessionRequest = request('/', 'GET', { headers: { cookie: `__Host-admin_session=${sessionToken}` } });
  assert.deepEqual(await server.getGoogleAdmin(sessionRequest), {
    siteUserId: 'browser:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', subject: 'google-flow-subject', email: 'owner@business.example.test',
    expiresAt: rows.get(schema.adminSessions)[0].expiresAt,
  });
  currentUser.value.userId = 'browser:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  assert.equal(await server.getGoogleAdmin(sessionRequest), null, 'a different browser namespace cannot reuse the session');
  currentUser.value.userId = 'browser:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  const logout = await server.adminAuthRoute('logout', request('/api/admin/auth/logout', 'POST', {
    headers: { cookie: `__Host-admin_session=${sessionToken}` },
  }));
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /^__Host-admin_session=; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=0$/);
  assert.equal(rows.get(schema.adminSessions).length, 0);
  assert.equal(await server.getGoogleAdmin(sessionRequest), null);
});

test('state denial/replay, expiry, wrong Site user and nonce mismatch fail closed', async () => {
  rows.set(schema.adminOauthStates, []);
  rows.set(schema.adminSessions, []);
  credentialBoundary.revision = 0;
  credentialBoundary.sealed_at = null;
  credentialBoundary.operation_token = null;
  credentialBatchCount = 0;
  rotateDuringNextBatch = false;
  currentUser.value.userId = 'browser:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  let authUrl = await connect();
  let state = stateFrom(authUrl);
  let denied = await server.adminAuthRoute('callback', callback(state, 'error=access_denied'));
  assert.equal(denied.headers.get('location'), '/admin?auth=denied');
  const replay = await server.adminAuthRoute('callback', callback(state, 'error=access_denied'));
  assert.equal(replay.headers.get('location'), '/admin?auth=invalid_state');

  authUrl = await connect();
  state = stateFrom(authUrl);
  rows.get(schema.adminOauthStates)[0].expiresAt = Date.now() - 1;
  const expired = await server.adminAuthRoute('callback', callback(state, 'error=access_denied'));
  assert.equal(expired.headers.get('location'), '/admin?auth=invalid_state');

  rows.set(schema.adminOauthStates, []);
  authUrl = await connect();
  state = stateFrom(authUrl);
  currentUser.value.userId = 'browser:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const wrongUser = await server.adminAuthRoute('callback', callback(state, 'error=access_denied'));
  assert.equal(wrongUser.headers.get('location'), '/admin?auth=invalid_state');
  currentUser.value.userId = 'browser:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  assert.equal(rows.get(schema.adminOauthStates).length, 1, 'wrong Site user did not consume another user’s state');

  const badNonceToken = signIdToken('not-the-state-nonce');
  const nonceFailure = await server.adminAuthRoute('callback', callback(state), {
    exchangeToken: async () => badNonceToken,
    verifyToken: async () => { throw new Error('verification must not run after nonce mismatch'); },
  });
  assert.equal(nonceFailure.headers.get('location'), '/admin?auth=invalid_identity');
  assert.equal(rows.get(schema.adminSessions).length, 0);
  assert.equal(credentialBoundary.sealed_at, null, 'denied, replayed, expired, wrong-user, and invalid-identity callbacks do not seal bootstrap');
  assert.equal(credentialBatchCount, 0);
});

test('credential rotation racing the verified callback prevents both seal and session issuance', async () => {
  rows.set(schema.adminOauthStates, []);
  rows.set(schema.adminSessions, []);
  credentialBoundary.revision = 7;
  credentialBoundary.sealed_at = null;
  credentialBoundary.operation_token = null;
  credentialBatchCount = 0;
  rotateDuringNextBatch = false;
  currentUser.value.userId = 'browser:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  const authUrl = await connect();
  const state = stateFrom(authUrl);
  const nonce = nonceFrom(authUrl);
  const result = await server.adminAuthRoute('callback', callback(state), {
    exchangeToken: async () => signIdToken(nonce),
    verifyToken: (token, config, actualNonce) => {
      rotateDuringNextBatch = true;
      return core.verifyGoogleAdminToken(token, config, actualNonce, keyResolver);
    },
  });

  assert.equal(result.headers.get('location'), '/admin?auth=configuration_changed');
  assert.equal(credentialBatchCount, 1);
  assert.equal(credentialBoundary.sealed_at, null);
  assert.equal(rows.get(schema.adminSessions).length, 0, 'a raced rotation must not leave a session without its matching seal');
});

function latestDiagnostic() {
  const row = rows.get(schema.adminAudit).filter(item => item.action === 'google_auth.diagnostic').at(-1);
  assert.ok(row, 'callback failure should persist one safe diagnostic');
  assert.equal(row.googleSubject, 'system:google-oidc-diagnostic');
  const parsed = diagnostic.parseAdminAuthDiagnostic(row.target);
  assert.ok(parsed, 'persisted diagnostic should satisfy the strict safe schema');
  return parsed;
}

test('credential-resolution and token-exchange failures stay unauthenticated and persist only safe stages', async () => {
  rows.set(schema.adminOauthStates, []);
  rows.set(schema.adminSessions, []);
  rows.set(schema.adminAudit, []);
  credentialBoundary.revision = 2;
  credentialBoundary.sealed_at = null;
  credentialBoundary.operation_token = null;
  credentialBatchCount = 0;
  rotateDuringNextBatch = false;
  resolverFailure = null;
  userLookupFailure = null;
  currentUser.value.userId = 'browser:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  let state = stateFrom(await connect());
  resolverFailure = new Error('raw resolver credential sentinel');
  const resolutionFailure = await server.adminAuthRoute('callback', callback(state));
  resolverFailure = null;
  assert.equal(resolutionFailure.headers.get('location'), '/admin?auth=provider_unavailable');
  assert.equal(resolutionFailure.headers.get('set-cookie'), null);
  assert.deepEqual(latestDiagnostic(), { stage: 'credential_resolution', result: 'unavailable', httpStatus: null, oauthError: null });
  assert.equal(rows.get(schema.adminOauthStates).length, 1, 'resolution precedes one-time state consumption');
  assert.equal(rows.get(schema.adminSessions).length, 0);
  assert.equal(credentialBoundary.sealed_at, null);
  assert.doesNotMatch(JSON.stringify(rows.get(schema.adminAudit)), /raw resolver credential sentinel|test-only-secret/);

  state = stateFrom(await connect());
  const exchangeFailure = await server.adminAuthRoute('callback', callback(state), {
    exchangeToken: async () => { throw new Error('raw provider error_description and token=secret sentinel'); },
  });
  assert.equal(exchangeFailure.headers.get('location'), '/admin?auth=provider_unavailable');
  assert.equal(exchangeFailure.headers.get('set-cookie'), null);
  assert.deepEqual(latestDiagnostic(), { stage: 'token_exchange', result: 'unavailable', httpStatus: null, oauthError: null });
  assert.equal(rows.get(schema.adminOauthStates).length, 1, 'the exchange-failure state was consumed; only the resolver-failure state remains');
  assert.equal(rows.get(schema.adminSessions).length, 0);
  assert.equal(credentialBoundary.sealed_at, null);
  assert.doesNotMatch(JSON.stringify(rows.get(schema.adminAudit)), /raw provider error_description|token=secret sentinel/);
  const replay = await server.adminAuthRoute('callback', callback(state));
  assert.equal(replay.headers.get('location'), '/admin?auth=invalid_state');
  assert.equal(rows.get(schema.adminSessions).length, 0);
});

test('OAuth response errors use a fixed allowlist and never store provider descriptions', async () => {
  rows.set(schema.adminOauthStates, []);
  rows.set(schema.adminSessions, []);
  rows.set(schema.adminAudit, []);
  credentialBoundary.revision = 3;
  credentialBoundary.sealed_at = null;
  resolverFailure = null;
  currentUser.value.userId = 'browser:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  let state = stateFrom(await connect());
  const known = await server.adminAuthRoute('callback', callback(state, 'error=server_error&error_description=private-provider-detail'));
  assert.equal(known.headers.get('location'), '/admin?auth=provider_unavailable');
  assert.equal(known.headers.get('set-cookie'), null);
  assert.deepEqual(latestDiagnostic(), { stage: 'oauth_response', result: 'oauth_error', httpStatus: null, oauthError: 'server_error' });
  assert.doesNotMatch(JSON.stringify(rows.get(schema.adminAudit)), /private-provider-detail/);
  assert.equal(rows.get(schema.adminSessions).length, 0);
  assert.equal(credentialBoundary.sealed_at, null);

  state = stateFrom(await connect());
  const unknown = await server.adminAuthRoute('callback', callback(state, 'error=provider-internal-secret&error_description=do-not-persist'));
  assert.equal(unknown.headers.get('location'), '/admin?auth=provider_unavailable');
  assert.deepEqual(latestDiagnostic(), { stage: 'oauth_response', result: 'oauth_error', httpStatus: null, oauthError: 'other' });
  assert.doesNotMatch(JSON.stringify(rows.get(schema.adminAudit)), /provider-internal-secret|do-not-persist/);
  assert.equal(rows.get(schema.adminSessions).length, 0);
  assert.equal(credentialBoundary.sealed_at, null);
});

test('site-identity lookup exceptions are classified without exposing exception text', async () => {
  rows.set(schema.adminOauthStates, []);
  rows.set(schema.adminSessions, []);
  rows.set(schema.adminAudit, []);
  credentialBoundary.sealed_at = null;
  userLookupFailure = new Error('raw Sites identity provider sentinel');
  const response = await server.adminAuthRoute('callback', callback('untrusted-state'));
  userLookupFailure = null;
  assert.equal(response.headers.get('location'), '/admin?auth=provider_unavailable');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(latestDiagnostic(), { stage: 'site_identity', result: 'unavailable', httpStatus: null, oauthError: null });
  assert.doesNotMatch(JSON.stringify(rows.get(schema.adminAudit)), /raw Sites identity provider sentinel/);
  assert.equal(rows.get(schema.adminSessions).length, 0);
  assert.equal(credentialBoundary.sealed_at, null);
});
