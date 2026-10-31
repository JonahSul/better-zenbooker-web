import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
const proof = await loadTs('lib/consent-proof.ts', { './purpose-consent-core': purpose });
const core = await loadTs('lib/element-measurement-core.ts', { './consent-proof': proof });
const feedback = await loadTs('lib/feedback-reference.ts', { zod: require('zod/v3'), './purpose-consent-core': purpose });
const secret = Buffer.alloc(32, 0x63).toString('base64');
const workspaceId = 'qa_measurement_workspace';
const ownerId = 'fixture-owner';
const now = 1_800_000_000_000;
const grant = { hash: 'c'.repeat(64), revision: 4, expiresAt: now + 86400000 };
const experimentGrant = { hash: 'd'.repeat(64), revision: 3, expiresAt: now + 86400000 };
const baseDescriptor = {
  purpose: 'element-document-v1', workspaceId, route: '/',
  snapshotHash: 'a'.repeat(64), assetManifestHash: 'b'.repeat(64),
  rendererVersion: 'fixture-renderer-v1', registryVersion: core.ELEMENT_REGISTRY_VERSION,
  issuedAt: now, expiresAt: now + core.ELEMENT_DOCUMENT_TTL_MS,
};

class ElementMeasurementError extends Error {
  constructor(code, retryAfter) { super(code); this.code = code; this.retryAfter = retryAfter; }
}

const server = await loadTs('lib/element-measurement-server.ts', {
  'cloudflare:workers': { env: {} },
  './purpose-consent-core': purpose,
  './element-measurement-core': core,
  './element-measurement-store': { ElementMeasurementStore: class {}, ElementMeasurementError },
  './purpose-consent-server': {
    currentAnalyticsGrant: async () => grant,
    currentExperimentGrant: async () => experimentGrant,
  },
  './feedback-reference': feedback,
  './admin-auth-core': {
    cookieValue: () => null,
    sha256: async value => createHash('sha256').update(value).digest('hex'),
  },
  './admin-auth-server': {
    getGoogleAdmin: async () => null,
    rejected: (_request, error, status, headers = {}) => Response.json({ error }, { status, headers }),
    safeJson: (value, status = 200, headers = {}) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } }),
    readSmallBody: async request => request.text(),
  },
  './runtime-secrets': { secretRuntime: () => ({ SITE_OWNER_USER_ID: ownerId, EXPERIMENT_COOKIE_SIGNING_KEY: secret }), SITE_PROJECT_ID: workspaceId },
  './analytics-configuration': { analyticsConfigurationService: () => ({}) },
  './ga4-property-configuration': { ga4PropertyConfigurationService: () => ({}) },
});

function request(pathname, { method = 'POST', body, headers = {}, protocol = 'https:' } = {}) {
  const url = `${protocol}//measurement.example.invalid${pathname}`;
  const actualHeaders = new Headers(headers);
  if (body !== undefined && !actualHeaders.has('content-type')) actualHeaders.set('content-type', 'application/json');
  if (!actualHeaders.has('origin')) actualHeaders.set('origin', 'https://measurement.example.invalid');
  return new Request(url, { method, headers: actualHeaders, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
}

async function responseJson(response) { return response.json(); }
async function signedDescriptor(value = baseDescriptor) { return core.signElementDescriptor(value, secret); }

test('document registration validates consent, origin, admin suppression, and signed fixed metadata before storage', async () => {
  const calls = [];
  const store = { async register(input) { calls.push(input); return { documentId: '4cb3da25-1907-46af-9be8-8dbb31bb59d1', expiresAt: now + core.ELEMENT_DOCUMENT_TTL_MS }; } };
  const deps = { store, workspaceId, secret, now: () => now, getGrant: async () => grant, getExperimentGrant: async () => null, isAdmin: () => false };
  const token = await signedDescriptor();
  const accepted = await server.elementDocumentsRoute(request('/api/measurement/documents', {
    body: { documentKey: '7cbb4c2a-c49d-43cf-8baa-47ff89d6d35d', descriptor: token },
  }), deps);
  assert.equal(accepted.status, 200);
  assert.deepEqual(await responseJson(accepted), { documentId: '4cb3da25-1907-46af-9be8-8dbb31bb59d1', expiresAt: now + core.ELEMENT_DOCUMENT_TTL_MS });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].descriptor, baseDescriptor);
  assert.equal(calls[0].grant.hash, grant.hash);
  assert.equal(calls[0].association, null);
  assert.match(calls[0].descriptorHash, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(await responseJson(Response.json({ result: calls[0] }))), /email|phone|subject|visitor|session|account/i);

  for (const rejectedRequest of [
    request('/api/measurement/documents?extra=1', { body: { documentKey: '7cbb4c2a-c49d-43cf-8baa-47ff89d6d35d', descriptor: token } }),
    request('/api/measurement/documents', { protocol: 'http:', body: { documentKey: '7cbb4c2a-c49d-43cf-8baa-47ff89d6d35d', descriptor: token } }),
    request('/api/measurement/documents', { headers: { origin: 'https://elsewhere.invalid' }, body: { documentKey: '7cbb4c2a-c49d-43cf-8baa-47ff89d6d35d', descriptor: token } }),
  ]) {
    const denied = await server.elementDocumentsRoute(rejectedRequest, deps);
    assert.equal(denied.status, 403);
  }
  assert.equal(calls.length, 1, 'invalid transport and public DTOs do not reach the Store');
  const extraField = await server.elementDocumentsRoute(request('/api/measurement/documents', {
    body: { documentKey: '7cbb4c2a-c49d-43cf-8baa-47ff89d6d35d', descriptor: token, visitorId: 'invented' },
  }), deps);
  assert.equal(extraField.status, 400, 'unknown identity fields are rejected by the strict DTO');
  assert.equal(calls.length, 1);

  const noGrant = await server.elementDocumentsRoute(request('/api/measurement/documents', { body: { documentKey: '7cbb4c2a-c49d-43cf-8baa-47ff89d6d35d', descriptor: token } }), { ...deps, getGrant: async () => null });
  assert.equal(noGrant.status, 403);
  const admin = await server.elementDocumentsRoute(request('/api/measurement/documents', { body: { documentKey: '7cbb4c2a-c49d-43cf-8baa-47ff89d6d35d', descriptor: token } }), { ...deps, isAdmin: () => true });
  assert.equal(admin.status, 403);
  assert.equal(calls.length, 1);
});

