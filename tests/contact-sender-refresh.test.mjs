import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { enabledModuleFixture } from './fixtures/module-config-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { env: senderEmailEnv, moduleConfig: senderEmailModules } = enabledModuleFixture('booking', 'notifications');
class FixtureProviderError extends Error {
  constructor(code, status = null) { super(code); this.code = code; this.status = status; }
}

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

const configuration = await loadTs('lib/contact-notification-configuration.ts');
const email = await loadTs('lib/customer-email.ts', {
  'cloudflare:workers': { env: senderEmailEnv },
  './module-config': senderEmailModules,
  './customer-auth-core': { normalizeEmail: value => String(value).trim().toLowerCase() },
  './zenbooker-core': {
    async boundedProviderJson(response) { return response.json(); },
    ProviderError: FixtureProviderError,
  },
});

const synthetic = {
  now: 1_800_000_000_000,
  workspaceId: 'contact-fixture-workspace',
  accountId: 'a'.repeat(32),
  token: 'synthetic-email-token-only',
  generation: 'b'.repeat(64),
  fingerprint: 'c'.repeat(64),
  configFingerprint: 'e'.repeat(64),
  credentialSource: 'encrypted',
  senderRevision: 2,
  configRevision: 7,
  from: 'notices@example.invalid',
  to: 'recipient@example.invalid',
  bcc: 'audit-copy@example.invalid',
  zoneId: 'd'.repeat(32),
  subdomainId: 'f'.repeat(32),
  outboxId: 'd9000000-0000-4000-8000-000000000001',
};
const actor = 'verified-owner-fixture';
const emailRuntime = await loadTs('lib/contact-email-runtime.ts', {
  'cloudflare:workers': { env: {} },
  './runtime-secrets': { SITE_PROJECT_ID: synthetic.workspaceId, secretRuntime() { throw new Error('unexpected uninjected secrets'); }, credentialStore() { throw new Error('unexpected uninjected credential store'); } },
  './contact-notification-configuration': configuration,
});

function proof(now = synthetic.now) {
  return {
    workspaceId: synthetic.workspaceId,
    accountId: synthetic.accountId,
    from: synthetic.from,
    zoneId: synthetic.zoneId,
    subdomainId: synthetic.subdomainId,
    senderRevision: synthetic.senderRevision,
    credentialSource: synthetic.credentialSource,
    credentialGeneration: synthetic.generation,
    fingerprint: synthetic.fingerprint,
    checkedAt: now,
    expiresAt: now + 86_400_000,
    checkedConfigRevision: synthetic.configRevision,
    domainEnabled: true,
  };
}

function runtimeFor(state, overrides = {}) {
  const evidence = state.evidence;
  const evidenceFresh = !!evidence && evidence.workspaceId === synthetic.workspaceId
    && evidence.accountId === synthetic.accountId && evidence.from === state.from
    && evidence.zoneId === state.zoneId && evidence.subdomainId === state.subdomainId
    && evidence.senderRevision === state.senderRevision && evidence.credentialSource === state.credentialSource
    && evidence.credentialGeneration === state.generation && evidence.fingerprint === state.fingerprint
    && evidence.domainEnabled === true && evidence.expiresAt > state.now && evidence.checkedAt <= state.now;
  const configuration = {
    revision: state.configRevision,
    enabled: state.enabled,
    events: state.events,
    from: state.from,
    zoneId: state.zoneId,
    subdomainId: state.subdomainId,
  };
  const policyReady = state.enabled && state.events.includes('contact.message_created')
    && state.tokenReadable && state.senderConfigured && state.routingValid;
  return {
    workspaceId: synthetic.workspaceId,
    configuration,
    senderRevision: state.senderRevision,
    senderEvidence: evidence,
    senderFingerprint: state.fingerprint,
    credentialSource: state.credentialSource,
    credentialGeneration: state.generation,
    configRevision: state.configRevision,
    configFingerprint: state.configFingerprint,
    accountId: state.senderConfigured ? synthetic.accountId : null,
    token: state.tokenReadable ? synthetic.token : null,
    from: state.senderConfigured ? state.from : null,
    to: state.routingValid ? synthetic.to : null,
    bcc: state.routingValid ? synthetic.bcc : null,
    subjectPrefix: 'Fixture',
    ready: policyReady && evidenceFresh,
    policyReady,
    evidenceFresh,
    tokenPresent: state.tokenPresent,
    tokenReadable: state.tokenReadable,
    senderConfigured: state.senderConfigured,
    toConfigured: state.routingValid,
    bccConfigured: state.routingValid,
    prefixConfigured: true,
    routingValid: state.routingValid,
    blockedReason: !state.enabled ? 'disabled' : !state.tokenReadable ? 'token_missing' : !state.senderConfigured ? 'sender_unset' : !state.routingValid ? 'routing_unconfigured' : !evidenceFresh ? 'sender_unverified' : null,
    ...overrides,
  };
}

