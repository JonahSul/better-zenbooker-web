import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { enabledModuleFixture } from './fixtures/module-config-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireFromTest = createRequire(import.meta.url);
const { env: analysisEnv, moduleConfig: analysisModules } = enabledModuleFixture('ai', 'analytics');
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
    if (specifier === './analytics-source-binding') return sourceBinding;
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
const core = await loadTs('lib/analysis-core.ts', { './experiment-core': experiments, './analytics-source-binding': sourceBinding });

test('provider configuration is bounded, defaults disabled, and excludes credentials', () => {
  assert.equal(core.DEFAULT_PROVIDER_CONFIG.mpValidationOnly, true);
  assert.equal(core.DEFAULT_PROVIDER_CONFIG.allowDemoTest, false);
  assert.equal(core.DEFAULT_PROVIDER_CONFIG.dailyCallLimit, 5);
  assert.equal(core.providerConfiguration.safeParse({ ...core.DEFAULT_PROVIDER_CONFIG, aiToken: 'secret' }).success, false);
  assert.equal(core.providerConfiguration.safeParse({ ...core.DEFAULT_PROVIDER_CONFIG, unexpected: true }).success, false);
  assert.equal(core.providerConfiguration.safeParse({ ...core.DEFAULT_PROVIDER_CONFIG, dailyCallLimit: 101 }).success, false);
});

test('snapshot schemas validate generic source shapes while installer bindings select permitted resources', () => {
  const common = {
    searcherriesProjectId: 7319,
    from: 1_790_000_000_000,
    to: 1_790_000_060_000,
    fetchedAt: 1_790_000_120_000,
    sample: { rowsReturned: 1, rowLimit: 1000, exhaustive: false },
  };
  const search = core.snapshotInput.parse({
    ...common, source: 'search_console', resource: 'sc-domain:example.test',
    metrics: { clicks: 4, impressions: 50 },
  });
  assert.equal(search.resource, 'sc-domain:example.test');
  assert.equal(core.snapshotInput.safeParse({ ...search, searcherriesProjectId: 7320 }).success, true, 'structural parsing does not embed another installation’s ID');
  assert.equal(core.snapshotInput.safeParse({ ...search, resource: 'sc-domain:attacker.example' }).success, true, 'resource trust is enforced by the installer binding');
  assert.equal(core.snapshotInput.safeParse({ ...search, resource: 'properties/8102' }).success, false, 'Search Console cannot use a GA4 property resource');
  assert.equal(core.snapshotInput.safeParse({ ...search, metrics: { clicks: 4, sessions: 2 } }).success, false);

  const ga = core.snapshotInput.parse({
    ...common, source: 'ga4', resource: 'properties/8102',
    metrics: { sessions: 8, activeUsers: 5, pageViews: 12 },
  });
  assert.equal(ga.resource, 'properties/8102');
  assert.equal(core.snapshotInput.safeParse({ ...ga, resource: 'sc-domain:example.test' }).success, false);
  assert.equal(core.snapshotInput.safeParse({ ...ga, metrics: { sessions: 8, clicks: 2 } }).success, false);
  assert.equal(core.snapshotInput.safeParse({ ...ga, fetchedAt: ga.to - 1 }).success, false);

  const bindings = JSON.stringify([
    { projectId: 7319, source: 'search_console', resource: 'sc-domain:example.test', scope: 'production_search' },
    { projectId: 7319, source: 'ga4', resource: 'properties/8102', scope: 'ga4_property' },
  ]);
  assert.deepEqual(sourceBinding.assertTrustedSnapshotSource(search, bindings), { scope: 'production_search' });
  assert.deepEqual(sourceBinding.assertTrustedSnapshotSource(ga, bindings), { scope: 'ga4_property' });
  for (const value of [
    { ...search, searcherriesProjectId: 7320 },
    { ...search, resource: 'sc-domain:attacker.example' },
    { ...search, scope: 'ga4_property' },
    { ...search, source: 'ga4' },
  ]) assert.throws(() => sourceBinding.assertTrustedSnapshotSource(value, bindings));
  assert.throws(() => sourceBinding.assertTrustedSnapshotSource(search, undefined), /not configured/);
});

test('model text sanitizer removes contact details and credentials before review', () => {
  const value = 'Call 555-010-0177 or owner@example.com with Bearer abc123 and key AIza1234567890';
  const safe = core.sanitizeModelText(value);
  assert.doesNotMatch(safe, /406-555|owner@example|Bearer abc123|AIza123456/);
  assert.equal(core.sanitizeModelText('This is a plain public copy statement.'), 'This is a plain public copy statement.');
});

