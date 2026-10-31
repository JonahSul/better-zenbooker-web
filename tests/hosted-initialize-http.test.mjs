import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const names = [
  'TEST_HOSTED_CALLBACK_BASE_URL',
  'TEST_HOSTED_CALLBACK_OWNER_USER_ID',
  'TEST_HOSTED_CALLBACK_OWNER_EMAIL',
  'TEST_HOSTED_CALLBACK_OWNER_COOKIE',
  'TEST_HOSTED_CALLBACK_VIEWER_USER_ID',
  'TEST_HOSTED_CALLBACK_VIEWER_EMAIL',
  'TEST_HOSTED_CALLBACK_VIEWER_COOKIE',
];
const configured = names.filter(name => process.env[name]).length;
if (configured !== 0 && configured !== names.length) throw new Error('Hosted initialization test requires the full local fixture.');
const enabled = configured === names.length;
let base;
let owner;
let viewer;
if (enabled) {
  base = new URL(process.env.TEST_HOSTED_CALLBACK_BASE_URL);
  if (base.protocol !== 'https:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
    throw new Error('Hosted initialization tests require loopback HTTPS.');
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
    if (!/^[a-f0-9]{64}$/i.test(identity.cookie)) throw new Error('Hosted initialization fixture session is malformed.');
  }
}