function makeHarness({ fresh = false, senderConfigured = true, tokenReadable = true, routingValid = true, senderEnabled = true, senderHttpStatus = null, senderCheckError = null, busy = false, enabled = true, events = ['contact.message_created'], changeConfigAfterCheck = false, changeCredentialAfterCheck = false, deleteSourceAfterCheck = false, sendResult = { state: 'delivered', providerMessageId: 'FixtureMessage123' } } = {}) {
  const state = {
    now: synthetic.now,
    configRevision: synthetic.configRevision,
    senderRevision: synthetic.senderRevision,
    configFingerprint: synthetic.configFingerprint,
    generation: synthetic.generation,
    fingerprint: synthetic.fingerprint,
    credentialSource: synthetic.credentialSource,
    from: synthetic.from,
    zoneId: synthetic.zoneId,
    subdomainId: synthetic.subdomainId,
    enabled,
    events,
    tokenReadable,
    tokenPresent: tokenReadable,
    senderConfigured,
    routingValid,
    evidence: fresh ? proof() : null,
    lease: null,
    deleted: false,
    attentionReason: null,
    postCalls: [],
    sendCalls: [],
    auditCount: 0,
    refreshCalls: 0,
    outbox: { id: synthetic.outboxId, revision: 1, state: 'blocked', event: 'contact.message_created', createdAt: synthetic.now, attentionReason: 'sender_check_required' },
  };
  const configStore = {
    async claimSenderRefresh(binding, leaseMs = 30000) {
      state.refreshCalls += 1;
      assert.equal(leaseMs, 30000);
      assert.deepEqual(binding, {
        configRevision: synthetic.configRevision,
        senderRevision: synthetic.senderRevision,
        fingerprint: synthetic.fingerprint,
        credentialGeneration: synthetic.generation,
        credentialSource: synthetic.credentialSource,
      });
      if (busy || state.lease?.until > state.now) return { claimed: false, token: null, until: state.now + 30000 };
      state.lease = { token: 'e0000000-0000-4000-8000-000000000001', until: state.now + leaseMs, binding };
      return { claimed: true, token: state.lease.token, until: state.lease.until };
    },
    async finishSenderRefresh(token, binding, evidence, _actor) {
      if (!state.lease || state.lease.token !== token || state.lease.until <= state.now) return { saved: false, auditId: null };
      assert.deepEqual(binding, state.lease.binding);
      state.lease = null;
      state.evidence = evidence;
      state.auditCount += 1;
      if (changeConfigAfterCheck) state.configRevision += 1;
      if (deleteSourceAfterCheck) state.deleted = true;
      return { saved: true, auditId: `f0000000-0000-4000-8000-${String(state.auditCount).padStart(12, '0')}` };
    },
    async save(input, _actor) {
      assert.equal(input.expectedRevision, state.configRevision);
      state.configRevision += 1;
      state.enabled = input.enabled;
      state.events = input.events;
      state.from = input.from;
      state.zoneId = input.zoneId;
      state.subdomainId = input.subdomainId;
      state.auditCount += 1;
      return { ...input, revision: state.configRevision, auditId: `f1000000-0000-4000-8000-${String(state.auditCount).padStart(12, '0')}` };
    },
  };
  const store = {
    async outboxSummaries() { return [state.outbox]; },
    async attentionOutbox(_id, reason) { state.attentionReason = reason; state.outbox = { ...state.outbox, state: 'blocked', attentionReason: reason, revision: state.outbox.revision + 1 }; return state.outbox; },
    async promoteNewOutbox(input) {
      assert.equal(input.id, synthetic.outboxId, 'only the initiating new message is eligible for promotion');
      if (state.deleted || state.outbox.createdAt < state.now - 30000) return { ...state.outbox, state: state.deleted ? 'canceled' : 'blocked' };
      state.outbox = { ...state.outbox, state: 'pending', attentionReason: null, revision: state.outbox.revision + 1 };
      return state.outbox;
    },
    async claimOutbox() {
      if (state.outbox.state !== 'pending') return { ...state.outbox, claimed: false, claimToken: null };
      state.outbox = { ...state.outbox, state: 'dispatching', revision: state.outbox.revision + 1 };
      return { ...state.outbox, claimed: true, claimToken: 'f1000000-0000-4000-8000-000000000001' };
    },
    async sourceForDispatch() {
      if (state.deleted) return null;
      return { id: 'd8000000-0000-4000-8000-000000000001', revision: 1, name: 'Fixture Person', email: 'customer@example.invalid', message: 'Synthetic contact request', event: 'contact.message_created', sourceType: 'contact' };
    },
    async finishOutbox(input) {
      state.outbox = { ...state.outbox, state: input.state, revision: state.outbox.revision + 1 };
      return state.outbox;
    },
  };
  const fetcher = async (url, init) => {
    state.postCalls.push({ url: String(url), init });
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.headers.Authorization, `Bearer ${synthetic.token}`);
    assert.equal(Object.hasOwn(init.headers, 'Content-Type'), false);
    if (changeConfigAfterCheck) state.configFingerprint = '9'.repeat(64);
    if (changeCredentialAfterCheck) { state.generation = '9'.repeat(64); state.fingerprint = '8'.repeat(64); }
    const pathname = new URL(String(url)).pathname;
    if (senderHttpStatus !== null) return Response.json({ success: false }, { status: senderHttpStatus });
    if (pathname === `/client/v4/zones/${synthetic.zoneId}`) {
      return Response.json({ success: true, result: { account: { id: synthetic.accountId }, name: 'example.invalid' } });
    }
    if (pathname === `/client/v4/zones/${synthetic.zoneId}/email/sending/subdomains/${synthetic.subdomainId}`) {
      return Response.json({ success: true, result: { tag: synthetic.subdomainId, name: 'example.invalid', enabled: senderEnabled } });
    }
    throw new Error('unexpected synthetic GET URL');
  };
  const send = async envelope => {
    state.sendCalls.push(envelope);
    return sendResult;
  };
  const service = contactNotificationService({
    store,
    configurationStore: configStore,
    resolveRuntime: async () => runtimeFor(state),
    checkSenderDomain: senderCheckError ? async () => { throw senderCheckError; } : email.checkEnabledSenderDomain,
    fetcher,
    send,
    now: () => state.now,
  });
  return { service, state, store, configStore };
}

