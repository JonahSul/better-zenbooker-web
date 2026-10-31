import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireFromTest = createRequire(import.meta.url);
const source = await readFile(path.join(root, 'lib/performance-core.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', js)((specifier) => {
  if (specifier === 'zod/v3') return requireFromTest(specifier);
  throw new Error(`Unexpected import: ${specifier}`);
}, loaded, loaded.exports);
const performance = loaded.exports;

const sample = overrides => ({
  at: 1_800_000_123_456,
  requestMs: 4.5,
  snapshotMs: 1.25,
  cacheMs: 0.5,
  outcome: 'served',
  cacheState: 'hit',
  ...overrides,
});

test('performance records use bounded actual durations, UTC five-minute buckets, and explicit histogram bins', () => {
  const row = performance.timingValues(sample({ requestMs: 5 }));
  assert.equal(row.bucketStart, Math.floor(1_800_000_123_456 / 300_000) * 300_000);
  assert.equal(row.outcome, 'served');
  assert.equal(row.cacheState, 'hit');
  assert.equal(row.values[0], 1, 'one measured request');
  assert.equal(row.values[1], 5_000, 'durations convert milliseconds to integer microseconds');
  assert.equal(row.values[2], 1);
  assert.equal(row.values[3], 1_250);
  assert.equal(row.values[4], 1);
  assert.equal(row.values[5], 500);
  assert.equal(row.values[6], 0, 'the 5 ms sample is not in the <=1 ms bin');
  assert.equal(row.values[7], 1, 'the 5 ms sample is in the <=5 ms bin');
  assert.equal(row.values.reduce((sum, value, index) => index >= 6 ? sum + value : sum, 0), 1, 'each real sample contributes to one histogram bucket');
});

test('unavailable snapshot/cache timings remain absent and are not filled with zero-duration samples', () => {
  const row = performance.timingValues(sample({ requestMs: 6000, snapshotMs: null, cacheMs: null, outcome: 'unavailable', cacheState: 'storage-unavailable' }));
  assert.equal(row.values[2], 0);
  assert.equal(row.values[3], 0);
  assert.equal(row.values[4], 0);
  assert.equal(row.values[5], 0);
  assert.equal(row.values.at(-1), 1, 'durations above the last finite boundary have an explicit overflow bin');
  assert.equal(row.outcome, 'unavailable');
  assert.equal(row.cacheState, 'storage-unavailable');
});

test('timing input rejects inferred/impossible dimensions and only accepts the explicit source states', () => {
  for (const invalid of [
    sample({ requestMs: -1 }),
    sample({ requestMs: 86_400_001 }),
    sample({ snapshotMs: 1e99 }),
    sample({ outcome: 'web_vitals' }),
    sample({ cacheState: 'guessed-hit' }),
    { ...sample({}), coreWebVitals: { lcp: 1200 } },
  ]) assert.equal(performance.timingInput.safeParse(invalid).success, false);
  assert.deepEqual(performance.performanceWindow.safeParse({ from: 1000, to: 2000 }).success, true);
  assert.equal(performance.performanceWindow.safeParse({ from: 2000, to: 1000 }).success, false);
  assert.equal(performance.performanceWindow.safeParse({ from: 0, to: 367 * 86_400_000 }).success, false);
});
