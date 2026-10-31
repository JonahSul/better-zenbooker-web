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
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
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
const proof = await loadTs('lib/consent-proof.ts', {
  './purpose-consent-core': purpose,
});
const core = await loadTs('lib/element-measurement-core.ts', {
  './consent-proof': proof,
});

const expectedTargets = [
  ['home_heading', '/', 'hero', 'view'],
  ['home_book_header', '/', 'header', 'both'],
  ['home_book_hero', '/', 'hero', 'both'],
  ['home_contact_header', '/', 'header', 'both'],
  ['home_services_heading', '/', 'services', 'view'],
  ['home_service_1', '/', 'services', 'both'],
  ['home_service_2', '/', 'services', 'both'],
  ['home_service_3', '/', 'services', 'both'],
  ['home_service_4', '/', 'services', 'both'],
  ['home_coverage_heading', '/', 'coverage', 'view'],
  ['home_request_heading', '/', 'request', 'view'],
  ['home_request_form', '/', 'request', 'both'],
  ['book_heading', '/book', 'main', 'view'],
  ['book_offerings', '/book', 'services', 'both'],
  ['book_external', '/book', 'booking', 'both'],
  ['appointments_heading', '/appointments', 'main', 'view'],
  ['appointments_contact', '/appointments', 'main', 'both'],
  ['contact_heading', '/contact', 'main', 'view'],
  ['contact_form', '/contact', 'contact', 'both'],
  ['contact_faq_1', '/contact', 'questions', 'both'],
  ['contact_faq_2', '/contact', 'questions', 'both'],
  ['contact_book', '/contact', 'questions', 'both'],
  ['privacy_heading', '/privacy', 'main', 'view'],
  ['terms_heading', '/terms', 'main', 'view'],
];
const ids = expectedTargets.map(([id]) => id);
const now = 1_800_000_000_000;
const descriptor = {
  purpose: 'element-document-v1',
  workspaceId: 'workspace_fixture',
  route: '/',
  snapshotHash: 'a'.repeat(64),
  assetManifestHash: 'b'.repeat(64),
  rendererVersion: 'fixture-renderer-v1',
  registryVersion: 'element-v2',
  issuedAt: now,
  expiresAt: now + 30 * 60 * 1000,
};

test('the registry is fixed to current public semantic targets and allowed kinds', () => {
  assert.equal(core.ELEMENT_REGISTRY_VERSION, 'element-v2');
  assert.deepEqual(core.PUBLIC_MEASUREMENT_ROUTES, ['/', '/book', '/appointments', '/contact', '/privacy', '/terms']);
  assert.equal(core.elementRegistry.length, expectedTargets.length);
  assert.equal(new Set(core.elementRegistry.map(item => item.id)).size, expectedTargets.length);
  assert.deepEqual(core.elementRegistry.map(item => [item.id, item.route, item.placement, item.kinds.length === 1 ? item.kinds[0] : 'both']), expectedTargets);
  assert.ok(core.elementRegistry.every(item => item.kinds.every(kind => kind === 'view' || kind === 'action')));
});

test('event DTO accepts only fixed registry IDs and view/action kinds', () => {
  assert.equal(core.elementEventInput.safeParse({ elementId: 'home_book_header', kind: 'action' }).success, true);
  assert.equal(core.elementEventInput.safeParse({ elementId: 'home_heading', kind: 'action' }).success, false);
  assert.equal(core.allowedElementEvent('/', { elementId: 'home_book_header', kind: 'action' }), true);
  assert.equal(core.allowedElementEvent('/contact', { elementId: 'home_book_header', kind: 'action' }), false);
  for (const invalid of [
    { elementId: 'made_up', kind: 'view' },
    { elementId: 'home_heading', kind: 'click' },
    { elementId: 'contact_form', kind: 'view', value: 'private@example.invalid' },
  ]) assert.equal(core.elementEventInput.safeParse(invalid).success, false);
  assert.equal(core.elementEventsInput.safeParse({ documentId: '4cb3da25-1907-46af-9be8-8dbb31bb59d1', events: [] }).success, false);
  assert.equal(core.elementEventsInput.safeParse({ documentId: '4cb3da25-1907-46af-9be8-8dbb31bb59d1', events: Array.from({ length: 21 }, () => ({ elementId: 'home_book_header', kind: 'view' })) }).success, false);
  assert.equal(core.elementEventsInput.safeParse({ documentId: '4cb3da25-1907-46af-9be8-8dbb31bb59d1', events: [{ elementId: 'home_book_header', kind: 'view' }], email: 'private@example.invalid' }).success, false);
});

test('signed document descriptors are exact, workspace-bound metadata with a 30-minute lifetime', async () => {
  assert.equal(core.ELEMENT_DOCUMENT_TTL_MS, 30 * 60 * 1000);
  assert.equal(core.elementDescriptorInput.safeParse(descriptor).success, true);
  const secret = Buffer.alloc(32, 0x53).toString('base64');
  const token = await core.signElementDescriptor(descriptor, secret);
  assert.equal(typeof token, 'string');
  assert.deepEqual(await core.verifyElementDescriptor(token, secret, now), descriptor);
  assert.equal(await core.verifyElementDescriptor(token, Buffer.alloc(32, 0x54).toString('base64'), now), null);
  assert.equal(await core.verifyElementDescriptor(token, secret, descriptor.expiresAt), null);
  assert.equal(core.elementDocumentInput.safeParse({ documentKey: '4cb3da25-1907-46af-9be8-8dbb31bb59d1', descriptor: token }).success, true);

  for (const invalid of [
    { ...descriptor, purpose: 'analytics' },
    { ...descriptor, workspaceId: 'workspace.fixture' },
    { ...descriptor, snapshotHash: 'z'.repeat(64) },
    { ...descriptor, registryVersion: 'another-registry' },
    { ...descriptor, expiresAt: descriptor.expiresAt + 1 },
    { ...descriptor, email: 'private@example.invalid' },
  ]) assert.equal(core.elementDescriptorInput.safeParse(invalid).success, false);
  assert.equal(core.elementDocumentInput.safeParse({ documentKey: '4cb3da25-1907-46af-9be8-8dbb31bb59d1', descriptor: token, cachedAssignment: 'latest' }).success, false);
  assert.equal(core.elementDocumentInput.safeParse({ documentKey: 'not-a-uuid', descriptor: token }).success, false);
});

test('report windows default to the previous seven days and reject partial or overlong ranges', () => {
  assert.equal(core.ELEMENT_RETENTION_MS, 30 * 24 * 60 * 60 * 1000);
  assert.equal(core.elementReportInput.safeParse({}).success, true);
  assert.deepEqual(core.resolveElementReportWindow({}, now), { from: now - 7 * 24 * 60 * 60 * 1000, to: now, route: null });
  assert.deepEqual(core.resolveElementReportWindow({ from: now - 1000, to: now, route: '/contact' }, now), { from: now - 1000, to: now, route: '/contact' });
  for (const invalid of [
    { from: now - 1000 },
    { to: now },
    { from: now - 32 * 86400000, to: now },
    { from: now, to: now },
    { from: now - 1000, to: now, route: '/admin' },
    { from: now - 1000, to: now, googleSubject: 'private' },
  ]) assert.equal(core.elementReportInput.safeParse(invalid).success, false);
  assert.throws(() => core.resolveElementReportWindow({ from: now - 1000, to: now + 1 }, now));
});
