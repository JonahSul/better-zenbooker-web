import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const targetModuleCache = new Map();
function loadTargetTs(relativePath) {
  const absolute = path.resolve(root, relativePath);
  if (targetModuleCache.has(absolute)) return targetModuleCache.get(absolute);
  const source = readFileSync(absolute, 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = { exports: {} };
  targetModuleCache.set(absolute, loaded.exports);
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (specifier === 'zod/v3') return require('zod/v3');
    if (specifier === 'jose') return require('jose');
    if (specifier === 'drizzle-orm' || specifier.startsWith('drizzle-orm/')) return require(specifier);
    if (specifier === 'next/headers') return require(specifier);
    if (specifier === 'next/navigation') return require(specifier);
    if (specifier === 'cloudflare:workers') return { env: { qaEnabledModules: new Set() } };
    if (specifier.startsWith('.')) {
      const base = path.resolve(path.dirname(absolute), specifier);
      for (const candidate of [base + '.ts', path.join(base, 'index.ts')]) {
        if (existsSync(candidate) && candidate.startsWith(root)) return loadTargetTs(path.relative(root, candidate));
      }
    }
    throw new Error(`Unexpected target TypeScript import in ${relativePath}: ${specifier}`);
  }, loaded, loaded.exports);
  targetModuleCache.set(absolute, loaded.exports);
  return loaded.exports;
}
const source = await readFile(path.join(root, 'lib/chat-core.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', js)((specifier) => {
  if (specifier === 'zod/v3') return require('zod/v3');
  if (specifier === './admin-redaction') return { redactAdminText: ({ text }) => ({ text, redacted: false }) };
  throw new Error(`Unexpected import from chat-core.ts: ${specifier}`);
}, loaded, loaded.exports);
const { explicitIntentAllows } = loaded.exports;
const budgetSource = await readFile(path.join(root, 'lib/input-budget.ts'), 'utf8');
const budgetJs = ts.transpileModule(budgetSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const budgetModule = { exports: {} };
new Function('require', 'module', 'exports', budgetJs)(specifier => { throw new Error(`Unexpected input-budget import: ${specifier}`); }, budgetModule, budgetModule.exports);
const apiCore = await (async () => {
  const providerSource = await readFile(path.join(root, 'lib/zenbooker-core.ts'), 'utf8');
  const providerJs = ts.transpileModule(providerSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const providerModule = { exports: {} };
  new Function('require', 'module', 'exports', providerJs)((specifier) => {
    if (specifier === 'zod/v3') return require('zod/v3');
    if (specifier === './input-budget') return budgetModule.exports;
    throw new Error(`Unexpected import from zenbooker-core.ts: ${specifier}`);
  }, providerModule, providerModule.exports);
  const apiSource = await readFile(path.join(root, 'lib/zenbooker-api-core.ts'), 'utf8');
  const apiJs = ts.transpileModule(apiSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const apiModule = { exports: {} };
  new Function('require', 'module', 'exports', apiJs)((specifier) => {
    if (specifier === 'zod/v3') return require('zod/v3');
    if (specifier === './zenbooker-core') return providerModule.exports;
    if (specifier === './zenbooker-provider-diagnostic') return { inspectRejectedResponse: async () => ({}) };
    throw new Error(`Unexpected import from zenbooker-api-core.ts: ${specifier}`);
  }, apiModule, apiModule.exports);
  return apiModule.exports;
})();
const mcpModule = { exports: loadTargetTs('lib/mcp-call-contract.ts') };
const { siteToolCall, siteToolNames } = mcpModule.exports;

test('API status is read-only, while check and refresh require clear positive Zenbooker intent', () => {
  assert.equal(explicitIntentAllows('zenbooker.api_status', 'What is the API read status?', {}), true);

  assert.equal(explicitIntentAllows('zenbooker.api_check', 'Check the Zenbooker API.', {}), true);
  assert.equal(explicitIntentAllows('zenbooker.api_check', 'Verify Zenbooker API connectivity.', {}), true);
  assert.equal(explicitIntentAllows('zenbooker.api_check', 'Should I check Zenbooker?', {}), false);
  assert.equal(explicitIntentAllows('zenbooker.api_check', 'Do not check Zenbooker.', {}), false);
  assert.equal(explicitIntentAllows('zenbooker.api_check', 'Check the services.', {}), false);

  assert.equal(explicitIntentAllows('zenbooker.api_refresh', 'Scan Zenbooker services.', {}), true);
  assert.equal(explicitIntentAllows('zenbooker.api_refresh', 'Continue the Zenbooker job scan.', {}), true);
  assert.equal(explicitIntentAllows('zenbooker.api_refresh', 'Could you refresh Zenbooker jobs?', {}), false);
  assert.equal(explicitIntentAllows('zenbooker.api_refresh', 'Never refresh Zenbooker jobs.', {}), false);
  assert.equal(explicitIntentAllows('zenbooker.api_refresh', 'Refresh our booking settings.', {}), false);
});

test('API status/check/refresh are registered as owner read tools without generic mutation receipts', async () => {
  const sourceText = await readFile(path.join(root, 'lib/admin-tools.ts'), 'utf8');
  for (const name of ['zenbooker.api_status', 'zenbooker.api_check', 'zenbooker.api_refresh']) {
    assert.match(sourceText, new RegExp(`'${name.replaceAll('.', '\\.')}':tool\\(`));
  }
  const readToolSet = sourceText.match(/const readTools=new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(readToolSet, 'admin tool registry must retain an explicit read-tool list');
  const names = [...readToolSet[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.equal(names.includes('zenbooker.api_status'), true);
  assert.equal(names.includes('zenbooker.api_check'), true);
  assert.equal(names.includes('zenbooker.api_refresh'), true);
});

test('native API tools expose strict fixed arguments for status, check, and bounded refresh', () => {
  assert.equal(siteToolNames.includes('zenbooker_api_status'), true);
  assert.equal(siteToolNames.includes('zenbooker_api_check'), true);
  assert.equal(siteToolNames.includes('zenbooker_api_refresh'), true);
  assert.equal(siteToolCall.safeParse({ name: 'zenbooker_api_status', arguments: {} }).success, true);
  assert.equal(siteToolCall.safeParse({ name: 'zenbooker_api_status', arguments: { check: true } }).success, false);
  assert.equal(siteToolCall.safeParse({
    name: 'zenbooker_api_check', arguments: { requestKey: '3c8e2426-c0b0-4df0-9f6d-4a89e83c5e42' },
  }).success, true);
  assert.equal(siteToolCall.safeParse({
    name: 'zenbooker_api_check', arguments: { requestKey: '3c8e2426-c0b0-4df0-9f6d-4a89e83c5e42', url: 'https://attacker.invalid' },
  }).success, false);
  assert.equal(siteToolCall.safeParse({
    name: 'zenbooker_api_refresh', arguments: {
      action: 'start', requestKey: '75b6d719-32bd-4b72-9378-41c8653f1d19', resource: 'jobs',
      window: { from: '2026-10-01T00:00:00Z', to: '2026-10-30T00:00:00Z' },
    },
  }).success, true);
  assert.equal(siteToolCall.safeParse({
    name: 'zenbooker_api_refresh', arguments: {
      action: 'start', requestKey: '75b6d719-32bd-4b72-9378-41c8653f1d19', resource: 'jobs',
      window: { from: '2026-10-01T00:00:00Z', to: '2026-10-30T00:00:00Z' }, filter: { customer: 'person@example.invalid' },
    },
  }).success, false);
});
