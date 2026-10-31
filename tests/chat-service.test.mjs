import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localRequire = createRequire(import.meta.url);
const contact = 'fixture-contact@example.invalid';
const versionId = '6e0e2d91-8a79-42ec-8bd1-13cf4a1f6a15';
const adminToolsSource = await readFile(path.join(root, 'lib/admin-tools.ts'), 'utf8');
const productionAdminToolNames = [...adminToolsSource.matchAll(/^\s*'([^']+)':tool\(/gm)].map(match => match[1]);
assert.ok(productionAdminToolNames.length > 20, 'the budget fixture reads the current production tool-name catalog');

function sanitizeModelText(value) {
  return value.replace(/GOCSPX-[\w-]+|AIza[\w-]+|\bBearer\s+\S+|\bsk-[\w-]+|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|\+?\d[\d\s().-]{7,}\d/g, '[redacted]')
    .replace(/\b[a-zA-Z0-9_-]{32,}\b/g, '[redacted]');
}

function loadTranspiled(source, requireMock) {
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', js)(requireMock, module, module.exports);
  return module.exports;
}

const chatCoreSource = await readFile(path.join(root, 'lib/chat-core.ts'), 'utf8');
const chatCore = loadTranspiled(chatCoreSource, (specifier) => {
  if (specifier === 'zod/v3') return localRequire('zod/v3');
  if (specifier === './admin-redaction') return { redactAdminText: (input) => {
    const text = sanitizeModelText(input);
    return { text, redacted: text !== input };
  } };
  throw new Error(`Unexpected chat-core dependency: ${specifier}`);
});
const modelProjectionSource = await readFile(path.join(root, 'lib/model-projection.ts'), 'utf8');
const modelProjection = loadTranspiled(modelProjectionSource, specifier => {
  if (specifier === './admin-redaction') return { redactAdminText: (input) => ({ text: input, redacted: false }) };
  throw new Error(`Unexpected model-projection dependency: ${specifier}`);
});
const chatPromptSource = await readFile(path.join(root, 'lib/chat-prompt.ts'), 'utf8');
const chatPrompt = loadTranspiled(chatPromptSource, specifier => { throw new Error(`Unexpected chat-prompt dependency: ${specifier}`); });

