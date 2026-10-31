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
process.env.OWNER_EMAILS = 'owner@business.example.test,qa@example.test';

async function loadCore() {
  const diagnosticSource = await readFile(path.join(root, 'lib/admin-auth-diagnostic.ts'), 'utf8');
  const diagnosticJs = ts.transpileModule(diagnosticSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const diagnosticModule = { exports: {} };
  new Function('require', 'module', 'exports', diagnosticJs)(() => { throw new Error('No diagnostic imports expected'); }, diagnosticModule, diagnosticModule.exports);
  const source = await readFile(path.join(root, 'lib/admin-auth-core.ts'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  const requireMock = (specifier) => {
    if (specifier === 'jose') return requireFromTest(specifier);
    if (specifier === './admin-auth-diagnostic') return diagnosticModule.exports;
    if (specifier === './site-config') {
      return { DEMO_ORIGIN: 'https://demo.example.test' };
    }
    throw new Error(`Unexpected admin-auth-core import: ${specifier}`);
  };
  new Function('require', 'module', 'exports', js)(requireMock, loaded, loaded.exports);
  Object.assign(loaded.exports, diagnosticModule.exports);
  return loaded.exports;
}

const core = await loadCore();
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'qa-key-1', alg: 'RS256', use: 'sig' };
const localKeys = createLocalJWKSet({ keys: [publicJwk] });

function signedToken(overrides = {}, signer = privateKey) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'qa-key-1' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'https://accounts.google.com',
    aud: 'qa-admin-client.apps.googleusercontent.com',
    sub: 'google-subject-qa-1',
    email: 'owner@business.example.test',
    email_verified: true,
    exp: Math.floor(Date.now() / 1000) + 600,
    iat: Math.floor(Date.now() / 1000),
    nonce: 'qa-one-time-nonce',
    ...overrides,
  })).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256').update(signingInput).end().sign(signer).toString('base64url');
  return `${signingInput}.${signature}`;
}

const runtime = {
  ADMIN_GOOGLE_CLIENT_ID: 'qa-admin-client.apps.googleusercontent.com',
  ADMIN_GOOGLE_CLIENT_SECRET: 'test-only-not-a-real-secret',
};
const config = core.adminOidcConfig(runtime);

test('admin Google OIDC configuration fails closed when confidential credentials are missing', () => {
  assert.equal(core.adminOidcConfig({}), null);
  assert.ok(config);
});

test('admin email policy accepts only verified exact allowlisted domains', () => {
  for (const email of ['owner@business.example.test', 'qa@example.test']) {
    assert.equal(core.allowedAdminEmail(email, true), true, email);
  }
  for (const email of [
    'owner@sub.business.example.test',
    'owner@notbusiness.example.test',
    'owner@business.example.test.attacker.example',
    'owner@example.test.attacker.example',
    'owner@demoblowout406.co',
    'owner@gmail.com',
  ]) assert.equal(core.allowedAdminEmail(email, true), false, email);
  assert.equal(core.allowedAdminEmail('owner@business.example.test', false), false, 'unverified address is rejected');
});

test('authorization URL requests authentication only and does not use hd as an access rule', async () => {
  const url = new URL(core.adminAuthorizationUrl(config, 'state-fixture', 'nonce-fixture'));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), core.ADMIN_CALLBACK);
  assert.equal(core.ADMIN_CALLBACK, 'https://demo.example.test/api/admin/auth/callback');
  assert.equal(url.searchParams.get('state'), 'state-fixture');
  assert.equal(url.searchParams.get('nonce'), 'nonce-fixture');
  assert.equal(url.searchParams.get('prompt'), 'select_account');
  assert.equal(url.searchParams.has('hd'), false);
  assert.doesNotMatch(url.search, /business\.manage/);
});

test('authorization-code exchange uses the fixed HTTPS token endpoint and exact registered callback', async () => {
  const config = { clientId: 'qa-admin-client.apps.googleusercontent.com', clientSecret: 'test-only-secret' };
  let captured;
  const idToken = signedToken('unused-exchange-fixture-nonce');
  const result = await core.exchangeAdminCode(config, 'one-time-code', async (url, init) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({ id_token: idToken }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  assert.equal(result, idToken);
  assert.equal(captured.url, 'https://oauth2.googleapis.com/token');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.redirect, 'manual');
  assert.equal(captured.init.cache, 'no-store');
  const body = new URLSearchParams(captured.init.body);
  assert.equal(body.get('client_id'), config.clientId);
  assert.equal(body.get('client_secret'), config.clientSecret);
  assert.equal(body.get('code'), 'one-time-code');
  assert.equal(body.get('redirect_uri'), core.ADMIN_CALLBACK);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.has('scope'), false);
});

