import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { webcrypto } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
globalThis.crypto ??= webcrypto;

async function loadTs(relativePath, imports = {}) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (Object.hasOwn(imports, specifier)) return imports[specifier];
    if (specifier === 'zod/v3') return require('zod/v3');
    throw new Error(`Unexpected ${relativePath} import: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const context = await loadTs('lib/public-context.ts', {
  'cloudflare:workers': { env: {} },
  './business-site': { businessSite: async () => null },
  './service-offerings-server': { serviceOfferingStore: () => { throw new Error('Unexpected default offerings store'); } },
  './module-config': { moduleStatuses: async () => [] },
  './runtime-secrets': { SITE_PROJECT_ID: 'synthetic-installation' },
});
const publicArtifacts = { assetManifestHash: 'b'.repeat(64), rendererVersion: 'fixture-renderer', baseline: { hash: 'fixture-baseline' } };
const exposureCalls = [];
const runtimeModule = await loadTs('lib/experiment-runtime.ts', {
  './public-context': context,
  './purpose-consent-server': { currentExperimentGrant: async () => null },
  './runtime-secrets': { SITE_PROJECT_ID: 'synthetic-installation' },
  './feedback-reference': { FEEDBACK_TIMING_METRIC: 'feedback', FEEDBACK_TTL_MS: 60_000, signFeedbackReference: async () => 'fixture-feedback-ref', verifyFeedbackReference: async () => null },
  './approved-baseline': { ApprovedBaselineStore: class { async compatible() { return null; } } },
  './experiment-core': { HARD_RULES: { version: 'fixture-rules' }, sections: ['hero'] },
  './measurement-capture': { captureExposure: (_request, assignment) => exposureCalls.push(assignment), captureFeedback() {} },
  './attribution-core': { ATTRIBUTION_COOKIE: '__Host-experiment', ATTRIBUTION_WINDOW_MS: 604_800_000, signExposureReference: async () => 'fixture-exposure-ref', verifyExposureReference: async () => null, clearExposureCookie: () => '__Host-experiment=; Max-Age=0' },
  'cloudflare:workers': { env: { EXPERIMENT_COOKIE_SIGNING_KEY: 'synthetic-signing-key' } },
  './public-compiler': { publicArtifacts },
  './experiment-store': { ExperimentStore: class {} },
  './admin-auth-core': { cookieValue: () => null },
  './admin-auth-server': { readSmallBody: async () => '', rejected: () => new Response(null), safeJson: value => Response.json(value) },
});

const digestA = 'a'.repeat(64);
const digestB = 'c'.repeat(64);
const meta = value => `<meta name="public-context-digest" content="${value}">`;
const computedDigest = async ({ offeringRevision = 3, expiresAt = Date.now() + 60_000, offeringRows = [{ offeringId: '9a194f98-a155-4a2f-bccb-79e6325f6599', name: 'Current fixture service', providerServiceId: 'fixture-service-01', providerIdVerified: true }], bookingEnabled = true } = {}) => (await context.loadPublicContext({
  business: async () => ({ revision: 1, details_json: JSON.stringify({ businessName: 'Fixture Business', publicUrl: 'https://business.example.test' }) }),
  offerings: async () => ({ revision: offeringRevision, expiresAt, offerings: offeringRows }),
  modules: async () => [{ module: 'booking', enabled: bookingEnabled, revision: 3, status: bookingEnabled ? 'ready' : 'disabled', config: { readEnabled: bookingEnabled, writeEnabled: false } }],
  installationId: 'synthetic-installation-7319',
})).digest;
const snapshot = (digest, hash = `snapshot-${digest[0]}`) => ({
  hash,
  html: `<!doctype html><html><head>${meta(digest)}</head><body><main>Fixture page</main></body></html>`,
  renderer_version: publicArtifacts.rendererVersion,
  asset_manifest_hash: publicArtifacts.assetManifestHash,
  rules_version: 'fixture-rules',
});

function fixture({ digest = digestA, baseline = snapshot(digest), variant = null, active = false } = {}) {
  const state = { assignCalls: 0, exposeCalls: 0, cacheCalls: 0 };
  const assignment = variant ? { version_id: 'fixture-version', composition_id: 'fixture-composition', subject_hash: 'f'.repeat(64), grant_revision: 2 } : null;
  const store = {
    async runtime() { return { baseline_hash: null, active_version_id: active ? 'fixture-version' : null }; },
    async snapshot(hash) { return hash === 'fixture-variant' ? variant : baseline; },
    async version() { return { compositions: [{ id: 'fixture-composition', snapshot_hash: 'fixture-variant' }] }; },
    async assign() { state.assignCalls++; return assignment; },
    async exposure() { return null; },
    async expose(_assignment, at) { state.exposeCalls++; state.exposedAt = at; return true; },
  };
  const dependencies = {
    contextDigest: async () => digest,
    store: () => store,
    approvedBaseline: async (_store, expected) => expected === digest ? baseline : null,
    grant: async () => variant ? { subjectHash: 'f'.repeat(64), revision: 2, expiresAt: Date.now() + 600_000 } : null,
    cacheSnapshot: async (selected, _origin, _cache, _timing, expectedDigest) => {
      state.cacheCalls++;
      return { html: selected.html, cacheStatus: 'fixture-hit', expectedDigest };
    },
    captureExposure: (_request, assignmentValue) => exposureCalls.push(assignmentValue),
  };
  return { state, store, dependencies, assignment };
}

test('current immutable baseline is served byte-for-byte with no exposure when consent is absent', async () => {
  exposureCalls.length = 0;
  const { state, dependencies } = fixture();
  const expected = snapshot(digestA).html;
  const response = await runtimeModule.serveExperimentDocument(new Request('https://site.example.test/', { method: 'GET' }), dependencies);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), expected);
  assert.equal(response.headers.get('X-Experiment-Measured'), 'false');
  assert.equal(state.exposeCalls, 0);
  assert.equal(exposureCalls.length, 0);
});

test('missing, stale, or corrupt compiled context fails closed', async () => {
  const missing = fixture({ baseline: { ...snapshot(digestA), html: '<html><body>old</body></html>' } });
  assert.equal(await runtimeModule.serveExperimentDocument(new Request('https://site.example.test/'), missing.dependencies), null);
  const stale = fixture({ digest: digestB, baseline: snapshot(digestA) });
  assert.equal(await runtimeModule.serveExperimentDocument(new Request('https://site.example.test/'), stale.dependencies), null);
  const malformed = fixture({ baseline: { ...snapshot(digestA), html: snapshot(digestA).html.replace(meta(digestA), `${meta(digestA)}${meta(digestA)}`) } });
  assert.equal(await runtimeModule.serveExperimentDocument(new Request('https://site.example.test/'), malformed.dependencies), null);
});

test('stale experiment variants are rejected before assignment, exposure, cache, or measurement', async () => {
  exposureCalls.length = 0;
  const { state, dependencies } = fixture({ variant: snapshot(digestB, 'fixture-variant'), active: true });
  assert.equal(await runtimeModule.serveExperimentDocument(new Request('https://site.example.test/'), dependencies), null);
  assert.equal(state.assignCalls, 0);
  assert.equal(state.exposeCalls, 0);
  assert.equal(state.cacheCalls, 0);
  assert.equal(exposureCalls.length, 0);
});

test('offered-service withdrawal or expiry and booking disable make a compiled baseline stale', async () => {
  const oldDigest = await computedDigest();
  const withdrawnDigest = await computedDigest({ offeringRevision: 4, offeringRows: [] });
  const expiredDigest = await computedDigest({ expiresAt: Date.now() - 1 });
  const bookingDisabledDigest = await computedDigest({ bookingEnabled: false });
  for (const currentDigest of [withdrawnDigest, expiredDigest, bookingDisabledDigest]) {
    const current = fixture({ digest: currentDigest, baseline: snapshot(oldDigest) });
    assert.equal(await runtimeModule.serveExperimentDocument(new Request('https://site.example.test/'), current.dependencies), null);
    assert.equal(current.state.cacheCalls, 0);
    assert.equal(current.state.exposeCalls, 0);
  }
});

test('context changes before cache lookup or after cache return prevent serving and exposure', async () => {
  const beforeCache = fixture();
  let beforeRead = 0;
  beforeCache.dependencies.contextDigest = async () => (++beforeRead === 1 ? digestA : digestB);
  assert.equal(await runtimeModule.serveExperimentDocument(new Request('https://site.example.test/'), beforeCache.dependencies), null);
  assert.equal(beforeCache.state.cacheCalls, 0);

  exposureCalls.length = 0;
  const afterCache = fixture();
  let afterRead = 0;
  afterCache.dependencies.contextDigest = async () => (++afterRead < 3 ? digestA : digestB);
  assert.equal(await runtimeModule.serveExperimentDocument(new Request('https://site.example.test/'), afterCache.dependencies), null);
  assert.equal(afterCache.state.cacheCalls, 1);
  assert.equal(afterCache.state.exposeCalls, 0);
  assert.equal(exposureCalls.length, 0);
});

test('stale cache bytes fail closed even when the approved baseline itself is current', async () => {
  const current = fixture();
  current.dependencies.cacheSnapshot = async () => ({ html: snapshot(digestB).html, cacheStatus: 'fixture-hit' });
  assert.equal(await runtimeModule.serveExperimentDocument(new Request('https://site.example.test/'), current.dependencies), null);
});

test('current selected variants preserve exact HTML and only record exposure after final context verification', async () => {
  exposureCalls.length = 0;
  const variant = snapshot(digestA, 'fixture-variant');
  const current = fixture({ variant, active: true });
  const response = await runtimeModule.serveExperimentDocument(new Request('https://site.example.test/'), current.dependencies);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), variant.html);
  assert.equal(response.headers.get('X-Experiment-Measured'), 'true');
  assert.equal(current.state.assignCalls, 1);
  assert.equal(current.state.exposeCalls, 1);
  assert.equal(exposureCalls.length, 1);
});
