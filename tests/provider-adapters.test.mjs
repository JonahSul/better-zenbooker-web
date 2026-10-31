import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { enabledModuleFixture } from './fixtures/module-config-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { env: providerEnv, moduleConfig: providerModuleConfig } = enabledModuleFixture('ai', 'admin_chat', 'vectorize', 'analytics', 'google', 'search');
const requireFromTest = createRequire(import.meta.url);
const cache = new Map();

async function loadTs(relative, overrides = {}) {
  if (cache.has(relative)) return cache.get(relative);
  const source = await readFile(path.join(root, relative), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  const ownRequire = (specifier) => {
    if (Object.hasOwn(overrides, specifier)) return overrides[specifier];
    if (specifier === 'zod/v3' && Object.hasOwn(overrides, 'zod')) return overrides.zod;
    if (specifier === 'zod/v3') return requireFromTest(specifier);
    throw new Error(`Unexpected ${relative} import: ${specifier}`);
  };
  new Function('require', 'module', 'exports', js)(ownRequire, loaded, loaded.exports);
  cache.set(relative, loaded.exports);
  return loaded.exports;
}

const experiments = await loadTs('lib/experiment-core.ts');
const sourceBinding = await loadTs('lib/analytics-source-binding.ts');
const analysis = await loadTs('lib/analysis-core.ts', { './experiment-core': experiments, './analytics-source-binding': sourceBinding });
const inputBudget = await loadTs('lib/input-budget.ts');
const providers = await loadTs('lib/provider-adapters.ts', {
  './analysis-core': analysis,
  './input-budget': inputBudget,
  'cloudflare:workers': { env: providerEnv },
  './module-config': providerModuleConfig,
});

const baseConfig = {
  accountId: '0123456789abcdef0123456789abcdef',
  workspaceId: 'site-project-fixture',
  aiToken: 'fixture-ai-token',
  model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  embeddingModel: '@cf/baai/bge-base-en-v1.5',
  vectorToken: 'fixture-vector-token',
  indexName: 'approved-copy-index',
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('AI generation uses the fixed Cloudflare account/model endpoint, JSON mode, and bearer credential', async () => {
  let observed;
  const fetcher = async (url, init) => {
    observed = { url: String(url), init };
    return json({ success: true, result: { response: JSON.stringify({
      definition: { headline: 'Plan demo care around the season' },
      rationale: 'This wording keeps the request clear and grounded in the approved service information.',
    }), usage: { prompt_tokens: 48, completion_tokens: 20 } } });
  };
  const result = await providers.generateDraft(baseConfig, 'System rules', 'Evidence only', 300, fetcher);
  assert.equal(result.proposal.definition.headline, 'Plan demo care around the season');
  assert.deepEqual(result.usage, { prompt_tokens: 48, completion_tokens: 20 });
  assert.equal(observed.url, 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  assert.equal(observed.init.headers.Authorization, 'Bearer fixture-ai-token');
  assert.equal(JSON.parse(observed.init.body).response_format.type, 'json_object');
  assert.equal(observed.init.redirect, 'manual');
  assert.equal(observed.init.cache, 'no-store');
});

test('AI rejects unapproved models and unsafe model-generated copy without returning provider content', async () => {
  let calls = 0;
  const neverFetch = async () => { calls += 1; throw new Error('unexpected'); };
  await assert.rejects(providers.generateDraft({ ...baseConfig, model: '@cf/other/model' }, '', '', 100, neverFetch), error => error.errorClass === 'configuration');
  assert.equal(calls, 0);

  const unsafe = async () => json({ success: true, result: { response: JSON.stringify({
    definition: { headline: 'Call 555-010-0177 now' },
    rationale: 'This copy will include a private phone number and should be rejected.',
  }) } });
  await assert.rejects(providers.generateDraft(baseConfig, 'system', 'bounded evidence', 100, unsafe), error => error.errorClass === 'schema' && !error.message.includes('406-555'));
});

test('embedding dimensions are checked against the selected model', async () => {
  const vectors = Array.from({ length: 2 }, (_, i) => Array(768).fill(i / 10));
  const result = await providers.embedApprovedCopy(baseConfig, ['approved baseline', 'approved draft'], async () => json({ success: true, result: { data: vectors } }));
  assert.equal(result.length, 2);
  assert.equal(result[0].length, 768);
  await assert.rejects(providers.embedApprovedCopy(baseConfig, ['approved text'], async () => json({ success: true, result: { data: [Array(1024).fill(0)] } })), error => error.errorClass === 'schema');
  await assert.rejects(providers.embedApprovedCopy({ ...baseConfig, embeddingModel: '@cf/unknown/embed' }, ['approved'], async () => { throw new Error('unexpected'); }), error => error.errorClass === 'configuration');
});

test('Vectorize requests stay on the configured index and use exact workspace/model provenance filters', async () => {
  const config = { ...baseConfig };
  const vectorId = 'a'.repeat(64);
  let infoUrl;
  const info = await providers.vectorIndexInfo(config, async (url, init) => {
    infoUrl = String(url);
    assert.equal(init.headers.Authorization, 'Bearer fixture-vector-token');
    return json({ success: true, result: { config: { dimensions: 768, metric: 'cosine' } } });
  });
  assert.deepEqual(info, { dimensions: 768, metric: 'cosine' });
  assert.equal(infoUrl, 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/vectorize/v2/indexes/approved-copy-index');

  let submitted;
  const result = await providers.upsertApprovedVectors(config, [{
    id: vectorId,
    values: Array(768).fill(0.25),
    metadata: { workspace: config.workspaceId, kind: 'approved_copy', version_id: 'v1', composition_id: 'c1', definition_hash: 'b'.repeat(64), model: config.embeddingModel },
  }], async (url, init) => {
    submitted = { url: String(url), form: init.body };
    return json({ success: true, result: { mutationId: 'fixture-mutation' } });
  });
  assert.deepEqual(result, { enqueued: true, mutationId: 'fixture-mutation' });
  assert.match(submitted.url, /\/indexes\/approved-copy-index\/upsert$/);
  const file = submitted.form.get('body');
  assert.ok(file instanceof Blob);
  const row = JSON.parse((await file.text()).trim());
  assert.equal(row.id, vectorId);
  assert.equal(row.metadata.workspace, config.workspaceId);
  assert.equal(row.metadata.kind, 'approved_copy');
  assert.equal(row.metadata.definition_hash, 'b'.repeat(64));

  let queryBody;
  await providers.queryApprovedVectors(config, Array(768).fill(0), async (_url, init) => {
    queryBody = JSON.parse(init.body);
    return json({ success: true, result: { matches: [] } });
  });
  assert.deepEqual(queryBody.filter, {
    kind: { $eq: 'approved_copy' },
    workspace: { $eq: config.workspaceId },
    model: { $eq: config.embeddingModel },
  });
  assert.equal(queryBody.topK, 5);
  assert.equal(queryBody.returnMetadata, 'all');
  await assert.rejects(providers.upsertApprovedVectors({ ...config, workspaceId: 'other-workspace' }, [{
    id: vectorId, values: Array(768).fill(0.25),
    metadata: { workspace: config.workspaceId, kind: 'approved_copy', version_id: 'v1', composition_id: 'c1', definition_hash: 'b'.repeat(64), model: config.embeddingModel },
  }], async () => { throw new Error('foreign workspace must be rejected before fetch'); }), error => error.errorClass === 'schema');
});

test('provider failures are classified without echoing raw response content', async () => {
  for (const [status, expected] of [[401, 'auth'], [429, 'rate_limit'], [503, 'transient'], [400, 'schema']]) {
    await assert.rejects(providers.vectorIndexInfo(baseConfig, async () => new Response('secret=fixture-secret', { status })), error => {
      assert.equal(error.errorClass, expected);
      assert.equal(error.message, expected);
      assert.doesNotMatch(error.message, /fixture-secret/);
      return true;
    });
  }
});

test('Cloudflare provider redirects are rejected after one manual fetch', async () => {
  const calls = [];
  await assert.rejects(providers.generateDraft(baseConfig, 'System rules', 'Evidence only', 300, async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 302, headers: { Location: 'https://redirect-target.invalid/ai?token=must-not-follow' } });
  }), error => {
    assert.equal(error.errorClass, 'schema');
    assert.doesNotMatch(error.message, /redirect-target|must-not-follow/);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\//);
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer fixture-ai-token');
  assert.doesNotMatch(JSON.stringify(calls[0].init), /redirect-target|must-not-follow/);
});

test('external reports use fixed resources and keep GA4 and Search Console metric sets separate', async () => {
  let gaRequest;
  const ga = await providers.readGa4Report('fixture-access-token', '2026-10-01', '2026-10-07', async (url, init) => {
    gaRequest = { url: String(url), init, body: JSON.parse(init.body) };
    return json({ rows: [{ metricValues: [{ value: '12' }, { value: '8' }, { value: '19' }] }] });
  }, '1234567890123');
  assert.deepEqual(ga, { sessions: 12, activeUsers: 8, pageViews: 19 });
  assert.equal(gaRequest.url, 'https://analyticsdata.googleapis.com/v1beta/properties/1234567890123:runReport');
  assert.equal(gaRequest.init.headers.Authorization, 'Bearer fixture-access-token');
  assert.deepEqual(gaRequest.body.metrics.map(row => row.name), ['sessions', 'activeUsers', 'screenPageViews']);

  let searchRequest;
  const search = await providers.readSearchConsole('fixture-access-token', '2026-10-01', '2026-10-07', async (url, init) => {
    searchRequest = { url: String(url), body: JSON.parse(init.body) };
    return json({ rows: [{ clicks: 4, impressions: 70 }] });
  }, 'https://search.example.test/');
  assert.deepEqual(search, { clicks: 4, impressions: 70 });
  assert.equal(searchRequest.url, 'https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fsearch.example.test%2F/searchAnalytics/query');
  assert.deepEqual(searchRequest.body, { startDate: '2026-10-01', endDate: '2026-10-07', rowLimit: 1 });
});

test('GA4 report requires a configured numeric property ID and never guesses a destination', async () => {
  let calls = 0;
  const neverFetch = async () => { calls += 1; throw new Error('unexpected report request'); };
  for (const propertyId of [undefined, null, '', '0', '0123', 'G-ABC123', '123/extra', '123456789012345678901']) {
    await assert.rejects(
      providers.readGa4Report('fixture-access-token', '2026-10-01', '2026-10-07', neverFetch, propertyId),
      error => error.errorClass === 'configuration',
    );
  }
  assert.equal(calls, 0, 'unset or invalid destination fails before any fetch');

  let url;
  await providers.readGa4Report('fixture-access-token', '2026-10-01', '2026-10-07', async value => {
    url = String(value);
    return json({ rows: [] });
  }, '987654321');
  assert.equal(url, 'https://analyticsdata.googleapis.com/v1beta/properties/987654321:runReport');
});
