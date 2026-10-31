import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { enabledModuleFixture } from './fixtures/module-config-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { env: providerEnv, moduleConfig: providerModuleConfig } = enabledModuleFixture('ai', 'admin_chat', 'vectorize', 'analytics', 'google', 'search', 'experiments');
const requireFromTest = createRequire(import.meta.url);

async function loadTs(relative, overrides = {}) {
  const source = await readFile(path.join(root, relative), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  const ownRequire = specifier => {
    if (Object.hasOwn(overrides, specifier)) return overrides[specifier];
    if (specifier === 'zod/v3' && Object.hasOwn(overrides, 'zod')) return overrides.zod;
    if (specifier === 'zod/v3') return requireFromTest(specifier);
    throw new Error(`Unexpected ${relative} import: ${specifier}`);
  };
  new Function('require', 'module', 'exports', js)(ownRequire, loaded, loaded.exports);
  return loaded.exports;
}

const experimentCore = await loadTs('lib/experiment-core.ts');
const sourceBinding = await loadTs('lib/analytics-source-binding.ts');
const analysisCore = await loadTs('lib/analysis-core.ts', { './experiment-core': experimentCore, './analytics-source-binding': sourceBinding });
const inputBudget = await loadTs('lib/input-budget.ts');
const providerAdapters = await loadTs('lib/provider-adapters.ts', {
  './analysis-core': analysisCore,
  './input-budget': inputBudget,
  'cloudflare:workers': { env: providerEnv },
  './module-config': providerModuleConfig,
});

const approvedDefinition = {
  headline: 'Prepare your demo system for fall',
  cta: 'Request a preferred date',
  processLayout: 'steps',
  order: ['hero', 'services', 'coverage', 'process', 'reviews', 'request', 'questions'],
};
const modelResponse = (definition = approvedDefinition) => new Response(JSON.stringify({
  success: true,
  result: { response: JSON.stringify({ definition, rationale: 'The measured cohort is small; test one clear request path.' }), usage: { prompt_tokens: 100, completion_tokens: 40 } },
}), { status: 200, headers: { 'content-type': 'application/json' } });

function fakeStore({ reserveError, revisionError } = {}) {
  const runs = new Map();
  const recommendations = new Map();
  const gates = [];
  const records = [];
  const setting = {
    provider: 'workers_ai', enabled: 1, revision: 3,
    config_json: JSON.stringify({ ...analysisCore.DEFAULT_PROVIDER_CONFIG, approvedModel: providerAdapters.GENERATION_MODELS[0], outputTokenLimit: 400 }),
  };
  const store = {
    db: {}, runs, recommendations, gates, records,
    async setting(provider) {
      if (provider === 'workers_ai') return setting;
      return { provider, enabled: 0, revision: 0, config_json: JSON.stringify(analysisCore.DEFAULT_PROVIDER_CONFIG) };
    },
    async snapshots() { return []; },
    async prompt() { return null; },
    async permit(provider) { gates.push(`permit:${provider}`); },
    async reserve(provider) {
      gates.push(`reserve:${provider}`);
      if (reserveError) throw reserveError;
      return { revision: setting.revision, outputTokenLimit: 400 };
    },
    async stillEnabled(provider) {
      gates.push(`stillEnabled:${provider}`);
      if (revisionError) throw revisionError;
    },
    async record(...args) { records.push(args); },
    statement(sql, ...args) {
      return {
        async run() {
          if (sql.startsWith('INSERT OR IGNORE INTO analysis_runs')) {
            const [id, idempotencyKey, inputHash, versionId, mode, inputJson, createdBy, createdAt] = args;
            if (runs.has(idempotencyKey)) return { meta: { changes: 0 } };
            runs.set(idempotencyKey, { id, idempotency_key: idempotencyKey, input_hash: inputHash, version_id: versionId, mode, status: 'running', input_json: inputJson, created_by: createdBy, created_at: createdAt, result_json: null });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith('INSERT INTO analysis_recommendations')) {
            const [id, runId, versionId, definitionJson, rationale, createdAt] = args;
            recommendations.set(id, { id, run_id: runId, version_id: versionId, definition_json: definitionJson, rationale, status: 'proposed', created_at: createdAt });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith('UPDATE analysis_runs SET status=')) {
            const [resultJson, completedAt, id] = args;
            const row = [...runs.values()].find(item => item.id === id);
            if (row?.status === 'running') Object.assign(row, { status: 'completed', result_json: resultJson, completed_at: completedAt });
            return { meta: { changes: row?.status === 'completed' ? 1 : 0 } };
          }
          throw new Error(`Unexpected fake SQL run: ${sql}`);
        },
        async first() {
          if (sql.startsWith('SELECT * FROM analysis_runs WHERE id=?')) return [...runs.values()].find(row => row.id === args[0]) ?? null;
          if (sql.startsWith('SELECT * FROM analysis_runs WHERE idempotency_key=?')) return runs.get(args[0]) ?? null;
          throw new Error(`Unexpected fake SQL first: ${sql}`);
        },
        async all() { return { results: [] }; },
      };
    },
  };
  return store;
}

async function batchServiceFor(store, fetcher) {
  const batchModule = await loadTs('lib/batch-service.ts', {
    './vector-provenance': { revalidateVectorMatches: async () => ({ valid: [], stale: [], rejected: 0 }) },
    'cloudflare:workers': { env: providerEnv },
    './analysis-store': { AnalysisStore: class {} },
    './experiment-store': { ExperimentStore: class { async version(id) { return { version: { id, stage: 'running' }, compositions: [] }; } async metrics() { return { from: 100, to: 200, asOf: 200, rows: [] }; } } },
    './analysis-core': analysisCore,
    './input-budget': inputBudget,
    './memory-vector-service': { MemoryVectorService: class { constructor() { throw new Error('unexpected vector service construction'); } } },
    './memory-store': { MemoryStore: class { constructor() { throw new Error('unexpected memory store construction'); } } },
    './model-projection': {
      revalidateMemoryEvidence: async () => ({ uncertain: false, value: [] }),
      redactModelContext: async () => ({ uncertain: false, value: [] }),
    },
    './module-config': providerModuleConfig,
    './approved-copy-retrieval': {
      retrieveApprovedCopyContext: async () => { throw new Error('unexpected vector retrieval in draft-only batch fixture'); },
      refreshApprovedCopyContext: async () => { throw new Error('unexpected vector refresh in draft-only batch fixture'); },
    },
    './provider-adapters': { ...providerAdapters, embedApprovedCopy: async () => [], upsertApprovedVectors: async () => ({}), vectorIndexInfo: async () => ({ dimensions: 768 }), queryApprovedVectors: async () => [], deleteVectorIds: async () => ({}) },
    './runtime-secrets': { credentialStore: () => ({ resolve: async () => null }), secretRuntime: () => ({}) },
    './admin-auth-core': { sha256: async value => `hash:${value}` },
    './public-compiler': { compilePublicDocument: async () => ({ hash: 'a'.repeat(64), html: '<main></main>', rendererVersion: 'test', assetManifestHash: 'b'.repeat(64) }), publicArtifacts: { body: '<h1>Demo Business</h1>', assetManifestHash: 'b'.repeat(64) } },
    './experiment-core': experimentCore,
  });
  return new batchModule.BatchService(store, async () => ({
    accountId: 'a'.repeat(32), aiToken: 'fixture-token-never-real', model: providerAdapters.GENERATION_MODELS[0],
  }), fetcher);
}

const batchInput = () => ({ versionId: '123e4567-e89b-42d3-a456-426614174000', from: 100, to: 200, asOf: 200, mode: 'real', idempotencyKey: 'qa-batch-service-key-0001' });

test('configured AI path calls the injected provider after gates and stores a proposal without compiling or publishing it', async () => {
  const store = fakeStore();
  const calls = [];
  const service = await batchServiceFor(store, async (url, init) => {
    calls.push({ url, init });
    return modelResponse();
  });
  const row = await service.run(batchInput(), 'qa-admin-subject');
  assert.equal(row.status, 'completed');
  const result = JSON.parse(row.result_json);
  assert.equal(result.ai.status, 'draft_proposed');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/ai\/run\/@cf\/meta\/llama-3\.3-70b-instruct-fp8-fast$/);
  assert.deepEqual(store.gates.slice(0, 3), ['permit:workers_ai', 'reserve:workers_ai', 'stillEnabled:workers_ai']);
  assert.equal(store.recommendations.size, 1);
  const recommendation = [...store.recommendations.values()][0];
  assert.equal(recommendation.status, 'proposed');
  assert.equal(JSON.parse(recommendation.definition_json).headline, approvedDefinition.headline);
  assert.equal(store.records.at(-1)[1], 'healthy');

  const retry = await service.run(batchInput(), 'qa-admin-subject');
  assert.equal(retry.id, row.id);
  assert.equal(calls.length, 1, 'same idempotency key does not invoke the model twice');
  assert.equal(store.recommendations.size, 1);
});

