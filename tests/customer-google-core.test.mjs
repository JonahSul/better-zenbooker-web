import test from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { createLocalJWKSet } from 'jose';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
process.env.NEXT_PUBLIC_HOSTED_BOOKING_URL ??= 'https://widget.zenbooker.com/book/test-business?embed=true';

async function loadTs(relativePath, imports = {}) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((specifier) => {
    if (Object.hasOwn(imports, specifier)) return imports[specifier];
    if (specifier === 'zod/v3') return require(specifier);
    if (specifier === 'jose') return require(specifier);
    if (specifier === './site-config') return { DEMO_ORIGIN: 'https://demo.example.test' };
    if (specifier === './hosted-booking-core') return hostedCore;
    throw new Error(`Unexpected import from ${relativePath}: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const hostedCore = await loadTs('lib/hosted-booking-core.ts');
const google = await loadTs('lib/customer-google-core.ts');
const clientId = 'customer-qa.apps.googleusercontent.com';
const clientSecret = 'synthetic-google-secret';
const config = { clientId, clientSecret };
const now = Date.now();
const callbackUrl = new URL(google.CUSTOMER_GOOGLE_CALLBACK);
const pkceVerifier = 'synthetic-pkce-verifier-with-enough-entropy-0123456789';

function base64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

async function challengeFor(verifier) {
  return base64url(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}

test('customer Google inputs are strict and the embed target is the exact reviewed URL', () => {
  const visitId = 'e3b8012f-5fb2-48bd-b219-1e482dd6a676';
  assert.equal(google.customerGoogleConnectInput.safeParse({ purpose: 'account', returnContext: 'book', visitId }).success, true);
  assert.equal(google.customerGoogleConnectInput.safeParse({ purpose: 'account', returnContext: 'home' }).success, true);
  assert.equal(google.customerGoogleConnectInput.safeParse({ purpose: 'booking_prefill', returnContext: 'book' }).success, true);
  assert.equal(google.customerGoogleConnectInput.safeParse({ purpose: 'booking_prefill', returnContext: 'support-booking' }).success, true);
  assert.equal(google.customerGoogleConnectInput.safeParse({ returnTo: 'book' }).success, true, 'legacy one-use booking flows remain accepted');
  assert.equal(google.normalizeCustomerGoogleConnect({ returnTo: 'book' }).purpose, 'booking_prefill');
  assert.deepEqual(google.normalizeCustomerGoogleConnect({ purpose: 'account', returnContext: 'book', visitId }), {
    purpose: 'account', returnContext: 'book', returnTo: 'book', visitId,
  });
  for (const input of [
    { purpose: 'account', returnContext: 'https://attacker.invalid/', visitId },
    { purpose: 'account', returnContext: '/admin', visitId },
    { purpose: 'account', returnContext: 'book', visitId, email: 'person@example.invalid' },
    { purpose: 'account', returnContext: 'book', visitId: 'caller-controlled' },
    { purpose: 'booking_prefill', returnContext: 'admin' },
    { purpose: 'booking_prefill', returnContext: 'support-booking', visitId },
    { returnTo: 'support-booking', callback: 'https://attacker.invalid/' },
  ]) assert.equal(google.customerGoogleConnectInput.safeParse(input).success, false);

  assert.equal(google.CUSTOMER_GOOGLE_IFRAME_URL, 'https://widget.zenbooker.com/book/test-business?embed=true');
  const iframe = new URL(google.CUSTOMER_GOOGLE_IFRAME_URL);
  assert.equal(iframe.origin, 'https://widget.zenbooker.com');
  assert.equal(iframe.pathname, '/book/test-business');
  assert.deepEqual([...iframe.searchParams], [['embed', 'true']]);
  assert.equal(iframe.hash, '');
  assert.equal(iframe.username, '');
  assert.equal(iframe.password, '');
});

test('customer connect URL uses fixed callback, one-time state/nonce and S256 PKCE only', async () => {
  const state = 'a'.repeat(64);
  const nonce = 'b'.repeat(64);
  const url = new URL(await google.customerGoogleAuthorizationUrl(config, state, nonce, pkceVerifier));
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.pathname, '/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), clientId);
  assert.equal(url.searchParams.get('redirect_uri'), callbackUrl.href);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
  assert.equal(url.searchParams.get('state'), state);
  assert.equal(url.searchParams.get('nonce'), nonce);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), await challengeFor(pkceVerifier));
  assert.equal(url.searchParams.has('code_verifier'), false);
  assert.equal(url.searchParams.has('client_secret'), false);
  assert.equal(url.searchParams.has('access_type'), false, 'the sign-in flow does not request offline access');
  assert.equal(url.searchParams.has('prompt'), false);
  assert.deepEqual([...url.searchParams.keys()].sort(), [
    'client_id', 'code_challenge', 'code_challenge_method', 'nonce', 'redirect_uri', 'response_type', 'scope', 'state',
  ]);
});

test('fixed post-callback destinations contain no provider values or arbitrary redirect', () => {
  const signedInBook = google.customerGoogleReturn('book', 'signed_in');
  const signedInSupport = google.customerGoogleReturn('support-booking', 'signed_in');
  const signedInChat = google.customerGoogleReturn('support-chat', 'signed_in');
  assert.equal(signedInBook, '/book?account=signed_in');
  assert.equal(signedInSupport, '/?support=booking&account=signed_in');
  assert.equal(signedInChat, '/?support=chat&account=signed_in');
  assert.throws(() => google.customerGoogleReturn('https://attacker.invalid/', 'signed_in'));
  for (const result of [signedInBook, signedInSupport, signedInChat, google.customerGoogleReturn('book', 'unavailable'), google.customerGoogleReturn('support-booking', 'denied')]) {
    assert.equal(new URL(result, callbackUrl.origin).origin, callbackUrl.origin);
    assert.doesNotMatch(result, /code=|state=|nonce=|token=|description=|example.invalid/i);
    assert.doesNotMatch(result, /https?:\/\//i);
  }
});

test('the account sign-in context map is a finite exact set of same-site page destinations', () => {
  const expected = [
    'home', 'book', 'appointments', 'contact', 'privacy', 'terms', 'support-chat', 'support-booking',
    'admin', 'admin-chat', 'admin-credentials', 'admin-bookings', 'admin-reviews', 'admin-analytics',
    'admin-experiments', 'admin-performance', 'admin-analysis', 'admin-support', 'admin-memory',
    'admin-settings', 'admin-audit',
  ];
  assert.deepEqual(google.CUSTOMER_RETURN_CONTEXTS, expected);
  assert.equal(google.CUSTOMER_RETURN_PATHS.contact, '/contact');
  for (const context of expected) {
    const path = google.CUSTOMER_RETURN_PATHS[context];
    assert.equal(typeof path, 'string');
    assert.equal(path.startsWith('/'), true);
    assert.equal(path.startsWith('//'), false);
    const result = google.customerGoogleReturn(context, 'signed_in');
    assert.equal(new URL(result, callbackUrl.origin).origin, callbackUrl.origin);
    assert.equal(new URL(result, callbackUrl.origin).searchParams.get('account'), 'signed_in');
    assert.equal(result.includes('#'), false);
  }
});

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyResolver = createLocalJWKSet({
  keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'customer-oidc-test-key', alg: 'RS256', use: 'sig' }],
});

function signIdToken(nonce, claims = {}) {
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'customer-oidc-test-key' })));
  const payload = base64url(Buffer.from(JSON.stringify({
    iss: 'https://accounts.google.com',
    aud: clientId,
    sub: 'stable-customer-google-sub',
    email: 'customer@gmail.com',
    email_verified: true,
    name: 'Customer Example',
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 900,
    nonce,
    ...claims,
  })));
  const content = `${header}.${payload}`;
  return `${content}.${createSign('RSA-SHA256').update(content).end().sign(privateKey).toString('base64url')}`;
}

test('verified customer identity is keyed by subject and allows customer email domains', async () => {
  const identity = await google.verifyCustomerGoogleToken(
    signIdToken('expected-customer-nonce', {
      phone_number: 'fixture-phone-sentinel',
      picture: 'https://fixture.invalid/profile-image',
      address: { formatted: 'fixture-address-sentinel' },
      hd: 'untrusted-domain-claim.invalid',
    }),
    { clientId },
    'expected-customer-nonce',
    keyResolver,
    () => now,
  );
  assert.deepEqual(identity, {
    subject: 'stable-customer-google-sub',
    name: 'Customer Example',
    email: 'customer@gmail.com',
    expiresAt: (Math.floor(now / 1000) + 900) * 1000,
  });
  assert.notEqual(identity.subject, identity.email);
  assert.equal(JSON.stringify(identity).includes('id_token'), false);
});

test('customer token validation rejects bad issuer, audience, nonce, expiry, subject and unverified email', async () => {
  const invalidClaims = [
    { iss: 'https://attacker.invalid' },
    { aud: 'another-client.apps.googleusercontent.com' },
    { nonce: 'wrong-nonce' },
    { exp: Math.floor(now / 1000) - 1 },
    { sub: '' },
    { email_verified: false },
    { email: '' },
    { email: 'not-an-email' },
    { name: 42 },
    { name: 'x'.repeat(201) },
  ];
  for (const claims of invalidClaims) {
    await assert.rejects(google.verifyCustomerGoogleToken(
      signIdToken('expected-customer-nonce', claims),
      { clientId },
      'expected-customer-nonce',
      keyResolver,
      () => now,
    ));
  }
});

test('a verified email-only Google identity remains usable for explicit prefill when name is absent', async () => {
  const identity = await google.verifyCustomerGoogleToken(
    signIdToken('expected-customer-nonce', { name: undefined }),
    { clientId },
    'expected-customer-nonce',
    keyResolver,
    () => now,
  );
  assert.equal(identity.email, 'customer@gmail.com');
  assert.equal(identity.name, null);
  const url = new URL(google.buildCustomerGooglePrefillUrl({ name: identity.name, email: identity.email }, { placement: 'booking' }));
  assert.equal(url.searchParams.get('customer_email'), 'customer@gmail.com');
  assert.equal(url.searchParams.has('customer_name'), false);
});

test('code exchange sends only a fixed confidential-client PKCE request and returns no provider tokens', async () => {
  let captured;
  const idToken = 'synthetic.signed.id-token';
  const result = await google.exchangeCustomerGoogleCode(config, 'synthetic-auth-code', pkceVerifier, async (url, init) => {
    captured = { url, init, body: new URLSearchParams(init.body) };
    return new Response(JSON.stringify({ id_token: idToken, access_token: 'do-not-retain', refresh_token: 'do-not-retain' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  assert.equal(result, idToken);
  assert.equal(captured.url, 'https://oauth2.googleapis.com/token');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.redirect, 'manual');
  assert.equal(captured.init.cache, 'no-store');
  assert.equal(captured.body.get('client_id'), clientId);
  assert.equal(captured.body.get('client_secret'), clientSecret);
  assert.equal(captured.body.get('code'), 'synthetic-auth-code');
  assert.equal(captured.body.get('code_verifier'), pkceVerifier);
  assert.equal(captured.body.get('redirect_uri'), callbackUrl.href);
  assert.equal(captured.body.get('grant_type'), 'authorization_code');
  assert.equal([...captured.body.keys()].sort().join(','), 'client_id,client_secret,code,code_verifier,grant_type,redirect_uri');
});

test('code exchange rejects provider errors and malformed or oversized responses without reflecting their contents', async () => {
  const responses = [
    new Response(JSON.stringify({ error: 'provider-private-error', error_description: 'customer-secret-sentinel' }), { status: 400 }),
    new Response('{malformed customer-secret-sentinel', { status: 200 }),
    new Response(JSON.stringify({ access_token: 'customer-secret-sentinel' }), { status: 200 }),
    new Response('x'.repeat(16385), { status: 200 }),
  ];
  for (const response of responses) {
    await assert.rejects(google.exchangeCustomerGoogleCode(config, 'synthetic-auth-code', pkceVerifier, async () => response), error => {
      assert.equal(error.message, 'Google exchange unavailable');
      assert.doesNotMatch(String(error), /provider-private-error|customer-secret-sentinel/);
      return true;
    });
  }
});

test('prefill input accepts only reviewed service and placement; caller cannot supply contact data or URL', () => {
  const allowed = { serviceId: hostedCore.HOSTED_SERVICE_IDS[2], placement: 'booking', intent: 'manual', returnTo: 'book' };
  assert.equal(google.customerGooglePrefillInput.safeParse(allowed).success, true);
  for (const input of [
    { ...allowed, customer_name: 'Injected Name' },
    { ...allowed, customer_email: 'person@example.invalid' },
    { ...allowed, url: 'https://attacker.invalid/' },
    { ...allowed, returnTo: 'https://attacker.invalid/' },
    { serviceId: hostedCore.HOSTED_SERVICE_IDS[2], placement: 'booking' },
    { ...allowed, intent: 'automatic' },
    { serviceId: 'unreviewed-service', placement: 'booking' },
    { serviceId: hostedCore.HOSTED_SERVICE_IDS[2], placement: 'unknown' },
  ]) assert.equal(google.customerGooglePrefillInput.safeParse(input).success, false);
});

test('prefill URL is built from verified identity and contains only the fixed embed, selection and two supported contact fields', () => {
  const resolvedProviderServiceId = 'verified-fixture-service-42';
  const url = new URL(google.buildCustomerGooglePrefillUrl(
    { name: 'Zoë Example', email: 'zoe@example.invalid' },
    { serviceId: hostedCore.HOSTED_SERVICE_IDS[2], placement: 'booking' },
    resolvedProviderServiceId,
  ));
  assert.equal(url.origin, 'https://widget.zenbooker.com');
  assert.equal(url.pathname, '/book/test-business');
  assert.equal(url.searchParams.get('embed'), 'true');
  assert.equal(url.searchParams.get('preselected-service'), resolvedProviderServiceId);
  assert.equal(url.searchParams.get('customer_name'), 'Zoë Example');
  assert.equal(url.searchParams.get('customer_email'), 'zoe@example.invalid');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['customer_email', 'customer_name', 'embed', 'preselected-service']);
  assert.doesNotMatch(url.href, /access_token|refresh_token|id_token|sub=|nonce=|code=/i);
});

test('legacy static service hints cannot preselect without a current published-offering resolution', () => {
  const url = new URL(google.buildCustomerGooglePrefillUrl(
    { name: 'Zoë Example', email: 'zoe@example.invalid' },
    { serviceId: hostedCore.HOSTED_SERVICE_IDS[2], placement: 'booking' },
  ));
  assert.equal(url.searchParams.has('preselected-service'), false);
});
