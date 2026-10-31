import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

async function loadTs(relativePath, mocks = {}) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (specifier === 'zod/v3') return require('zod/v3');
    if (Object.hasOwn(mocks, specifier)) return mocks[specifier];
    throw new Error(`Unexpected import in ${relativePath}: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const core = await loadTs('lib/contact-core.ts');
const projection = await loadTs('lib/contact-model-projection.ts', { './contact-core': core });
const admin = { siteUserId: 'fixed-owner', subject: 'verified-owner-subject' };
const ownerId = 'fixed-owner';
const secrets = { SITE_OWNER_USER_ID: ownerId };
const serviceCalls = [];
const safeStatus = {
  revision: 4, enabled: false, events: [], ready: false, blockedReason: 'disabled',
  token: { present: true, locallyReadable: true },
  sender: { configured: true, domainEnabled: false, evidenceFresh: false, sendingTested: false },
  routing: { toConfigured: true, bccConfigured: true, prefixConfigured: true },
};
const service = {
  async status() { return safeStatus; },
  async checkSender(input, actor) {
    serviceCalls.push({ input, actor });
    return { revision: 4, senderDomainEnabled: false, sendingTested: false, auditId: 'd5000000-0000-4000-8000-000000000001', failure: { code: 'http_rejected', httpStatus: 401, classification: 'unauthorized' } };
  },
};
const notificationConfig = {
  revision: 4, enabled: false, events: [], from: 'PRIVATE_FROM_SENTINEL',
  zoneId: 'PRIVATE_ZONE_SENTINEL', subdomainId: 'PRIVATE_SUBDOMAIN_SENTINEL',
  to: 'PRIVATE_TO_SENTINEL', bcc: 'PRIVATE_BCC_SENTINEL', subjectPrefix: 'PRIVATE_PREFIX_SENTINEL',
  writeToken: 'PRIVATE_WRITE_TOKEN_SENTINEL',
};
const route = await loadTs('lib/contact-admin-server.ts', {
  'cloudflare:workers': { env: {} },
  './runtime-secrets': { SITE_PROJECT_ID: 'fixture-workspace', secretRuntime: () => secrets },
  './admin-auth-server': {
    async getGoogleAdmin() { return admin; },
    safeJson(body, status = 200) { return Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } }); },
    async readContactJson(request) { return JSON.parse(await request.text()); },
  },
  './contact-core': core,
  './contact-store': { ContactStore: class ContactStore {} },
  './contact-server': { async readContactJson(request) { return JSON.parse(await request.text()); } },
  './contact-notification-configuration': { ContactNotificationConfigurationStore: class ContactNotificationConfigurationStore {} },
  './contact-notification-server': {
    contactNotificationService: () => service,
    contactDispatchInput: require('zod/v3').z.object({ id: require('zod/v3').z.string().uuid(), expectedRevision: require('zod/v3').z.number().int().positive() }).strict(),
    contactSenderCheckInput: require('zod/v3').z.object({ expectedRevision: require('zod/v3').z.number().int().nonnegative() }).strict(),
  },
});

const https = (pathname, method = 'GET', body) => new Request(`https://site.invalid${pathname}`, {
  method,
  headers: method === 'POST' ? { origin: 'https://site.invalid', 'content-type': 'application/json' } : {},
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test('contact model tool projections expose metadata only and strip unknown message and notification fields', () => {
  const now = Date.now();
  const id = 'd4000000-0000-4000-8000-000000000001';
  const safe = projection.projectContactToolResult('contact.messages_list', { messages: [
    { id, revision: 2, status: 'read', createdAt: now - 1, expiresAt: now + 300000, name: 'PRIVATE_NAME', email: 'PRIVATE_EMAIL', message: 'PRIVATE_MESSAGE', bcc: 'PRIVATE_BCC' },
    { id: 'malformed', revision: 1, status: 'new', createdAt: now, expiresAt: now + 86400000, message: 'PRIVATE_MALFORMED' },
    { id, revision: 1, status: 'new', createdAt: now, expiresAt: now - 1, message: 'PRIVATE_EXPIRED' },
  ] }, now);
  assert.deepEqual(safe, {
    count: 1,
    messages: [{ id, revision: 2, status: 'read', createdAt: now - 1, expiresAt: now + 300000 }],
    resultLink: '/admin/inquiries',
  });
  const status = projection.projectContactToolResult('contact.notifications_status', safeStatus);
  assert.equal(status.protectedDetails, true);
  assert.equal(status.resultLink, '/admin/inquiries');
  assert.equal(status.token.locallyReadable, true);
  const serialized = JSON.stringify(status);
  for (const sentinel of ['PRIVATE_TOKEN_SENTINEL', 'PRIVATE_TO_SENTINEL', 'PRIVATE_BCC_SENTINEL', 'PRIVATE_FROM_SENTINEL', 'PRIVATE_PREFIX_SENTINEL']) {
    assert.equal(serialized.includes(sentinel), false);
  }
});

test('contact inbox route requires verified admin and returns private rows only to that browser route', async () => {
  const rows = [{ id: 'd4000000-0000-4000-8000-000000000002', revision: 1, name: 'Fixture Contact', email: 'contact@example.invalid', message: 'Private inbox message', status: 'new', createdAt: 10, expiresAt: 20 }];
  let listCalls = 0;
  const store = { async list() { listCalls += 1; return rows; } };
  const denied = await route.contactAdminRoute('list', https('/api/admin/contact/messages'), { getAdmin: async () => null, store });
  assert.equal(denied.status, 403);
  assert.equal(listCalls, 0);
  const allowed = await route.contactAdminRoute('list', https('/api/admin/contact/messages'), { getAdmin: async () => admin, store });
  assert.equal(allowed.status, 200);
  assert.deepEqual((await allowed.json()).messages, rows);
  assert.equal(allowed.headers.get('cache-control'), 'private, no-store');
});

test('owner notification reads expose allowlisted status and setup fields, and sender check stays explicit', async () => {
  const configurationStore = { async read() { return notificationConfig; } };
  const status = await route.contactNotificationOwnerRoute('status', https('/api/admin/contact/notifications'), { getAdmin: async () => admin, ownerId, service });
  assert.equal(status.status, 200);
  const statusBody = JSON.stringify(await status.json());
  for (const sentinel of ['PRIVATE_TOKEN_SENTINEL', 'PRIVATE_TO_SENTINEL', 'PRIVATE_BCC_SENTINEL', 'PRIVATE_FROM_SENTINEL', 'PRIVATE_PREFIX_SENTINEL']) assert.equal(statusBody.includes(sentinel), false);

  const config = await route.contactNotificationOwnerRoute('configuration', https('/api/admin/contact/notifications/configuration'), { getAdmin: async () => admin, ownerId, configurationStore });
  assert.deepEqual(await config.json(), { revision: 4, enabled: false, events: [], from: 'PRIVATE_FROM_SENTINEL', zoneId: 'PRIVATE_ZONE_SENTINEL', subdomainId: 'PRIVATE_SUBDOMAIN_SENTINEL' });

  const denied = await route.contactNotificationOwnerRoute('status', https('/api/admin/contact/notifications'), { getAdmin: async () => null, ownerId, service });
  assert.equal(denied.status, 403);

  const check = await route.contactNotificationOwnerRoute('check-sender', https('/api/admin/contact/notifications/check-sender', 'POST', { expectedRevision: 3 }), { getAdmin: async () => admin, ownerId, service });
  assert.equal(check.status, 200);
  assert.deepEqual(serviceCalls.at(-1), { input: { expectedRevision: 3 }, actor: admin.subject });
  assert.deepEqual(await check.json(), { revision: 4, senderDomainEnabled: false, sendingTested: false, auditId: 'd5000000-0000-4000-8000-000000000001', failure: { code: 'http_rejected', httpStatus: 401, classification: 'unauthorized' } });
});

test('shared Contact audit rows expose only the current workspace and allowlisted setting/check fields', async () => {
  const workspaceId = 'fixture-workspace';
  const rows = [
    { id: 'a1', google_subject: 'owner-subject', action: 'contact.notifications_save', target: JSON.stringify({ workspaceId, revision: 4, enabled: false, events: ['contact.message_created'], senderConfigured: true, to: 'PRIVATE_TO_SENTINEL', bcc: 'PRIVATE_BCC_SENTINEL', token: 'PRIVATE_TOKEN_SENTINEL' }), created_at: 1 },
    { id: 'a2', google_subject: 'system:contact-intake', action: 'contact.sender_check', target: JSON.stringify({ workspaceId, revision: 4, domainEnabled: false, from: 'PRIVATE_FROM_SENTINEL', bcc: 'PRIVATE_BCC_SENTINEL' }), created_at: 2 },
    { id: 'a3', google_subject: 'another-owner', action: 'contact.notifications_save', target: JSON.stringify({ workspaceId: 'other-workspace', revision: 9, enabled: true, events: [], senderConfigured: true }), created_at: 3 },
    { id: 'a4', google_subject: 'another-owner', action: 'contact.sender_check', target: '{broken', created_at: 4 },
    { id: 'a5', google_subject: 'another-owner', action: 'contact.message_delete', target: 'PRIVATE_OTHER_ACTION_SENTINEL', created_at: 5 },
  ];
  const z = require('zod/v3').z;
  const module = await loadTs('lib/console-store.ts', {
    './public-reviews-url': { publicReviewsUrlInput: z.string().nullable() },
    './inquiry-validation': { updateInput: z.object({}), services: ['fixture'], areas: ['fixture'] },
    './contact-store': { ContactStore: class ContactStore {} },
    './element-measurement-store': { ElementMeasurementStore: class ElementMeasurementStore { constructor() { throw new Error('Unexpected element-measurement store construction in audit-only coverage'); } } },
  });
  const calls = [];
  const db = { prepare(sql) { return { sql, values: [], bind(...values) { this.values = values; calls.push(this); return this; }, async all() { return { results: rows }; } }; } };
  const output = await new module.ConsoleStore(db, workspaceId, 'owner-subject', 'owner-user').audit();
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /contact\.notifications_save/);
  assert.match(calls[0].sql, /contact\.sender_check/);
  assert.deepEqual(calls[0].values, ['owner-subject', workspaceId]);
  assert.deepEqual(output, [
    { id: 'a1', action: 'contact.notifications_save', created_at: 1, actor: 'Admin', target: { workspaceId, revision: 4, enabled: false, events: ['contact.message_created'], senderConfigured: true } },
    { id: 'a2', action: 'contact.sender_check', created_at: 2, actor: 'Contact notifications', target: { workspaceId, revision: 4, domainEnabled: false } },
  ]);
  const serialized = JSON.stringify(output);
  for (const sentinel of ['PRIVATE_TO_SENTINEL', 'PRIVATE_BCC_SENTINEL', 'PRIVATE_TOKEN_SENTINEL', 'PRIVATE_FROM_SENTINEL', 'PRIVATE_OTHER_ACTION_SENTINEL']) assert.equal(serialized.includes(sentinel), false);
});
