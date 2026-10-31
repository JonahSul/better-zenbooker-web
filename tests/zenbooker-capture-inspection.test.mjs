import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, webcrypto } from 'node:crypto';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const zod = require('zod/v3');
globalThis.crypto ??= webcrypto;

async function loadTs(relativePath, imports = {}) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (Object.hasOwn(imports, specifier)) return imports[specifier];
    throw new Error(`Unexpected import from ${relativePath}: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const bridge = await loadTs('integrations/zenbooker-bridge/core.ts', { zod, 'zod/v3': zod });
const capture = await loadTs('integrations/zenbooker-bridge/capture.ts', { zod, 'zod/v3': zod, './core': bridge });
const inspection = await loadTs('integrations/zenbooker-bridge/capture-inspection.ts', {
  zod,
  'zod/v3': zod,
  './core': bridge,
});
const { inspectRetainedCapture, captureInspectionResultSchema, captureInspectInput } = inspection;

const now = 1_800_000_000_000;
const metadata = {
  id: '45df1ded-9c1c-4c54-8aa0-63a6f5dc69f0',
  eventKey: 'e'.repeat(64),
  bodySha256: 'b'.repeat(64),
  keyVersion: 'v1',
  namespace: capture.CAPTURE_NAMESPACE,
  parserPolicyVersion: 'webhook-inspection-v1',
  mode: 'setup',
  configRevision: 1,
  byteLength: 300,
  capturedAt: now - 100,
  expiresAt: now + capture.CAPTURE_TTL_MS,
};
const payload = {
  event: 'job.created',
  account: { id: 'ACCOUNT_VALUE_SENTINEL' },
  webhook_id: 'WEBHOOK_VALUE_SENTINEL',
  retry_count: 0,
  unknown_extension_sentinel: 'PRIVATE_EXTENSION_VALUE_SENTINEL',
  data: {
    id: 'JOB_VALUE_SENTINEL',
    customer: { name: 'CUSTOMER_NAME_SENTINEL', email: 'PERSONAL_SENTINEL@example.invalid' },
    location: { address: 'ADDRESS_SENTINEL' },
  },
};
const raw = Buffer.from(JSON.stringify(payload));
metadata.byteLength = raw.byteLength;
metadata.bodySha256 = createHash('sha256').update(raw).digest('hex');
const basePins = {
  accountId: 'ACCOUNT_VALUE_SENTINEL',
  webhookIds: ['WEBHOOK_VALUE_SENTINEL'],
  eventScope: ['job.created'],
  schemaProfile: 'unverified',
};
const policy = (revision, pins = basePins, mode = 'setup') => ({
  revision,
  mode,
  pins,
  refreshEnabled: false,
});
function dependencies({
  row = metadata,
  rows,
  policies,
  bytes = raw,
  decryptError,
} = {}) {
  let readIndex = 0;
  let policyIndex = 0;
  let decryptCalls = 0;
  return {
    get decryptCalls() { return decryptCalls; },
    readCapture: async () => {
      if (rows) return rows[Math.min(readIndex++, rows.length - 1)];
      return row;
    },
    decrypt: async () => {
      decryptCalls++;
      if (decryptError) throw decryptError;
      return new Uint8Array(bytes);
    },
    readPolicy: async () => {
      if (policies) return policies[Math.min(policyIndex++, policies.length - 1)];
      return policy(4);
    },
    now: () => now,
  };
}

test('fresh retained-capture inspection returns only bounded safe metadata and fixed structural diagnostics', async () => {
  const deps = dependencies();
  const result = await inspectRetainedCapture({ captureId: metadata.id }, deps);

  assert.deepEqual(captureInspectInput.parse({ captureId: metadata.id }), { captureId: metadata.id });
  assert.equal(captureInspectionResultSchema.safeParse(result).success, true);
  assert.deepEqual(Object.keys(result).sort(), ['businessEligible', 'capture', 'inspection', 'policy']);
  assert.deepEqual(Object.keys(result.capture).sort(), [
    'bodySha256', 'byteLength', 'capturedAt', 'configRevision', 'expiresAt', 'id', 'mode',
  ]);
  assert.deepEqual(Object.keys(result.policy).sort(), ['fingerprint', 'parserVersion', 'revision']);
  assert.deepEqual(Object.keys(result.inspection).sort(), [
    'disposition', 'event', 'fieldTypes', 'reason', 'schemaHash', 'unknownFieldCount', 'validationIssues',
  ]);
  assert.equal(result.capture.bodySha256, metadata.bodySha256);
  assert.equal(result.capture.byteLength, metadata.byteLength);
  assert.equal(result.capture.mode, 'setup');
  assert.equal(result.businessEligible, false);
  assert.equal(result.policy.revision, 4);
  assert.equal(result.policy.parserVersion, 'webhook-inspection-v2');
  assert.equal(result.inspection.disposition, 'quarantine');
  assert.equal(result.inspection.unknownFieldCount, 1);
  assert.equal(metadata.parserPolicyVersion, 'webhook-inspection-v1', 'inspection must not rewrite historical capture metadata');
  assert.deepEqual(Object.keys(result.inspection.fieldTypes).sort(), [
    'account', 'account.id', 'data', 'data.id', 'data.job_id', 'event', 'retry_count', 'webhook_id',
  ]);
  assert.ok(Object.keys(result.inspection.fieldTypes).every(key =>
    ['absent', 'null', 'array', 'string', 'number', 'boolean', 'object'].includes(result.inspection.fieldTypes[key])));
  assert.ok(result.inspection.validationIssues.length <= 8);
  assert.equal(deps.decryptCalls, 1);

  const serialized = JSON.stringify(result);
  for (const forbidden of [
    'ACCOUNT_VALUE_SENTINEL', 'WEBHOOK_VALUE_SENTINEL', 'JOB_VALUE_SENTINEL',
    'CUSTOMER_NAME_SENTINEL', 'PERSONAL_SENTINEL', 'ADDRESS_SENTINEL',
    'unknown_extension_sentinel', 'PRIVATE_EXTENSION_VALUE_SENTINEL',
    'eventKey', 'keyVersion', 'ciphertext', 'nonce', 'accountId', 'webhookId', 'jobId',
  ]) assert.equal(serialized.includes(forbidden), false, `safe inspection exposed ${forbidden}`);

  assert.equal(captureInspectionResultSchema.safeParse({ ...result, raw: 'FORBIDDEN_EXTRA_FIELD' }).success, false);
});

test('fresh inspection re-evaluates current pins rather than returning a parser-version cache result', async () => {
  const firstDeps = dependencies({ policies: [policy(2), policy(2)] });
  const first = await inspectRetainedCapture({ captureId: metadata.id }, firstDeps);
  assert.equal(first.inspection.reason, 'schema_unverified');
  assert.equal(first.businessEligible, false);

  const shape = first.inspection.schemaHash;
  const verifiedPins = {
    accountId: 'ACCOUNT_VALUE_SENTINEL',
    webhookIds: ['different-webhook'],
    eventScope: ['job.created'],
    schemaProfile: { kind: 'owner_verified_v3', accountIdPath: 'account.id', jobIdPath: 'data.id', shapeHash: shape },
  };
  const mismatch = await inspectRetainedCapture(
    { captureId: metadata.id },
    dependencies({ policies: [policy(3, verifiedPins), policy(3, verifiedPins)] }),
  );
  assert.equal(mismatch.inspection.reason, 'webhook_mismatch');
  assert.equal(mismatch.policy.revision, 3);
  assert.notEqual(mismatch.policy.fingerprint, first.policy.fingerprint);

  const currentPins = { ...verifiedPins, webhookIds: ['WEBHOOK_VALUE_SENTINEL'] };
  const current = await inspectRetainedCapture(
    { captureId: metadata.id },
    dependencies({ policies: [policy(4, currentPins), policy(4, currentPins)] }),
  );
  assert.equal(current.inspection.disposition, 'accepted');
  assert.equal(current.inspection.reason, 'accepted');
  assert.equal(current.businessEligible, false, 'a retained SETUP capture can never become eligible for live projection');
  assert.equal(current.policy.revision, 4);
  assert.notEqual(current.policy.fingerprint, mismatch.policy.fingerprint);
  assert.equal(JSON.stringify(current).includes('ACCOUNT_VALUE_SENTINEL'), false);
  assert.equal(JSON.stringify(current).includes('JOB_VALUE_SENTINEL'), false);
  assert.equal(current.inspection.unknownFieldCount, 1);
  assert.equal(JSON.stringify(current).includes('unknown_extension_sentinel'), false);
  assert.equal(JSON.stringify(current).includes('PRIVATE_EXTENSION_VALUE_SENTINEL'), false);
});

test('setup capture preserves the fresh parser result but is permanently ineligible for live projection', async () => {
  const first = await inspectRetainedCapture({ captureId: metadata.id }, dependencies());
  const currentPins = {
    accountId: 'ACCOUNT_VALUE_SENTINEL',
    webhookIds: ['WEBHOOK_VALUE_SENTINEL'],
    eventScope: ['job.created'],
    schemaProfile: {
      kind: 'owner_verified_v3', accountIdPath: 'account.id', jobIdPath: 'data.id', shapeHash: first.inspection.schemaHash,
    },
  };
  const result = await inspectRetainedCapture(
    { captureId: metadata.id },
    dependencies({ policies: [policy(5, currentPins), policy(5, currentPins)] }),
  );
  assert.equal(result.inspection.disposition, 'accepted');
  assert.equal(result.inspection.reason, 'accepted');
  assert.equal(result.businessEligible, false);

  const malformedRaw = Buffer.from(JSON.stringify({
    ...payload,
    event: 17,
    account: null,
    validation_private_SENTINEL: 'PRIVATE_VALUE_SENTINEL',
  }));
  const malformed = await inspectRetainedCapture(
    { captureId: metadata.id },
    dependencies({
      row: {
        ...metadata,
        byteLength: malformedRaw.byteLength,
        bodySha256: createHash('sha256').update(malformedRaw).digest('hex'),
      },
      bytes: malformedRaw,
      policies: [policy(5), policy(5)],
    }),
  );
  assert.equal(malformed.inspection.disposition, 'quarantine');
  assert.equal(malformed.inspection.reason, 'envelope_invalid');
  assert.equal(malformed.businessEligible, false);
  assert.ok(malformed.inspection.validationIssues.length <= 8);
  assert.equal(JSON.stringify(malformed).includes('PRIVATE_VALUE_SENTINEL'), false);
  assert.equal(JSON.stringify(malformed).includes('validation_private_SENTINEL'), false);
});

test('inspection fails closed when capture, key, expiry, or JSON is unavailable', async () => {
  const missing = dependencies({ row: null });
  await assert.rejects(inspectRetainedCapture({ captureId: metadata.id }, missing));
  assert.equal(missing.decryptCalls, 0);

  const expired = dependencies({ row: { ...metadata, expiresAt: now } });
  await assert.rejects(inspectRetainedCapture({ captureId: metadata.id }, expired));
  assert.equal(expired.decryptCalls, 0);

  const noKey = dependencies({ decryptError: new Error('LOCAL_KEY_SENTINEL') });
  await assert.rejects(inspectRetainedCapture({ captureId: metadata.id }, noKey));

  const malformed = dependencies({ bytes: Buffer.from('{"customer":"RAW_VALUE_SENTINEL"') });
  await assert.rejects(inspectRetainedCapture({ captureId: metadata.id }, malformed));
});

test('inspection refuses captures or policy that change while decrypting and parsing', async () => {
  const changedRow = dependencies({ rows: [metadata, { ...metadata, bodySha256: 'c'.repeat(64) }] });
  await assert.rejects(inspectRetainedCapture({ captureId: metadata.id }, changedRow));

  const changedPolicy = dependencies({ policies: [policy(7), policy(8)] });
  await assert.rejects(inspectRetainedCapture({ captureId: metadata.id }, changedPolicy));
});
