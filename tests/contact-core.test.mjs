import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

async function loadTs(relativePath) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (specifier === 'zod/v3') return require('zod/v3');
    throw new Error(`Unexpected import in ${relativePath}: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const core = await loadTs('lib/contact-core.ts');
const requestKey = 'd1000000-0000-4000-8000-000000000001';
const contactId = 'd2000000-0000-4000-8000-000000000001';

test('contact submissions use one workspace-scoped 100-new-per-hour quota', () => {
  assert.equal(core.CONTACT_RATE_WINDOW_MS, 60 * 60 * 1000);
  assert.equal(core.CONTACT_RATE_LIMIT, 100);
  assert.equal(typeof core.ContactRateLimitError, 'function');
  const error = new core.ContactRateLimitError(73);
  assert.equal(error.message, 'contact_rate_limited');
  assert.equal(error.retryAfter, 73);
});

test('public contact input trims and bounds fields while rejecting controls and extra keys', () => {
  const valid = core.contactMessageInput.parse({
    requestKey,
    name: '  Casey Customer  ',
    email: '  casey@example.invalid  ',
    message: '  Please call about spring service.\nThank you.  ',
  });
  assert.deepEqual(valid, {
    requestKey,
    name: 'Casey Customer',
    email: 'casey@example.invalid',
    message: 'Please call about spring service.\nThank you.',
  });
  for (const invalid of [
    { requestKey, name: '', email: 'casey@example.invalid', message: 'hello' },
    { requestKey, name: 'x'.repeat(81), email: 'casey@example.invalid', message: 'hello' },
    { requestKey, name: 'Casey\rCustomer', email: 'casey@example.invalid', message: 'hello' },
    { requestKey, name: 'Casey\u0001', email: 'casey@example.invalid', message: 'hello' },
    { requestKey, name: 'Casey', email: 'invalid', message: 'hello' },
    { requestKey, name: 'Casey', email: `${'x'.repeat(245)}@example.test`, message: 'hello' },
    { requestKey, name: 'Casey', email: 'casey@example.invalid', message: '' },
    { requestKey, name: 'Casey', email: 'casey@example.invalid', message: 'x'.repeat(4001) },
    { requestKey, name: 'Casey', email: 'casey@example.invalid', message: 'bad\u0000message' },
    { requestKey, name: 'Casey', email: 'casey@example.invalid', message: 'hello', recipient: 'attacker@example.invalid' },
    { requestKey: 'not-a-uuid', name: 'Casey', email: 'casey@example.invalid', message: 'hello' },
  ]) assert.equal(core.contactMessageInput.safeParse(invalid).success, false);
});

test('owner status and delete operations require an owned UUID and positive expected revision', () => {
  assert.deepEqual(core.contactStatusInput.parse({ id: contactId, expectedRevision: 1, status: 'read' }), {
    id: contactId, expectedRevision: 1, status: 'read',
  });
  assert.deepEqual(core.contactDeleteInput.parse({ id: contactId, expectedRevision: 1 }), {
    id: contactId, expectedRevision: 1,
  });
  for (const invalid of [
    { id: contactId, expectedRevision: 0, status: 'read' },
    { id: contactId, expectedRevision: 1, status: 'booked' },
    { id: contactId, expectedRevision: 1, status: 'read', revenueCents: 100 },
  ]) assert.equal(core.contactStatusInput.safeParse(invalid).success, false);
  assert.equal(core.contactDeleteInput.safeParse({ id: contactId, expectedRevision: 0 }).success, false);
  assert.equal(core.contactDeleteInput.safeParse({ id: 'bad', expectedRevision: 1 }).success, false);
});

test('contact retention is exactly thirty days and model projection omits message/contact sentinels', () => {
  assert.equal(core.CONTACT_RETENTION_MS, 30 * 24 * 60 * 60 * 1000);
  const sentinel = 'PRIVATE_CONTACT_SENTINEL_7f39';
  const row = {
    id: contactId,
    revision: 1,
    status: 'new',
    createdAt: 1000,
    expiresAt: 1000 + core.CONTACT_RETENTION_MS,
    name: sentinel,
    email: `${sentinel}@example.invalid`,
    message: sentinel,
  };
  const projected = core.projectContactForModel([row], 2000);
  assert.deepEqual(projected, {
    count: 1,
    messages: [{ id: contactId, revision: 1, status: 'new', createdAt: 1000, expiresAt: 1000 + core.CONTACT_RETENTION_MS }],
    resultLink: '/admin/inquiries',
  });
  const serialized = JSON.stringify(projected);
  assert.ok(!serialized.includes(sentinel));
  assert.deepEqual(core.projectContactForModel([
    row,
    { ...row, id: 'broken', name: sentinel },
    { ...row, id: 'd3000000-0000-4000-8000-000000000001', expiresAt: 2000 },
    { ...row, id: 'd4000000-0000-4000-8000-000000000001', deletedAt: 1500 },
  ], 2000), projected, 'malformed, expired and deleted rows are omitted');
});