const actualConfig = await loadTs('lib/contact-notification-configuration.ts');
const serviceModule = await loadTs('lib/contact-notification-server.ts', {
  'cloudflare:workers': { env: senderEmailEnv },
  './module-config': { ...senderEmailModules, async moduleStatus() { return { status: 'ready' }; } },
  './runtime-secrets': { SITE_PROJECT_ID: synthetic.workspaceId },
  './contact-store': { ContactStore: class ContactStore {} },
  './contact-demo-source-store': { ContactNotificationSourceStore: class ContactNotificationSourceStore {} },
  './contact-notification-configuration': actualConfig,
  './zenbooker-core': { ProviderError: FixtureProviderError },
  './contact-email-runtime': {
    async resolveContactEmailRuntime() { throw new Error('unexpected uninjected runtime'); },
    projectContactNotificationStatus(runtime) { return { revision: runtime.configRevision, enabled: runtime.configuration.enabled }; },
  },
  './customer-email': email,
  './contact-email-transport': { async sendContactEmail() { throw new Error('unexpected uninjected send'); } },
});
const { contactNotificationService } = serviceModule;

test('notification status is a presence-only projection with no token, recipient, BCC, sender or fingerprint values', async () => {
  const now = synthetic.now;
  const config = {
    revision: synthetic.configRevision,
    enabled: true,
    events: ['contact.message_created'],
    from: synthetic.from,
    zoneId: synthetic.zoneId,
    subdomainId: synthetic.subdomainId,
  };
  const senderFingerprint = await emailRuntime.contactSenderFingerprint({
    workspaceId: synthetic.workspaceId,
    accountId: synthetic.accountId,
    from: synthetic.from,
    zoneId: synthetic.zoneId,
    subdomainId: synthetic.subdomainId,
    senderRevision: synthetic.senderRevision,
    credentialSource: synthetic.credentialSource,
    credentialGeneration: synthetic.generation,
  });
  const checkedAt = now - 1000;
  const evidence = {
    workspaceId: synthetic.workspaceId,
    accountId: synthetic.accountId,
    from: synthetic.from,
    zoneId: synthetic.zoneId,
    subdomainId: synthetic.subdomainId,
    senderRevision: synthetic.senderRevision,
    credentialSource: synthetic.credentialSource,
    credentialGeneration: synthetic.generation,
    fingerprint: senderFingerprint,
    checkedAt,
    expiresAt: checkedAt + 86_400_000,
    checkedConfigRevision: synthetic.configRevision,
    domainEnabled: true,
  };
  const runtime = await emailRuntime.resolveContactEmailRuntime({
    workspaceId: synthetic.workspaceId,
    now: () => now,
    runtime: {
      CLOUDFLARE_EMAIL_ACCOUNT_ID: synthetic.accountId,
      CONTACT_NOTIFICATION_TO: synthetic.to,
      CONTACT_NOTIFICATION_BCC: synthetic.bcc,
      CONTACT_NOTIFICATION_SUBJECT_PREFIX: 'Synthetic only',
    },
    configurationStore: {
      async read() { return config; },
      async senderEvidence() { return { senderRevision: synthetic.senderRevision, evidence }; },
    },
    credential: async () => ({ token: synthetic.token, present: true, locallyReadable: true, source: synthetic.credentialSource, generation: synthetic.generation }),
  });
  const projected = emailRuntime.projectContactNotificationStatus(runtime);
  assert.deepEqual(projected, {
    revision: synthetic.configRevision,
    enabled: true,
    events: ['contact.message_created'],
    ready: true,
    blockedReason: null,
    token: { present: true, locallyReadable: true },
    sender: { configured: true, domainEnabled: true, evidenceFresh: true, sendingTested: false },
    routing: { toConfigured: true, bccConfigured: true, prefixConfigured: true },
  });
  const serialized = JSON.stringify(projected);
  for (const privateValue of [synthetic.token, synthetic.to, synthetic.bcc, synthetic.from, synthetic.accountId, synthetic.generation, senderFingerprint]) assert.equal(serialized.includes(privateValue), false);
});

