import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

async function loadAdapters({enabled = false} = {}) {
  const source = await readFile(path.join(root, 'lib/provider-adapters.ts'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true},
  }).outputText;
  const state = {moduleChecks: 0, fetches: 0};
  class ProviderError extends Error { constructor(code) { super(code); this.code = code; } }
  const modules = {
    './input-budget': {assertCollectionBudget: value => value},
    'cloudflare:workers': {env: {}},
    './module-config': {
      async assertModule(_env, module) { assert.equal(module, 'vectorize'); state.moduleChecks++; if (!enabled) throw new ProviderError('module_disabled'); },
      async assertAi() { throw new ProviderError('ai_disabled'); },
    },
    'zod/v3': require('zod/v3'),
    './analysis-core': {modelName: {}, proposalInput: {}, ProviderError},
  };
  const loaded = {exports: {}};
  new Function('require', 'module', 'exports', js)((name) => {
    if (Object.hasOwn(modules, name)) return modules[name];
    throw new Error(`Unexpected provider-adapter dependency: ${name}`);
  }, loaded, loaded.exports);
  const fetcher = async () => {
    state.fetches++;
    return Response.json({success: true, result: {mutationId: 'cleanup-only'}});
  };
  return {api: loaded.exports, state, fetcher};
}

test('Vectorize reads and writes are gated while explicit vector deletion cleanup remains available', async () => {
  const {api, state, fetcher} = await loadAdapters();
  const config = {accountId: 'a'.repeat(32), workspaceId: 'test-installation', vectorToken: 'synthetic-token', indexName: 'test-index', embeddingModel: '@cf/baai/bge-base-en-v1.5'};
  const vector = {id: 'b'.repeat(64), values: Array(768).fill(0), metadata: {workspace: config.workspaceId, kind: 'application_memory', namespace: 'interaction', scope: 'private', node_id: 'synthetic-node', revision: 1, content_hash: 'c'.repeat(64), model: config.embeddingModel}};
  const denied = [
    () => api.vectorIndexInfo(config, fetcher),
    () => api.vectorIndexProgress(config, fetcher),
    () => api.getVectorIds(config, [vector.id], fetcher),
    () => api.queryMemoryVectors(config, Array(768).fill(0), 'interaction', 'private', fetcher),
    () => api.upsertMemoryVector(config, vector, fetcher),
  ];
  for (const operation of denied) await assert.rejects(operation, /module_disabled/);
  assert.equal(state.moduleChecks, denied.length);
  assert.equal(state.fetches, 0, 'disabled module must make zero Vectorize requests');

  const cleanup = await api.deleteVectorIds(config, [vector.id], fetcher);
  assert.equal(cleanup.mutationId, 'cleanup-only');
  assert.equal(cleanup.enqueued, true);
  assert.equal(state.fetches, 1, 'authorized tombstone cleanup remains possible when new vector work is disabled');
});
