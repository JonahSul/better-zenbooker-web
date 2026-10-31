import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localRequire = createRequire(import.meta.url);

async function loadTs(relativePath, overrides = {}) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const requireMock = (specifier) => {
    if (specifier === 'zod/v3') return localRequire('zod/v3');
    if (Object.hasOwn(overrides, specifier)) return overrides[specifier];
    throw new Error(`Unexpected ${relativePath} import: ${specifier}`);
  };
  new Function('require', 'module', 'exports', js)(requireMock, module, module.exports);
  return module.exports;
}

const sourceBinding = await loadTs('lib/analytics-source-binding.ts');
const v2 = await loadTs('lib/snapshot-v2.ts', { './analytics-source-binding': sourceBinding });
const base = {
  schemaVersion: 2,
  source: 'ga4',
  searcherriesProjectId: 7319,
  resource: 'properties/8102',
  scope: 'ga4_property',
  window: { kind: 'calendar_dates', startDate: '2024-02-29', endDateInclusive: '2024-03-04', timeZone: 'America/Denver' },
  fetchedAt: '2024-03-02T04:15:00.000Z',
  summary: { kind: 'provider_reported', metrics: { sessions: 0 }, completeness: 'unknown' },
  detailSample: { rowsReturned: 0, rowLimit: 1000, exhaustive: true },
};

test('calendar-date windows preserve inclusive dates and timezone without UTC conversion', () => {
  const parsed = v2.snapshotV2Input.parse(base);
  assert.equal(parsed.window.startDate, '2024-02-29');
  assert.equal(parsed.window.endDateInclusive, '2024-03-04');
  assert.equal(parsed.window.timeZone, 'America/Denver');
  assert.match(v2.snapshotWindowLabel(parsed.window), /2024-02-29.*2024-03-04 inclusive \(America\/Denver\)/);
  assert.equal(parsed.fetchedAt, '2024-03-02T04:15:00.000Z', 'a report fetched before its calendar window end remains valid');
});

test('provider completeness and detail-sample completeness are independent; missing is not zero', () => {
  const parsed = v2.snapshotV2Input.parse(base);
  assert.equal(parsed.summary.completeness, 'unknown');
  assert.equal(parsed.summary.metrics.sessions, 0);
  assert.equal(Object.hasOwn(parsed.summary.metrics, 'activeUsers'), false);
  assert.deepEqual(parsed.detailSample, { rowsReturned: 0, rowLimit: 1000, exhaustive: true });
  assert.equal(v2.snapshotV2Input.parse({ ...base, detailSample: null }).detailSample, null);
});

test('snapshot v2 enforces structural source and scope shape; installer binding authorizes exact sources', () => {
  assert.equal(v2.snapshotV2Input.safeParse({ ...base, searcherriesProjectId: 7320 }).success, true);
  assert.equal(v2.snapshotV2Input.safeParse({ ...base, source: 'search_console' }).success, false);
  assert.equal(v2.snapshotV2Input.safeParse({ ...base, resource: 'sc-domain:example.test' }).success, false);
  assert.equal(v2.snapshotV2Input.safeParse({ ...base, scope: 'production_search' }).success, false);
  const search = v2.snapshotV2Input.parse({
    ...base, source: 'search_console', resource: 'sc-domain:example.test', scope: 'production_search',
    summary: { kind: 'provider_reported', metrics: { clicks: 4, impressions: 40 }, completeness: 'partial' },
  });
  assert.equal(search.scope, 'production_search');
  const bindings = JSON.stringify([
    { projectId: 7319, source: 'ga4', resource: 'properties/8102', scope: 'ga4_property' },
    { projectId: 7319, source: 'search_console', resource: 'sc-domain:example.test', scope: 'production_search' },
  ]);
  assert.deepEqual(sourceBinding.assertTrustedSnapshotSource(base, bindings), { scope: 'ga4_property' });
  assert.deepEqual(sourceBinding.assertTrustedSnapshotSource(search, bindings), { scope: 'production_search' });
  for (const value of [
    { ...base, searcherriesProjectId: 7320 },
    { ...base, resource: 'properties/9999' },
    { ...base, scope: 'production_search' },
    { ...search, resource: 'sc-domain:attacker.example' },
    { ...search, source: 'ga4' },
  ]) assert.throws(() => sourceBinding.assertTrustedSnapshotSource(value, bindings));
  assert.throws(() => sourceBinding.assertTrustedSnapshotSource(base, undefined), /not configured/);
});

test('invalid calendar dates, reversed ranges, unknown timezone, and fabricated legacy bounds are rejected', () => {
  assert.equal(v2.snapshotV2Input.safeParse({ ...base, window: { ...base.window, startDate: '2025-02-29' } }).success, false);
  assert.equal(v2.snapshotV2Input.safeParse({ ...base, window: { ...base.window, startDate: '2024-03-05' } }).success, false);
  assert.equal(v2.snapshotV2Input.safeParse({ ...base, window: { ...base.window, timeZone: 'Mars/Olympus' } }).success, false);
  assert.equal(v2.snapshotV2Input.safeParse({ ...base, from: 1, to: 2 }).success, false);
  assert.equal(v2.snapshotV2Input.safeParse({ ...base, detailSample: { rowsReturned: 1001, rowLimit: 1000, exhaustive: false } }).success, false);
});

test('instant windows remain offset-aware, exclusive, bounded, and no later than provider fetch time', () => {
  const valid = { ...base, window: { kind: 'instants', startInclusive: '2024-03-01T00:00:00-07:00', endExclusive: '2024-03-02T00:00:00-07:00' }, fetchedAt: '2024-03-02T07:00:00Z' };
  assert.equal(v2.snapshotV2Input.parse(valid).window.startInclusive, '2024-03-01T00:00:00-07:00');
  assert.equal(v2.snapshotV2Input.safeParse({ ...valid, fetchedAt: '2024-03-01T00:00:00Z' }).success, false);
  assert.equal(v2.snapshotV2Input.safeParse({ ...valid, window: { ...valid.window, endExclusive: valid.window.startInclusive } }).success, false);
});
