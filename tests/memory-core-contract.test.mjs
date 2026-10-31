import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localRequire = createRequire(import.meta.url);

async function loadMemoryCore() {
  const source = await readFile(path.join(root, 'lib/memory-core.ts'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const requireMock = (specifier) => {
    if (specifier === 'zod/v3') return localRequire('zod/v3');
    throw new Error(`Unexpected import in memory core: ${specifier}`);
  };
  new Function('require', 'module', 'exports', js)(requireMock, module, module.exports);
  return module.exports;
}

const core = await loadMemoryCore();
const nodeId = 'b0aa7f8e-e011-4b8c-a5dd-9554b78a9a2c';

test('memory create keeps interaction and shared curation as explicit separate namespaces', () => {
  const base = { title: 'Fall scheduling note', content: 'Preferred date requests should be reviewed promptly.' };
  assert.equal(core.memoryAdd.parse({ ...base, namespace: 'interaction' }).namespace, 'interaction');
  assert.equal(core.memoryAdd.parse({ ...base, namespace: 'curation' }).namespace, 'curation');
  assert.throws(() => core.memoryAdd.parse({ ...base, namespace: 'google_profile' }));
  assert.throws(() => core.memoryAdd.parse({ ...base, namespace: 'interaction', ownerSubject: 'another-user' }));
  assert.equal(core.memoryAdd.parse({ ...base, namespace: 'curation' }).provenance.source, 'manual');
});

test('memory edits and deletes require a selected record and positive revision', () => {
  assert.equal(core.memoryEdit.parse({
    nodeId, revision: 1, title: 'Updated scheduling note',
    content: 'Review the requested dates with the manager.',
    provenance: { source: 'manual', sourceId: null, window: null },
  }).revision, 1);
  assert.throws(() => core.memoryEdit.parse({ nodeId, revision: 0, title: 'Updated', content: 'Review dates' }));
  assert.throws(() => core.memoryIdentity.parse({ revision: 1 }));
  assert.throws(() => core.memoryIdentity.parse({ nodeId, revision: 1, purge: true }));
});

test('memory search bounds result size and strictly validates namespace and filters', () => {
  const parsed = core.memoryList.parse({ namespace: 'interaction' });
  assert.equal(parsed.limit, 50);
  assert.equal(parsed.deleted, false);
  assert.throws(() => core.memoryList.parse({ namespace: 'curation', limit: 1000 }));
  assert.throws(() => core.memoryList.parse({ namespace: 'interaction', includeAllPrincipals: true }));
});

test('memory graph links allow only declared directed relations and reject self-links', () => {
  assert.equal(core.memoryLink.parse({ fromId: nodeId, toId: '11111111-1111-4111-8111-111111111111', relation: 'supports' }).relation, 'supports');
  assert.throws(() => core.memoryLink.parse({ fromId: nodeId, toId: nodeId, relation: 'supports' }));
  assert.throws(() => core.memoryLink.parse({ fromId: nodeId, toId: '11111111-1111-4111-8111-111111111111', relation: 'owns' }));
});
