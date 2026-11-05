import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadScheduler(state) {
  const source = await readFile(path.join(root, 'lib/standalone-scheduler.ts'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  const proxy = {
    request: async (...args) => { state.modelCalls++; return { ok: true, args }; },
    status: async () => ({ enabled: true, health: 'verified', configured: true }),
    reserveSystemCall: async () => 'call-id',
  };
  class SupportAdminService {
    constructor(store, suppliedProxy) { this.store = store; this.proxy = suppliedProxy; }
    async curate(key, actor) {
      state.curations.push({ key, actor });
      await this.proxy.request('/infer', { messages: [], tools: [], max_tokens: 32 }, () => {});
      return { status: 'draft', published: false };
    }
  }
  const imports = {
    './module-config': {
      assertAi: async () => {
        state.aiChecks++;
        if (!state.aiReady) throw new Error('AI disabled');
        if (state.turnOffAtAiCheck) state.enabled = false;
      },
      assertModule: async (_env, module) => {
        state.moduleChecks.push(module);
        if (!state.enabled || !state.ready) throw new Error('module unavailable');
      },
      moduleStatus: async () => ({
        module: 'schedules', enabled: state.enabled, revision: 1,
        config: state.config, status: state.enabled ? 'ready' : 'disabled',
      }),
      scheduleConfiguration: (config) => config?.task === 'visitor_curation' && /^\d{1,2} \d{1,2} \* \* \*$/.test(config.cron)
        ? { task: 'visitor_curation', cron: config.cron } : null,
    },
    './support-admin': { SupportAdminService },
    './support-runtime': {
      supportStore: () => ({ prune: async () => { state.prunes++; } }),
      supportProxy: () => proxy,
    },
    './admin-auth-core': { sha256: async (value) => `digest-${value}` },
  };
  new Function('require', 'module', 'exports', js)((name) => {
    if (Object.hasOwn(imports, name)) return imports[name];
    throw new Error(`Unexpected scheduler import: ${name}`);
  }, loaded, loaded.exports);
  return loaded.exports.dispatchScheduled;
}

function fixture(overrides = {}) {
  const state = {
    enabled: false, ready: true, aiReady: true, turnOffAtAiCheck: false,
    config: { task: 'visitor_curation', cron: '15 7 * * *' },
    prunes: 0, aiChecks: 0, modelCalls: 0, moduleChecks: [], curations: [], ...overrides,
  };
  return { state, runtime: { DB: {}, INSTALLATION_ID: 'qa-installation', AI: { run: async () => ({}) } } };
}

function recentDailyEvent(minute = 15) {
  const now = Date.now();
  const currentDay = new Date(now);
  let candidate = Date.UTC(currentDay.getUTCFullYear(), currentDay.getUTCMonth(), currentDay.getUTCDate(), 7, minute);
  if (candidate > now + 300000) candidate -= 86400000;
  return candidate;
}

test('scheduled handler keeps privacy cleanup available while schedule and AI are disabled', async () => {
  const { state, runtime } = fixture();
  const dispatch = await loadScheduler(state);
  const result = await dispatch(runtime, { scheduledTime: Date.UTC(2026, 9, 31, 7, 15), cron: '15 7 * * *' });
  assert.equal(result.cleanup, 'complete');
  assert.equal(result.generation, 'disabled');
  assert.equal(state.prunes, 1);
  assert.equal(state.aiChecks, 0);
  assert.equal(state.modelCalls, 0);
  assert.equal(state.curations.length, 0);
});

test('scheduled curation requires an exact UTC event and emits the same daily idempotency key without publishing', async () => {
  const { state, runtime } = fixture({ enabled: true });
  const dispatch = await loadScheduler(state);
  const scheduledTime = recentDailyEvent();
  const wrongCron = await dispatch(runtime, { scheduledTime, cron: '16 7 * * *' });
  assert.equal(wrongCron.generation, 'not_due');
  const wrongMinute = await dispatch(runtime, { scheduledTime: recentDailyEvent(14), cron: '15 7 * * *' });
  assert.equal(wrongMinute.generation, 'not_due');
  const result = await dispatch(runtime, { scheduledTime, cron: '15 7 * * *' });
  assert.equal(result.generation, 'processed');
  assert.equal(result.published, false);
  assert.equal(state.modelCalls, 1);
  assert.equal(state.curations.length, 1);
  const firstKey = state.curations[0].key;
  assert.match(firstKey, /^schedule_digest-/);
  assert.match(state.curations[0].actor, /^system:scheduled:digest-/);
  await dispatch(runtime, { scheduledTime, cron: '15 7 * * *' });
  assert.equal(state.curations[1].key, firstKey, 'repeat deliveries of a daily event share the durable store request key');
  assert.equal(state.curations[1].actor, state.curations[0].actor);
  assert.equal(state.curations[1].published, undefined, 'the scheduler has no publish capability');
});

test('scheduler rechecks its module gate immediately before model dispatch', async () => {
  const { state, runtime } = fixture({ enabled: true, turnOffAtAiCheck: true });
  const dispatch = await loadScheduler(state);
  const result = await dispatch(runtime, { scheduledTime: recentDailyEvent(), cron: '15 7 * * *' });
  assert.equal(result.generation, 'unavailable');
  assert.equal(state.modelCalls, 0);
  assert.ok(state.moduleChecks.length >= 2, 'expected readiness checks before prep and dispatch');
});

test('scheduler rejects stale, future, and invalid-time invocations without calling AI', async () => {
  const { state, runtime } = fixture({ enabled: true });
  const dispatch = await loadScheduler(state);
  for (const event of [
    { scheduledTime: Date.now() - 2 * 86400000, cron: '15 7 * * *' },
    { scheduledTime: Date.now() + 10 * 60000, cron: '15 7 * * *' },
    { scheduledTime: Number.NaN, cron: '15 7 * * *' },
  ]) {
    const result = await dispatch(runtime, event);
    assert.equal(result.generation, 'not_due');
  }
  assert.equal(state.modelCalls, 0);
  assert.equal(state.curations.length, 0);
});
