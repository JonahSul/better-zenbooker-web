import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const names = [
  'TEST_HOSTED_CALLBACK_BASE_URL',
  'TEST_HOSTED_CALLBACK_OWNER_USER_ID',
  'TEST_HOSTED_CALLBACK_OWNER_EMAIL',
  'TEST_HOSTED_CALLBACK_OWNER_COOKIE',
  'TEST_HOSTED_CALLBACK_VIEWER_USER_ID',
  'TEST_HOSTED_CALLBACK_VIEWER_EMAIL',
  'TEST_HOSTED_CALLBACK_VIEWER_COOKIE',
];
const count = names.filter(name => process.env[name]).length;
if (count !== 0 && count !== names.length) throw new Error('Callback-copy fixture requires all local variables.');
const enabled = count === names.length;
let base;
let owner;
let viewer;
if (enabled) {
  base = new URL(process.env.TEST_HOSTED_CALLBACK_BASE_URL);
  if (base.protocol !== 'https:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
    throw new Error('Callback-copy tests require a loopback HTTPS Worker.');
  }
  owner = {
    id: process.env.TEST_HOSTED_CALLBACK_OWNER_USER_ID,
    email: process.env.TEST_HOSTED_CALLBACK_OWNER_EMAIL,
    cookie: process.env.TEST_HOSTED_CALLBACK_OWNER_COOKIE,
  };
  viewer = {
    id: process.env.TEST_HOSTED_CALLBACK_VIEWER_USER_ID,
    email: process.env.TEST_HOSTED_CALLBACK_VIEWER_EMAIL,
    cookie: process.env.TEST_HOSTED_CALLBACK_VIEWER_COOKIE,
  };
  for (const identity of [owner, viewer]) {
    if (!/^[a-f0-9]{64}$/i.test(identity.cookie)) throw new Error('Callback-copy fixture session is malformed.');
  }
}

const origin = () => base.origin;
function requestHeaders(identity, requestOrigin = origin()) {
  return {
    ...(identity ? {
      ...(identity.cookie ? { cookie: `__Host-admin_session=${identity.cookie}` } : {}),
      'oai-authenticated-user-id': identity.id,
      'oai-authenticated-user-email': identity.email,
    } : {}),
    origin: requestOrigin,
  };
}
async function request(path, { identity, requestOrigin, body } = {}) {
  const response = await fetch(new URL(path, base), {
    method: 'POST',
    headers: {
      ...requestHeaders(identity, requestOrigin),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
    cache: 'no-store',
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { response, json };
}

test('protected callback copy requires owner Google session, HTTPS origin, current revision and verified bridge', { skip: !enabled }, async () => {
  const auth = await fetch(new URL('/api/admin/auth/status', base), {
    headers: {
      cookie: `__Host-admin_session=${owner.cookie}`,
      'oai-authenticated-user-id': owner.id,
      'oai-authenticated-user-email': owner.email,
    },
    redirect: 'manual',
    cache: 'no-store',
  });
  assert.equal(auth.status, 200);
  const authState = await auth.json();
  assert.equal(authState.authenticated, true);
  assert.equal(authState.email, owner.email);

  const readinessResult = await request('/api/admin/tools', {
    identity: owner,
    body: { tool: 'hosted.readiness', arguments: {} },
  });
  assert.equal(readinessResult.response.status, 200);
  const readiness = readinessResult.json?.result;
  assert.equal(readiness?.initialized, true);
  assert.equal(readiness?.configured, true);
  assert.equal(readiness?.health, 'verified');
  assert.equal(readiness?.mode, 'setup');
  assert.equal(readiness?.bridgeOrigin, 'https://demo406-demo-booking-bridge.me-400.workers.dev');
  assert.equal(Number.isInteger(readiness?.revision) && readiness.revision > 0, true);
  assert.match(readiness?.callbackVerifier ?? '', /^[0-9a-f]{64}$/);

  const denied = await request('/api/admin/hosted-booking/callback-copy', {
    body: { revision: readiness.revision, confirm: true },
  });
  assert.equal(denied.response.status, 403);

  const missingGoogleSession = await request('/api/admin/hosted-booking/callback-copy', {
    identity: { id: owner.id, email: owner.email },
    body: { revision: readiness.revision, confirm: true },
  });
  assert.notEqual(missingGoogleSession.response.status, 200);

  const missingConfirmation = await request('/api/admin/hosted-booking/callback-copy', {
    identity: owner,
    body: { revision: readiness.revision },
  });
  assert.notEqual(missingConfirmation.response.status, 200);

  const wrongOrigin = await request('/api/admin/hosted-booking/callback-copy', {
    identity: owner,
    requestOrigin: 'https://invalid.example',
    body: { revision: readiness.revision, confirm: true },
  });
  assert.equal(wrongOrigin.response.status, 403);

  const nonOwner = await request('/api/admin/hosted-booking/callback-copy', {
    identity: viewer,
    body: { revision: readiness.revision, confirm: true },
  });
  assert.equal(nonOwner.response.status, 403);

  const stale = await request('/api/admin/hosted-booking/callback-copy', {
    identity: owner,
    body: { revision: readiness.revision + 1, confirm: true },
  });
  assert.equal(stale.response.status, 409);

  const copied = await request('/api/admin/hosted-booking/callback-copy', {
    identity: owner,
    body: { revision: readiness.revision, confirm: true },
  });
  assert.equal(copied.response.status, 200);
  assert.match(copied.response.headers.get('cache-control') ?? '', /private/i);
  assert.match(copied.response.headers.get('cache-control') ?? '', /no-store/i);
  assert.equal(copied.response.headers.get('referrer-policy'), 'no-referrer');
  const callbackUrl = new URL(copied.json?.callbackUrl ?? 'https://invalid.example');
  const callbackCapability = callbackUrl.searchParams.get('cap') ?? '';
  assert.equal(callbackUrl.origin, readiness.bridgeOrigin);
  assert.equal(callbackUrl.pathname, '/webhooks/zenbooker');
  assert.equal(callbackUrl.username, '');
  assert.equal(callbackUrl.password, '');
  assert.equal(callbackUrl.hash, '');
  assert.equal([...callbackUrl.searchParams.keys()].length, 1);
  assert.equal(/^[a-f0-9]{64}$/i.test(callbackCapability), true);
  assert.equal(createHash('sha256').update(callbackCapability).digest('hex') === readiness.callbackVerifier, true);

  const readinessAfter = await request('/api/admin/tools', {
    identity: owner,
    body: { tool: 'hosted.readiness', arguments: {} },
  });
  assert.equal(readinessAfter.response.status, 200);
  assert.equal(readinessAfter.json?.result?.callbackVerifier === readiness.callbackVerifier, true);
  assert.equal(JSON.stringify(readinessAfter.json).includes(callbackCapability), false);
  assert.equal(Object.hasOwn(readinessAfter.json?.result ?? {}, 'callbackUrl'), false);

  const nativeStatus = await fetch(new URL('/mcp', base), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'oai-authenticated-user-id': owner.id,
      'oai-authenticated-user-email': owner.email,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'hosted-safe-status', method: 'tools/call',
      params: { name: 'experiment_connection_status', arguments: {} },
    }),
    redirect: 'manual',
    cache: 'no-store',
  });
  assert.equal(nativeStatus.status, 200);
  const nativePayload = await nativeStatus.json();
  const nativeText = nativePayload?.result?.content?.[0]?.text ?? '';
  assert.equal(typeof nativeText, 'string');
  assert.equal(nativeText.includes(callbackCapability), false);
  assert.equal(nativeText.includes(callbackUrl.href), false);
});
