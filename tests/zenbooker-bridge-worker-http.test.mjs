import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

const envNames = [
  'TEST_BRIDGE_BASE_URL',
  'TEST_BRIDGE_CALLBACK_TOKEN',
  'TEST_BRIDGE_BEARER_TOKEN',
];
const present = envNames.filter(name => process.env[name]);
const enabled = present.length === envNames.length;
if (present.length && !enabled) throw new Error('Bridge HTTP test requires all local fixture variables.');

let base;
let callbackToken;
let bearerToken;
if (enabled) {
  base = new URL(process.env.TEST_BRIDGE_BASE_URL);
  if (!['http:', 'https:'].includes(base.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
    throw new Error('Bridge HTTP tests are restricted to a loopback Worker.');
  }
  callbackToken = process.env.TEST_BRIDGE_CALLBACK_TOKEN;
  bearerToken = process.env.TEST_BRIDGE_BEARER_TOKEN;
  if (!/^[0-9a-f]{64}$/.test(callbackToken) || !/^[0-9a-f]{64}$/.test(bearerToken)) {
    throw new Error('Bridge fixture tokens must be synthetic 256-bit hex values.');
  }
}

const digest = value => createHash('sha256').update(value).digest('hex');
function url(path) { return new URL(path, base).href; }
async function json(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { throw new Error(`Expected JSON HTTP response; got status ${response.status}.`); }
}

async function authenticated(path, { method = 'GET', body = '', nonce = randomUUID() } = {}) {
  const bytes = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = {
    authorization: `Bearer ${bearerToken}`,
    'x-bridge-timestamp': String(Date.now()),
    'x-bridge-nonce': nonce,
    'x-bridge-body-sha256': digest(bytes),
  };
  if (bytes) headers['content-type'] = 'application/json';
  return fetch(url(path), { method, headers, body: method === 'GET' ? undefined : bytes, redirect: 'manual', cache: 'no-store' });
}

function webhook(overrides = {}) {
  return {
    event: 'job.created',
    account: { id: 'fixture-account' },
    webhook_id: 'fixture-webhook-one',
    retry_count: 0,
    data: {
      id: 'fixture-job-one',
      status: 'scheduled',
      customer: { name: 'Local Fixture Person', email: 'local-fixture@example.invalid', phone: '+15555550123' },
      location: { address: 'Local Fixture Address' },
    },
    ...overrides,
  };
}

test('local receiver enforces capability-only callback path, setup quarantine, durable dedupe, and ack replay', { skip: !enabled }, async () => {
  const initialStatusResponse = await authenticated('/bridge/status');
  assert.equal(initialStatusResponse.status, 200);
  const initialStatus = await json(initialStatusResponse);
  assert.equal(initialStatus.configured, true);
  assert.equal(initialStatus.revision, 0);
  assert.equal(initialStatus.config.mode, 'setup');
  assert.equal(initialStatus.config.pins.schemaProfile, 'unverified');
  assert.equal(initialStatus.callbackVerifier, digest(callbackToken));
  assert.equal(initialStatus.bridgeVerifier, digest(bearerToken));
  assert.equal(JSON.stringify(initialStatus).includes(callbackToken), false);
  assert.equal(JSON.stringify(initialStatus).includes(bearerToken), false);

  const body = JSON.stringify(webhook());
  const correctCallback = path => fetch(url(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    redirect: 'manual',
    cache: 'no-store',
  });
  const wrongMethod = await fetch(url(`/webhooks/zenbooker?cap=${callbackToken}`), { method: 'GET', redirect: 'manual' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.has('access-control-allow-origin'), false);
  assert.equal((await json(wrongMethod)).error, 'request_rejected');

  assert.equal((await correctCallback('/webhooks/zenbooker')).status, 401);
  assert.equal((await correctCallback(`/webhooks/zenbooker?cap=${callbackToken}&cap=${callbackToken}`)).status, 401);
  assert.equal((await correctCallback(`/webhooks/zenbooker?cap=${callbackToken}&other=1`)).status, 401);
  assert.equal((await correctCallback(`/webhooks/zenbooker?cap=${digest(callbackToken)}`)).status, 401);
  assert.equal((await fetch(url('/webhooks/zenbooker'), {
    method: 'POST',
    headers: { authorization: `Bearer ${callbackToken}`, 'content-type': 'application/json' },
    body,
    redirect: 'manual',
  })).status, 401);
  assert.equal((await correctCallback(`/webhooks/zenbooker/?cap=${callbackToken}`)).status, 404);
  assert.equal((await correctCallback(`/bridge/webhooks/zenbooker?cap=${callbackToken}`)).status, 401);
  assert.equal((await fetch(url(`/bridge/status?cap=${callbackToken}`), { method: 'GET', redirect: 'manual' })).status, 401);

  const first = await correctCallback(`/webhooks/zenbooker?cap=${callbackToken}`);
  assert.equal(first.status, 200);
  const firstResult = await json(first);
  assert.equal(firstResult.received, true);
  assert.equal(firstResult.disposition, 'quarantine');
  assert.equal(firstResult.duplicate, undefined);
  assert.equal(JSON.stringify(firstResult).includes('local-fixture@example.invalid'), false);
  assert.equal(first.headers.has('access-control-allow-origin'), false);

  const pullFirstResponse = await authenticated('/bridge/pull?cursor=0&limit=100');
  assert.equal(pullFirstResponse.status, 200);
  const pullFirst = await json(pullFirstResponse);
  assert.equal(pullFirst.items.length, 1);
  assert.equal(pullFirst.items[0].mode, 'setup');
  assert.equal(pullFirst.items[0].disposition, 'quarantine');
  assert.equal(pullFirst.items[0].reason, 'schema_unverified');
  assert.equal(JSON.stringify(pullFirst.items).includes('local-fixture@example.invalid'), false);
  assert.equal(JSON.stringify(pullFirst.items).includes('Local Fixture Address'), false);

  const retry = webhook({ webhook_id: 'fixture-webhook-two', retry_count: 4 });
  const duplicateResponse = await fetch(url(`/webhooks/zenbooker?cap=${callbackToken}`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(retry),
    redirect: 'manual',
  });
  assert.equal(duplicateResponse.status, 200);
  assert.equal((await json(duplicateResponse)).duplicate, true);

  const pullAgain = await json(await authenticated('/bridge/pull?cursor=0&limit=100'));
  assert.deepEqual(pullAgain.items.map(item => item.remoteId), pullFirst.items.map(item => item.remoteId));
  const ackNonce = randomUUID();
  const ack = await authenticated('/bridge/ack', { method: 'POST', body: { cursor: pullFirst.nextCursor }, nonce: ackNonce });
  assert.equal(ack.status, 200);
  assert.equal((await json(ack)).acknowledged, true);
  const changedBodyReplay = await authenticated('/bridge/ack', {
    method: 'POST',
    body: { cursor: pullFirst.nextCursor + 1 },
    nonce: ackNonce,
  });
  assert.equal(changedBodyReplay.status, 409);
  assert.equal((await json(changedBodyReplay)).error, 'replay_rejected');
  const repeatedAck = await authenticated('/bridge/ack', { method: 'POST', body: { cursor: pullFirst.nextCursor } });
  assert.equal(repeatedAck.status, 200);
  assert.equal((await json(repeatedAck)).acknowledged, true);
  const afterAck = await json(await authenticated('/bridge/pull?cursor=0&limit=100'));
  assert.deepEqual(afterAck.items.map(item => item.remoteId), pullFirst.items.map(item => item.remoteId));

  const invalidLive = await authenticated('/bridge/configure', {
    method: 'POST',
    body: { expectedRevision: 0, config: { ...initialStatus.config, mode: 'live' } },
  });
  assert.equal(invalidLive.status, 409);
  assert.equal((await json(invalidLive)).error, 'verified_pins_required');

  const verifiedPins = {
    accountId: 'fixture-account',
    webhookIds: ['fixture-webhook-one', 'fixture-webhook-two'],
    eventScope: ['job.created', 'job.rescheduled', 'job.canceled'],
    schemaProfile: {
      kind: 'owner_verified_v3',
      accountIdPath: 'account.id',
      jobIdPath: 'data.id',
      shapeHash: pullFirst.items[0].schemaHash,
    },
  };
  const pinSetup = await authenticated('/bridge/configure', {
    method: 'POST',
    body: { expectedRevision: 0, config: { mode: 'setup', pins: verifiedPins, refreshEnabled: false } },
  });
  assert.equal(pinSetup.status, 200);
  const pinSetupResult = await json(pinSetup);
  assert.equal(pinSetupResult.revision, 1);

  const enableLive = await authenticated('/bridge/configure', {
    method: 'POST',
    body: { expectedRevision: 1, config: { mode: 'live', pins: verifiedPins, refreshEnabled: false } },
  });
  assert.equal(enableLive.status, 200);
  const liveResult = await json(enableLive);
  assert.equal(liveResult.revision, 2);
  assert.equal(liveResult.config.mode, 'live');

  const newLiveEvent = webhook({
    webhook_id: 'fixture-webhook-one',
    retry_count: 0,
    data: { id: 'fixture-job-live', status: 'scheduled' },
  });
  const liveDelivery = await fetch(url(`/webhooks/zenbooker?cap=${callbackToken}`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(newLiveEvent),
    redirect: 'manual',
  });
  assert.equal(liveDelivery.status, 200);
  const liveDeliveryResult = await json(liveDelivery);
  assert.equal(liveDeliveryResult.disposition, 'accepted');

  const otherSubscriptionRetry = { ...newLiveEvent, webhook_id: 'fixture-webhook-two', retry_count: 4 };
  const crossSubscriptionDuplicate = await fetch(url(`/webhooks/zenbooker?cap=${callbackToken}`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(otherSubscriptionRetry),
    redirect: 'manual',
  });
  assert.equal(crossSubscriptionDuplicate.status, 200);
  assert.equal((await json(crossSubscriptionDuplicate)).duplicate, true);

  const wrongAccount = { ...newLiveEvent, account: { id: 'foreign-account' }, data: { id: 'foreign-job' } };
  const wrongAccountResponse = await fetch(url(`/webhooks/zenbooker?cap=${callbackToken}`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(wrongAccount),
    redirect: 'manual',
  });
  assert.equal(wrongAccountResponse.status, 200);
  assert.equal((await json(wrongAccountResponse)).disposition, 'quarantine');

  const finalPull = await json(await authenticated('/bridge/pull?cursor=0&limit=100'));
  const setupRow = finalPull.items.find(item => item.mode === 'setup');
  assert.ok(setupRow);
  assert.equal(setupRow.disposition, 'quarantine');
  assert.equal(setupRow.reason, 'schema_unverified');
  const acceptedLive = finalPull.items.filter(item => item.mode === 'live' && item.event === 'job.created' && item.disposition === 'accepted');
  assert.equal(acceptedLive.length, 1);
  assert.equal(acceptedLive[0].jobId, 'fixture-job-live');
  assert.equal(finalPull.items.some(item => item.reason === 'account_mismatch'), true);
});
