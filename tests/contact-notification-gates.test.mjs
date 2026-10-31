import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import {randomUUID} from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

async function loadService({notificationsReady = false} = {}) {
  const source = await readFile(path.join(root, 'lib/contact-notification-server.ts'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true},
  }).outputText;
  const state = {runtimeReads: 0, senderChecks: 0, sends: 0, storeReads: 0, moduleChecks: 0};
  const runtime = {
    workspaceId: 'test-installation', configuration: {enabled: true, events: ['contact.message_created'], revision: 9},
    configRevision: 9, configFingerprint: 'synthetic-config', credentialGeneration: 'synthetic-credential',
    ready: true, policyReady: true, evidenceFresh: false, tokenReadable: true,
    senderConfigured: true, token: 'synthetic-only', accountId: 'synthetic-account', from: 'owner@example.test',
    to: 'owner@example.test', senderFingerprint: 'synthetic-fingerprint', credentialSource: 'encrypted',
    senderRevision: 4, subjectPrefix: '', senderEvidence: null,
  };
  const store = {
    async outboxSummaries() { state.storeReads++; throw new Error('disabled module must not inspect/claim notification work'); },
    async attentionOutbox() { state.storeReads++; throw new Error('disabled module must not mutate notification work'); },
  };
  const modules = {
    './module-config': {
      async moduleStatus(_env, module) { assert.equal(module, 'notifications'); state.moduleChecks++; return {status: notificationsReady ? 'ready' : 'disabled'}; },
      async assertModule(_env, module) { assert.equal(module, 'notifications'); state.moduleChecks++; if (!notificationsReady) throw new Error('module disabled'); },
    },
    './zenbooker-core': {ProviderError: class ProviderError extends Error {}},
    './contact-demo-source-store': {ContactNotificationSourceStore: class {}},
    'cloudflare:workers': {env: {}},
    'zod/v3': require('zod/v3'),
    './runtime-secrets': {SITE_PROJECT_ID: 'test-installation'},
    './contact-store': {ContactStore: class {}},
    './contact-notification-configuration': {
      CONTACT_SENDER_EVIDENCE_MS: 300000,
      ContactNotificationConfigurationStore: class {},
      contactNotificationConfigurationInput: {parse: value => value},
    },
    './contact-email-runtime': {
      async resolveContactEmailRuntime() { state.runtimeReads++; return runtime; },
      projectContactNotificationStatus: value => value,
    },
    './customer-email': {async checkEnabledSenderDomain() { state.senderChecks++; return true; }},
    './contact-email-transport': {async sendContactEmail() { state.sends++; return {state: 'delivered'}; }},
  };
  const loaded = {exports: {}};
  new Function('require', 'module', 'exports', js)((name) => {
    if (Object.hasOwn(modules, name)) return modules[name];
    throw new Error(`Unexpected notification dependency: ${name}`);
  }, loaded, loaded.exports);
  return {service: loaded.exports.contactNotificationService({store, resolveRuntime: async () => { state.runtimeReads++; return runtime; }, send: async () => { state.sends++; return {state: 'delivered'}; }, checkSenderDomain: async () => { state.senderChecks++; return true; }}), state};
}

test('contact notification disabled keeps eligibility false and dispatchNew makes no sender or store calls', async () => {
  const {service, state} = await loadService();
  const eligibility = await service.eligibility();
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.policyEligible, false);
  assert.equal(eligibility.refreshSender, false);
  const result = await service.dispatchNew({id: '10000000-0000-4000-8000-000000000001', expectedRevision: 1}, 'system:test');
  assert.equal(result.state, 'blocked');
  assert.equal(result.attempted, false);
  assert.equal(state.senderChecks, 0);
  assert.equal(state.sends, 0);
  assert.equal(state.storeReads, 0);
});

test('contact notification ready eligibility identifies stale sender evidence without sending', async () => {
  const {service, state} = await loadService({notificationsReady: true});
  const eligibility = await service.eligibility();
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.refreshSender, true);
  assert.equal(state.senderChecks, 0, 'eligibility does not perform the owner sender-domain check');
  assert.equal(state.sends, 0);
});

test('public contact intake remains durable with notifications off and never schedules a send', async () => {
  const source = await readFile(path.join(root, 'lib/contact-server.ts'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true},
  }).outputText;
  const records = [];
  let dispatches = 0;
  const schema = require('zod/v3').z.object({
    requestKey: require('zod/v3').z.string().uuid(), name: require('zod/v3').z.string().min(1),
    email: require('zod/v3').z.string().email(), message: require('zod/v3').z.string().min(1),
  }).strict();
  const modules = {
    './element-measurement-server': {async captureElementOutcome() {}},
    './element-measurement-core': {ELEMENT_DOCUMENT_HEADER: 'x-document-measurement'},
    'cloudflare:workers': {env: {}, waitUntil() {}},
    './runtime-secrets': {SITE_PROJECT_ID: 'test-installation', secretRuntime: () => ({})},
    './contact-core': {ContactRateLimitError: class extends Error {}, contactMessageInput: schema},
    './contact-store': {ContactStore: class {}},
    './contact-notification-server': {contactNotificationService: () => ({})},
  };
  const loaded = {exports: {}};
  new Function('require', 'module', 'exports', js)((name) => {
    if (Object.hasOwn(modules, name)) return modules[name];
    throw new Error(`Unexpected contact route dependency: ${name}`);
  }, loaded, loaded.exports);
  const payload = {requestKey: randomUUID(), name: 'Synthetic visitor', email: 'visitor@example.test', message: 'Please contact me about an appointment.'};
  const response = await loaded.exports.contactMessagesRoute(new Request('https://business.example.test/api/contact/messages', {
    method: 'POST', headers: {origin: 'https://business.example.test', 'content-type': 'application/json'}, body: JSON.stringify(payload),
  }), {
    store: {async submit(value, eligibility) { records.push({value, eligibility}); return {id: randomUUID(), created: true, state: 'received'}; }, async outboxForSource() { throw new Error('notifications are off'); }},
    eligibility: async () => ({eligible: false, policyEligible: false, configRevision: 0, configFingerprint: null, credentialGeneration: null, attentionReason: 'notifications_off'}),
    dispatchNew: async () => { dispatches++; },
  });
  assert.equal(response.status, 201);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].value, payload);
  assert.equal(records[0].eligibility.attentionReason, 'notifications_off');
  assert.equal(dispatches, 0);
});
