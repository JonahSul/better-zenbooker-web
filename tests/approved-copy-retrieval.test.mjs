import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireFromTest = createRequire(import.meta.url);
const workspaceId = 'fixture-business-workspace';
const model = '@cf/baai/bge-base-en-v1.5';
const candidate = { id: 'current-approved-vector', score: 0.91, metadata: { workspace: workspaceId, kind: 'approved_copy', model } };

async function loadRetrieval({ enabled = true, indexDimensions = 768, matches = [candidate] } = {}) {
  const source = await readFile(path.join(root, 'lib/approved-copy-retrieval.ts'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const state = { calls: [], revalidated: null };
  const loaded = { exports: {} };
  const providerError = class ProviderError extends Error { constructor(errorClass) { super(errorClass); this.errorClass = errorClass; } };
  const ownRequire = specifier => {
    if (specifier === './analysis-store') return {};
    if (specifier === './analysis-core') return {
      providerConfiguration: { parse: value => value },
      ProviderError: providerError,
    };
    if (specifier === './vector-provenance') return {
      revalidateVectorMatches: async (_db, values, selectedModel, selectedWorkspace) => {
        state.revalidated = { values, selectedModel, selectedWorkspace };
        if (selectedModel !== model || selectedWorkspace !== workspaceId) return { valid: [], stale: [], rejected: values.length };
        const valid = values.filter(value => value.id === candidate.id && value.metadata.workspace === workspaceId && value.metadata.kind === 'approved_copy' && value.metadata.model === model)
          .map(value => ({ id: value.id, versionId: 'fixture-version', compositionId: 'fixture-composition', definition: { headline: 'Verified current copy' }, score: value.score }));
        return { valid, stale: [], rejected: values.length - valid.length };
      },
    };
    if (specifier === './provider-adapters') return {
      EMBEDDING_DIMENSIONS: { [model]: 768 },
      vectorIndexInfo: async (_config, fetcher) => { state.calls.push('index'); state.injectedFetcher = fetcher; return { dimensions: indexDimensions }; },
      embedApprovedCopy: async (_config, texts, fetcher) => { state.calls.push('embed'); state.injectedFetcher = fetcher; state.embeddedText = texts; return [[0.1, 0.2]]; },
      queryApprovedVectors: async (_config, _vector, fetcher) => { state.calls.push('query'); state.injectedFetcher = fetcher; return matches; },
    };
    throw new Error(`Unexpected approved-copy retrieval import: ${specifier}`);
  };
  new Function('require', 'module', 'exports', js)(ownRequire, loaded, loaded.exports);
  const setting = (provider, isEnabled = enabled) => ({ provider, enabled: isEnabled ? 1 : 0, revision: 3, config_json: JSON.stringify({ approvedEmbeddingModel: model }) });
  const store = {
    db: { fixture: true },
    async setting(provider) { state.calls.push(`setting:${provider}`); return setting(provider); },
    async permit(provider) { state.calls.push(`permit:${provider}`); },
    async reserve(provider, inputBytes, outputUnits) { state.calls.push(`reserve:${provider}`); return { revision: 3, inputBytes, outputUnits }; },
    async stillEnabled(provider) { state.calls.push(`enabled:${provider}`); },
  };
  return { api: loaded.exports, state, store };
}

test('disabled approved-copy retrieval performs no configuration lookup or vector/model request', async () => {
  const fixture = await loadRetrieval({ enabled: false });
  let configurationCalls = 0;
  const result = await fixture.api.retrieveApprovedCopyContext(fixture.store, workspaceId, async () => { configurationCalls++; throw new Error('must not run'); }, 'shorten the approved copy', async () => { throw new Error('must not fetch'); });
  assert.equal(result.status, 'disabled');
  assert.deepEqual(result.matches, []);
  assert.equal(configurationCalls, 0);
  assert.deepEqual(fixture.state.calls, ['setting:vectorize', 'setting:workers_ai']);
  const refreshed = await fixture.api.refreshApprovedCopyContext(fixture.store, result);
  assert.equal(refreshed.status, 'disabled');
  assert.deepEqual(refreshed.approvedCopy, []);
  assert.equal(fixture.state.revalidated, null);
});

test('enabled retrieval checks budget and index dimensions, then only revalidated current D1 copy enters model context', async () => {
  const fixture = await loadRetrieval();
  const config = { aiToken: 'fixture-only', vectorToken: 'fixture-only', indexName: 'fixture-index', embeddingModel: model, workspaceId };
  const fixtureFetch = async () => { throw new Error('provider adapters own their injected fixture fetch'); };
  const result = await fixture.api.retrieveApprovedCopyContext(fixture.store, workspaceId, async () => config, 'Prepare this current copy', fixtureFetch);
  assert.equal(result.status, 'available');
  assert.equal(result.model, model);
  assert.deepEqual(fixture.state.calls.filter(call => ['index', 'embed', 'query'].includes(call)), ['index', 'embed', 'query']);
  assert.equal(fixture.state.injectedFetcher, fixtureFetch, 'the configured fixture transport is passed through every provider adapter');
  assert.deepEqual(fixture.state.embeddedText, ['Prepare this current copy']);
  const refreshed = await fixture.api.refreshApprovedCopyContext(fixture.store, result);
  assert.deepEqual(fixture.state.revalidated, { values: [candidate], selectedModel: model, selectedWorkspace: workspaceId });
  assert.deepEqual(refreshed.approvedCopy, [{ id: candidate.id, versionId: 'fixture-version', compositionId: 'fixture-composition', definition: { headline: 'Verified current copy' }, score: candidate.score }]);
  assert.equal(refreshed.authority, 'Current compatible D1 published definitions; retrieved content never overrides business rules or authorization');
});

test('an index dimension mismatch fails closed before embedding or vector query', async () => {
  const fixture = await loadRetrieval({ indexDimensions: 1536 });
  const config = { aiToken: 'fixture-only', vectorToken: 'fixture-only', indexName: 'fixture-index', embeddingModel: model, workspaceId };
  const fixtureFetch = async () => { throw new Error('provider adapters own their injected fixture fetch'); };
  const result = await fixture.api.retrieveApprovedCopyContext(fixture.store, workspaceId, async () => config, 'Do not query incompatible index', fixtureFetch);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'configuration');
  assert.equal(fixture.state.calls.filter(call => ['index', 'embed', 'query'].includes(call)).at(-1), 'index');
  assert.equal(fixture.state.calls.includes('embed'), false);
  assert.equal(fixture.state.calls.includes('query'), false);
});