test('a new eligible message refreshes expired sender proof with the two fixed GET checks, then sends once', async () => {
  const { service, state } = makeHarness();
  const result = await service.dispatchNew({ id: synthetic.outboxId, expectedRevision: 1 }, actor);

  assert.deepEqual(state.postCalls.map(call => new URL(call.url).pathname), [
    `/client/v4/zones/${synthetic.zoneId}`,
    `/client/v4/zones/${synthetic.zoneId}/email/sending/subdomains/${synthetic.subdomainId}`,
  ]);
  assert.equal(state.postCalls.length, 2);
  assert.equal(state.sendCalls.length, 1);
  assert.equal(state.outbox.state, 'delivered');
  assert.deepEqual(result, { id: synthetic.outboxId, state: 'delivered', attempted: true });
  assert.equal(state.evidence.domainEnabled, true);
  assert.equal(state.evidence.expiresAt - state.evidence.checkedAt, 86_400_000);
  assert.equal(state.evidence.checkedConfigRevision, synthetic.configRevision);
  assert.equal(JSON.stringify(result).includes(synthetic.token), false);
  assert.equal(JSON.stringify(result).includes(synthetic.bcc), false);
});

test('fresh sender proof performs no sender GET and sends the initiating message once', async () => {
  const { service, state } = makeHarness({ fresh: true });
  const result = await service.dispatchNew({ id: synthetic.outboxId, expectedRevision: 1 }, actor);
  assert.deepEqual(result, { id: synthetic.outboxId, state: 'delivered', attempted: true });
  assert.equal(state.postCalls.length, 0);
  assert.equal(state.sendCalls.length, 1);
});