test('experiment association comes only from the same signed home snapshot and current experiment grant', async () => {
  const saved = [];
  const store = { async register(input) { saved.push(input); return { documentId: '4cb3da25-1907-46af-9be8-8dbb31bb59d1', expiresAt: now + core.ELEMENT_DOCUMENT_TTL_MS }; } };
  const reference = {
    purpose: 'section-feedback-v1', workspaceId, subjectHash: experimentGrant.hash,
    grantRevision: experimentGrant.revision, versionId: '28241648-bd39-4bea-aec6-307547ed84cc',
    compositionId: 'e2351268-1228-4e0c-9ce4-c45a80ccf341', snapshotHash: baseDescriptor.snapshotHash,
    issuedAt: now - 1000, expiresAt: now + 10 * 60 * 1000,
  };
  const signedReference = await feedback.signFeedbackReference(reference, secret);
  const deps = { store, workspaceId, secret, now: () => now, getGrant: async () => grant, getExperimentGrant: async () => experimentGrant, isAdmin: () => false };
  const homeToken = await signedDescriptor();
  const payload = { documentKey: '7cbb4c2a-c49d-43cf-8baa-47ff89d6d35d', descriptor: homeToken, experimentReference: signedReference };
  await server.elementDocumentsRoute(request('/api/measurement/documents', { body: payload }), deps);
  assert.deepEqual(saved[0].association, { hash: experimentGrant.hash, revision: experimentGrant.revision, versionId: reference.versionId, compositionId: reference.compositionId });
  assert.equal(JSON.stringify(saved[0]).includes(signedReference), false);

  const contactDescriptor = { ...baseDescriptor, route: '/contact', snapshotHash: 'e'.repeat(64) };
  const contactToken = await signedDescriptor(contactDescriptor);
  await server.elementDocumentsRoute(request('/api/measurement/documents', { body: { ...payload, documentKey: 'dd475253-4e76-4f80-9f8f-6a6754ff1014', descriptor: contactToken } }), deps);
  assert.equal(saved[1].association, null, 'a home reference cannot associate to a different route snapshot');
  await server.elementDocumentsRoute(request('/api/measurement/documents', { body: { ...payload, documentKey: '7d847d38-d2e9-4c90-9a44-0b9d5580c5d8' } }), { ...deps, getExperimentGrant: async () => null });
  assert.equal(saved[2].association, null, 'without the separate current experiment grant, baseline registration remains unassociated');
});

