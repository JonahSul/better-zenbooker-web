import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { enabledModuleFixture } from './fixtures/module-config-fixture.mjs';
import { loadAbuseCore } from './fixtures/load-ts-test-module.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { env: supportEnv, moduleConfig: supportModuleConfig } = enabledModuleFixture('visitor_support');
const offeringFixtureId = '3e672177-5a79-4a99-82f4-9c6673d153a0';

async function loadTs(relative, overrides = {}) {
  const source = await readFile(path.join(root, relative), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((specifier) => {
    if (Object.hasOwn(overrides, specifier)) return overrides[specifier];
    if (specifier === 'zod/v3' && Object.hasOwn(overrides, 'zod')) return overrides.zod;
    if (specifier === 'zod/v3') return require(specifier);
    throw new Error(`Unexpected ${relative} import: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const contextModule = await loadTs('lib/support-preference-context.ts');
const serviceInterests = await loadTs('lib/service-interests.ts', {
  './service-offerings-server': { serviceOfferingStore: () => ({ publicOfferings: async () => ({ offerings: [{ offeringId: offeringFixtureId }] }) }) },
});
const resolverModule = await loadTs('lib/effective-support-preferences.ts', {
  './support-runtime': { supportStore: () => { throw new Error('Unexpected default store'); } },
  './customer-account-store': { CustomerAccountStore: class { async read() { throw new Error('Unexpected default account store'); } } },
  './support-preference-context': contextModule,
});
const { resolveEffectiveSupportPreferences } = resolverModule;
const { supportPreferenceContextSchema, supportPreferenceGuard } = contextModule;

const supportCore = await loadTs('lib/support-core.ts', { zod: require('zod/v3'), './visitor-abuse-core': await loadAbuseCore(root) });
const supportTools = await loadTs('lib/support-tools.ts', {
  'cloudflare:workers': { env: supportEnv },
  './module-config': { ...supportModuleConfig, maintenanceOperation: () => undefined },
  zod: require('zod/v3'),
  './support-core': supportCore,
  './support-preference-context': contextModule,
  './service-interests': serviceInterests,
  './tool-schema': { jsonSchema: () => ({ type: 'object' }) },
  './support-store': {},
});
let onTool;
const supportService = await loadTs('lib/support-service.ts', {
  zod: require('zod/v3'),
  './visitor-abuse-core': await loadAbuseCore(root),
  './visitor-abuse-service': { abuseNoticeAnswer: () => 'A local safety notice.' },
  './visitor-budget-core': await loadTs('lib/visitor-budget-core.ts', {}),
  './support-grounding': {
    routeSupportQuestion: () => 'supported',
    guardSupportAnswer: answer => ({ allowed: true, answer }),
    verifiedUnknownAnswer: () => 'Unsupported fixture question.',
  },
  './support-core': supportCore,
  './support-tools': {
    visitorToolDefinitions: [],
    executeSupportTool: async (...args) => onTool?.(...args) ?? { result: [], contact: false },
  },
  './support-store': {},
});
const { runSupportTurn } = supportService;

const visitorHash = 'a'.repeat(64);
const subjectKey = 'b'.repeat(64);
const sessionHash = 'c'.repeat(64);
const fingerprint = 'd'.repeat(64);
const accountId = '93c16a95-7fc4-4bc2-8d2c-d3b0bff0a224';
const identity = { subjectKey, sessionHash, googleSubject: 'opaque-google-subject', fingerprint };

function fixture({ now = 10_000, session = { revision: 4, memory_expires_at: 40_000 }, identityValue = identity,
  activeSessionExpiresAt = 50_000, account = { exists: true, accountId, revision: 2, expiresAt: 90_000,
    preferences: { remember: true, answerLength: 'short', serviceInterests: ['fall_blowout'] } }, accountPreferenceExpiresAt = 70_000,
  browserPreferences = { revision: 4, remember: true, answerLength: 'standard', serviceInterests: ['maintenance'], expiresAt: 40_000 } } = {}) {
  const reads = { account: 0, accountPreferenceExpiry: 0, identity: 0 };
  const store = {
    db: {}, workspaceId: 'fixture-workspace', now: () => now,
    async session(hash) { assert.equal(hash, visitorHash); return session; },
    async preferences(hash) { assert.equal(hash, visitorHash); return browserPreferences; },
    statement(sql) {
      return { async first() {
        if (sql.includes('SELECT revision FROM app_credential_state')) return { revision: 7 };
        if (sql.includes('FROM customer_google_prefill_sessions')) {
          return activeSessionExpiresAt > now ? { expires_at: activeSessionExpiresAt } : null;
        }
        if (sql.includes('FROM customer_account_preferences')) {
          reads.accountPreferenceExpiry++;
          return accountPreferenceExpiresAt > now ? { expires_at: accountPreferenceExpiresAt } : null;
        }
        throw new Error('Unexpected resolver query');
      } };
    },
  };
  const accountStore = { async read(key) { reads.account++; assert.equal(key, subjectKey); return account; } };
  const getIdentity = async request => { reads.identity++; assert.equal(request.url, 'https://example.test/support'); return identityValue; };
  return { store, accountStore, getIdentity, reads, request: new Request('https://example.test/support') };
}

test('an active remembered account supplies the effective support preferences and a private revision fence', async () => {
  const f = fixture();
  const result = await resolveEffectiveSupportPreferences(f.request, visitorHash, f);

  assert.equal(result.accountActive, true);
  assert.deepEqual(result.preferences, {
    revision: 2, remember: true, answerLength: 'short', serviceInterests: ['fall_blowout'], expiresAt: 50_000,
  });
  assert.deepEqual(result.context, {
    version: 1, source: 'account', browserRevision: 4, browserMemoryExpiresAt: 40_000,
    sessionHash, fingerprint, credentialRevision: 7, subjectKey, accountId, accountRevision: 2, expiresAt: 50_000,
  });
  assert.equal(supportPreferenceContextSchema.safeParse(result.context).success, true);
  const guard = supportPreferenceGuard('fixture-workspace', visitorHash, result.context, 10_000);
  assert.match(guard.sql, /customer_google_prefill_sessions/);
  assert.match(guard.sql, /app_credential_state/);
  assert.match(guard.sql, /customer_accounts/);
  assert.match(guard.sql, /customer_account_preferences/);
  assert.ok(guard.values.includes(2), 'the account revision is checked atomically');
  assert.ok(guard.values.includes(7), 'the credential revision is checked atomically');
  assert.doesNotMatch(JSON.stringify({ preferences: result.preferences, context: result.context }), /opaque-google-subject|email|name|Fixture/);
});

test('missing, expired, or nonremembered account state falls back to current browser preferences', async t => {
  const cases = [
    ['no signed-in account', { identityValue: null }],
    ['expired Google session', { activeSessionExpiresAt: 10_000 }],
    ['forgotten account', { account: { exists: false, accountId: null, revision: 3, expiresAt: null, preferences: { remember: false, answerLength: 'standard', serviceInterests: [] } } }],
    ['account did not opt into remembering', { account: { exists: true, accountId, revision: 3, expiresAt: 90_000, preferences: { remember: false, answerLength: 'standard', serviceInterests: [] } } }],
    ['expired account preference', { accountPreferenceExpiresAt: 10_000 }],
  ];
  for (const [label, overrides] of cases) await t.test(label, async () => {
    const f = fixture(overrides);
    const result = await resolveEffectiveSupportPreferences(f.request, visitorHash, f);
    assert.equal(result.accountActive, false);
    assert.deepEqual(result.preferences, f.store && overrides.browserPreferences || {
      revision: 4, remember: true, answerLength: 'standard', serviceInterests: ['maintenance'], expiresAt: 40_000,
    });
    assert.equal(result.context.source, 'browser');
    if (overrides.identityValue === null || overrides.activeSessionExpiresAt === 10_000) assert.equal(f.reads.account, 0);
  });
});

test('browser edits, logout, forget, and credential rotation invalidate the captured source fences', async () => {
  const f = fixture();
  const { context: accountContext } = await resolveEffectiveSupportPreferences(f.request, visitorHash, f);
  const accountGuard = supportPreferenceGuard('fixture-workspace', visitorHash, accountContext, 10_000);
  assert.ok(accountGuard.values.includes(sessionHash));
  assert.ok(accountGuard.values.includes(subjectKey));
  assert.ok(accountGuard.values.includes(accountId));

  const browserContext = { ...accountContext, source: 'browser', sessionHash: null, fingerprint: null,
    credentialRevision: null, subjectKey: null, accountId: null, accountRevision: 0, expiresAt: null };
  const browserGuard = supportPreferenceGuard('fixture-workspace', visitorHash, browserContext, 10_000);
  assert.ok(browserGuard.values.includes(4), 'the browser preference revision fences stale responses');
  assert.ok(browserGuard.values.includes(40_000), 'the browser preference expiry is part of the fence');
  assert.doesNotMatch(browserGuard.sql, /customer_google_prefill_sessions|customer_accounts/);

  assert.equal(supportPreferenceContextSchema.safeParse({ ...accountContext, profile: { email: 'private@example.test' } }).success, false);
  assert.equal(supportPreferenceContextSchema.safeParse({ ...accountContext, accountRevision: -1 }).success, false);
  assert.equal(supportPreferenceContextSchema.safeParse({ ...accountContext, source: 'account', accountId: null }).success, false);
});

function supportStoreFixture() {
  const state = {
    valid: true,
    preferences: { revision: 2, remember: true, answerLength: 'short', serviceInterests: ['fall_blowout'], expiresAt: 50_000 },
    turn: { id: '74f1d352-3607-4f38-a4fb-a5046b4f40f4', thread_id: '4b3b5be0-4d73-4a42-8e71-c570f22540f3', visitor_hash: visitorHash,
      status: 'pending', message: 'What demo services do you offer?', answer: null, result_json: null,
      thread_revision: 0, session_revision: 4, created_at: 20_000, preference_context_json: null },
    providerCalls: 0, completeCalls: 0, beginCalls: 0, contextCalls: 0, nextReplay: false,
  };
  const store = {
    workspaceId: 'fixture-workspace', now: () => 10_000,
    boundPreferenceContext(value) { return value.preference_context_json ? JSON.parse(value.preference_context_json) : null; },
    async prune() {},
    async beginTurn(_visitor, _args, context) {
      state.beginCalls++;
      if (context) state.turn.preference_context_json = JSON.stringify(context);
      if (state.nextReplay) return { turn: state.turn, replayed: true };
      return { turn: state.turn, replayed: false };
    },
    async attachPhotoContext() {},
    async currentContext() {
      state.contextCalls++;
      if (!state.valid) throw new Error('Preference context changed');
      return { preferences: state.preferences, thread: [] };
    },
    async searchPublicKb() { return []; },
    async reserveCall() { return 'synthetic-call'; },
    async callOutcome() {},
    async completeTurn(_visitor, _turn, result) {
      state.completeCalls++;
      state.turn.status = 'complete';
      state.turn.answer = result.answer;
      state.turn.result_json = JSON.stringify(result);
      return true;
    },
  };
  return { store, state };
}

function supportInput(requestKey = 'support-turn-fixture-key') {
  return { requestKey, message: 'What demo services do you offer?' };
}

function dependencies(store, resolvePreferences, provider) {
  return { enabled: true, dailyModelCalls: 3, resolvePreferences, provider, store };
}

test('support model sees the active account preferences on each round and never receives identity fields', async () => {
  const { store, state } = supportStoreFixture();
  const first = { revision: 2, remember: true, answerLength: 'short', serviceInterests: ['fall_blowout'], expiresAt: 50_000 };
  const context = { version: 1, source: 'account', browserRevision: 4, browserMemoryExpiresAt: 40_000,
    sessionHash, fingerprint, credentialRevision: 7, subjectKey, accountId, accountRevision: 2, expiresAt: 50_000 };
  const observed = [];
  onTool = async () => ({ result: [], contact: false });
  try {
    const result = await runSupportTurn(store, visitorHash, supportInput(), dependencies(store,
      async () => ({ preferences: first, context, accountActive: true }),
      async messages => {
        state.providerCalls++;
        const payload = JSON.parse(messages[1].content);
        observed.push(payload.preferences);
        assert.doesNotMatch(JSON.stringify(messages), /opaque-google-subject|fixture@example\.test|profileSentinel|googleSubject|sessionHash/);
        return { reply: state.providerCalls === 1
          ? { answer: '', toolCalls: [{ name: 'public_kb.search', arguments: { query: 'approved services' } }] }
          : { answer: 'The approved service list can help.', toolCalls: [] }, usage: { prompt_tokens: 1 } };
      }));
    assert.equal(result.status, 'answered');
    assert.equal(state.providerCalls, 2);
    assert.deepEqual(observed, [first, first], 'all rounds in one turn keep the initially captured account revision and values');
    assert.equal(state.turn.status, 'complete');
  } finally { onTool = undefined; }
});

test('a source change while the provider is awaited prevents completion and same-key replay never returns its answer', async () => {
  const { store, state } = supportStoreFixture();
  const context = { version: 1, source: 'account', browserRevision: 4, browserMemoryExpiresAt: 40_000,
    sessionHash, fingerprint, credentialRevision: 7, subjectKey, accountId, accountRevision: 2, expiresAt: 50_000 };
  let releaseProvider;
  let providerStarted;
  const started = new Promise(resolve => { providerStarted = resolve; });
  const waiting = new Promise(resolve => { releaseProvider = resolve; });
  const promise = runSupportTurn(store, visitorHash, supportInput('support-turn-stale-key'), dependencies(store,
    async () => ({ preferences: { revision: 2, remember: true, answerLength: 'short', serviceInterests: ['repair'], expiresAt: 50_000 }, context, accountActive: true }),
    async () => { state.providerCalls++; providerStarted(); await waiting; return { reply: { answer: 'Private stale result', toolCalls: [] }, usage: {} }; }));
  await started;
  state.valid = false;
  releaseProvider();
  const result = await promise;
  assert.equal(result.status, 'superseded');
  assert.equal(state.completeCalls, 0);
  assert.equal(state.turn.answer, null);
  assert.equal(state.providerCalls, 1);

  state.nextReplay = true;
  const replay = await runSupportTurn(store, visitorHash, supportInput('support-turn-stale-key'), dependencies(store,
    async () => ({ preferences: { revision: 2, remember: true, answerLength: 'short', serviceInterests: ['repair'], expiresAt: 50_000 }, context, accountActive: true }),
    async () => { state.providerCalls++; return { reply: { answer: 'must not run', toolCalls: [] }, usage: {} }; }));
  assert.equal(replay.status, 'superseded');
  assert.equal(state.providerCalls, 1, 'same-key replay does not invoke the provider again');
  assert.doesNotMatch(replay.answer, /Private stale result/);
});

test('own-memory reads the same effective account values and account edits open the shared preferences surface', async () => {
  const { store, state } = supportStoreFixture();
  const turn = { ...state.turn, preference_context_json: JSON.stringify({ version: 1, source: 'account', browserRevision: 4,
    browserMemoryExpiresAt: 40_000, sessionHash, fingerprint, credentialRevision: 7, subjectKey, accountId,
    accountRevision: 2, expiresAt: 50_000 }) };
  const effective = { revision: 2, remember: true, answerLength: 'short', serviceInterests: [offeringFixtureId], expiresAt: 50_000 };
  store.currentContext = async () => ({ preferences: effective, thread: [] });
  let browserWrites = 0;
  store.updatePreferences = async () => { browserWrites++; };
  store.forgetPreferences = async () => { browserWrites++; };

  const read = await supportTools.executeSupportTool(store, visitorHash, turn, 'own_memory.read', {}, 'What do you remember?');
  assert.deepEqual(read.result, effective);
  const update = await supportTools.executeSupportTool(store, visitorHash, turn, 'own_memory.update', {
    revision: 2, remember: true, answerLength: 'standard', serviceInterests: [offeringFixtureId],
  }, 'I prefer standard answers.');
  const forget = await supportTools.executeSupportTool(store, visitorHash, turn, 'own_memory.delete', { revision: 2 }, 'Forget my saved preferences.');
  assert.equal(update.openAccountPreferences, true);
  assert.equal(forget.openAccountPreferences, true);
  assert.equal(browserWrites, 0, 'account memory changes never mutate the anonymous browser preference store');
});
