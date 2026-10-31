import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const source = await readFile(path.join(root, 'lib/service-offerings.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', compiled)((specifier) => {
  if (specifier === 'zod/v3') return require(specifier);
  if (specifier === './admin-auth-core') return { sha256: async () => 'a'.repeat(64) };
  throw new Error(`Unexpected service-offerings import: ${specifier}`);
}, loaded, loaded.exports);
const { offeringEntrySchema, offeringDraftInput, offeringPublishInput, offeringWithdrawInput } = loaded.exports;

const offeringId = '4d2dc7c8-5a8f-4a8b-8cdf-b6c5d0b0df10';
const snapshotId = '1a55b89a-c6bf-4057-bfc6-0ce6289367db';
const requestKey = '20cb71a6-69d4-45f3-9b2e-73fc148bcfa1';
const entry = { offeringId, name: 'Fall demo service', providerServiceId: null, providerIdVerified: false };

test('offering entries require a strict app UUID, bounded display name and explicit provider-ID verification', () => {
  assert.deepEqual(offeringEntrySchema.parse(entry), entry);
  assert.equal(offeringEntrySchema.safeParse({ ...entry, providerIdVerified: true }).success, false);
  assert.equal(offeringEntrySchema.safeParse({ ...entry, providerServiceId: 'bad/id' }).success, false);
  assert.equal(offeringEntrySchema.safeParse({ ...entry, offeringId: 'provider-service-id' }).success, false);
  assert.equal(offeringEntrySchema.safeParse({ ...entry, internalNotes: 'not public' }).success, false);
  assert.equal(offeringEntrySchema.safeParse({ ...entry, name: 'x'.repeat(121) }).success, false);
});

test('draft input is bounded and rejects duplicate offering IDs and extra caller-controlled fields', () => {
  const valid = { requestKey, expectedRevision: 0, source: 'owner_review', offerings: [entry] };
  assert.equal(offeringDraftInput.safeParse(valid).success, true);
  assert.equal(offeringDraftInput.safeParse({ ...valid, offerings: Array(31).fill(entry) }).success, false);
  assert.equal(offeringDraftInput.safeParse({ ...valid, offerings: [entry, entry] }).success, false);
  assert.equal(offeringDraftInput.safeParse({ ...valid, actor: 'caller-selected' }).success, false);
  assert.equal(offeringDraftInput.safeParse({ ...valid, offerings: [{ ...entry, imageUrl: 'https://example.test' }] }).success, false);
  assert.equal(offeringDraftInput.safeParse({ ...valid, expectedRevision: -1 }).success, false);
});

test('publish and withdraw inputs require exact snapshots and revisions', () => {
  assert.equal(offeringPublishInput.safeParse({ requestKey, expectedRevision: 1, snapshotId, expectedSnapshotRevision: 1 }).success, true);
  assert.equal(offeringPublishInput.safeParse({ requestKey, expectedRevision: 1, snapshotId, expectedSnapshotRevision: 0 }).success, false);
  assert.equal(offeringPublishInput.safeParse({ requestKey, expectedRevision: 1, snapshotId, expectedSnapshotRevision: 1, publish: true }).success, false);
  assert.equal(offeringWithdrawInput.safeParse({ requestKey, expectedRevision: 1 }).success, true);
  assert.equal(offeringWithdrawInput.safeParse({ requestKey, expectedRevision: 1, snapshotId }).success, false);
});
