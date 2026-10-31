import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

async function loadTs(relativePath, mocks = {}) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (specifier === 'zod/v3') return require('zod/v3');
    if (Object.hasOwn(mocks, specifier)) return mocks[specifier];
    throw new Error(`Unexpected import in ${relativePath}: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

test('the existing explicit retention operation invokes both bounded Contact and measurement cleanup primitives', async () => {
  const calls = [];
  class ContactStore {
    constructor(db, workspaceId) { calls.push({ kind: 'construct', db, workspaceId }); }
    async prune(limit) { calls.push({ kind: 'prune', limit }); return { erased: 2, canceledOutbox: 1 }; }
  }
  class ElementMeasurementStore {
    constructor(db, workspaceId) { calls.push({ kind: 'measurement-construct', db, workspaceId }); }
    async prune(limit) { calls.push({ kind: 'measurement-prune', limit }); return { deletedDocuments: 3, remaining: true }; }
  }
  const dbCalls = [];
  const db = {
    prepare(sql) {
      const statement = { sql, bind(...values) { this.values = values; dbCalls.push({ sql, values }); return this; }, async all() { return { results: [] }; } };
      return statement;
    },
  };
  const z = require('zod/v3').z;
  const loaded = await loadTs('lib/console-store.ts', {
    './public-reviews-url': { publicReviewsUrlInput: z.string().nullable() },
    './inquiry-validation': { updateInput: z.object({}), services: ['fixture'], areas: ['fixture'] },
    './contact-store': { ContactStore },
    './element-measurement-store': { ElementMeasurementStore },
  });
  const store = new loaded.ConsoleStore(db, 'fixture-workspace', 'verified-admin-subject', 'verified-admin-user');
  const result = await store.applyRetention();
  assert.deepEqual(calls, [
    { kind: 'construct', db, workspaceId: 'fixture-workspace' },
    { kind: 'prune', limit: 100 },
    { kind: 'measurement-construct', db, workspaceId: 'fixture-workspace' },
    { kind: 'measurement-prune', limit: 100 },
  ]);
  assert.deepEqual(result.contact, { erased: 2, canceledOutbox: 1 });
  assert.deepEqual(result.elementMeasurement, { deletedDocuments: 3, remaining: true });
  assert.deepEqual(result.interaction, null);
  assert.equal(result.bounded, true);
  assert.equal(dbCalls.length, 1, 'the existing retention-setting read is preserved; Contact cleanup delegates to the shared bounded store operation');
  assert.match(dbCalls[0].sql, /SELECT key,value_json,revision FROM admin_settings/);

  const adminTools = await readFile(path.join(root, 'lib/admin-tools.ts'), 'utf8');
  assert.match(adminTools, /'retention\.apply':tool\(z\.object\(\{\}\)\.strict\(\),async admin=>consoleStore\(admin\)\.applyRetention\(\)\)/);
  assert.match(adminTools, /if\(name==='retention\.apply'\)\{for\(const setting of await consoleStore\(admin\)\.settings\(\)\)/);
});
