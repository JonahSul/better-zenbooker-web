import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const zod = require('zod/v3');

async function loadTs(relativePath, imports = {}) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (Object.hasOwn(imports, specifier)) return imports[specifier];
    if (specifier === 'zod/v3') return zod;
    throw new Error(`Unexpected import from ${relativePath}: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const bridge = await loadTs('integrations/zenbooker-bridge/core.ts', { zod, 'zod/v3': zod });
const capture = await loadTs('integrations/zenbooker-bridge/capture.ts', { zod, './core': bridge });
const inspection = await loadTs('integrations/zenbooker-bridge/capture-inspection.ts', {
  zod,
  './core': bridge,
});
const { captureInspectInput, captureInspectionResultSchema } = inspection;
const scheduleContract = await loadTs('lib/support-schedule.ts', { zod });
const inputBudget = await loadTs('lib/input-budget.ts');
const zenbookerCore = await loadTs('lib/zenbooker-core.ts', { zod, 'zod/v3': zod, './input-budget': inputBudget });
const providerDiagnostic = await loadTs('lib/zenbooker-provider-diagnostic.ts');
const zenbookerApiCore = await loadTs('lib/zenbooker-api-core.ts', {
  zod,
  './zenbooker-core': zenbookerCore,
  './zenbooker-provider-diagnostic': providerDiagnostic,
});
const purposeConsent = await loadTs('lib/purpose-consent-core.ts', { zod, 'zod/v3': zod });
const consentProof = await loadTs('lib/consent-proof.ts', { './purpose-consent-core': purposeConsent });
const elementMeasurement = await loadTs('lib/element-measurement-core.ts', {
  zod,
  'zod/v3': zod,
  './consent-proof': consentProof,
});
const ownerId = 'site-owner-fixture';
const captureId = '45df1ded-9c1c-4c54-8aa0-63a6f5dc69f0';
const safeResult = captureInspectionResultSchema.parse({
  capture: {
    id: captureId,
    bodySha256: 'a'.repeat(64),
    byteLength: 64,
    capturedAt: 1_800_000_000_000,
    expiresAt: 1_802_592_000_000,
    mode: 'setup',
    configRevision: 0,
  },
  policy: { revision: 0, fingerprint: 'b'.repeat(64), parserVersion: 'webhook-inspection-v2' },
  businessEligible: false,
  inspection: {
    disposition: 'quarantine',
    reason: 'schema_unverified',
    event: 'job.created',
    schemaHash: 'c'.repeat(64),
    fieldTypes: {
      event: 'string', account: 'object', 'account.id': 'string', webhook_id: 'string', retry_count: 'number',
      data: 'object', 'data.id': 'string', 'data.job_id': 'absent',
    },
    validationIssues: [],
    unknownFieldCount: 0,
  },
});

function responseJson(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', ...headers },
  });
}
function request(body, { origin = 'https://demo.invalid', method = 'POST', contentType = 'application/json' } = {}) {
  return new Request('https://demo.invalid/api/admin/hosted-booking/captures/inspect', {
    method,
    headers: { origin, ...(contentType ? { 'content-type': contentType } : {}) },
    ...(body === undefined || method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

let currentAdmin = { siteUserId: ownerId };
let inspectCalls = 0;
let inspectValue = safeResult;
const hostedRoute = await loadTs('lib/hosted-capture-inspection.ts', {
  './admin-auth-server': {
    getGoogleAdmin: async () => currentAdmin,
    rejected: (_request, message, status = 403) => responseJson({ error: message }, status),
    readSmallBody: async req => {
      const text = await req.text();
      if (Buffer.byteLength(text) > 8192) throw new Error('bounded');
      return text;
    },
    safeJson: responseJson,
  },
  './runtime-secrets': { secretRuntime: () => ({ SITE_OWNER_USER_ID: ownerId }) },
  './hosted-admin': {
    hostedBridgeService: () => ({ inspectCapture: async () => safeResult }),
  },
  '../integrations/zenbooker-bridge/capture-inspection': inspection,
});

async function callHosted(requestValue) {
  return hostedRoute.inspectHostedCapture(requestValue, {
    getAdmin: async () => currentAdmin,
    inspect: async value => {
      inspectCalls++;
      assert.deepEqual(value, { captureId });
      return inspectValue;
    },
  });
}

test('protected capture-inspection route requires verified Google admin, HTTPS and same origin before inspection', async () => {
  inspectCalls = 0;
  currentAdmin = null;
  assert.equal((await callHosted(request({ captureId }))).status, 403);

  currentAdmin = { siteUserId: ownerId, subject: 'fixture-google-subject', email: 'owner@example.invalid' };
  assert.equal((await callHosted(request({ captureId }, { origin: 'https://attacker.invalid' }))).status, 403);
  assert.equal((await callHosted(request({ captureId }, { origin: 'http://demo.invalid' }))).status, 403);
  assert.equal((await callHosted(request({ captureId }, { origin: null }))).status, 403);
  assert.equal((await callHosted(request({ captureId }, { method: 'GET' }))).status, 403);
  assert.equal(inspectCalls, 0, 'denied requests must not reach the bridge service');
});

test('protected route strictly validates one capture ID and returns only the safe DTO without cacheability', async () => {
  currentAdmin = { siteUserId: ownerId };
  inspectCalls = 0;
  for (const malformed of [
    {},
    { captureId: 'not-a-uuid' },
    { captureId, raw: 'FORBIDDEN_RAW_INPUT' },
  ]) assert.equal((await callHosted(request(malformed))).status, 400);
  assert.equal((await callHosted(request('{not-json'))).status, 400);
  const oversized = JSON.stringify({ captureId, padding: 'x'.repeat(8200) });
  assert.equal((await callHosted(request(oversized))).status, 400);
  assert.equal(inspectCalls, 0);

  const response = await callHosted(request({ captureId }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/i);
  const value = await response.json();
  assert.deepEqual(value, safeResult);
  assert.equal(inspectCalls, 1);

  inspectValue = { ...safeResult, raw: 'RAW_VALUE_SENTINEL' };
  const invalidProjection = await callHosted(request({ captureId }));
  assert.equal(invalidProjection.status, 503);
  const failureText = await invalidProjection.text();
  assert.equal(failureText.includes('RAW_VALUE_SENTINEL'), false);
  inspectValue = safeResult;
});

// The retired native Sites test coupled capture projection to a Site user ID.
// Machine-scoped MCP authentication and its current integration contract are covered by
// tests/hosted-bridge-worker.integration.test.mjs; the HTTP route and safe DTO stay covered above.

const bridgeStoreModule = await loadTs('lib/hosted-bridge-store.ts', {
  zod,
  './encrypted-value': { encryptValue: async () => '', decryptValue: async () => '', validEncryptionKey: () => true },
  '../integrations/zenbooker-bridge/core': bridge,
});
const bridgeClientModule = await loadTs('lib/hosted-bridge-client.ts', {
  zod,
  './hosted-bridge-runtime': { localHostedBridgeFetch: async () => { throw new Error('unexpected native bridge fetch'); } },
  './admin-auth-server': { getGoogleAdmin: async () => null },
  './hosted-bridge-store': bridgeStoreModule,
  '../integrations/zenbooker-bridge/core': bridge,
});
const hostedBridgeServiceModule = await loadTs('lib/hosted-bridge-service.ts', {
  '../integrations/zenbooker-bridge/capture-inspection': inspection,
  './hosted-booking-core': {
    HOSTED_SERVICE_IDS: ['synthetic-service'],
    buildHostedBookingUrl: () => 'https://widget.zenbooker.com/book/synthetic?embed=true',
  },
  zod,
  './hosted-bridge-store': bridgeStoreModule,
  './hosted-bridge-client': bridgeClientModule,
  '../integrations/zenbooker-bridge/core': bridge,
});

function serviceRow({ revision = 6, pendingJson = null } = {}) {
  const config = bridgeStoreModule.hostedBridgeConfiguration.parse({
    origin: bridgeStoreModule.APPROVED_BRIDGE_ORIGIN,
    mode: 'setup',
    pins: { accountId: null, webhookIds: [], eventScope: ['job.created'], schemaProfile: 'unverified' },
    refreshEnabled: false,
  });
  return { revision, pending_json: pendingJson, config_json: JSON.stringify(config) };
}

function makeHostedService({ rows, result = safeResult, fetchCalls } = {}) {
  let readIndex = 0;
  const store = {
    read: async () => rows[Math.min(readIndex++, rows.length - 1)],
    tokens: async () => ({ bearer: '2'.repeat(64), callback: '1'.repeat(64) }),
    pendingTokens: async () => { throw new Error('not expected'); },
  };
  const fetcher = async (target, init) => {
    fetchCalls.push({ url: String(target), method: init.method, body: init.body });
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return new hostedBridgeServiceModule.HostedBridgeService(
    store,
    bridgeStoreModule.APPROVED_BRIDGE_ORIGIN,
    fetcher,
    async () => {},
  );
}

test('Site service uses the pinned inspection endpoint and rechecks local revision/config after the response', async () => {
  const stableRow = serviceRow();
  const successfulCalls = [];
  const successful = makeHostedService({ rows: [stableRow, stableRow], fetchCalls: successfulCalls });
  const result = await successful.inspectCapture({ captureId });
  assert.deepEqual(result, safeResult);
  assert.equal(successfulCalls.length, 1);
  assert.equal(successfulCalls[0].url, `${bridgeStoreModule.APPROVED_BRIDGE_ORIGIN}/bridge/captures/inspect`);
  assert.equal(successfulCalls[0].method, 'POST');
  assert.deepEqual(JSON.parse(successfulCalls[0].body), { captureId });

  const changedCalls = [];
  const changed = makeHostedService({ rows: [stableRow, serviceRow({ revision: 7 })], fetchCalls: changedCalls });
  await assert.rejects(changed.inspectCapture({ captureId }));
  assert.equal(changedCalls.length, 1, 'revision drift after the remote response must withhold its result');

  const pendingCalls = [];
  const pending = makeHostedService({ rows: [serviceRow({ pendingJson: '{"pending":true}' })], fetchCalls: pendingCalls });
  await assert.rejects(pending.inspectCapture({ captureId }));
  assert.equal(pendingCalls.length, 0, 'pending credential rotation blocks inspection before the remote request');
});