test('missing setup performs no sender request and provider mismatch records no proof or email attempt', async () => {
  const missing = makeHarness({ senderConfigured: false });
  const missingResult = await missing.service.dispatchNew({ id: synthetic.outboxId, expectedRevision: 1 }, actor);
  assert.equal(missingResult.state, 'blocked');
  assert.equal(missing.state.postCalls.length, 0);
  assert.equal(missing.state.sendCalls.length, 0);
  assert.equal(missing.state.attentionReason, 'not_ready');

  const failed = makeHarness({ senderEnabled: false });
  const failedResult = await failed.service.dispatchNew({ id: synthetic.outboxId, expectedRevision: 1 }, actor);
  assert.equal(failedResult.state, 'blocked');
  assert.equal(failed.state.postCalls.length, 2);
  assert.equal(failed.state.sendCalls.length, 0);
  assert.equal(failed.state.evidence, null);
  assert.equal(failed.state.attentionReason, 'sender_check_failed');
});

test('a concurrent refresh contender is left blocked without sender GETs or email POSTs', async () => {
  const { service, state } = makeHarness({ busy: true });
  const result = await service.dispatchNew({ id: synthetic.outboxId, expectedRevision: 1 }, actor);
  assert.equal(result.state, 'blocked');
  assert.equal(state.attentionReason, 'sender_check_busy');
  assert.equal(state.postCalls.length, 0);
  assert.equal(state.sendCalls.length, 0);
});

test('an explicit owner sender check performs the two GET checks without enabling notifications or sending mail', async () => {
  const { service, state } = makeHarness({ enabled: false, events: [] });
  const result = await service.checkSender({ expectedRevision: synthetic.configRevision }, actor);
  assert.deepEqual(result, { revision: synthetic.configRevision, senderDomainEnabled: true, sendingTested: false, auditId: result.auditId });
  assert.equal(typeof result.auditId, 'string');
  assert.equal(state.postCalls.length, 2);
  assert.equal(state.sendCalls.length, 0);
  assert.equal(state.enabled, false);
  assert.deepEqual(state.events, []);
  assert.equal(state.evidence.domainEnabled, true);
});

test('sender-check failure diagnostics retain only typed codes and fixed HTTP status classifications', async () => {
  const unauthorized = makeHarness({ senderHttpStatus: 401 });
  const unauthorizedResult = await unauthorized.service.checkSender({ expectedRevision: synthetic.configRevision }, actor);
  assert.deepEqual(unauthorizedResult.failure, { code: 'http_rejected', httpStatus: 401, classification: 'unauthorized' });
  assert.equal(unauthorized.state.postCalls.length, 1);
  assert.equal(unauthorized.state.sendCalls.length, 0);
  assert.equal(JSON.stringify(unauthorizedResult).includes(synthetic.token), false);

  const upstream = makeHarness({ senderHttpStatus: 503 });
  const upstreamResult = await upstream.service.checkSender({ expectedRevision: synthetic.configRevision }, actor);
  assert.deepEqual(upstreamResult.failure, { code: 'http_rejected', httpStatus: 503, classification: 'upstream_error' });

  const typedNetwork = makeHarness({ senderCheckError: new FixtureProviderError('network') });
  const networkResult = await typedNetwork.service.checkSender({ expectedRevision: synthetic.configRevision }, actor);
  assert.deepEqual(networkResult.failure, { code: 'network', httpStatus: null, classification: null });

  const untyped = makeHarness({ senderCheckError: new Error('PRIVATE_SENTINEL_UNTYPED') });
  const untypedResult = await untyped.service.checkSender({ expectedRevision: synthetic.configRevision }, actor);
  assert.deepEqual(untypedResult.failure, { code: 'unknown', httpStatus: null, classification: null });
  assert.equal(JSON.stringify(untypedResult).includes('PRIVATE_SENTINEL_UNTYPED'), false);
});