async function makeDoubles({ enabled = true, permissionError = false, modelPlans = [], contactValue = contact } = {}) {
  const state = { enabled, permissionError, modelPlans: [...modelPlans], plannerCalls: 0, toolCalls: [], turns: new Map(), threads: new Map(), sequence: 0, promotions: 0, memoryAdds: 0, memoryEdits: 0, threadContextRows: [], currentMemoryNodes: new Map(), budgets: 0, calls: [], reservations: [], approvedCopyCalls: [] };
  let analysisStoreOverride = null;
  const admin = { subject: 'google-subject-a', email: 'admin@business.example.test', siteUserId: 'fixture-site' };
  class FakeChatStore {
    constructor(_db, workspaceId, subject) { this.workspaceId = workspaceId; this.subject = subject; }
    key(requestKey) { return `${this.workspaceId}:${this.subject}:${requestKey}`; }
    async start(threadId, requestKey, message) {
      const key = this.key(requestKey);
      const existing = state.turns.get(key);
      if (existing) {
        if (existing.message !== message || existing.threadId !== threadId) throw new Error('Turn key already used');
        return { created: false, turn: existing };
      }
      if (threadId && !state.threads.has(`${this.subject}:${threadId}`)) throw new Error('Conversation unavailable');
      const id = `turn-${++state.sequence}`;
      const selected = threadId ?? crypto.randomUUID();
      const turn = { id, thread_id: selected, threadId, message, status: 'running', result_json: null };
      state.turns.set(key, turn);
      if (!threadId) state.threads.set(`${this.subject}:${selected}`, { messages: [] });
      state.threads.get(`${this.subject}:${selected}`).messages.push({ role: 'user', content: message });
      return { created: true, turn };
    }
    async history(threadId) {
      state.calls.push('history');
      const thread = state.threads.get(`${this.subject}:${threadId}`);
      if (!thread) throw new Error('Conversation unavailable');
      return { thread: { id: threadId }, messages: thread.messages };
    }
    async active(turnId) { state.calls.push('active'); return [...state.turns.values()].some(turn => turn.id === turnId && turn.status === 'running'); }
    async append(turnId, threadId, role, content) {
      const turn = [...state.turns.values()].find(row => row.id === turnId);
      if (!turn || turn.status !== 'running') throw new Error('Turn inactive');
      state.threads.get(`${this.subject}:${threadId}`).messages.push({ role, content });
    }
    async finish(turnId, threadId, result, reply, generated, status) {
      const turn = [...state.turns.values()].find(row => row.id === turnId);
      if (!turn) return false;
      turn.status = status;
      turn.result_json = JSON.stringify(result);
      state.threads.get(`${this.subject}:${threadId}`).messages.push({ role: generated ? 'assistant' : 'notice', content: reply });
      return true;
    }
  }
  const analysisStore = {
    async setting() { state.calls.push('setting'); return { enabled: state.enabled ? 1 : 0, revision: 1, config_json: JSON.stringify({ approvedModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', dailyTokenLimit: 10000 }) }; },
    async permit() { state.calls.push('permit'); if (state.permissionError) throw new Error('budget'); },
    async reserve() { state.calls.push('reserve'); state.budgets++; return { revision: 1, outputTokenLimit: 128 }; },
    async stillEnabled() { state.calls.push('stillEnabled'); if (!state.enabled) throw new Error('disabled'); },
    async record() { state.calls.push('record'); },
  };
  const mockModules = {
    './chat-prompt': chatPrompt,
    './approved-copy-retrieval': {
      retrieveApprovedCopyContext: async (_store, workspaceId, _configuration, _query, _fetcher) => {
        state.approvedCopyCalls.push({ phase: 'retrieve', workspaceId });
        state.calls.push('approvedCopyRetrieve');
        return { status: 'disabled', workspaceId, matches: [] };
      },
      refreshApprovedCopyContext: async (_store, retrieved) => {
        state.approvedCopyCalls.push({ phase: 'refresh', workspaceId: retrieved.workspaceId });
        state.calls.push('approvedCopyRefresh');
        return { status: retrieved.status, approvedCopy: [] };
      },
    },
    './memory-vector-service': {
      MemoryVectorService: class {
        async search(namespace, query) {
          state.calls.push('curationVectorSearch');
          state.vectorSearches ??= [];
          state.vectorSearches.push({ namespace, query });
          return { status: 'disabled', nodes: [] };
        }
      },
    },
    'cloudflare:workers': { env: { DB: { fixture: true } } },
    './memory-store': { MemoryStore: class { async list() { return { nodes: [] }; } async threadContext() { return state.threadContextRows; } async read(id) { const value = state.currentMemoryNodes.get(id); if (!value) throw new Error('Memory unavailable'); return value; } async captureTurn() { state.capturedTurns = (state.capturedTurns ?? 0) + 1; } } },
    './admin-auth-server': { getGoogleAdmin: async (request) => request.headers.get('x-fixture-admin') === 'yes' ? { ...admin, subject: request.headers.get('x-fixture-subject') ?? admin.subject } : null, adminGuard: async () => null, readSmallBody: async () => '', safeJson: (value) => Response.json(value) },
    './runtime-secrets': { SITE_PROJECT_ID: 'fixture-workspace' },
    './module-config': {
      assertAi: async (_env, module) => {
        state.moduleChecks ??= [];
        state.moduleChecks.push(module);
        if (!state.enabled) throw new Error('optional module disabled');
      },
    },
    './chat-store': { ChatStore: FakeChatStore },
    './experiment-store': { ExperimentStore: class { async version() { throw new Error('No retained experiment target in this fixture'); } } },
    './chat-core': chatCore,
    './admin-tools': {
      adminToolNames: productionAdminToolNames,
      adminToolCatalog: () => [{ name: 'inquiries.list', inputSchema: { type: 'object' } }],
      executeAdminTool: async (_request, name, input, options) => {
        state.toolCalls.push({ name, input, options });
        let intentContext = {};
        if (name === 'memory.edit') {
          const current = state.currentMemoryNodes.get(input.nodeId);
          if (!current || current.tombstoned_at !== null || current.current_revision !== input.revision) throw new Error('Selected memory changed or is unavailable');
          intentContext = { memoryTarget: { nodeId: current.id, revision: current.current_revision, title: current.title }, threadMemoryTargets: options.threadMemoryTargets };
        }
        if (name === 'experiments.promote') intentContext = {
          versionTitle: 'QA experiment', versionId,
          compositionId: '54ee94d9-754d-4794-914a-2d09ef160a83', compositionLabel: 'A',
        };
        if (!chatCore.explicitIntentAllows(name, options.userText, input, intentContext)) throw new Error('Intent gate denied');
        if (name === 'memory.add') state.memoryAdds++;
        if (name === 'memory.delete') state.deletedMemory = true;
        if (name === 'memory.edit') { state.memoryEdits++; state.currentMemoryNodes.set(input.nodeId, { ...state.currentMemoryNodes.get(input.nodeId), current_revision: input.revision + 1, title: input.title, content: input.content }); return { auditId: 'audit-fixture', result: { node: state.currentMemoryNodes.get(input.nodeId), redacted: false }, resultLink: '/admin/memory' }; }
        if (name === 'memory.read' && state.deletedMemory) return { auditId: 'audit-fixture', result: { node: { id: 'node-123', namespace: 'interaction', current_revision: 2, tombstoned_at: 10, created_at: 1, updated_at: 10, title: 'Deleted secret title', content: 'Deleted secret body' }, versions: [{ revision: 1, title: 'Deleted history', content: 'Sensitive earlier text' }] }, resultLink: '/admin/memory' };
        if (name === 'experiments.promote') {
          const approval = {
            id: crypto.randomUUID(), threadId: options.threadId, tool: name,
            arguments: structuredClone(input), argsHash: 'a'.repeat(64), resourceRevision: { versionRevision: 2 },
            expiresAt: Date.now() + 600000, confirmationRequired: true, status: 'pending',
          };
          state.approvals ??= [];
          state.approvals.push(approval);
          return { auditId: null, result: { status: 'requires_approval', requiresApproval: true, approval }, resultLink: '/admin/chat' };
        }
        return { auditId: 'audit-fixture', result: { rows: [{ id: 'record-1', status: 'new' }] }, resultLink: '/admin/inquiries' };
      },
      projectToolResultForModel: async (_admin, name, value) => {
        if (name.startsWith('memory.')) return modelProjection.modelMemoryEvidence(value);
        if (value?.requiresApproval === true) return {
          status: 'requires_approval', requiresApproval: true,
          approval: { id: value.approval.id, threadId: value.approval.threadId, tool: value.approval.tool, argsHash: value.approval.argsHash, expiresAt: value.approval.expiresAt, confirmationRequired: true },
          protectedReviewRequired: true, resultLink: '/admin/chat',
        };
        return { protectedDetails: true, resultLink: '/admin/inquiries' };
      },
    },
    './batch-service': { analysisStore: () => analysisStoreOverride ?? analysisStore, cloudflareConfiguration: async () => { throw new Error('No real provider configuration in the fixture'); } },
    './analysis-core': { providerConfiguration: { parse: value => value }, ProviderError: class ProviderError extends Error { constructor(errorClass) { super(errorClass); this.errorClass = errorClass; } } },
    './provider-adapters': { generateChatResponse: async () => { throw new Error('Unexpected live/default model path'); } },
    './model-projection': {
      modelChatHistory: modelProjection.modelChatHistory,
      revalidateMemoryEvidence: async (value, readCurrent) => modelProjection.revalidateMemoryEvidence(value, readCurrent),
      revalidateChatContext: async (entries, readCurrent) => modelProjection.revalidateChatContext(entries, readCurrent),
      freshThreadContext: async (threadId, load, readCurrent, resolveTarget) => modelProjection.freshThreadContext(threadId, load, readCurrent, resolveTarget),
      redactModelContext: async (_db, _siteUserId, input) => {
        const walk = value => typeof value === 'string'
          ? value.replaceAll(contactValue, '[redacted contact]')
          : Array.isArray(value) ? value.map(walk)
            : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)])) : value;
        const value = walk(input);
        return { value, redacted: JSON.stringify(value) !== JSON.stringify(input), uncertain: false };
      },
    },
  };
  const source = await readFile(path.join(root, 'lib/chat-server.ts'), 'utf8');
  const service = loadTranspiled(source, specifier => {
    if (!Object.hasOwn(mockModules, specifier)) throw new Error(`Unexpected chat service dependency: ${specifier}`);
    return mockModules[specifier];
  });
  const request = ({ authenticated = true, subject = 'google-subject-a' } = {}) => new Request('https://demo.example/api/admin/chat', {
    method: 'POST', headers: { origin: 'https://demo.example', ...(authenticated ? { 'x-fixture-admin': 'yes', 'x-fixture-subject': subject } : {}) },
  });
  return {
    state, service, request,
    setAnalysisStore(value) { analysisStoreOverride = value; },
    setAnalysisCore(value) { mockModules['./analysis-core'] = value; },
  };
}