test('AnalysisStore rejects absent and mismatched installer bindings before writes for v1 and v2 imports', async () => {
  const bindings = JSON.stringify([
    { projectId: 7319, source: 'search_console', resource: 'sc-domain:example.test', scope: 'production_search' },
    { projectId: 7319, source: 'ga4', resource: 'properties/8102', scope: 'ga4_property' },
  ]);
  let writes = 0;
  const db = { prepare() { const statement = { bind() { return statement; }, async run() { writes++; return { meta: { changes: 1 } }; }, async first() { return null; }, async all() { return { results: [] }; } }; return statement; } };
  const { AnalysisStore } = await loadTs('lib/analysis-store.ts', {
    './snapshot-v2': await loadTs('lib/snapshot-v2.ts'),
    './analysis-core': core,
    './admin-auth-core': { sha256: async value => value },
    'cloudflare:workers': { env: {} },
  });
  const v1 = {
    source: 'search_console', searcherriesProjectId: 7319, resource: 'sc-domain:example.test',
    from: Date.now() - 60_000, to: Date.now() - 30_000, fetchedAt: Date.now(),
    metrics: { clicks: 3, impressions: 17 }, sample: { rowsReturned: 1, rowLimit: 10, exhaustive: false },
  };
  const v2 = {
    schemaVersion: 2, source: 'ga4', searcherriesProjectId: 7319, resource: 'properties/8102', scope: 'ga4_property',
    window: { kind: 'calendar_dates', startDate: '2024-02-29', endDateInclusive: '2024-03-04', timeZone: 'America/Denver' },
    fetchedAt: '2024-03-02T04:15:00.000Z',
    summary: { kind: 'provider_reported', metrics: { sessions: 3 }, completeness: 'partial' }, detailSample: null,
  };
  const unboundStore = new AnalysisStore(db, () => undefined);
  await assert.rejects(unboundStore.ingest(v1, 'fixture-admin'), /not configured/);
  await assert.rejects(unboundStore.ingest(v2, 'fixture-admin'), /not configured/);
  assert.equal(writes, 0);
  const store = new AnalysisStore(db, () => bindings);
  for (const invalid of [
    { ...v1, searcherriesProjectId: 7320 },
    { ...v1, resource: 'sc-domain:other.example' },
    { ...v1, scope: 'ga4_property' },
    { ...v1, source: 'ga4', metrics: { sessions: 3 } },
  ]) await assert.rejects(store.ingest(invalid, 'fixture-admin'));
  for (const invalid of [
    { ...v2, searcherriesProjectId: 7320 },
    { ...v2, resource: 'properties/9001' },
    { ...v2, scope: 'production_search' },
    { ...v2, source: 'search_console' },
  ]) await assert.rejects(store.ingest(invalid, 'fixture-admin'));
  assert.equal(writes, 0, 'foreign, missing, and mismatched bindings are refused before database writes');
  assert.equal((await store.ingest(v1, 'fixture-admin')).scope, 'production_search');
  assert.equal((await store.ingest(v2, 'fixture-admin')).scope, 'ga4_property');
  assert.ok(writes > 0, 'matching installer bindings permit the same validated imports');
});

test('provider health guard honors stored circuit and retry deadlines', async () => {
  const { AnalysisStore } = await loadTs('lib/analysis-store.ts', {
    './snapshot-v2': await loadTs('lib/snapshot-v2.ts'),
    './analysis-core': core,
    './admin-auth-core': { sha256: async value => value },
    'cloudflare:workers': { env: analysisEnv },
    './module-config': analysisModules,
  });
  let health = { circuit_until: Date.now() + 600_000, next_retry_at: Date.now() + 60_000 };
  const db = {
    prepare(sql) {
      return { bind() { return { first: async () => sql.includes('provider_health') ? health : null }; } };
    },
  };
  const store = new AnalysisStore(db);
  await assert.rejects(store.permit('workers_ai'), error => error.errorClass === 'circuit_open');
  health = { circuit_until: null, next_retry_at: Date.now() + 60_000 };
  await assert.rejects(store.permit('workers_ai'), error => error.errorClass === 'rate_limit');
  health = { circuit_until: null, next_retry_at: null };
  await store.permit('workers_ai');
});
