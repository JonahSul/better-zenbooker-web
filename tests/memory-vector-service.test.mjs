import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localRequire = createRequire(import.meta.url);
const workspace = 'fixture-workspace-123';
const accountId = 'a'.repeat(32);
const model = '@cf/baai/bge-base-en-v1.5';

async function sha256(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
}

function loadService(adapterState) {
  const ProviderError = class ProviderError extends Error { constructor(errorClass) { super(errorClass); this.errorClass = errorClass; } };
  class AnalysisStore { constructor() {} }
  class MemoryStore { constructor() {} }
  const adapterMocks = {
    embedApprovedCopy: async (_config, texts) => { adapterState.embeds++; assert.equal(texts.length, 1); return [Array(768).fill(0.25)]; },
    queryMemoryVectors: async (_config, _vector, namespace, scope) => { adapterState.queries.push({ namespace, scope }); return adapterState.matches[namespace] ?? []; },
  };
  const sourcePath = path.join(root, 'lib/memory-vector-service.ts');
  return readFile(sourcePath, 'utf8').then(source => {
    const js = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const module = { exports: {} };
    const modules = {
      'zod/v3': localRequire('zod/v3'),
      zod: localRequire('zod/v3'),
      './analysis-store': { AnalysisStore },
      './memory-store': { MemoryStore },
      './admin-auth-core': { sha256 },
      './analysis-core': { providerConfiguration: { parse: value => value }, ProviderError },
      './provider-adapters': { EMBEDDING_DIMENSIONS: { [model]: 768 }, ...adapterMocks },
      './model-projection': { redactModelContext: async (_db, _siteUserId, input) => ({ value: input, redacted: false, uncertain: false }) },
    };
    new Function('require', 'module', 'exports', js)(specifier => {
      if (!Object.hasOwn(modules, specifier)) throw new Error(`Unexpected memory vector dependency: ${specifier}`);
      return modules[specifier];
    }, module, module.exports);
    return module.exports.MemoryVectorService;
  });
}

function makeNode({ id, namespace, revision = 1, title = 'Verified note', content = 'Approved informational content.', tombstoned = null }) {
  return { id, namespace, current_revision: revision, tombstoned_at: tombstoned, title, content, provenance_json: '{}', created_at: 1, updated_at: 1 };
}

async function makeService({ subject, scope, nodes, matches, enabled = true }) {
  const state = { embeds: 0, queries: [], matches };
  const MemoryVectorService = await loadService(state);
  const config = { accountId, workspaceId: workspace, aiToken: 'fixture-ai-token', vectorToken: 'fixture-vector-token', indexName: 'fixture-index', embeddingModel: model };
  const service = new MemoryVectorService({}, workspace, subject, 'fixture-site-user', async () => config, async () => { throw new Error('No provider fetch should occur in this injected helper test.'); });
  service.store.setting = async provider => ({
    enabled: enabled ? 1 : 0,
    revision: 1,
    config_json: JSON.stringify({ memoryNamespaces: ['interaction', 'curation'], approvedEmbeddingModel: model, dailyCallLimit: 5, dailyTokenLimit: 10000 }),
  });
  service.store.permit = async () => {};
  service.store.reserve = async () => ({ revision: 1, inputTokenLimit: 2000, dailyTokenLimit: 10000 });
  service.store.stillEnabled = async () => {};
  service.scopeToken = async namespace => namespace === 'curation' ? 'shared' : scope;
  const reads = [];
  service.memories.read = async id => {
    reads.push(id);
    const node = nodes.get(id);
    if (!node || node.namespace === 'interaction' && node.owner_subject !== subject) throw new Error('Memory unavailable in this principal scope');
    return node;
  };
  return { service, state, reads, config };
}

async function vectorMatch(node, { scope, workspaceId = workspace, revision = node.current_revision, contentHash, modelName = model, vectorId } = {}) {
  const hash = contentHash ?? await sha256(node.title + '\n' + node.content);
  const id = vectorId ?? await sha256(workspaceId + ':memory:v2:' + node.namespace + ':' + scope + ':' + node.id + ':' + revision + ':' + hash + ':' + modelName);
  return { id, score: 0.9, metadata: { workspace: workspaceId, kind: 'application_memory', namespace: node.namespace, scope, node_id: node.id, revision, content_hash: hash, model: modelName } };
}