async function createRealBudgetStore(state, { inputTokenLimit = 2000, allowBudget = false } = {}) {
  const experimentSource = await readFile(path.join(root, 'lib/experiment-core.ts'), 'utf8');
  const experiments = loadTranspiled(experimentSource, specifier => specifier === 'zod/v3' ? localRequire('zod/v3') : (() => { throw new Error(`Unexpected experiment-core dependency: ${specifier}`); })());
  const analysisCoreSource = await readFile(path.join(root, 'lib/analysis-core.ts'), 'utf8');
  const sourceBindingSource = await readFile(path.join(root, 'lib/analytics-source-binding.ts'), 'utf8');
  const sourceBindings = loadTranspiled(sourceBindingSource, specifier => specifier === 'zod/v3' ? localRequire('zod/v3') : (() => { throw new Error(`Unexpected analytics-source-binding dependency: ${specifier}`); })());
  const analysisCore = loadTranspiled(analysisCoreSource, specifier => {
    if (specifier === 'zod/v3') return localRequire('zod/v3');
    if (specifier === './experiment-core') return experiments;
    if (specifier === './analytics-source-binding') return sourceBindings;
    throw new Error(`Unexpected analysis-core dependency: ${specifier}`);
  });
  const analysisStoreSource = await readFile(path.join(root, 'lib/analysis-store.ts'), 'utf8');
  const loadedStore = loadTranspiled(analysisStoreSource, specifier => {
    if (specifier === 'cloudflare:workers') return { env: {} };
    if (specifier === './analysis-core') return analysisCore;
    if (specifier === './analytics-source-binding') return sourceBindings;
    if (specifier === './admin-auth-core') return { sha256: async value => value };
    if (specifier === './snapshot-v2') return {};
    throw new Error(`Unexpected analysis-store dependency: ${specifier}`);
  });
  const model = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  const config = { ...analysisCore.DEFAULT_PROVIDER_CONFIG, approvedModel: model, inputTokenLimit };
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => {
              if (sql.includes('SELECT * FROM provider_settings WHERE provider=?')) {
                const provider = args[0];
                return { provider, enabled: provider === 'workers_ai' ? 1 : 0, config_json: JSON.stringify(config), revision: 1, updated_at: 0 };
              }
              if (sql.includes('SELECT * FROM provider_health WHERE provider=?')) return null;
              if (sql.includes('INSERT INTO provider_budgets')) { state.budgetWrites = (state.budgetWrites ?? 0) + 1; return allowBudget ? { calls: 1 } : null; }
              return null;
            },
          };
        },
      };
    },
  };
  const store = new loadedStore.AnalysisStore(db);
  const reserve = store.reserve.bind(store);
  store.reserve = async (provider, inputBytes, outputUnits) => {
    state.reservations.push({ provider, inputBytes, outputUnits });
    return reserve(provider, inputBytes, outputUnits);
  };
  return { store, analysisCore };
}