test('event route accepts only bounded fixed events and returns safe counts', async () => {
  const received = [];
  const store = { async record(input) { received.push(input); return { accepted: 1, duplicates: 0 }; } };
  const deps = { store, getGrant: async () => grant, isAdmin: () => false };
  const event = { elementId: 'contact_form', kind: 'action' };
  const response = await server.elementEventsRoute(request('/api/measurement/events', { body: { documentId: '4cb3da25-1907-46af-9be8-8dbb31bb59d1', events: [event] } }), deps);
  assert.equal(response.status, 200);
  assert.deepEqual(await responseJson(response), { accepted: 1, duplicates: 0 });
  assert.deepEqual(received[0].events, [event]);
  assert.equal(received[0].grant.hash, grant.hash);

  for (const badBody of [
    { documentId: 'not-uuid', events: [event] },
    { documentId: '4cb3da25-1907-46af-9be8-8dbb31bb59d1', events: [{ ...event, message: 'private text' }] },
    { documentId: '4cb3da25-1907-46af-9be8-8dbb31bb59d1', events: [{ elementId: 'home_book_header', kind: 'view' }, { elementId: 'home_book_header', kind: 'view' }] , privateData: true },
  ]) {
    const bad = await server.elementEventsRoute(request('/api/measurement/events', { body: badBody }), deps);
    assert.equal(bad.status, 400);
  }
  const blocked = await server.elementEventsRoute(request('/api/measurement/events', { body: { documentId: '4cb3da25-1907-46af-9be8-8dbb31bb59d1', events: [event] } }), { ...deps, getGrant: async () => null });
  assert.equal(blocked.status, 403);
  assert.equal(received.length, 1);
});

test('fixed-owner status and aggregate report expose no document, visitor, or event IDs', async () => {
  const statusValue = {
    collectionAvailable: true, registryVersion: core.ELEMENT_REGISTRY_VERSION,
    routes: core.PUBLIC_MEASUREMENT_ROUTES, retentionDays: 30, googleReceipt: 'unverified',
    tagConfiguration: { revision: 2, enabled: true, containerId: 'GTM-FIXTURE1', source: 'persisted' },
    propertyConfiguration: { revision: 1, propertyId: '1234567890123', source: 'persisted' },
  };
  const reportValue = {
    window: { from: now - 86400000, to: now, route: '/contact' },
    rows: [{ route: '/contact', elementId: 'contact_form', placement: 'contact', snapshotHash: 'a'.repeat(64), assetManifestHash: 'b'.repeat(64), rendererVersion: 'fixture-renderer-v1', registryVersion: core.ELEMENT_REGISTRY_VERSION, contextKind: 'route_build', viewedDocuments: 3, actionDocuments: 1, actionsWithPriorView: 1, actionsWithoutPriorView: 0, actionRate: 1 / 3 }],
    outcomes: [{ route: '/contact', kind: 'contact_received', count: 1 }], googleReceipt: 'unverified',
  };
  const service = { status: async () => statusValue, report: async input => ({ ...reportValue, window: { ...reportValue.window, from: input.from, to: input.to } }) };
  const deps = { getAdmin: async () => ({ siteUserId: ownerId, subject: 'verified-owner' }), ownerId, service, now: () => now };
  const statusResponse = await server.elementMeasurementOwnerRoute(request('/api/admin/analytics/elements/status', { method: 'GET' }), 'status', deps);
  assert.equal(statusResponse.status, 200);
  assert.deepEqual(await responseJson(statusResponse), statusValue);
  assert.match(statusResponse.headers.get('cache-control') ?? '', /no-store/i);

  const input = { from: now - 86400000, to: now, route: '/contact' };
  const reportResponse = await server.elementMeasurementOwnerRoute(request('/api/admin/analytics/elements/report', { body: input }), 'report', deps);
  assert.equal(reportResponse.status, 200);
  const report = await responseJson(reportResponse);
  assert.deepEqual(report, { ...reportValue, window: input });
  assert.doesNotMatch(JSON.stringify(report), /documentId|visitor|subject|session|email|phone|message|sourceHash|eventId/i);

  const denied = await server.elementMeasurementOwnerRoute(request('/api/admin/analytics/elements/status', { method: 'GET' }), 'status', { ...deps, getAdmin: async () => null });
  assert.equal(denied.status, 403);
  const unauthenticated = await server.elementMeasurementOwnerRoute(request('/api/admin/analytics/elements/status', { method: 'GET' }), 'status', { ...deps, getAdmin: async () => null });
  assert.equal(unauthenticated.status, 403, 'requests without a verified Google administrator session are denied');
  const queriedStatus = await server.elementMeasurementOwnerRoute(request('/api/admin/analytics/elements/status?private=value', { method: 'GET' }), 'status', deps);
  assert.equal(queriedStatus.status, 403, 'status routes reject query strings');
  const wrongStatusMethod = await server.elementMeasurementOwnerRoute(request('/api/admin/analytics/elements/status', { method: 'POST', body: {} }), 'status', deps);
  assert.equal(wrongStatusMethod.status, 403);
  const wrongReportMethod = await server.elementMeasurementOwnerRoute(request('/api/admin/analytics/elements/report', { method: 'GET' }), 'report', deps);
  assert.equal(wrongReportMethod.status, 403);
  const invalidWindow = await server.elementMeasurementOwnerRoute(request('/api/admin/analytics/elements/report', { body: { from: now - 86400000, to: now, extra: true } }), 'report', deps);
  assert.equal(invalidWindow.status, 400, 'report accepts only the strict aggregate window DTO');
});
