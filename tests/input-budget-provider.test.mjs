import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
async function loadTs(relativePath, imports = {}) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (Object.hasOwn(imports, specifier)) return imports[specifier];
    if (specifier === 'zod/v3') return require(specifier);
    throw new Error(`Unexpected import: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}
const budget = await loadTs('lib/input-budget.ts');
const zenbooker = await loadTs('lib/zenbooker-core.ts', { './input-budget': budget });

test('collection budget rejects excessive fanout, total nodes, and nesting before schema work', () => {
  assert.throws(() => budget.assertCollectionBudget({ list: Array.from({ length: 1025 }, () => 0) }));
  assert.throws(() => budget.assertCollectionBudget(Array.from({ length: 4096 }, () => ({}))));
  let nested = 'leaf';
  for (let depth = 0; depth < 26; depth++) nested = { nested };
  assert.throws(() => budget.assertCollectionBudget(nested));
  assert.deepEqual(budget.assertCollectionBudget({ safe: [1, { ok: true }] }), { safe: [1, { ok: true }] });
});

test('provider JSON rejects hostile collection shapes and oversized responses as unknown outcomes', async () => {
  let calls = 0;
  const client = new zenbooker.ZenbookerClient('synthetic-provider-key', async () => {
    calls++;
    return Response.json({ results: Array.from({ length: 1100 }, (_, index) => ({ id: index })) });
  });
  await assert.rejects(() => client.catalog(), (error) => error.code === 'invalid_response');
  assert.equal(calls, 1, 'only the injected provider fixture should be called');

  await assert.rejects(() => zenbooker.boundedProviderJson(Response.json({ data: 'x'.repeat(4000) }), 100), (error) => error.code === 'invalid_response');
});