function headers(identity, origin = base.origin) {
  return {
    ...(identity ? {
      ...(identity.cookie ? { cookie: `__Host-admin_session=${identity.cookie}` } : {}),
      'oai-authenticated-user-id': identity.id,
      'oai-authenticated-user-email': identity.email,
    } : {}),
    ...(origin === null ? {} : { origin }),
  };
}
async function post(path, { identity, origin, body } = {}) {
  const response = await fetch(new URL(path, base), {
    method: 'POST',
    headers: {
      ...headers(identity, origin === undefined ? base.origin : origin),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    redirect: 'manual',
    cache: 'no-store',
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { response, json };
}
async function readiness(identity) {
  const result = await post('/api/admin/tools', {
    identity,
    body: { tool: 'hosted.readiness', arguments: {} },
  });
  assert.equal(result.response.status, 200);
  return result.json?.result;
}
function assertNoCapabilityFields(json) {
  assert.equal(Object.hasOwn(json ?? {}, 'bridge'), false);
  assert.equal(Object.hasOwn(json ?? {}, 'callback'), false);
  assert.equal(Object.hasOwn(json ?? {}, 'callbackUrl'), false);
  assert.equal(Object.hasOwn(json ?? {}, 'bearer'), false);
}

test('hosted initialization is owner-only, hash-only, HTTPS same-origin and idempotent when missing', { skip: !enabled }, async () => {
  const before = await readiness(owner);
  assert.equal(before?.initialized, false);
  assert.equal(before?.revision, 0);

  const noSession = await post('/api/admin/hosted-booking/initialize', {
    body: { requestKey: `qa-init-${randomUUID()}` },
  });
  assert.notEqual(noSession.response.status, 200);
  assertNoCapabilityFields(noSession.json);

  const otherNativeOwner = await post('/api/admin/hosted-booking/initialize', {
    identity: viewer,
    body: { requestKey: `qa-init-${randomUUID()}` },
  });
  assert.notEqual(otherNativeOwner.response.status, 200);
  assertNoCapabilityFields(otherNativeOwner.json);

  const missingOrigin = await post('/api/admin/hosted-booking/initialize', {
    identity: owner,
    origin: null,
    body: { requestKey: `qa-init-${randomUUID()}` },
  });
  assert.notEqual(missingOrigin.response.status, 200);
  assertNoCapabilityFields(missingOrigin.json);

  const wrongOrigin = await post('/api/admin/hosted-booking/initialize', {
    identity: owner,
    origin: 'https://invalid.example',
    body: { requestKey: `qa-init-${randomUUID()}` },
  });
  assert.notEqual(wrongOrigin.response.status, 200);
  assertNoCapabilityFields(wrongOrigin.json);

  const invalidKey = await post('/api/admin/hosted-booking/initialize', {
    identity: owner,
    body: { requestKey: 'short' },
  });
  assert.notEqual(invalidKey.response.status, 200);
  assertNoCapabilityFields(invalidKey.json);

  const oversized = await post('/api/admin/hosted-booking/initialize', {
    identity: owner,
    body: ' '.repeat(9000),
  });
  assert.notEqual(oversized.response.status, 200);
  assertNoCapabilityFields(oversized.json);

  const stillMissing = await readiness(owner);
  assert.equal(stillMissing?.initialized, false);
  assert.equal(stillMissing?.revision, 0);

  const requestKey = `qa-init-${randomUUID()}`;
  const first = await post('/api/admin/hosted-booking/initialize', {
    identity: owner,
    body: { requestKey },
  });
  assert.equal(first.response.status, 200);
  assert.deepEqual(Object.keys(first.json ?? {}).sort(), [
    'bridgeVerifier', 'callbackVerifier', 'initialized', 'revision',
  ]);
  assert.equal(first.json.initialized, true);
  assert.equal(first.json.revision, 1);
  assert.equal(/^[a-f0-9]{64}$/.test(first.json.bridgeVerifier), true);
  assert.equal(/^[a-f0-9]{64}$/.test(first.json.callbackVerifier), true);
  assert.equal(first.json.bridgeVerifier !== first.json.callbackVerifier, true);

  const sameKeyRetry = await post('/api/admin/hosted-booking/initialize', {
    identity: owner,
    body: { requestKey },
  });
  assert.equal(sameKeyRetry.response.status, 200);
  assert.deepEqual(sameKeyRetry.json, first.json);

  const newKeyRetry = await post('/api/admin/hosted-booking/initialize', {
    identity: owner,
    body: { requestKey: `qa-init-${randomUUID()}` },
  });
  assert.equal(newKeyRetry.response.status, 200);
  assert.deepEqual(newKeyRetry.json, first.json);

  const after = await readiness(owner);
  assert.equal(after?.initialized, true);
  assert.equal(after?.revision, first.json.revision);
  assert.equal(after?.bridgeVerifier, first.json.bridgeVerifier);
  assert.equal(after?.callbackVerifier, first.json.callbackVerifier);
  assert.equal(Object.hasOwn(after ?? {}, 'callbackUrl'), false);

  const auditResult = await post('/api/admin/tools', {
    identity: owner,
    body: { tool: 'audit.list', arguments: {} },
  });
  assert.equal(auditResult.response.status, 200);
  const initAudits = (auditResult.json?.result ?? []).filter(row =>
    row?.action === 'hosted.bridge.initialize' && row?.target === 'bridge-credential-boundary');
  assert.equal(initAudits.length, 1);
  assert.equal(JSON.stringify(initAudits).includes(requestKey), false);
  assert.equal(JSON.stringify(initAudits).includes(first.json.bridgeVerifier), false);
  assert.equal(JSON.stringify(initAudits).includes(first.json.callbackVerifier), false);

  const mcpStatusResponse = await fetch(new URL('/mcp', base), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'oai-authenticated-user-id': owner.id,
      'oai-authenticated-user-email': owner.email,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'hosted-init-safe-status', method: 'tools/call',
      params: { name: 'experiment_connection_status', arguments: {} },
    }),
    redirect: 'manual',
    cache: 'no-store',
  });
  assert.equal(mcpStatusResponse.status, 200);
  const mcpStatusEnvelope = await mcpStatusResponse.json();
  const mcpStatusText = mcpStatusEnvelope?.result?.content?.[0]?.text ?? '';
  const mcpStatus = JSON.parse(mcpStatusText);
  assert.equal(mcpStatus?.hostedBooking?.initialized, true);
  assert.equal(mcpStatus?.hostedBooking?.revision, first.json.revision);
  assert.equal(Object.hasOwn(mcpStatus.hostedBooking, 'callbackUrl'), false);

  const mcpInitResponse = await fetch(new URL('/mcp', base), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'oai-authenticated-user-id': owner.id,
      'oai-authenticated-user-email': owner.email,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'hosted-init-idempotent-native', method: 'tools/call',
      params: { name: 'hosted_bridge_initialize', arguments: { requestKey } },
    }),
    redirect: 'manual',
    cache: 'no-store',
  });
  assert.equal(mcpInitResponse.status, 200);
  const mcpInitEnvelope = await mcpInitResponse.json();
  const mcpInitText = mcpInitEnvelope?.result?.content?.[0]?.text ?? '';
  const mcpInit = JSON.parse(mcpInitText);
  assert.deepEqual(Object.keys(mcpInit).sort(), [
    'bridgeVerifier', 'callbackVerifier', 'initialized', 'revision',
  ]);
  assert.deepEqual(mcpInit, first.json);
});
