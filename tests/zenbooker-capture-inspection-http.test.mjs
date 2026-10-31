import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const envNames = [
  'TEST_BRIDGE_CAPTURE_BASE_URL',
  'TEST_BRIDGE_CAPTURE_CALLBACK_TOKEN',
  'TEST_BRIDGE_CAPTURE_BEARER_TOKEN',
  'TEST_BRIDGE_CAPTURE_D1_CONFIG',
  'TEST_BRIDGE_CAPTURE_D1_PERSIST',
  'TEST_BRIDGE_CAPTURE_D1_NAME',
];
const present = envNames.filter(name => process.env[name]);
const enabled = present.length === envNames.length;
if (present.length && !enabled) throw new Error('Capture-inspection test requires all isolated fixture variables.');

let base;
let callbackToken;
let bearerToken;
let config;
let persist;
let databaseName;
if (enabled) {
  base = new URL(process.env.TEST_BRIDGE_CAPTURE_BASE_URL);
  if (!['http:', 'https:'].includes(base.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
    throw new Error('Capture-inspection tests are restricted to a loopback receiver.');
  }
  callbackToken = process.env.TEST_BRIDGE_CAPTURE_CALLBACK_TOKEN;
  bearerToken = process.env.TEST_BRIDGE_CAPTURE_BEARER_TOKEN;
  config = process.env.TEST_BRIDGE_CAPTURE_D1_CONFIG.replaceAll('\\', '/');
  persist = process.env.TEST_BRIDGE_CAPTURE_D1_PERSIST.replaceAll('\\', '/');
  databaseName = process.env.TEST_BRIDGE_CAPTURE_D1_NAME;
  if (!/^[0-9a-f]{64}$/.test(callbackToken) || !/^[0-9a-f]{64}$/.test(bearerToken)) {
    throw new Error('Capture-inspection fixture tokens must be synthetic 256-bit hex values.');
  }
  if (!/\.sites-runtime\/bridge-capture-[^/]+\/wrangler\.json$/i.test(config)) {
    throw new Error('Capture-inspection tests require a dedicated local receiver config.');
  }
  if (!/\.wrangler\/bridge-capture-local-[^/]+$/i.test(persist)) {
    throw new Error('Capture-inspection tests require a dedicated disposable local database.');
  }
  if (databaseName !== 'bridge-capture-fixture') throw new Error('Unexpected capture-inspection fixture database.');
}

const suite = enabled ? test : test.skip;
const digest = value => createHash('sha256').update(value).digest('hex');
const url = route => new URL(route, base).href;

async function json(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { throw new Error(`Expected JSON response; status ${response.status}.`); }
}

async function authenticated(route, { method = 'GET', body, nonce = randomUUID(), token = bearerToken } = {}) {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return fetch(url(route), {
    method,
    headers: {
      connection: 'close',
      authorization: `Bearer ${token}`,
      'x-bridge-timestamp': String(Date.now()),
      'x-bridge-nonce': nonce,
      'x-bridge-body-sha256': digest(text),
      ...(text ? { 'content-type': 'application/json' } : {}),
    },
    ...(method === 'GET' ? {} : { body: text }),
    redirect: 'manual',
    cache: 'no-store',
  });
}

function localD1(sql) {
  assert.ok(enabled);
  const stdout = execFileSync(process.execPath, [
    resolve('node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', databaseName,
    '--local', '--config', resolve(config), '--persist-to', resolve(persist), '--command', sql, '--json',
  ], { cwd: process.cwd(), encoding: 'utf8', timeout: 30000, windowsHide: true });
  const start = stdout.indexOf('[\n');
  assert.notEqual(start, -1, 'local D1 returns JSON results');
  return JSON.parse(stdout.slice(start));
}

function domainCounts() {
  return localD1(
    'SELECT (SELECT COUNT(*) FROM bridge_captures) AS captures,' +
    '(SELECT COUNT(*) FROM bridge_inbox) AS inbox,' +
    '(SELECT COUNT(*) FROM bridge_jobs) AS jobs,' +
    '(SELECT COUNT(*) FROM bridge_capture_replays) AS replay_cache',
  )[0].results[0];
}

function businessSettings() {
  return localD1('SELECT revision,data_json FROM bridge_settings WHERE id=1')[0].results[0];
}

function syntheticEvent() {
  return {
    event: 'job.created',
    account: { id: 'INSPECTION_ACCOUNT_SENTINEL' },
    webhook_id: 'INSPECTION_WEBHOOK_SENTINEL',
    retry_count: 0,
    unknown_extension_sentinel: 'PRIVATE_EXTENSION_VALUE_SENTINEL',
    data: {
      id: 'INSPECTION_JOB_SENTINEL',
      customer: {
        name: 'INSPECTION_NAME_SENTINEL',
        email: 'INSPECTION_EMAIL_SENTINEL@example.invalid',
        phone: '+15555550123',
      },
      location: { address: 'INSPECTION_ADDRESS_SENTINEL' },
    },
  };
}

suite('receiver capture inspection is authenticated, freshly recomputed, redacted, and read-only', async () => {
  assert.deepEqual(domainCounts(), { captures: 0, inbox: 0, jobs: 0, replay_cache: 0 });
  const beforeSettings = businessSettings();
  const raw = JSON.stringify(syntheticEvent());
  const received = await fetch(url(`/webhooks/zenbooker?cap=${callbackToken}`), {
    method: 'POST',
    headers: { connection: 'close', 'content-type': 'application/json' },
    body: raw,
    redirect: 'manual',
    cache: 'no-store',
  });
  assert.equal(received.status, 200);
  const receipt = await json(received);
  assert.equal(receipt.received, true);
  assert.equal(receipt.disposition, 'quarantine');
  assert.equal(receipt.capture.available, true);
  const captureId = receipt.capture.id;
  assert.match(captureId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(domainCounts(), { captures: 1, inbox: 1, jobs: 0, replay_cache: 0 });

  const unauthenticated = await fetch(url('/bridge/captures/inspect'), {
    method: 'POST',
    headers: { connection: 'close', 'content-type': 'application/json' },
    body: JSON.stringify({ captureId }),
    redirect: 'manual',
    cache: 'no-store',
  });
  assert.equal(unauthenticated.status, 401);

  const wrongToken = await authenticated('/bridge/captures/inspect', {
    method: 'POST', body: { captureId }, token: 'f'.repeat(64),
  });
  assert.equal(wrongToken.status, 401);

  const malformed = await authenticated('/bridge/captures/inspect', { method: 'POST', body: { captureId, raw: 'NO' } });
  assert.equal(malformed.status, 400);
  const missing = await authenticated('/bridge/captures/inspect', { method: 'POST', body: { captureId: randomUUID() } });
  assert.ok(missing.status < 200 || missing.status >= 300);

  const settingsBeforeInspection = businessSettings();
  const beforeInspection = domainCounts();
  const nonce = randomUUID();
  const inspect = () => authenticated('/bridge/captures/inspect', { method: 'POST', body: { captureId }, nonce });
  const response = await inspect();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/i);
  assert.match(response.headers.get('x-content-type-options') ?? '', /nosniff/i);
  const result = await json(response);
  assert.deepEqual(Object.keys(result).sort(), ['businessEligible', 'capture', 'inspection', 'policy']);
  assert.deepEqual(Object.keys(result.capture).sort(), [
    'bodySha256', 'byteLength', 'capturedAt', 'configRevision', 'expiresAt', 'id', 'mode',
  ]);
  assert.deepEqual(Object.keys(result.policy).sort(), ['fingerprint', 'parserVersion', 'revision']);
  assert.deepEqual(Object.keys(result.inspection).sort(), [
    'disposition', 'event', 'fieldTypes', 'reason', 'schemaHash', 'unknownFieldCount', 'validationIssues',
  ]);
  assert.equal(result.capture.id, captureId);
  assert.equal(result.capture.bodySha256, digest(raw));
  assert.equal(result.capture.byteLength, Buffer.byteLength(raw));
  assert.equal(result.capture.mode, 'setup');
  assert.equal(result.businessEligible, false);
  assert.equal(result.policy.revision, beforeSettings.revision);
  assert.equal(result.policy.parserVersion, 'webhook-inspection-v2');
  assert.match(result.policy.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(result.inspection.disposition, 'quarantine');
  assert.equal(result.inspection.reason, 'schema_unverified');
  assert.equal(result.inspection.event, 'job.created');
  assert.equal(result.inspection.unknownFieldCount, 1);
  assert.ok(result.inspection.validationIssues.length <= 8);
  assert.deepEqual(domainCounts(), beforeInspection, 'inspection must not mutate captures, receipts, jobs or parser cache');
  assert.deepEqual(businessSettings(), settingsBeforeInspection, 'inspection must not change pins, mode or config revision');

  const serialized = JSON.stringify(result);
  for (const forbidden of [
    'INSPECTION_ACCOUNT_SENTINEL', 'INSPECTION_WEBHOOK_SENTINEL', 'INSPECTION_JOB_SENTINEL',
    'INSPECTION_NAME_SENTINEL', 'INSPECTION_EMAIL_SENTINEL', 'INSPECTION_ADDRESS_SENTINEL',
    'unknown_extension_sentinel', 'PRIVATE_EXTENSION_VALUE_SENTINEL',
    'ciphertext', 'nonce', 'eventKey', 'keyVersion', 'accountId', 'webhookId', 'jobId',
    callbackToken, bearerToken,
  ]) assert.equal(serialized.includes(forbidden), false, `inspection response exposed ${forbidden}`);

  const replay = await inspect();
  assert.equal(replay.status, 409, 'reused receiver nonce remains rejected');

  assert.deepEqual(domainCounts(), beforeInspection, 'failed missing-capture inspection does not create parser or business rows');
});
