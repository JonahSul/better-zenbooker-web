import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireFromTest = createRequire(import.meta.url);

async function loadAdminTools() {
  const source = await readFile(path.join(root, 'lib/admin-tools.ts'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const state = { starts: [], auditRows: [], moduleGates: [] };
  const z = requireFromTest('zod/v3').z;
  const passthrough = z.object({}).passthrough();
  const store = {
    async start(...args) { state.starts.push(args); return { runningVersionId: args[1] }; },
  };
  const fakeStoreFactory = () => store;
  const modules = {
    './chat-prompt': { chatPromptReadiness: () => ({}) },
    './module-config': {
      assertModule: async (_env, module) => { state.moduleGates.push(module); },
      toolModule: name => name.startsWith('experiments.') ? 'experiments' : null,
      maintenanceOperation: () => false,
    },
    './action-approval-core': { ActionApprovalStore: class {}, requiresActionApproval: () => true },
    './google-reviews-server': { googleReviewsRoute: async () => Response.json({}) },
    './approved-baseline': { ApprovedBaselineStore: class {} },
    './public-compiler': { publicArtifacts: { baseline: { hash: '0'.repeat(64) }, assetManifestHash: '1'.repeat(64), rendererVersion: 'fixture' } },
    './experiment-core': { HARD_RULES: { version: 'fixture' }, selectedCompositions: z.array(z.any()) },
    './snapshot-v2': { snapshotV2Input: passthrough },
    './memory-vector-service': { MemoryVectorService: class {} },
    './batch-service': { analysisStore: fakeStoreFactory, batchService: fakeStoreFactory, cloudflareConfiguration: async () => ({}) },
    './chat-store': { ChatStore: class {} },
    './tool-schema': { schemaDescription: () => ({}) },
    './model-projection': { relevantContacts: async () => [], redactModelContext: async (_db, _id, value) => ({ value, uncertain: false }), modelMemoryEvidence: value => value, revalidateMemoryEvidence: async value => value, modelChatHistory: value => value },
    'cloudflare:workers': { env: { DB: {} } },
    './console-server': { consoleStore: fakeStoreFactory, memoryStore: fakeStoreFactory },
    './element-measurement-server': {
      elementStatusInput: passthrough,
      elementReportInput: passthrough,
      elementMeasurementService: fakeStoreFactory,
    },
    './ga4-property-configuration-server': { ga4PropertyConfigurationService: fakeStoreFactory, ga4PropertyConfigurationInput: passthrough, ga4PropertyConfigurationStatusInput: passthrough },
    './contact-admin-server': { contactAdminService: fakeStoreFactory },
    './contact-notification-server': { contactNotificationService: fakeStoreFactory, contactDispatchInput: passthrough, contactSenderCheckInput: passthrough },
    './contact-notification-configuration': { contactNotificationConfigurationInput: passthrough, ContactNotificationConfigurationStore: class {} },
    './contact-core': { contactStatusInput: passthrough, contactDeleteInput: passthrough },
    './contact-model-projection': { projectContactToolResult: (_name, value) => value },
    './trustindex-widget-configuration-server': { trustindexWidgetConfigurationService: fakeStoreFactory, trustindexWidgetInput: passthrough, trustindexWidgetConfigurationStatusInput: passthrough },
    './service-offerings-server': { serviceOfferingStore: fakeStoreFactory, offeringDraftInput: passthrough, offeringPublishInput: passthrough, offeringWithdrawInput: passthrough, offeringStatusInput: passthrough },
    './analytics-configuration-server': { analyticsConfigurationService: fakeStoreFactory, analyticsConfigurationInput: passthrough, analyticsConfigurationStatusInput: passthrough },
    './performance-server': { performanceStore: fakeStoreFactory },
    './performance-core': { performanceWindow: passthrough },
    './console-store': { inquiryListInput: passthrough, inquiryDetailsInput: passthrough, recordIdentity: passthrough, retentionInput: passthrough, updateInput: passthrough },
    './memory-core': { memoryAdd: passthrough, memoryEdit: passthrough, memoryIdentity: passthrough, memoryList: passthrough, memoryLink: passthrough },
    './analysis-core': { modelSafeEvidence: value => value, providerKeys: [], providerConfiguration: passthrough, batchInput: passthrough, snapshotInput: passthrough },
    './admin-auth-core': { sha256: async () => 'fixture-hash' },
    './runtime-secrets': { SITE_PROJECT_ID: 'fixture-workspace' },
    './chat-core': { explicitIntentAllows: () => true, providerPolicyIntentAllows: () => true },
    './admin-redaction': { redactAdminText: value => ({ text: value, redacted: false }) },
    './provider-service': { providerOverview: async () => ({}) },
    'zod/v3': requireFromTest('zod/v3'),
    zod: requireFromTest('zod/v3'),
    './admin-auth-server': { getGoogleAdmin: async () => ({ subject: 'fixture-google-subject', siteUserId: 'fixture-site-user', email: 'admin@business.example.test' }) },
    '../db': { getDb: () => ({ insert: () => ({ values: async row => { state.auditRows.push(row); } }) }) },
    '../db/schema': { adminAudit: {} },
    './experiment-runtime': { experimentStore: () => store },
    './experiment-management-store': { ExperimentManagementStore: class {} },
    './zenbooker-api-server': { zenbookerApiService: fakeStoreFactory, apiStatusInputSchema: passthrough, apiCheckInputSchema: passthrough, apiRefreshInputSchema: passthrough },
    './experiment-management-core': { managementMutation: passthrough, managementExport: passthrough, managementTargets: passthrough },
    './support-photo-diagnostic': { runPhotoDiagnostic: async () => ({}), photoDiagnosticInput: passthrough },
    './support-admin': { supportAdmin: fakeStoreFactory, kbIdentity: passthrough, kbRollback: passthrough, proposalIdentity: passthrough, curationInput: passthrough, kbEditInput: passthrough, supportConfigInput: passthrough },
    './support-runtime': { supportProxy: fakeStoreFactory, supportStore: fakeStoreFactory },
    './hosted-admin': { hostedBridgeService: fakeStoreFactory, hostedBridgeReadiness: async () => ({}) },
    './hosted-bridge-service': { hostedConfigureInput: passthrough },
    './hosted-bridge-store': { bridgeRequestKey: passthrough },
    './hosted-bridge-runtime': { hostedBridgeStore: fakeStoreFactory },
    './booking-payment-policy': { paymentPolicyInput: passthrough },
    './customer-sender': { customerSenderService: fakeStoreFactory, customerSenderInput: passthrough },
    './support-schedule-server': { supportScheduleStore: fakeStoreFactory },
    './support-schedule': { scheduleObservationInput: passthrough },
    '../integrations/zenbooker-bridge/capture-inspection': { captureInspectInput: passthrough },
    './customer-runtime': { checkCustomerSender: async () => ({}), attestCustomerSender: async () => ({}), attestBookingPaymentPolicy: async () => ({}), customerStore: fakeStoreFactory },
    './booking-admin': { bookingMetrics: async () => ({}), bookingSettingsInput: passthrough, bookingReadiness: async () => ({}), configureBooking: async () => ({}), checkBookingCatalog: async () => ({}), adminAppointments: async () => [], adminReadAppointment: async () => null, prepareAdminReschedule: async () => ({}), selectAdminReschedule: async () => ({}), changeAdminAppointment: async () => ({}), eraseCustomerLocal: async () => ({}), exportCustomerLocal: async () => ({}), reconcileBookingOperation: async () => ({}) },
    './booking-store': { appointmentChange: passthrough },
  };
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (!Object.hasOwn(modules, specifier)) throw new Error(`Unexpected admin-tools dependency: ${specifier}`);
    return modules[specifier];
  }, loaded, loaded.exports);
  return { api: loaded.exports, state };
}