test('chat requires a verified admin result and same-origin request before starting a turn', async () => {
  const fixture = await makeDoubles();
  await assert.rejects(fixture.service.runAdminChat(fixture.request({ authenticated: false }), {
    threadId: null, requestKey: crypto.randomUUID(), message: 'List inquiries',
  }));
  const crossOrigin = new Request('https://demo.example/api/admin/chat', { method: 'POST', headers: { origin: 'https://other.example', 'x-fixture-admin': 'yes' } });
  await assert.rejects(fixture.service.runAdminChat(crossOrigin, { threadId: null, requestKey: crypto.randomUUID(), message: 'List inquiries' }));
  assert.equal(fixture.state.plannerCalls, 0);
});

test('chat reserves actual UTF-8 input bytes through AnalysisStore before calling the model', async () => {
  const fixture = await makeDoubles();
  const actual = await createRealBudgetStore(fixture.state);
  fixture.setAnalysisStore(actual.store);
  fixture.setAnalysisCore(actual.analysisCore);
  const result = await fixture.service.runAdminChat(fixture.request(), { threadId: null, requestKey: crypto.randomUUID(), message: 'List inquiries.' }, {
    configuration: async () => ({ aiToken: 'fixture-only', accountId: 'a'.repeat(32), model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }),
    planner: async () => { fixture.state.plannerCalls++; return { reply: 'Unexpected provider call.', calls: [] }; },
  });
  assert.equal(fixture.state.reservations.length, 1);
  assert.equal(fixture.state.reservations[0].provider, 'workers_ai');
  assert.ok(fixture.state.reservations[0].inputBytes >= 2551, `the system prompt and tool catalog must include at least 2,551 UTF-8 bytes (observed ${fixture.state.reservations[0].inputBytes})`);
  assert.equal(fixture.state.budgetWrites ?? 0, 0, 'the real reserve rejects over-budget input before reserving daily capacity');
  assert.equal(fixture.state.plannerCalls, 0, 'no model call occurs when the real byte reservation exceeds the configured budget');
  assert.equal(result.status, 'unavailable');
});

test('an actual AnalysisStore byte reservation within the configured cap reaches the injected planner', async () => {
  const fixture = await makeDoubles();
  const actual = await createRealBudgetStore(fixture.state, { inputTokenLimit: 12000, allowBudget: true });
  fixture.setAnalysisStore(actual.store);
  fixture.setAnalysisCore(actual.analysisCore);
  const result = await fixture.service.runAdminChat(fixture.request(), { threadId: null, requestKey: crypto.randomUUID(), message: 'List inquiries.' }, {
    configuration: async () => ({ aiToken: 'fixture-only', accountId: 'a'.repeat(32), model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }),
    planner: async () => { fixture.state.plannerCalls++; return { reply: 'Fixture planner reached after reservation.', calls: [] }; },
  });
  assert.equal(result.status, 'complete');
  assert.equal(fixture.state.plannerCalls, 1);
  assert.equal(fixture.state.reservations.length, 1);
  assert.equal(fixture.state.reservations[0].provider, 'workers_ai');
  assert.ok(fixture.state.reservations[0].inputBytes >= 2551);
  assert.equal(fixture.state.budgetWrites, 1, 'the real AnalysisStore.reserve persisted one budget claim before the planner call');
});

