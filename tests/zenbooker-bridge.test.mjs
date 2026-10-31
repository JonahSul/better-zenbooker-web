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
    throw new Error(`Unexpected import from ${relativePath}: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const bridge = await loadTs('integrations/zenbooker-bridge/core.ts', { zod, 'zod/v3': zod });

function envelope(overrides = {}) {
  return {
    event: 'job.created',
    account: { id: 'fixture-account' },
    webhook_id: 'fixture-webhook',
    retry_count: 0,
    data: {
      id: 'fixture-job',
      status: 'scheduled',
      customer: {
        name: 'Fixture Customer',
        email: 'fixture@example.invalid',
        phone: '+15555550123',
      },
      location: { address: 'Fixture Street, Billings, MT' },
    },
    ...overrides,
  };
}

test('webhook envelope strips unknown top-level extensions while preserving known-field validation', () => {
  const value = envelope();
  assert.equal(bridge.webhookEnvelopeSchema.safeParse(value).success, true);
  const extended = bridge.webhookEnvelopeSchema.safeParse({ ...value, unexpected_extension_sentinel: 'PRIVATE_EXTENSION_VALUE_SENTINEL' });
  assert.equal(extended.success, true);
  assert.equal(Object.hasOwn(extended.data, 'unexpected_extension_sentinel'), false);
  assert.equal(bridge.webhookEnvelopeSchema.safeParse({ ...value, retry_count: -1 }).success, false);
  assert.equal(bridge.webhookEnvelopeSchema.safeParse({ ...value, retry_count: 5 }).success, false);
  assert.equal(bridge.webhookEnvelopeSchema.safeParse({ ...value, data: 'not-an-object' }).success, false);
  assert.equal(bridge.webhookEnvelopeSchema.safeParse({ ...value, event: '' }).success, false);
  const missingEvent = { ...value };
  delete missingEvent.event;
  assert.equal(bridge.webhookEnvelopeSchema.safeParse(missingEvent).success, false);
  const missingRetry = { ...value };
  delete missingRetry.retry_count;
  assert.equal(bridge.webhookEnvelopeSchema.safeParse(missingRetry).success, false);
});

test('unknown root extensions are counted but never enter safe inspection or pinned projection', async () => {
  const value = envelope({ unexpected_extension_sentinel: 'PRIVATE_EXTENSION_VALUE_SENTINEL' });
  const pins = {
    accountId: 'fixture-account',
    webhookIds: ['fixture-webhook'],
    eventScope: ['job.created'],
    schemaProfile: 'unverified',
  };
  const inspected = await bridge.inspectWebhook(value, pins);
  assert.equal(inspected.disposition, 'quarantine');
  assert.equal(inspected.reason, 'schema_unverified');
  assert.equal(inspected.unknownFieldCount, 1);
  assert.equal(Object.keys(inspected.fieldTypes).length, 8);
  assert.deepEqual(pins, {
    accountId: 'fixture-account',
    webhookIds: ['fixture-webhook'],
    eventScope: ['job.created'],
    schemaProfile: 'unverified',
  });
  const serialized = JSON.stringify(inspected);
  assert.equal(serialized.includes('unexpected_extension_sentinel'), false);
  assert.equal(serialized.includes('PRIVATE_EXTENSION_VALUE_SENTINEL'), false);

  const verifiedPins = {
    ...pins,
    schemaProfile: {
      kind: 'owner_verified_v3',
      accountIdPath: 'account.id',
      jobIdPath: 'data.id',
      shapeHash: inspected.schemaHash,
    },
  };
  const verified = await bridge.inspectWebhook(value, verifiedPins);
  assert.equal(verified.disposition, 'accepted');
  assert.equal(verified.jobId, 'fixture-job');
  assert.equal(verified.unknownFieldCount, 1);
  assert.equal(JSON.stringify(verified).includes('PRIVATE_EXTENSION_VALUE_SENTINEL'), false);
});

test('canonical event hash ignores retry_count and webhook config ID but binds account, event and payload', async () => {
  const first = envelope({ retry_count: 0 });
  const retry = envelope({ retry_count: 4 });
  const hash = await bridge.canonicalWebhookHash(first);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(await bridge.canonicalWebhookHash(retry), hash);

  const reordered = {
    data: first.data,
    retry_count: 2,
    webhook_id: first.webhook_id,
    account: first.account,
    event: first.event,
  };
  assert.equal(await bridge.canonicalWebhookHash(reordered), hash);
  assert.notEqual(await bridge.canonicalWebhookHash(envelope({ event: 'job.canceled' })), hash);
  assert.equal(await bridge.canonicalWebhookHash(envelope({ webhook_id: 'another-webhook' })), hash);
  assert.notEqual(await bridge.canonicalWebhookHash(envelope({ account: { id: 'another-account' } })), hash);
  assert.notEqual(await bridge.canonicalWebhookHash(envelope({ data: { ...first.data, id: 'another-job' } })), hash);
});

test('capability verifier is a hash, and only the raw 256-bit token matches it', async () => {
  const raw = Buffer.alloc(32, 0x37).toString('hex');
  const verifier = await bridge.capabilityVerifier(raw);
  assert.match(verifier, /^[0-9a-f]{64}$/);
  assert.equal(await bridge.verifyCapability(raw, verifier), true);
  assert.equal(await bridge.verifyCapability('wrong-fixture-token', verifier), false);
  assert.equal(await bridge.verifyCapability(verifier, verifier), false);
  assert.notEqual(await bridge.capabilityVerifier(Buffer.alloc(32, 0x38).toString('hex')), verifier);
});

test('valid-looking payload stays quarantined while the owner has not verified the v3 schema', async () => {
  const value = envelope();
  const inspected = await bridge.inspectWebhook(value, {
    accountId: 'fixture-account',
    webhookIds: ['fixture-webhook'],
    eventScope: ['job.created', 'job.rescheduled', 'job.canceled'],
    schemaProfile: 'unverified',
  });

  assert.equal(inspected.disposition, 'quarantine');
  assert.equal(inspected.reason, 'schema_unverified');
  assert.equal(inspected.event, 'job.created');
  assert.equal(inspected.accountId === null || /^[a-zA-Z0-9_-]{1,128}$/.test(inspected.accountId), true);
  assert.equal(inspected.webhookId === null || /^[a-zA-Z0-9_-]{1,128}$/.test(inspected.webhookId), true);
  assert.equal(inspected.jobId === null || /^[a-zA-Z0-9_-]{1,128}$/.test(inspected.jobId), true);
  assert.match(inspected.schemaHash, /^[0-9a-f]{64}$/);
  assert.equal(typeof inspected.fieldTypes, 'object');
  assert.equal(JSON.stringify(inspected).includes('Fixture Customer'), false);
  assert.equal(JSON.stringify(inspected).includes('fixture@example.invalid'), false);
  assert.equal(JSON.stringify(inspected).includes('+15555550123'), false);
  assert.equal(JSON.stringify(inspected).includes('Fixture Street'), false);
  assert.equal(Object.hasOwn(inspected, 'data'), false);
  assert.equal(Object.hasOwn(inspected, 'raw'), false);
});

test('setup sample remains quarantined until an owner-pinned schema profile matches observed field types', async () => {
  const value = envelope();
  const setup = await bridge.inspectWebhook(value, {
    accountId: 'fixture-account',
    webhookIds: ['fixture-webhook'],
    eventScope: ['job.created'],
    schemaProfile: 'unverified',
  });
  assert.equal(setup.disposition, 'quarantine');
  assert.equal(setup.reason, 'schema_unverified');

  const pins = {
    accountId: 'fixture-account',
    webhookIds: ['fixture-webhook'],
    eventScope: ['job.created'],
    schemaProfile: {
      kind: 'owner_verified_v3',
      accountIdPath: 'account.id',
      jobIdPath: 'data.id',
      shapeHash: setup.schemaHash,
    },
  };
  const verified = await bridge.inspectWebhook(value, pins);
  assert.equal(verified.disposition, 'accepted');
  assert.equal(verified.reason, 'accepted');
  assert.equal(verified.accountId, 'fixture-account');
  assert.equal(verified.webhookId, 'fixture-webhook');
  assert.equal(verified.jobId, 'fixture-job');
  assert.equal(Object.hasOwn(verified, 'data'), false);
});

test('schema changes and pins outside the owner-reviewed profile fail closed', async () => {
  const observed = envelope();
  const setup = await bridge.inspectWebhook(observed, {
    accountId: null,
    webhookIds: [],
    eventScope: ['job.created', 'job.rescheduled', 'job.canceled'],
    schemaProfile: 'unverified',
  });
  const profile = {
    kind: 'owner_verified_v3',
    accountIdPath: 'account.id',
    jobIdPath: 'data.id',
    shapeHash: setup.schemaHash,
  };
  const basePins = {
    accountId: 'fixture-account',
    webhookIds: ['fixture-webhook'],
    eventScope: ['job.created'],
    schemaProfile: profile,
  };
  const changedShape = envelope({ data: { ...observed.data, id: 42 } });
  assert.equal((await bridge.inspectWebhook(changedShape, basePins)).reason, 'schema_mismatch');
  assert.equal((await bridge.inspectWebhook(observed, { ...basePins, accountId: 'other-account' })).reason, 'account_mismatch');
  assert.equal((await bridge.inspectWebhook(observed, { ...basePins, webhookIds: ['other-hook'] })).reason, 'webhook_mismatch');
  assert.equal((await bridge.inspectWebhook(observed, { ...basePins, eventScope: ['job.canceled'] })).reason, 'event_out_of_scope');
});

test('unknown event and pinned account or webhook mismatch quarantine without echoing values', async () => {
  const pins = {
    accountId: 'fixture-account',
    webhookIds: ['fixture-webhook'],
    eventScope: ['job.created', 'job.rescheduled', 'job.canceled'],
    schemaProfile: 'unverified',
  };
  const cases = [
    envelope({ event: 'invoice_payment.succeeded' }),
    envelope({ account: { id: 'foreign-account' } }),
    envelope({ webhook_id: 'foreign-webhook' }),
    envelope({ data: { status: 'scheduled' } }),
  ];

  for (const payload of cases) {
    const result = await bridge.inspectWebhook(payload, pins);
    assert.equal(result.disposition, 'quarantine');
    assert.equal(typeof result.reason, 'string');
    assert.equal(JSON.stringify(result).includes('fixture@example.invalid'), false);
    assert.equal(JSON.stringify(result).includes('+15555550123'), false);
    assert.equal(Object.hasOwn(result, 'data'), false);
  }
});
