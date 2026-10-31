import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = process.env.TEST_BASE_URL;
const userA = process.env.TEST_USER_A_ID;
const userB = process.env.TEST_USER_B_ID;
const authEmail = process.env.TEST_AUTH_EMAIL ?? 'qa@example.invalid';
const suite = baseUrl && userA && userB ? test : test.skip;
const disabledSuite = process.env.TEST_GOOGLE_REVIEWS_ENABLED === 'true' ? test.skip : suite;
const enabledSuite = process.env.TEST_GOOGLE_REVIEWS_ENABLED === 'true' ? suite : test.skip;

function authHeaders(userId) {
  return {
    'oai-authenticated-user-id': userId,
    'oai-authenticated-user-email': authEmail,
  };
}

async function call(pathname, { userId, method = 'GET', body, headers = {}, origin, redirect = 'manual' } = {}) {
  const url = new URL(pathname, baseUrl);
  return fetch(url, {
    method,
    redirect,
    headers: {
      ...(userId ? authHeaders(userId) : {}),
      ...(method === 'POST' ? { origin: origin ?? url.origin } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

disabledSuite('Google Business Profile local HTTP gates (disabled config)', async (t) => {
  await t.test('unauthenticated reads and mutations fail closed', async () => {
    for (const pathname of ['/api/google-reviews/status', '/api/google-reviews/locations', '/api/google-reviews/display']) {
      const response = await call(pathname);
      assert.equal(response.status, 401, `${pathname} should require Site identity`);
    }
    for (const pathname of ['/api/google-reviews/connect', '/api/google-reviews/location', '/api/google-reviews/disconnect']) {
      const response = await call(pathname, { method: 'POST', body: {} });
      assert.equal(response.status, 401, `${pathname} should require Site identity`);
    }
  });

  await t.test("unconfigured status exposes only the requesting user's setup identity", async () => {
    const response = await call('/api/google-reviews/status', { userId: userA });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.configured, false);
    assert.equal(body.connected, false);
    assert.equal(body.isOwner, false);
    assert.equal(body.setupUserId, userA);
    assert.equal(JSON.stringify(body).includes(userB), false);
    assert.deepEqual(Object.keys(body).sort(), ['configured', 'connected', 'isOwner', 'message', 'selected', 'setupUserId'].sort());
  });

  await t.test('unconfigured authenticated API operations fail without returning a Google URL or reviews', async () => {
    for (const [pathname, method] of [
      ['/api/google-reviews/connect', 'POST'],
      ['/api/google-reviews/locations', 'GET'],
      ['/api/google-reviews/location', 'POST'],
      ['/api/google-reviews/disconnect', 'POST'],
      ['/api/google-reviews/display', 'GET'],
    ]) {
      const response = await call(pathname, { userId: userA, method, body: method === 'POST' ? {} : undefined });
      assert.equal(response.status, 503, `${method} ${pathname} should remain disabled without credentials/owner config`);
      assert.equal(response.headers.get('cache-control')?.includes('no-store'), true);
      const text = await response.text();
      assert.doesNotMatch(text, /accounts\.google\.com|averageRating|totalReviewCount|review-fixture/i);
    }
  });

  await t.test('callback failure redirects to a fixed clean manager URL with no OAuth query values', async () => {
    const response = await call('/api/google-reviews/oauth-callback?code=fixture-code&state=fixture-state', { userId: userA });
    assert.equal(response.status, 303);
    const location = response.headers.get('location');
    assert.equal(location, 'https://demo.example.test/manage/google-reviews?connection=not_authorized');
    assert.equal(response.headers.get('cache-control')?.includes('no-store'), true);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.doesNotMatch(location, /code=|state=/);
  });

});

enabledSuite('Google Business Profile local HTTP gates (fake config, no Google calls)', async (t) => {
  await t.test('only the configured Site owner can see status or manage connection routes', async () => {
    const owner = await call('/api/google-reviews/status', { userId: userA });
    assert.equal(owner.status, 200);
    const status = await owner.json();
    assert.equal(status.configured, true);
    assert.equal(status.isOwner, true);
    assert.equal(status.connected, false);

    for (const [pathname, method] of [
      ['/api/google-reviews/status', 'GET'],
      ['/api/google-reviews/connect', 'POST'],
      ['/api/google-reviews/locations', 'GET'],
      ['/api/google-reviews/location', 'POST'],
      ['/api/google-reviews/disconnect', 'POST'],
    ]) {
      const response = await call(pathname, { userId: userB, method, body: method === 'POST' ? {} : undefined });
      assert.equal(response.status, 403, `signed-in non-owner must be denied ${method} ${pathname}`);
    }
    const display = await call('/api/google-reviews/display', { userId: userB });
    assert.notEqual(display.status, 403, 'an authenticated Site viewer may use the read-only display route');
    assert.ok([200, 503].includes(display.status), `unexpected display response ${display.status}`);
    assert.doesNotMatch(await display.text(), /refresh.?token|client.?secret|encryption.?key/i);
  });

  await t.test('owner POST mutations reject foreign origins', async () => {
    for (const pathname of ['/api/google-reviews/connect', '/api/google-reviews/location', '/api/google-reviews/disconnect']) {
      const response = await call(pathname, { userId: userA, method: 'POST', body: {}, origin: 'https://attacker.invalid' });
      assert.equal(response.status, 403, `${pathname} must reject a foreign Origin`);
    }
  });

  await t.test('connect creates a fixed OAuth URL and callback state is owner-bound, one-time, and never exchanged on rejection', async () => {
    const connected = await call('/api/google-reviews/connect', { userId: userA, method: 'POST', body: {} });
    assert.equal(connected.status, 200);
    const { authorizationUrl } = await connected.json();
    const auth = new URL(authorizationUrl);
    assert.equal(auth.origin + auth.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(auth.searchParams.get('redirect_uri'), 'https://demo.example.test/api/google-reviews/oauth-callback');
    assert.equal(auth.searchParams.get('scope'), 'https://www.googleapis.com/auth/business.manage');
    const state = auth.searchParams.get('state');
    assert.ok(state);

    const missing = await call('/api/google-reviews/oauth-callback', { userId: userA });
    assert.equal(missing.status, 303);
    assert.match(missing.headers.get('location'), /connection=invalid_state$/);

    const wrongOwner = await call(`/api/google-reviews/oauth-callback?state=${encodeURIComponent(state)}`, { userId: userB });
    assert.equal(wrongOwner.status, 303);
    assert.match(wrongOwner.headers.get('location'), /connection=not_authorized$/);

    const denied = await call(`/api/google-reviews/oauth-callback?state=${encodeURIComponent(state)}&error=access_denied`, { userId: userA });
    assert.equal(denied.status, 303);
    assert.match(denied.headers.get('location'), /connection=denied$/);

    const replay = await call(`/api/google-reviews/oauth-callback?state=${encodeURIComponent(state)}&error=access_denied`, { userId: userA });
    assert.equal(replay.status, 303);
    assert.match(replay.headers.get('location'), /connection=invalid_state$/);
    for (const response of [missing, wrongOwner, denied, replay]) {
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(response.headers.get('cache-control')?.includes('no-store'), true);
      assert.doesNotMatch(response.headers.get('location'), /code=|state=|fixture-code|must-not-exchange/);
    }
  });

  await t.test('callback rejects an expired state before exchanging a code', async (t) => {
    const wranglerConfig = process.env.TEST_GOOGLE_REVIEWS_WRANGLER_CONFIG;
    const persistPath = process.env.TEST_GOOGLE_REVIEWS_PERSIST_PATH;
    if (!wranglerConfig || !persistPath) {
      t.skip('provide isolated local Wrangler config and persist path to exercise the D1 expiry row');
      return;
    }
    const connected = await call('/api/google-reviews/connect', { userId: userA, method: 'POST', body: {} });
    assert.equal(connected.status, 200);
    const state = new URL((await connected.json()).authorizationUrl).searchParams.get('state');
    assert.ok(state);
    const stateHash = createHash('sha256').update(state).digest('hex');
    const command = `UPDATE google_oauth_states SET expires_at = 0 WHERE state_hash = '${stateHash}'`;
    execFileSync(process.execPath, [
      path.join(root, 'node_modules/wrangler/bin/wrangler.js'),
      'd1', 'execute', 'site-creator-d1', '--local', '--command', command,
      '--persist-to', persistPath, '--config', wranglerConfig,
    ], { cwd: root, stdio: 'pipe' });
    const response = await call(`/api/google-reviews/oauth-callback?state=${encodeURIComponent(state)}&error=access_denied`, { userId: userA });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location'), /connection=invalid_state$/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.doesNotMatch(response.headers.get('location'), /code=|state=/);
  });

  await t.test('disconnect with no saved connection performs local cleanup without a Google token request', async () => {
    const response = await call('/api/google-reviews/disconnect', { userId: userA, method: 'POST', body: {} });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.disconnected, true);
    assert.equal(body.remoteRevocationConfirmed, true);
  });
});

test('disabled Google configuration guards all provider access paths before any fetch branch', async () => {
  const source = await readFile(path.join(root, 'lib/google-reviews-server.ts'), 'utf8');
  const adminCheck = source.indexOf('const denied=await adminGuard(request)');
  const configResolution = source.indexOf('const config=await resolveGoogleBusinessConfig()');
  const providerBranches = ['authorizationUrl(config', 'discoverLocations(auth.token,', 'fetchReviews(auth.token,', 'exchangeCode(config,'].map((needle) => source.indexOf(needle));
  assert.ok(adminCheck >= 0, 'management requests must pass the verified Google administrator guard');
  assert.ok(configResolution > adminCheck, 'only verified administrators may proceed to resolve provider configuration');
  assert.ok(providerBranches.every((index) => index > configResolution), 'provider calls must be reachable only after administrator and configuration checks');
});