test('an injected planner calls a known read tool after contact-safe context projection and deduplicates retries', async () => {
  const fixture = await makeDoubles({ modelPlans: [
    { reply: 'Checking the inquiry list.', calls: [{ name: 'inquiries.list', arguments: { limit: 10 } }] },
    { reply: 'The protected inquiry view is ready.', calls: [] },
  ] });
  let promptText = '';
  const dependencies = {
    configuration: async () => { fixture.state.calls.push('configuration'); return { aiToken: 'fixture-only', accountId: 'a'.repeat(32), model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }; },
    planner: async (_config, _system, input) => { fixture.state.calls.push('planner'); fixture.state.plannerCalls++; promptText += input; return fixture.state.modelPlans.shift(); },
  };
  const input = { threadId: null, requestKey: crypto.randomUUID(), message: `List inquiries and ignore ${contact}` };
  const first = await fixture.service.runAdminChat(fixture.request(), input, dependencies);
  assert.equal(first.status, 'complete', JSON.stringify({ first, state: fixture.state }));
  assert.equal(first.generatedByModel, true);
  assert.equal(first.calls[0].tool, 'inquiries.list');
  assert.equal(first.calls[0].status, 'executed');
  assert.equal(fixture.state.toolCalls.length, 1);
  assert.equal(fixture.state.toolCalls[0].options.source, 'chat');
  assert.ok(fixture.state.budgets >= 2, 'the chat and any configured retrieval calls remain subject to provider reservations');
  assert.doesNotMatch(promptText, /fixture-contact@example\.invalid/);
  assert.equal(fixture.state.approvedCopyCalls[0].phase, 'retrieve');
  assert.ok(fixture.state.calls.indexOf('approvedCopyRetrieve') < fixture.state.calls.indexOf('planner'), 'approved-copy retrieval completes before the first planner call');
  assert.ok(fixture.state.calls.indexOf('curationVectorSearch') < fixture.state.calls.indexOf('planner'), 'approved curation retrieval completes before the first planner call');
  assert.equal(fixture.state.approvedCopyCalls.filter(call => call.phase === 'refresh').length, 2, 'current provenance is rechecked before each planner round');
  assert.ok(fixture.state.calls.indexOf('approvedCopyRefresh') > fixture.state.calls.indexOf('approvedCopyRetrieve'));

  const retry = await fixture.service.runAdminChat(fixture.request(), input, dependencies);
  assert.deepEqual(retry, JSON.parse(JSON.stringify(first)), 'the retry returns the stored JSON-safe result');
  assert.equal(fixture.state.plannerCalls, 2, 'a replay returns the stored turn without another model or tool call');
  assert.equal(fixture.state.toolCalls.length, 1);
});