test('invalid model output is rejected without a proposal or draft acceptance', async () => {
  const store = fakeStore();
  const service = await batchServiceFor(store, async () => modelResponse({ headline: 'Call 555-010-0111 now' }));
  const row = await service.run({ ...batchInput(), idempotencyKey: 'qa-batch-invalid-output-01' }, 'qa-admin-subject');
  const result = JSON.parse(row.result_json);
  assert.equal(result.ai.status, 'unavailable');
  assert.equal(result.ai.errorClass, 'schema');
  assert.equal(store.recommendations.size, 0);
  assert.equal(row.status, 'completed', 'a rejected provider result is recorded as unavailable evidence');
});

test('revision and budget guards refuse provider execution before fetch', async t => {
  await t.test('configuration revision changed before call', async () => {
    const store = fakeStore({ revisionError: new analysisCore.ProviderError('disabled') });
    let calls = 0;
    const service = await batchServiceFor(store, async () => { calls++; return modelResponse(); });
    const row = await service.run({ ...batchInput(), idempotencyKey: 'qa-batch-revision-gate-01' }, 'qa-admin-subject');
    assert.equal(JSON.parse(row.result_json).ai.errorClass, 'disabled');
    assert.equal(calls, 0);
    assert.equal(store.recommendations.size, 0);
  });
  await t.test('daily budget refused before call', async () => {
    const store = fakeStore({ reserveError: new analysisCore.ProviderError('budget') });
    let calls = 0;
    const service = await batchServiceFor(store, async () => { calls++; return modelResponse(); });
    const row = await service.run({ ...batchInput(), idempotencyKey: 'qa-batch-budget-gate-01' }, 'qa-admin-subject');
    assert.equal(JSON.parse(row.result_json).ai.errorClass, 'budget');
    assert.equal(calls, 0);
    assert.equal(store.recommendations.size, 0);
  });
});