test('approved chat receipt revisions reach the experiment runtime CAS while ordinary UI calls remain unbound', async () => {
  const { api, state } = await loadAdminTools();
  const versionId = 'c8e9f6ca-4fbe-4dbe-94ba-117fae36f14a';
  const request = new Request('https://demo.example/api/admin/tools', { method: 'POST', headers: { origin: 'https://demo.example' } });
  const approved = { versionRevision: 7, runtimeRevision: 11, versionId };

  const confirmed = await api.executeAdminTool(request, 'experiments.start', { versionId }, { source: 'ui', approvedResourceRevision: approved });
  assert.deepEqual(state.starts[0], ['fixture-google-subject', versionId, 7, 11]);
  assert.equal(confirmed.result.runningVersionId, versionId);

  await api.executeAdminTool(request, 'experiments.start', { versionId }, { source: 'ui' });
  assert.deepEqual(state.starts[1], ['fixture-google-subject', versionId, undefined, undefined], 'typed UI behavior is unchanged when no receipt revision is supplied');
  assert.equal(state.auditRows.length, 2);
  assert.deepEqual(state.moduleGates, ['experiments', 'experiments'], 'both invocations recheck the optional module gate');
});

test('the protected receipt-confirm route forwards the stored approved revision, not request data', async () => {
  const source = await readFile(path.join(root, 'lib/action-approval-server.ts'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const approval = {
    id: 'f56d5d55-8434-4e68-9738-57f0b264808b',
    threadId: 'd7922f51-2630-467f-a652-b40dc2636690',
    tool: 'experiments.start',
    arguments: { versionId: 'c8e9f6ca-4fbe-4dbe-94ba-117fae36f14a' },
    argsHash: 'a'.repeat(64),
    resourceRevision: { operation: 'experiments.start', versionId: 'c8e9f6ca-4fbe-4dbe-94ba-117fae36f14a', versionRevision: 7, runtimeRevision: 11 },
    expiresAt: Date.now() + 600000,
    confirmationRequired: true,
    status: 'pending',
  };
  const state = { claim: null, execute: null };
  const modules = {
    'cloudflare:workers': { env: { DB: {} } },
    './action-approval-core': { ActionApprovalStore: class { async read() { return approval; } async claim(...args) { state.claim = args; } async complete() {} }, actionConfirmation: requireFromTest('zod/v3').z.object({ receiptId: requireFromTest('zod/v3').z.string().uuid(), threadId: requireFromTest('zod/v3').z.string().uuid(), argsHash: requireFromTest('zod/v3').z.string().regex(/^[0-9a-f]{64}$/), confirm: requireFromTest('zod/v3').z.literal(true) }).strict() },
    './admin-auth-server': { adminGuard: async () => null, getGoogleAdmin: async () => ({ subject: 'fixture-google-subject' }), readSmallBody: async request => request.text(), safeJson: (body, status = 200, headers = {}) => Response.json(body, { status, headers }), ADMIN_COOKIE: '__Host-admin_session' },
    './admin-tools': { adminActionRevision: async () => ({ operation: 'experiments.start', versionId: approval.resourceRevision.versionId, versionRevision: 7, runtimeRevision: 11 }), executeAdminTool: async (_request, _tool, args, options) => { state.execute = { args, options }; return { result: { runningVersionId: args.versionId } }; } },
    './runtime-secrets': { SITE_PROJECT_ID: 'fixture-workspace' },
  };
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (!Object.hasOwn(modules, specifier)) throw new Error(`Unexpected action-approval-server dependency: ${specifier}`);
    return modules[specifier];
  }, loaded, loaded.exports);
  const response = await loaded.exports.confirmAdminAction(new Request('https://demo.example/api/admin/actions/confirm', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://demo.example' },
    body: JSON.stringify({ receiptId: approval.id, threadId: approval.threadId, argsHash: approval.argsHash, confirm: true }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(state.execute.args, approval.arguments, 'confirmation executes only the stored receipt arguments');
  assert.deepEqual(state.execute.options.approvedResourceRevision, approval.resourceRevision);
  assert.equal(state.execute.options.requestKey, `human-approval:${approval.id}`);
  assert.equal(state.claim[3], approval.argsHash);
});