test('token exchange classifies failures without retaining provider text or secrets', async () => {
  const config = { clientId: 'qa-admin-client.apps.googleusercontent.com', clientSecret: 'test-only-secret' };
  const failures = [
    ['network', async () => { throw new Error('raw-secret-network-sentinel'); }, { stage: 'token_exchange', result: 'network', httpStatus: null, oauthError: null }],
    ['timeout', async () => { throw new DOMException('raw-secret-timeout-sentinel', 'TimeoutError'); }, { stage: 'token_exchange', result: 'timeout', httpStatus: null, oauthError: null }],
    ['HTTP rejection', async () => Response.json({ error: 'invalid_client', error_description: 'provider-body-secret-sentinel' }, { status: 400 }), { stage: 'token_exchange', result: 'http_rejected', httpStatus: 400, oauthError: 'invalid_client' }],
    ['empty body', async () => new Response(null, { status: 200 }), { stage: 'token_exchange', result: 'empty_body', httpStatus: 200, oauthError: null }],
    ['oversized body', async () => new Response('x'.repeat(9000), { status: 200 }), { stage: 'token_exchange', result: 'oversized_body', httpStatus: 200, oauthError: null }],
    ['invalid JSON', async () => new Response('raw-provider-body-sentinel', { status: 200 }), { stage: 'token_exchange', result: 'invalid_json', httpStatus: 200, oauthError: null }],
    ['missing id token', async () => Response.json({ access_token: 'private-token-sentinel' }), { stage: 'token_exchange', result: 'missing_id_token', httpStatus: 200, oauthError: null }],
  ];
  for (const [label, fetcher, expected] of failures) {
    await assert.rejects(core.exchangeAdminCode(config, 'fixture-code', fetcher), error => {
      assert.ok(error instanceof core.AdminTokenExchangeError, label);
      assert.deepEqual(error.diagnostic, expected, label);
      assert.equal(error.message, 'Google sign-in unavailable', label);
      assert.doesNotMatch(JSON.stringify(error), /raw-secret|provider-body|raw-provider|private-token|error_description|test-only-secret/i, label);
      return true;
    });
  }
});

test('token endpoint redirects are returned as a rejected response and never followed', async () => {
  const config = { clientId: 'qa-admin-client.apps.googleusercontent.com', clientSecret: 'test-only-secret' };
  const requests = [];
  await assert.rejects(core.exchangeAdminCode(config, 'fixture-code', async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(null, { status: 302, headers: { Location: 'https://redirect-target.invalid/token?secret=do-not-forward' } });
  }), error => {
    assert.ok(error instanceof core.AdminTokenExchangeError);
    assert.deepEqual(error.diagnostic, { stage: 'token_exchange', result: 'http_rejected', httpStatus: 302, oauthError: null });
    assert.equal(error.message, 'Google sign-in unavailable');
    return true;
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(requests[0].init.redirect, 'manual');
  assert.doesNotMatch(JSON.stringify(requests[0].init), /redirect-target|do-not-forward/);
});

test('token response stream read failures have no HTTP status and do not retain stream error text', async () => {
  const config = { clientId: 'qa-admin-client.apps.googleusercontent.com', clientSecret: 'test-only-secret' };
  const response = new Response(new ReadableStream({
    start(controller) { controller.error(new Error('raw response stream secret sentinel')); },
  }), { status: 200 });
  await assert.rejects(core.exchangeAdminCode(config, 'fixture-code', async () => response), error => {
    assert.ok(error instanceof core.AdminTokenExchangeError);
    assert.deepEqual(error.diagnostic, { stage: 'token_exchange', result: 'network', httpStatus: null, oauthError: null });
    assert.equal(error.message, 'Google sign-in unavailable');
    assert.doesNotMatch(JSON.stringify(error), /response stream secret sentinel|test-only-secret/);
    return true;
  });
});

test('valid signed Google ID token returns only verified stable identity and expiry', async () => {
  const identity = await core.verifyGoogleAdminToken(signedToken(), config, 'qa-one-time-nonce', localKeys);
  assert.deepEqual(identity, {
    subject: 'google-subject-qa-1',
    email: 'owner@business.example.test',
    expiresAt: identity.expiresAt,
  });
  assert.ok(identity.expiresAt > Math.floor(Date.now() / 1000));
  assert.equal(Object.hasOwn(identity, 'picture'), false);
  assert.equal(Object.hasOwn(identity, 'accessToken'), false);
});

test('verified email allowlist governs eligibility independently of the hd hint', async () => {
  const allowed = await core.verifyGoogleAdminToken(
    signedToken({ hd: 'unlisted-workspace.example' }), config, 'qa-one-time-nonce', localKeys,
  );
  assert.equal(allowed.email, 'owner@business.example.test');
  await assert.rejects(core.verifyGoogleAdminToken(
    signedToken({ email: 'owner@attacker.example', hd: 'business.example.test' }),
    config, 'qa-one-time-nonce', localKeys,
  ));
  const documentedIssuer = await core.verifyGoogleAdminToken(
    signedToken({ iss: 'accounts.google.com' }), config, 'qa-one-time-nonce', localKeys,
  );
  assert.equal(documentedIssuer.subject, 'google-subject-qa-1');
});

test('signed token validation rejects issuer, audience, expiry, nonce, and verified-email failures', async () => {
  const cases = [
    ['issuer', { iss: 'https://attacker.example' }],
    ['audience', { aud: 'another-client.apps.googleusercontent.com' }],
    ['non-exact audience set', { aud: ['qa-admin-client.apps.googleusercontent.com', 'another-client.apps.googleusercontent.com'] }],
    ['expiry', { exp: Math.floor(Date.now() / 1000) - 1 }],
    ['nonce', { nonce: 'replayed-or-wrong-nonce' }],
    ['unverified email', { email_verified: false }],
    ['unapproved domain', { email: 'owner@sub.business.example.test' }],
  ];
  for (const [label, overrides] of cases) {
    await assert.rejects(
      core.verifyGoogleAdminToken(signedToken(overrides), config, 'qa-one-time-nonce', localKeys),
      undefined,
      `must reject ${label}`,
    );
  }
});

test('signed token validation rejects non-RS256 and signature tampering', async () => {
  const [header, payload, signature] = signedToken().split('.');
  const alteredSignature = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
  await assert.rejects(
    core.verifyGoogleAdminToken(`${header}.${payload}.${alteredSignature}`, config, 'qa-one-time-nonce', localKeys),
  );
  const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT', kid: 'qa-key-1' })).toString('base64url');
  await assert.rejects(
    core.verifyGoogleAdminToken(`${noneHeader}.${payload}.${signature}`, config, 'qa-one-time-nonce', localKeys),
  );
});
