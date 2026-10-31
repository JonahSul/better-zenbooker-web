import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
async function loadTs(relative, overrides = {}) {
  const source = await readFile(path.join(root, relative), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (Object.hasOwn(overrides, specifier)) return overrides[specifier];
    if (specifier === 'zod/v3' && Object.hasOwn(overrides, 'zod')) return overrides.zod;
    if (specifier === 'zod/v3') return require(specifier);
    throw new Error(`Unexpected ${relative} import: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}
const purpose = await loadTs('lib/purpose-consent-core.ts');
const proof = await loadTs('lib/consent-proof.ts', { './purpose-consent-core': purpose });
const core = await loadTs('lib/element-measurement-core.ts', { './consent-proof': proof });
const responseModule = await loadTs('lib/element-document-response.ts', { './element-measurement-core': core });
const now = 1_800_000_000_000;
const secret = Buffer.alloc(32, 0x49).toString('base64');
const publicSnapshot = 'a'.repeat(64);
const routeBuild = 'c'.repeat(64);
const assetManifestHash = 'b'.repeat(64);
const rendererVersion = 'fixture-renderer-v1';
const html = '<!doctype html><html><body><h1>Public page</h1></body></html>';

function request(route, method = 'GET', headers = {}) {
  return new Request(`https://measurement.example.invalid${route}`, { method, headers });
}
function response({ status = 200, contentType = 'text/html; charset=utf-8', snapshot = publicSnapshot, timing = 'edge;dur=8' } = {}) {
  const headers = new Headers({ 'content-type': contentType, 'cache-control': 'public, max-age=60' });
  if (snapshot) headers.set('X-Public-Snapshot', snapshot);
  if (timing) headers.set('Server-Timing', timing);
  return new Response(html, { status, headers });
}
function timingToken(value) {
  const matches = [...value.matchAll(/(?:^|,\s*)element_document;desc="([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"/g)];
  assert.equal(matches.length, 1, 'exactly one signed document descriptor is attached');
  return matches[0][1];
}

test('successful home HTML gets an outside-body signed snapshot descriptor with no request identity', async () => {
  const original = response();
  const result = await responseModule.attachElementDocumentDescriptor(request('/', 'GET', { cookie: '__Host-customer_session=synthetic-private-value' }), original, {
    workspaceId: 'measurement_fixture_workspace', secret, now: () => now,
    snapshotHash: routeBuild, assetManifestHash, rendererVersion,
  });
  const body = await result.text();
  assert.equal(body, html, 'the static HTML body is unchanged');
  assert.equal(result.headers.get('cache-control'), 'public, max-age=60');
  assert.equal(result.headers.get('set-cookie'), null);
  assert.match(result.headers.get('server-timing'), /^edge;dur=8,\s*element_document;/);
  const token = timingToken(result.headers.get('server-timing'));
  const descriptor = await core.verifyElementDescriptor(token, secret, now);
  assert.deepEqual(descriptor, {
    purpose: 'element-document-v1', workspaceId: 'measurement_fixture_workspace', route: '/',
    snapshotHash: publicSnapshot, assetManifestHash, rendererVersion,
    registryVersion: 'element-v2', issuedAt: now, expiresAt: now + core.ELEMENT_DOCUMENT_TTL_MS,
  });
  assert.deepEqual(Object.keys(descriptor).sort(), ['assetManifestHash','expiresAt','issuedAt','purpose','registryVersion','rendererVersion','route','snapshotHash','workspaceId'].sort());
  assert.doesNotMatch(JSON.stringify(descriptor), /private-value|customer|email|visitor|account|session/i);
  assert.doesNotMatch(body, /element_document|measurement_fixture_workspace|customer_session/);
});

test('non-home route descriptor uses its route build hash and only signed navigation metadata', async () => {
  const result = await responseModule.attachElementDocumentDescriptor(request('/contact'), response(), {
    workspaceId: 'measurement_fixture_workspace', secret, now: () => now,
    snapshotHash: routeBuild, assetManifestHash, rendererVersion,
  });
  const descriptor = await core.verifyElementDescriptor(timingToken(result.headers.get('server-timing')), secret, now);
  assert.equal(descriptor.route, '/contact');
  assert.equal(descriptor.snapshotHash, routeBuild);
  assert.equal(descriptor.assetManifestHash, assetManifestHash);
});

test('descriptor attachment is omitted for cached-home metadata gaps, non-public routes, non-HTML and unsuccessful responses', async () => {
  const options = { workspaceId: 'measurement_fixture_workspace', secret, now: () => now, snapshotHash: routeBuild, assetManifestHash, rendererVersion };
  const cases = [
    [request('/'), response({ snapshot: null }), options],
    [request('/admin/analytics'), response(), options],
    [request('/contact', 'POST'), response(), options],
    [request('/contact'), response({ contentType: 'application/json' }), options],
    [request('/contact'), response({ status: 503 }), options],
    [request('/contact'), response(), { ...options, secret: undefined }],
  ];
  for (const [req, res, opts] of cases) {
    const originalTiming = res.headers.get('server-timing');
    const result = await responseModule.attachElementDocumentDescriptor(req, res, opts);
    assert.equal(result.headers.get('server-timing'), originalTiming);
  }
});