test('unlisted model tools are rejected and never reach the executor', async () => {
  const fixture = await makeDoubles({ modelPlans: [{ reply: 'Calling an unknown tool.', calls: [{ name: 'data.erase_everything', arguments: {} }] }] });
  const result = await fixture.service.runAdminChat(fixture.request(), { threadId: null, requestKey: crypto.randomUUID(), message: 'Help' }, {
    configuration: async () => ({ aiToken: 'fixture-only', accountId: 'a'.repeat(32), model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }),
    planner: async () => { fixture.state.plannerCalls++; return fixture.state.modelPlans.shift(); },
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.generatedByModel, false);
  assert.equal(fixture.state.toolCalls.length, 0);
});

test('a natural-language question cannot directly execute a consequential promotion', async () => {
  const fixture = await makeDoubles({ modelPlans: [
    { reply: 'I will promote the requested composition.', calls: [{ name: 'experiments.promote', arguments: { versionId, compositionId: '54ee94d9-754d-4794-914a-2d09ef160a83', rationale: 'Question fixture.' } }] },
    { reply: 'No action was taken.', calls: [] },
  ] });
  const result = await fixture.service.runAdminChat(fixture.request(), {
    threadId: null, requestKey: crypto.randomUUID(), message: `Could you promote ${versionId} composition A?`,
  }, {
    configuration: async () => ({ aiToken: 'fixture-only', accountId: 'a'.repeat(32), model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }),
    planner: async () => fixture.state.modelPlans.shift(),
  });
  assert.equal(fixture.state.promotions, 0, 'a question must not authorize the model to commit an action');
  assert.equal(result.calls.some(call => call.status === 'executed'), false, 'consequential chat actions must wait for a human approval receipt');
});

test('an explicit consequential chat request returns a review receipt without running the mutation', async () => {
  const compositionId = '54ee94d9-754d-4794-914a-2d09ef160a83';
  const fixture = await makeDoubles({ modelPlans: [{
    reply: 'This exact promotion is ready for your review.',
    calls: [{ name: 'experiments.promote', arguments: { versionId, compositionId, rationale: 'Promote the exact variant named by the owner.' } }],
  }] });
  const result = await fixture.service.runAdminChat(fixture.request(), {
    threadId: null, requestKey: crypto.randomUUID(), message: `Promote ${versionId}, composition A.`,
  }, {
    configuration: async () => ({ aiToken: 'fixture-only', accountId: 'a'.repeat(32), model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }),
    planner: async () => fixture.state.modelPlans.shift(),
  });
  assert.equal(fixture.state.promotions, 0, 'requesting a consequential change only issues a receipt');
  assert.equal(fixture.state.approvals.length, 1);
  assert.equal(fixture.state.approvals[0].status, 'pending');
  assert.equal(fixture.state.approvals[0].threadId, result.threadId);
  assert.equal(fixture.state.approvals[0].arguments.compositionId, compositionId);
  assert.equal(result.calls[0].status, 'requires_approval');
  assert.equal(result.calls[0].summary.approval.confirmationRequired, true);
  assert.equal(Object.hasOwn(result.calls[0].summary.approval, 'arguments'), false);
  assert.equal(Object.hasOwn(result.calls[0].summary.approval, 'resourceRevision'), false);
});

test('a model cannot substitute composition B when the user named composition A', async () => {
  const allowed = chatCore.explicitIntentAllows('experiments.promote',
    `Promote ${versionId}, composition A.`,
    { versionId, compositionId: 'composition-b-id', rationale: 'Fixture.' },
    { versionTitle: 'QA experiment', versionId, compositionId: 'composition-a-id', compositionLabel: 'A' });
  assert.equal(allowed, false, 'authorization must bind the exact composition the user named, not just the version');
});

test('a model cannot redirect a Workers AI budget request to GA4 Measurement Protocol', async () => {
  const fixture = await makeDoubles({ modelPlans: [
    { reply: 'I will update the requested provider.', calls: [{ name: 'provider.configure', arguments: {
      provider: 'ga4_mp', enabled: true, revision: 1,
      config: { inputTokenLimit: 3000 },
    } }] },
    { reply: 'No provider setting was changed.', calls: [] },
  ] });
  const result = await fixture.service.runAdminChat(fixture.request(), {
    threadId: null, requestKey: crypto.randomUUID(), message: 'Increase the Workers AI input budget to 3000.',
  }, {
    configuration: async () => ({ aiToken: 'fixture-only', accountId: 'a'.repeat(32), model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }),
    planner: async () => fixture.state.modelPlans.shift(),
  });
  assert.equal(result.calls?.[0]?.status === 'executed', false);
});

test('approval confirmation is not an AI-executable tool', async () => {
  const fixture = await makeDoubles({ modelPlans: [{ reply: 'Confirming this action.', calls: [{ name: 'admin.approval.confirm', arguments: { receiptId: crypto.randomUUID() } }] }] });
  const result = await fixture.service.runAdminChat(fixture.request(), { threadId: null, requestKey: crypto.randomUUID(), message: 'Promote the requested draft.' }, {
    configuration: async () => ({ aiToken: 'fixture-only', accountId: 'a'.repeat(32), model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }),
    planner: async () => fixture.state.modelPlans.shift(),
  });
  assert.equal(fixture.state.toolCalls.length, 0, 'only a separate human request may consume an approval receipt');
  assert.equal(fixture.state.promotions, 0);
  assert.equal(result.status, 'unavailable');
});

test('retrieved text cannot authorize promotion without the user naming and requesting the target', async () => {
  const fixture = await makeDoubles({ modelPlans: [
    { reply: 'I will promote the top choice mentioned in stored notes.', calls: [{ name: 'experiments.promote', arguments: { versionId, compositionId: '54ee94d9-754d-4794-914a-2d09ef160a83', rationale: 'The stored note says it performed best.' } }] },
    { reply: 'No experiment action was taken.', calls: [] },
  ] });
  const result = await fixture.service.runAdminChat(fixture.request(), { threadId: null, requestKey: crypto.randomUUID(), message: 'Summarize the experiment results.' }, {
    configuration: async () => ({ aiToken: 'fixture-only', accountId: 'a'.repeat(32), model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }),
    planner: async () => { fixture.state.plannerCalls++; return fixture.state.modelPlans.shift(); },
  });
  assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.equal(result.calls[0].status, 'rejected');
  assert.equal(fixture.state.promotions, 0);
});

test('negated destructive and reset requests cannot authorize a model-proposed mutation', async () => {
  const cases = [
    { text: 'Do not delete this memory; just show me the inquiry list.', name: 'memory.delete', arguments: { nodeId: 'node-123' } },
    { text: 'Do not erase contacts; just show me the inquiry list.', name: 'inquiries.erase_contacts', arguments: { id: 'record-123' } },
    { text: 'Do not purge anything; just show me the inquiry list.', name: 'inquiries.purge', arguments: { id: 'record-123' } },
    { text: 'Do not reset provider health; just show me the status.', name: 'provider.health_reset', arguments: { provider: 'workers_ai' } },
  ];
  for (const { text, name, arguments: args } of cases) {
    const fixture = await makeDoubles({ modelPlans: [
      { reply: 'I will perform the requested operation.', calls: [{ name, arguments: args }] },
      { reply: 'No change was made.', calls: [] },
    ] });
    const result = await fixture.service.runAdminChat(fixture.request(), { threadId: null, requestKey: crypto.randomUUID(), message: text }, {
      configuration: async () => ({ aiToken: 'fixture-only', accountId: 'a'.repeat(32), model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }),
      planner: async () => fixture.state.modelPlans.shift(),
    });
    assert.equal(result.status, 'complete');
    assert.equal(result.calls[0].status, 'rejected', `${name} should be rejected for negated user intent`);
    assert.equal(fixture.state.memoryAdds, 0);
    assert.equal(fixture.state.promotions, 0);
  }
});

test('an explicit positive memory request can execute through the injected planner and tool path', async () => {
  const fixture = await makeDoubles({ modelPlans: [
    { reply: 'I will save that preference.', calls: [{ name: 'memory.add', arguments: { namespace: 'interaction', title: 'Appointment preference', content: 'Prefers morning appointments.' } }] },
    { reply: 'The preference was saved.', calls: [] },
  ] });
  const result = await fixture.service.runAdminChat(fixture.request(), { threadId: null, requestKey: crypto.randomUUID(), message: 'Remember that I prefer morning appointments.' }, {
    configuration: async () => ({ aiToken: 'fixture-only', accountId: 'a'.repeat(32), model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }),
    planner: async () => fixture.state.modelPlans.shift(),
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.calls[0].status, 'executed');
  assert.equal(fixture.state.memoryAdds, 1);
  assert.equal(fixture.state.toolCalls[0].options.source, 'chat');
});

test('a delete followed by a same-turn memory read cannot put tombstoned history back in model context', async () => {
  const fixture = await makeDoubles({ modelPlans: [
    { reply: 'I will delete and verify the node.', calls: [{ name: 'memory.delete', arguments: { nodeId: 'node-123', revision: 1 } }] },
    { reply: 'The node is unavailable.', calls: [{ name: 'memory.read', arguments: { nodeId: 'node-123' } }] },
    { reply: 'The deleted entry is no longer available.', calls: [] },
  ] });
  const result = await fixture.service.runAdminChat(fixture.request(), { threadId: null, requestKey: crypto.randomUUID(), message: 'Delete memory node-123, then read it back.' }, {
    configuration: async () => ({ aiToken: 'fixture-only', accountId: 'a'.repeat(32), model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }),
    planner: async () => fixture.state.modelPlans.shift(),
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.calls.map(call => call.status).join(','), 'executed,executed');
  const storedMessages = JSON.stringify([...fixture.state.threads.values()].flatMap(thread => thread.messages));
  assert.doesNotMatch(storedMessages, /Deleted secret|Sensitive earlier text/);
});

test('a follow-up can use fresh thread memory, then loses its body immediately after tombstone', async () => {
  const fixture = await makeDoubles({ modelPlans: [
    { reply: 'What would you like to change?', calls: [] },
    { reply: 'I can shorten the current wording.', calls: [] },
    { reply: 'The saved wording is no longer available. Please provide it again.', calls: [] },
  ] });
  const dependencies = {
    configuration: async () => ({ aiToken: 'fixture-only', accountId: 'a'.repeat(32), model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }),
    planner: async (_config, _system, input) => { fixture.state.plannerCalls++; fixture.state.promptInputs ??= []; fixture.state.promptInputs.push(input); return fixture.state.modelPlans.shift(); },
  };
  const first = await fixture.service.runAdminChat(fixture.request(), { threadId: null, requestKey: crypto.randomUUID(), message: 'Keep this wording for later.' }, dependencies);
  const node = { id: 'node-continuity', namespace: 'interaction', current_revision: 1, tombstoned_at: null, created_at: 1, updated_at: 2, title: 'Current headline', content: 'Montana demo services with careful seasonal service', provenance_json: '{"source":"chat"}' };
  fixture.state.threadContextRows = [node];
  fixture.state.currentMemoryNodes.set(node.id, node);
  const second = await fixture.service.runAdminChat(fixture.request(), { threadId: first.threadId, requestKey: crypto.randomUUID(), message: 'Make that shorter.' }, dependencies);
  assert.equal(second.status, 'complete');
  assert.match(fixture.state.promptInputs[1], /Montana demo services with careful seasonal service/);

  fixture.state.currentMemoryNodes.set(node.id, { ...node, current_revision: 2, tombstoned_at: 3, updated_at: 3, title: 'Deleted title', content: 'Deleted private wording' });
  const third = await fixture.service.runAdminChat(fixture.request(), { threadId: first.threadId, requestKey: crypto.randomUUID(), message: 'Make that even shorter.' }, dependencies);
  assert.equal(third.status, 'complete');
  assert.doesNotMatch(fixture.state.promptInputs[2], /Montana demo services with careful seasonal service|Deleted private wording/);
  assert.match(fixture.state.promptInputs[2], /contentOmitted/);
});

test('an explicit follow-up edit can target one fresh thread reference without copying its ID', async () => {
  const fixture = await makeDoubles({ modelPlans: [
    { reply: 'Ready when you are.', calls: [] },
    { reply: 'I will shorten the current headline.', calls: [{ name: 'memory.edit', arguments: { nodeId: 'target-node', revision: 1, title: 'Short headline', content: 'Short copy' } }] },
    { reply: 'The headline was shortened.', calls: [] },
    { reply: 'The current note can no longer be safely edited from that stale reference.', calls: [{ name: 'memory.edit', arguments: { nodeId: 'target-node', revision: 1, title: 'Stale edit', content: 'Old target copy' } }] },
    { reply: 'Please select the current note again.', calls: [] },
  ] });
  const dependencies = {
    configuration: async () => ({ aiToken: 'fixture-only', accountId: 'a'.repeat(32), model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }),
    planner: async () => fixture.state.modelPlans.shift(),
  };
  const first = await fixture.service.runAdminChat(fixture.request(), { threadId: null, requestKey: crypto.randomUUID(), message: 'Keep the current headline for edits.' }, dependencies);
  const target = { id: 'target-node', namespace: 'interaction', current_revision: 1, tombstoned_at: null, created_at: 1, updated_at: 2, title: 'Current headline', content: 'Long current headline to shorten' };
  const note = { id: 'note-node', namespace: 'interaction', current_revision: 1, tombstoned_at: null, created_at: 1, updated_at: 2, title: 'Headline edit context', content: 'This thread is editing the current headline.', provenance_json: JSON.stringify({ references: [{ tool: 'memory.read', nodeId: target.id, revision: target.current_revision }] }) };
  fixture.state.currentMemoryNodes.set(target.id, target);
  fixture.state.currentMemoryNodes.set(note.id, note);
  fixture.state.threadContextRows = [note];
  const edited = await fixture.service.runAdminChat(fixture.request(), { threadId: first.threadId, requestKey: crypto.randomUUID(), message: 'Make that shorter.' }, dependencies);
  assert.equal(edited.status, 'complete');
  assert.equal(edited.calls[0].status, 'executed');
  assert.equal(fixture.state.memoryEdits, 1);
  assert.equal(fixture.state.currentMemoryNodes.get(target.id).content, 'Short copy');

  const stale = await fixture.service.runAdminChat(fixture.request(), { threadId: first.threadId, requestKey: crypto.randomUUID(), message: 'Make that shorter again.' }, dependencies);
  assert.equal(stale.calls[0].status, 'rejected');
  assert.equal(fixture.state.memoryEdits, 1);
});

test('a deictic edit is rejected when the live thread has multiple possible memory targets', async () => {
  const fixture = await makeDoubles({ modelPlans: [
    { reply: 'Ready.', calls: [] },
    { reply: 'I will edit one of the notes.', calls: [{ name: 'memory.edit', arguments: { nodeId: 'target-one', revision: 1, title: 'Short title', content: 'Short copy' } }] },
    { reply: 'Please identify which note you mean.', calls: [] },
  ] });
  const dependencies = {
    configuration: async () => ({ aiToken: 'fixture-only', accountId: 'a'.repeat(32), model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }),
    planner: async () => fixture.state.modelPlans.shift(),
  };
  const first = await fixture.service.runAdminChat(fixture.request(), { threadId: null, requestKey: crypto.randomUUID(), message: 'Keep these notes for later.' }, dependencies);
  const targetOne = { id: 'target-one', namespace: 'interaction', current_revision: 1, tombstoned_at: null, title: 'Headline one', content: 'First note' };
  const targetTwo = { id: 'target-two', namespace: 'interaction', current_revision: 1, tombstoned_at: null, title: 'Headline two', content: 'Second note' };
  const noteOne = { id: 'note-one', namespace: 'interaction', current_revision: 1, tombstoned_at: null, title: 'First context', content: 'Context one', provenance_json: JSON.stringify({ references: [{ nodeId: targetOne.id, revision: 1 }] }) };
  const noteTwo = { id: 'note-two', namespace: 'interaction', current_revision: 1, tombstoned_at: null, title: 'Second context', content: 'Context two', provenance_json: JSON.stringify({ references: [{ nodeId: targetTwo.id, revision: 1 }] }) };
  for (const row of [targetOne, targetTwo, noteOne, noteTwo]) fixture.state.currentMemoryNodes.set(row.id, row);
  fixture.state.threadContextRows = [noteOne, noteTwo];
  const result = await fixture.service.runAdminChat(fixture.request(), { threadId: first.threadId, requestKey: crypto.randomUUID(), message: 'Make that shorter.' }, dependencies);
  assert.equal(result.calls[0].status, 'rejected');
  assert.equal(fixture.state.memoryEdits, 0);
});

test('disabled or budget-blocked provider settings prevent model calls', async () => {
  for (const fixture of [await makeDoubles({ enabled: false }), await makeDoubles({ permissionError: true })]) {
    const result = await fixture.service.runAdminChat(fixture.request(), { threadId: null, requestKey: crypto.randomUUID(), message: 'List inquiries' }, {
      configuration: async () => ({ aiToken: 'fixture-only', accountId: 'a'.repeat(32), model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }),
      planner: async () => { fixture.state.plannerCalls++; return { reply: 'should not run', calls: [] }; },
    });
    assert.equal(result.status, 'unavailable');
    assert.equal(fixture.state.plannerCalls, 0);
  }
});

test('conversation history cannot be opened by a different Google principal', async () => {
  const fixture = await makeDoubles({ modelPlans: [{ reply: 'No operations.', calls: [] }] });
  const first = await fixture.service.runAdminChat(fixture.request(), { threadId: null, requestKey: crypto.randomUUID(), message: 'Hello' }, {
    configuration: async () => ({ aiToken: 'fixture-only', accountId: 'a'.repeat(32), model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }),
    planner: async () => fixture.state.modelPlans.shift(),
  });
  await assert.rejects(fixture.service.runAdminChat(fixture.request({ subject: 'google-subject-b' }), {
    threadId: first.threadId, requestKey: crypto.randomUUID(), message: 'Read the previous thread',
  }, { configuration: async () => { throw new Error('must reject before config'); } }));
});