test('private interaction vectors are isolated by Google principal and reject stale or foreign provenance', async () => {
  const aNode = makeNode({ id: 'a0aa7f8e-e011-4b8c-a5dd-9554b78a9a2c', namespace: 'interaction' });
  aNode.owner_subject = 'google-a';
  const otherNode = makeNode({ id: 'b0aa7f8e-e011-4b8c-a5dd-9554b78a9a2c', namespace: 'interaction' });
  otherNode.owner_subject = 'google-b';
  const foreignNode = makeNode({ id: 'c0aa7f8e-e011-4b8c-a5dd-9554b78a9a2c', namespace: 'interaction' });
  foreignNode.owner_subject = 'google-a';
  const valid = await vectorMatch(aNode, { scope: 'private-scope-a' });
  const wrongPrincipalScope = await vectorMatch(aNode, { scope: 'private-scope-b' });
  const foreignWorkspace = await vectorMatch(foreignNode, { scope: 'private-scope-a', workspaceId: 'other-workspace' });
  const staleHash = await vectorMatch(aNode, { scope: 'private-scope-a', contentHash: 'f'.repeat(64) });
  const staleRevision = await vectorMatch(aNode, { scope: 'private-scope-a', revision: 2 });
  const ownerA = await makeService({
    subject: 'google-a', scope: 'private-scope-a', nodes: new Map([[aNode.id, aNode]]),
    matches: { interaction: [valid, wrongPrincipalScope, foreignWorkspace, staleHash, staleRevision] },
  });
  const resultA = await ownerA.service.search('interaction', 'find the safe matching note');
  assert.equal(resultA.status, 'available');
  assert.deepEqual(resultA.nodes.map(node => node.id), [aNode.id]);
  assert.equal(resultA.rejected, 4);
  assert.deepEqual(ownerA.state.queries, [{ namespace: 'interaction', scope: 'private-scope-a' }]);

  const ownerB = await makeService({
    subject: 'google-b', scope: 'private-scope-b', nodes: new Map([[otherNode.id, otherNode]]),
    matches: { interaction: [valid, wrongPrincipalScope] },
  });
  const resultB = await ownerB.service.search('interaction', 'find a private note');
  assert.deepEqual(resultB.nodes, []);
  assert.equal(resultB.rejected, 2);
  assert.deepEqual(ownerB.reads, [aNode.id], 'a spoofed current scope can only trigger a principal-scoped D1 read, which must not return the other owner’s node');
});

test('shared curation uses a shared namespace token but still requires workspace and content proof', async () => {
  const node = makeNode({ id: 'd0aa7f8e-e011-4b8c-a5dd-9554b78a9a2c', namespace: 'curation' });
  const valid = await vectorMatch(node, { scope: 'shared' });
  const foreign = await vectorMatch(node, { scope: 'shared', workspaceId: 'other-workspace' });
  const owner = await makeService({ subject: 'google-b', scope: 'private-scope-b', nodes: new Map([[node.id, node]]), matches: { curation: [valid, foreign] } });
  const result = await owner.service.search('curation', 'find shared guidance');
  assert.equal(result.status, 'available');
  assert.deepEqual(result.nodes.map(value => value.id), [node.id]);
  assert.equal(result.rejected, 1);
  assert.deepEqual(owner.state.queries, [{ namespace: 'curation', scope: 'shared' }]);
});

test('disabled provider configuration falls back without embedding or querying Vectorize', async () => {
  const owner = await makeService({ subject: 'google-a', scope: 'private-scope-a', nodes: new Map(), matches: {}, enabled: false });
  const result = await owner.service.search('interaction', 'search without configured providers');
  assert.equal(result.status, 'disabled');
  assert.deepEqual(result.nodes, []);
  assert.equal(owner.state.embeds, 0);
  assert.equal(owner.state.queries.length, 0);
});
