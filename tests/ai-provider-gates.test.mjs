import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

async function loadProviders(mode) {
  const source = await readFile(path.join(root, 'lib/provider-adapters.ts'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true},
  }).outputText;
  const state = {aiChecks: [], aiRuns: 0, fetches: 0};
  class ProviderError extends Error { constructor(code) { super(code); this.code = code; } }
  const modules = {
    './input-budget': {assertCollectionBudget: value => value},
    'cloudflare:workers': {env: {AI: {run: async () => {state.aiRuns++; return {};}}}},
    './module-config': {
      async assertModule() {},
      async assertAi(_env, feature) {
        state.aiChecks.push(feature);
        if (mode === 'global_off' || mode === feature) throw new ProviderError(mode === 'global_off' ? 'global_ai_disabled' : 'feature_ai_disabled');
      },
    },
    'zod/v3': require('zod/v3'),
    './analysis-core': {modelName: {}, proposalInput: {}, ProviderError},
  };
  const loaded = {exports: {}};
  new Function('require', 'module', 'exports', js)((name) => {
    if (Object.hasOwn(modules, name)) return modules[name];
    throw new Error(`Unexpected provider-adapter dependency: ${name}`);
  }, loaded, loaded.exports);
  const fetcher = async () => { state.fetches++; throw new Error('External provider fetch must not occur'); };
  return {api: loaded.exports, state, fetcher};
}

for (const mode of ['global_off', 'visitor_support']) {
  test(`AI dispatch checks ${mode === 'global_off' ? 'the global kill switch' : 'the feature gate'} before Workers AI or provider fetch`, async () => {
    const {api, state, fetcher} = await loadProviders(mode);
    const config = {
      accountId: 'a'.repeat(32), model: api.GENERATION_MODELS[0], embeddingModel: '@cf/baai/bge-base-en-v1.5',
      module: 'visitor_support', ai: {async run() { state.aiRuns++; return {}; }}, aiToken: 'synthetic-token',
    };
    const calls = [
      () => api.generateDraft(config, 'system', 'bounded synthetic prompt', 100, fetcher),
      () => api.embedApprovedCopy(config, ['bounded approved text'], fetcher),
      () => api.generateChatResponse(config, 'system', 'bounded synthetic prompt', 100, fetcher),
    ];
    for (const call of calls) await assert.rejects(call, mode === 'global_off' ? /global_ai_disabled/ : /feature_ai_disabled/);
    assert.equal(state.aiChecks.length, calls.length);
    assert.deepEqual(state.aiChecks, calls.map(() => 'visitor_support'));
    assert.equal(state.aiRuns, 0, 'neither the Workers AI binding nor the optional paid-provider path may run');
    assert.equal(state.fetches, 0, 'AI off must make zero provider fetches');
  });
}
