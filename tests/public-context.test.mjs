import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.crypto ??= webcrypto;

async function loadTs(relativePath, imports = {}) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (Object.hasOwn(imports, specifier)) return imports[specifier];
    throw new Error(`Unexpected ${relativePath} import: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const publicContext = await loadTs('lib/public-context.ts', {
  'cloudflare:workers': { env: {} },
  './business-site': { businessSite: async () => null },
  './service-offerings-server': { serviceOfferingStore: () => { throw new Error('Unexpected default offerings store'); } },
  './module-config': { moduleStatuses: async () => [] },
  './runtime-secrets': { SITE_PROJECT_ID: 'test-installation' },
});

const base = () => ({
  business: { revision: 1, details_json: JSON.stringify({ businessName: 'Fixture Business', phone: '(555) 010-0001', publicUrl: 'https://business.example.test' }) },
  offerings: { revision: 4, expiresAt: 2_000_000_000_000, offerings: [{
    offeringId: '9a194f98-a155-4a2f-bccb-79e6325f6599', name: 'Fixture service', providerServiceId: 'fixture-service-01', providerIdVerified: true,
  }] },
  modules: [
    { module: 'booking', enabled: true, revision: 3, status: 'ready', config: { readEnabled: true, writeEnabled: false, sendingEnabled: false } },
    { module: 'visitor_support', enabled: false, revision: 2, status: 'disabled', config: { assistantEnabled: false } },
    { module: 'search', enabled: false, revision: 1, status: 'disabled', config: { projectId: null } },
  ],
  installationId: 'synthetic-installation-7319',
});

const contextFor = values => publicContext.loadPublicContext({
  business: async () => values.business,
  offerings: async () => values.offerings,
  modules: async () => values.modules,
  installationId: values.installationId,
});
const digest = async overrides => (await contextFor({ ...base(), ...overrides })).digest;

test('public context digest is deterministic across object and module ordering', async () => {
  const initial = base();
  const reordered = {
    ...initial,
    business: { ...initial.business, details_json: JSON.stringify({ publicUrl: 'https://business.example.test', phone: '(555) 010-0001', businessName: 'Fixture Business' }) },
    modules: [...initial.modules].reverse().map(row => ({ ...row, config: Object.fromEntries(Object.entries(row.config).reverse()) })),
  };
  assert.equal((await contextFor(initial)).digest, (await contextFor(reordered)).digest);
  assert.match((await publicContext.currentPublicContextDigest({ business: async () => initial.business, offerings: async () => initial.offerings, modules: async () => initial.modules, installationId: initial.installationId })), /^[0-9a-f]{64}$/);
});

test('public digest changes for every rendered business, offering, and enabled module value', async () => {
  const original = await digest();
  assert.notEqual(await digest({ business: { ...base().business, revision: 2 } }), original);
  assert.notEqual(await digest({ business: { revision: 1, details_json: JSON.stringify({ businessName: 'Changed Fixture Business' }) } }), original);
  assert.notEqual(await digest({ offerings: { ...base().offerings, revision: 5 } }), original);
  assert.notEqual(await digest({ offerings: { ...base().offerings, expiresAt: 2_000_000_001_000 } }), original);
  assert.notEqual(await digest({ offerings: { ...base().offerings, offerings: [{ ...base().offerings.offerings[0], name: 'Changed Fixture service' }] } }), original);
  const changedModule = base().modules.map(row => row.module === 'booking' ? { ...row, revision: row.revision + 1 } : row);
  assert.notEqual(await digest({ modules: changedModule }), original);
  const changedConfig = base().modules.map(row => row.module === 'booking' ? { ...row, config: { ...row.config, readEnabled: false } } : row);
  assert.notEqual(await digest({ modules: changedConfig }), original);
  assert.notEqual(await digest({ installationId: 'synthetic-installation-7320' }), original);
});

test('unrendered module changes do not invalidate public HTML, while rendered module state is included', async () => {
  const initial = base();
  const excludedOnly = initial.modules.map(row => row.module === 'search' ? { ...row, revision: 99, enabled: true, config: { projectId: 123456 } } : row);
  assert.equal((await contextFor(initial)).digest, (await contextFor({ ...initial, modules: excludedOnly })).digest);
});

test('compiled context marker must occur exactly once and match the current digest', async () => {
  const current = await digest();
  const meta = value => `<meta name="public-context-digest" content="${value}">`;
  assert.equal(publicContext.snapshotContextMatches(`<head>${meta(current)}</head>`, current), true);
  assert.equal(publicContext.snapshotContextMatches(`<head>${meta('a'.repeat(64))}</head>`, current), false);
  assert.equal(publicContext.snapshotContextMatches('<head></head>', current), false);
  assert.equal(publicContext.snapshotContextMatches(`<head>${meta(current)}${meta(current)}</head>`, current), false);
  assert.equal(publicContext.snapshotContextMatches(`<head>${meta('bad')}</head>`, current), false);
  assert.equal(publicContext.snapshotContextMatches(`<head>${meta(current)}</head>`, null), false);
});