test('configuration cannot be enabled without fresh sender evidence, but a fresh proof permits the explicit save', async () => {
  const stale = makeHarness({ enabled: false, events: [] });
  const enableInput = { expectedRevision: synthetic.configRevision, enabled: true, events: ['contact.message_created'], from: synthetic.from, zoneId: synthetic.zoneId, subdomainId: synthetic.subdomainId };
  await assert.rejects(stale.service.configure(enableInput, actor), error => error.message === 'sender_check_required');

  const expired = makeHarness({ fresh: true, enabled: false, events: [] });
  expired.state.now = expired.state.evidence.expiresAt;
  await assert.rejects(expired.service.configure(enableInput, actor), error => error.message === 'sender_check_required');

  const mismatched = makeHarness({ fresh: true, enabled: false, events: [] });
  mismatched.state.evidence = { ...mismatched.state.evidence, credentialGeneration: '9'.repeat(64) };
  await assert.rejects(mismatched.service.configure(enableInput, actor), error => error.message === 'sender_check_required');

  const valid = makeHarness({ fresh: true, enabled: false, events: [] });
  const saved = await valid.service.configure(enableInput, actor);
  assert.equal(saved.enabled, true);
  assert.equal(saved.revision, synthetic.configRevision + 1);
  assert.equal(valid.state.postCalls.length, 0);
  assert.equal(valid.state.sendCalls.length, 0);
});

test('configuration changes during sender check fence promotion and email dispatch', async () => {
  const { service, state } = makeHarness({ changeConfigAfterCheck: true });
  const result = await service.dispatchNew({ id: synthetic.outboxId, expectedRevision: 1 }, actor);
  assert.equal(result.state, 'blocked');
  assert.equal(state.postCalls.length, 2);
  assert.equal(state.sendCalls.length, 0);
  assert.equal(state.outbox.state, 'blocked');
});

test('credential-generation changes during sender check fence promotion and email dispatch', async () => {
  const { service, state } = makeHarness({ changeCredentialAfterCheck: true });
  const result = await service.dispatchNew({ id: synthetic.outboxId, expectedRevision: 1 }, actor);
  assert.equal(result.state, 'blocked');
  assert.equal(state.postCalls.length, 2);
  assert.equal(state.sendCalls.length, 0);
  assert.equal(state.outbox.state, 'blocked');
});

test('deleting the initiating message during sender check prevents promotion and email dispatch', async () => {
  const { service, state } = makeHarness({ deleteSourceAfterCheck: true });
  const result = await service.dispatchNew({ id: synthetic.outboxId, expectedRevision: 1 }, actor);
  assert.equal(result.state, 'canceled');
  assert.equal(state.postCalls.length, 2);
  assert.equal(state.sendCalls.length, 0);
});

test('unknown email outcome is terminal and an explicit replay cannot send it again', async () => {
  const { service, state } = makeHarness({ fresh: true, sendResult: { state: 'unknown', providerMessageId: null } });
  const first = await service.dispatchNew({ id: synthetic.outboxId, expectedRevision: 1 }, actor);
  assert.equal(first.state, 'unknown');
  const replay = await service.dispatch({ id: synthetic.outboxId, expectedRevision: state.outbox.revision }, actor);
  assert.equal(replay.attempted, false);
  assert.equal(state.sendCalls.length, 1);
  assert.equal(state.postCalls.length, 0);
});
