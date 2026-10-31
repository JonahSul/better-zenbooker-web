import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

const testRequire = createRequire(import.meta.url);
const approvalSource = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '../lib/action-approval-core.ts'), 'utf8');
const approvalJs = ts.transpileModule(approvalSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const approvalModule = { exports: {} };
new Function('require', 'module', 'exports', approvalJs)(specifier => {
  if (specifier === 'zod/v3') return testRequire('zod/v3');
  if (specifier === './admin-auth-core') return {
    sha256: async value => createHash('sha256').update(value).digest('hex'),
  };
  throw new Error(`Unexpected action approval dependency: ${specifier}`);
}, approvalModule, approvalModule.exports);
const { actionArgsHash, canonicalAction } = approvalModule.exports;

const baseUrl = process.env.TEST_EXPERIMENT_BASE_URL;
const siteUserId = process.env.TEST_EXPERIMENT_SITE_USER_ID;
const siteUserEmail = process.env.TEST_EXPERIMENT_SITE_USER_EMAIL;
const adminCookie = process.env.TEST_EXPERIMENT_ADMIN_COOKIE;
const secondAdminCookie = process.env.TEST_EXPERIMENT_SECOND_ADMIN_COOKIE;
const d1Config = process.env.TEST_EXPERIMENT_D1_CONFIG;
const d1Persist = process.env.TEST_EXPERIMENT_D1_PERSIST;
const d1Name = process.env.TEST_EXPERIMENT_D1_NAME;
const loopbackBaseUrl = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/i.test(baseUrl ?? '');
if (baseUrl && !loopbackBaseUrl) throw new Error('M4 acceptance tests may only target a loopback Worker.');
if (d1Config && !/\.sites-runtime\/m2-test-wrangler\.json$/i.test(d1Config.replaceAll('\\', '/'))) {
  throw new Error('M4 acceptance tests require the isolated local M2 Worker config.');
}
if (d1Persist && !/\.wrangler\/m2-isolated-[^/]+$/i.test(d1Persist.replaceAll('\\', '/'))) {
  throw new Error('M4 acceptance tests require a disposable local D1 directory.');
}
if (d1Name && d1Name !== 'site-creator-d1') throw new Error('Unexpected test D1 database name.');
const enabled = baseUrl && siteUserId && siteUserEmail && adminCookie && secondAdminCookie && d1Config && d1Persist && d1Name;
const suite = enabled ? test : test.skip;
const execFileAsync = promisify(execFile);

async function localD1(sql) {
  assert.match(baseUrl, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/i, 'approval seed/readback must use a loopback Worker');
  assert.match(d1Config.replaceAll('\\', '/'), /\.sites-runtime\/m2-test-wrangler\.json$/i);
  assert.match(d1Persist.replaceAll('\\', '/'), /\.wrangler\/m2-isolated-[^/]+$/i);
  const { stdout } = await execFileAsync(process.execPath, [
    resolve('node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', d1Name, '--local',
    '--config', d1Config, '--persist-to', d1Persist, '--command', sql,
  ], { cwd: process.cwd(), timeout: 30000, windowsHide: true });
  const start = stdout.indexOf('[\n');
  assert.notEqual(start, -1, 'Wrangler should return local D1 JSON');
  return JSON.parse(stdout.slice(start));
}

function siteHeaders(userId = siteUserId) {
  return { 'oai-authenticated-user-id': userId, 'oai-authenticated-user-email': siteUserEmail };
}

async function request(path, { method = 'GET', body, user = true, cookie = adminCookie, origin, headers: extra = {} } = {}) {
  const url = new URL(path, baseUrl);
  const headers = {
    ...(user ? siteHeaders() : {}),
    ...(cookie ? { cookie } : {}),
    ...(['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) ? { origin: origin ?? url.origin } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...extra,
  };
  return fetch(url, { method, redirect: 'manual', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function tool(name, args = {}, { cookie = adminCookie, requestKey = crypto.randomUUID(), origin } = {}) {
  return request('/api/admin/tools', {
    method: 'POST', cookie, origin,
    body: { tool: name, arguments: args, requestKey },
  });
}

async function result(response) {
  const body = await response.json();
  assert.equal(response.status, 200, `expected success; got ${response.status}: ${JSON.stringify(body)}`);
  assert.ok(body.auditId);
  return body.result;
}

function tomorrowInDenver() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const next = new Date(`${today}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

suite('M4 isolated local Worker and D1 acceptance', async (t) => {
  let interactionId;
  let curationId;
  let secondInteractionId;
  let inquiryId;
  let anonymousInquiryId;
  let secondSubmitterInquiryId;

  await t.test('admin identity, origin, and tool names remain enforced', async () => {
    const primarySession = await request('/api/admin/auth/status');
    const secondSession = await request('/api/admin/auth/status', { cookie: secondAdminCookie });
    assert.equal(primarySession.status, 200);
    assert.equal(secondSession.status, 200);
    const primaryStatus = await primarySession.json();
    const secondStatus = await secondSession.json();
    assert.equal(primaryStatus.authenticated, true);
    assert.equal(secondStatus.authenticated, true);
    assert.notEqual(primaryStatus.email, secondStatus.email, 'both current sessions identify distinct Google administrators');
    const token = cookie => cookie.split('=', 2)[1];
    const primaryHash = createHash('sha256').update(token(adminCookie)).digest('hex');
    const secondHash = createHash('sha256').update(token(secondAdminCookie)).digest('hex');
    const quote = value => `'${String(value).replaceAll("'", "''")}'`;
    const seeds = await localD1(`SELECT site_user_id,google_subject,email,config_fingerprint,expires_at FROM admin_sessions WHERE session_hash IN (${quote(primaryHash)},${quote(secondHash)}) ORDER BY google_subject;`);
    const seededSessions = seeds[0]?.results ?? [];
    assert.equal(seededSessions.length, 2);
    assert.ok(seededSessions.every(row => row.site_user_id === siteUserId && row.expires_at > Date.now()));
    assert.notEqual(seededSessions[0].google_subject, seededSessions[1].google_subject);
    assert.equal(seededSessions[0].config_fingerprint, seededSessions[1].config_fingerprint, 'both test sessions bind to the current native OAuth client configuration');

    const unauthenticated = await request('/api/admin/tools', { method: 'POST', cookie: null, body: { tool: 'memory.search', arguments: { namespace: 'curation' } } });
    assert.equal(unauthenticated.status, 403);
    const wrongSite = await request('/api/admin/tools', { method: 'POST', body: { tool: 'memory.search', arguments: { namespace: 'curation' } }, headers: { 'oai-authenticated-user-id': `${siteUserId}-different` } });
    assert.equal(wrongSite.status, 403);
    assert.equal((await tool('memory.search', { namespace: 'curation' }, { origin: 'https://other.example' })).status, 403);
    assert.equal((await tool('memory.drop_all', {})).status, 400);
  });

  await t.test('business inquiries are workspace-scoped while private memory remains principal-scoped', async () => {
    const inquiry = await request('/api/inquiries', { method: 'POST', cookie: null, body: {
      submissionKey: crypto.randomUUID(), name: 'QA Private Contact', contact: 'qa-private@example.invalid',
      service: 'fall-blowout', area: 'Billings', source: 'direct', preferredDate: tomorrowInDenver(),
      note: 'Disposable local record for isolated M4 QA; no contact.',
    } });
    assert.equal(inquiry.status, 201);
    inquiryId = (await inquiry.json()).id;

    const noPlatformIdentity = await request('/api/inquiries', { method: 'POST', user: false, cookie: null, body: {
      submissionKey: crypto.randomUUID(), name: 'QA Anonymous Customer', contact: 'customer-a@example.invalid',
      service: 'fall-blowout', area: 'Billings', source: 'direct', preferredDate: tomorrowInDenver(),
      note: 'Isolated local customer-route fixture; do not contact.',
    } });
    assert.equal(noPlatformIdentity.status, 201, 'a protected customer request must not borrow a Sites user ID as customer authentication');
    const anonymousRecord = await noPlatformIdentity.json();
    anonymousInquiryId = anonymousRecord.id;
    assert.ok(anonymousInquiryId);

    const secondSubmitter = await request('/api/inquiries', { method: 'POST', cookie: null, headers: { 'oai-authenticated-user-id': 'fixture-second-submitter' }, body: {
      submissionKey: crypto.randomUUID(), name: 'QA Second Customer', contact: 'customer-b@example.invalid',
      service: 'fall-blowout', area: 'Billings', source: 'direct', preferredDate: tomorrowInDenver(),
      note: 'Isolated local workspace-scope fixture; do not contact.',
    } });
    assert.equal(secondSubmitter.status, 201);
    const secondRecord = await secondSubmitter.json();
    secondSubmitterInquiryId = secondRecord.id;
    assert.ok(secondSubmitterInquiryId);

    const interaction = await result(await tool('memory.add', {
      namespace: 'interaction', title: 'Local follow-up note',
      content: 'QA Private Contact asked to review a preferred fall date; qa-private@example.invalid, 406-555-0199.',
    }));
    interactionId = interaction.node.id;
    assert.equal(interaction.node.namespace, 'interaction');
    assert.doesNotMatch(interaction.node.content, /QA Private Contact|qa-private@example\.invalid|406-555-0199/);

    const curation = await result(await tool('memory.add', {
      namespace: 'curation', title: 'Verified service note', content: 'Fall requests require a future preferred date.',
    }));
    curationId = curation.node.id;

    const visiblePrivate = await result(await tool('memory.read', { nodeId: interactionId }));
    assert.equal(visiblePrivate.node.namespace, 'interaction');
    assert.equal(visiblePrivate.node.id, interactionId);
    const secondCannotRead = await tool('memory.read', { nodeId: interactionId }, { cookie: secondAdminCookie });
    assert.equal(secondCannotRead.status, 400);
    const secondCanReadCuration = await result(await tool('memory.read', { nodeId: curationId }, { cookie: secondAdminCookie }));
    assert.equal(secondCanReadCuration.node.namespace, 'curation');
    const secondList = await result(await tool('memory.search', { namespace: 'interaction' }, { cookie: secondAdminCookie }));
    assert.equal(secondList.nodes.some(row => row.id === interactionId), false);
  });

  await t.test('graph mutations use revisions, hide tombstoned nodes, and queue only local vector cleanup', async () => {
    const second = await result(await tool('memory.add', {
      namespace: 'interaction', title: 'Another scoped note', content: 'Compare the stored preferred date request.',
    }));
    secondInteractionId = second.node.id;
    const linked = await result(await tool('memory.link', { fromId: interactionId, toId: secondInteractionId, relation: 'relates_to' }));
    assert.equal(linked.linked, true);
    const graph = await result(await tool('memory.graph', { namespace: 'interaction', query: '' }));
    assert.ok(graph.edges.some(edge => edge.from_id === interactionId && edge.to_id === secondInteractionId));

    const deleted = await result(await tool('memory.delete', { nodeId: interactionId, revision: 1 }));
    assert.ok(deleted.node.tombstoned_at);
    const active = await result(await tool('memory.search', { namespace: 'interaction', query: 'Local follow-up note' }));
    assert.equal(active.nodes.some(node => node.id === interactionId), false);
    const trash = await result(await tool('memory.search', { namespace: 'interaction', query: 'Local follow-up note', deleted: true }));
    assert.equal(trash.nodes.some(node => node.id === interactionId), true);
    const hiddenGraph = await result(await tool('memory.graph', { namespace: 'interaction', query: '' }));
    assert.equal(hiddenGraph.edges.some(edge => edge.from_id === interactionId || edge.to_id === interactionId), false);

    const undo = await result(await tool('memory.undo', { nodeId: interactionId, revision: 2 }));
    assert.equal(undo.node.tombstoned_at, null);
    const staleRevision = await tool('memory.delete', { nodeId: interactionId, revision: 1 });
    assert.equal(staleRevision.status, 400);
    const restoredGraph = await result(await tool('memory.graph', { namespace: 'interaction', query: '' }));
    assert.ok(restoredGraph.edges.some(edge => edge.from_id === interactionId && edge.to_id === secondInteractionId));

    const cleanup = await result(await tool('memory.cleanup_status', {}));
    assert.equal(cleanup.some(row => row.node_id === interactionId && row.action === 'delete'), false, 'an unprocessed local upsert has no remote vector to delete');
    assert.ok(cleanup.some(row => row.node_id === interactionId && row.action === 'upsert' && row.revision === 3));
    assert.ok(cleanup.every(row => row.workspace_id === undefined), 'cleanup status must not expose workspace identifiers');
  });

  await t.test('protected inquiry actions, exports, and deletion preserve lifecycle boundaries', async () => {
    const anonymousList = await request('/api/inquiries', { user: false, cookie: null });
    assert.ok([401, 403].includes(anonymousList.status), 'the business inbox is never exposed to an anonymous customer');
    const siteOnlyList = await request('/api/inquiries', { cookie: null });
    assert.ok([401, 403].includes(siteOnlyList.status), 'a Sites identity alone cannot read the business inbox');
    const list = await result(await tool('inquiries.list', { limit: 10 }));
    const record = list.inquiries.find(row => row.id === inquiryId);
    assert.ok(record);
    assert.ok(list.inquiries.some(row => row.id === anonymousInquiryId), 'the protected business inbox is workspace-scoped, including a request with no Sites identity header');
    assert.ok(list.inquiries.some(row => row.id === secondSubmitterInquiryId), 'the business inbox is not partitioned by the submitter platform identity');
    const secondAdminList = await result(await tool('inquiries.list', { limit: 10 }, { cookie: secondAdminCookie }));
    assert.ok(secondAdminList.inquiries.some(row => row.id === anonymousInquiryId));
    assert.ok(secondAdminList.inquiries.some(row => row.id === secondSubmitterInquiryId));
    assert.equal(record.contact, 'qa-private@example.invalid');

    const quote = value => `'${String(value).replaceAll("'", "''")}'`;
    const hosting = JSON.parse(await readFile(new URL('../.openai/hosting.json', import.meta.url), 'utf8'));
    const sessionToken = adminCookie.split('=', 2)[1];
    assert.match(sessionToken, /^[a-f0-9]{64}$/i);
    const sessionHash = createHash('sha256').update(sessionToken).digest('hex');
    const sessions = await localD1(`SELECT google_subject FROM admin_sessions WHERE session_hash=${quote(sessionHash)} AND site_user_id=${quote(siteUserId)};`);
    const googleSubject = sessions[0]?.results?.[0]?.google_subject;
    assert.ok(googleSubject);
    const revisionRows = await localD1(`SELECT updated_at,deleted_at FROM inquiries WHERE id=${quote(inquiryId)} AND workspace_id=${quote(hosting.project_id)};`);
    const currentRecord = revisionRows[0]?.results?.[0];
    assert.ok(currentRecord);

    const threadId = crypto.randomUUID();
    const receiptId = crypto.randomUUID();
    const action = { id: inquiryId, status: 'booked', revenueCents: 11123 };
    const revisions = { operation: 'inquiries.update', recordId: inquiryId, recordRevision: currentRecord.updated_at, deletedAt: currentRecord.deleted_at };
    const inquiryStateSql = `SELECT status,revenue_cents,updated_at,deleted_at FROM inquiries WHERE id=${quote(inquiryId)} AND workspace_id=${quote(hosting.project_id)};`;
    const stateBeforeRejectedConfirmations = (await localD1(inquiryStateSql))[0]?.results?.[0];
    assert.ok(stateBeforeRejectedConfirmations);
    const argsHash = await actionArgsHash('inquiries.update', action);
    const expiresAt = Date.now() + 600000;
    const createdAt = Date.now();
    await localD1(`INSERT INTO admin_chat_threads(id,workspace_id,google_subject,title,created_at,updated_at) VALUES(${quote(threadId)},${quote(hosting.project_id)},${quote(googleSubject)},'QA approval receipt',${createdAt},${createdAt});`);
    await localD1(`INSERT INTO action_approvals(id,workspace_id,google_subject,thread_id,tool,args_json,args_hash,resource_revision,status,expires_at,created_at) VALUES(${quote(receiptId)},${quote(hosting.project_id)},${quote(googleSubject)},${quote(threadId)},'inquiries.update',${quote(canonicalAction(action))},${quote(argsHash)},${quote(canonicalAction(revisions))},'pending',${expiresAt},${createdAt});`);

    const receiptUrl = `/api/admin/actions?receiptId=${encodeURIComponent(receiptId)}&threadId=${encodeURIComponent(threadId)}`;
    const hiddenReceipt = await request(receiptUrl, { cookie: secondAdminCookie });
    assert.equal(hiddenReceipt.status, 404, 'another authorized Google principal cannot read this thread receipt');
    const foreignConfirm = await request('/api/admin/actions/confirm', {
      method: 'POST', cookie: secondAdminCookie, body: { receiptId, threadId, argsHash, confirm: true },
    });
    assert.equal(foreignConfirm.status, 409, 'another Google principal cannot consume this receipt');
    const wrongHash = await request('/api/admin/actions/confirm', { method: 'POST', body: { receiptId, threadId, argsHash: 'b'.repeat(64), confirm: true } });
    assert.equal(wrongHash.status, 409);
    const withOverride = await request('/api/admin/actions/confirm', { method: 'POST', body: { receiptId, threadId, argsHash, confirm: true, arguments: { status: 'completed', revenueCents: 99999 } } });
    assert.equal(withOverride.status, 409, 'confirmation accepts no caller-supplied replacement arguments');
    const pendingReceipt = await request(receiptUrl);
    assert.equal((await pendingReceipt.json()).approval.status, 'pending', 'rejected confirmation attempts do not consume the receipt');
    const stateAfterRejectedConfirmations = (await localD1(inquiryStateSql))[0]?.results?.[0];
    assert.deepEqual(stateAfterRejectedConfirmations, stateBeforeRejectedConfirmations, 'foreign, wrong-hash, and override confirmations leave the inquiry row unchanged');

    const confirmed = await request('/api/admin/actions/confirm', { method: 'POST', body: { receiptId, threadId, argsHash, confirm: true } });
    assert.equal(confirmed.status, 200);
    assert.equal((await confirmed.json()).confirmed, true);
    const replay = await request('/api/admin/actions/confirm', { method: 'POST', body: { receiptId, threadId, argsHash, confirm: true } });
    assert.equal(replay.status, 409, 'the same human confirmation receipt is single use');
    const finalRecord = await result(await tool('inquiries.list', { status: 'booked' }));
    assert.equal(finalRecord.inquiries.find(row => row.id === inquiryId).revenue_cents, 11123, 'the operation used stored receipt arguments, not the attempted override');

    const changedReceiptId = crypto.randomUUID();
    const changedAction = { id: inquiryId, status: 'completed', revenueCents: 99999 };
    const finalRevisionRows = await localD1(`SELECT updated_at,deleted_at FROM inquiries WHERE id=${quote(inquiryId)} AND workspace_id=${quote(hosting.project_id)};`);
    const beforeConcurrentEdit = finalRevisionRows[0]?.results?.[0];
    const changedRevisions = { operation: 'inquiries.update', recordId: inquiryId, recordRevision: beforeConcurrentEdit.updated_at, deletedAt: beforeConcurrentEdit.deleted_at };
    const changedArgsHash = await actionArgsHash('inquiries.update', changedAction);
    const changedCreatedAt = Date.now();
    await localD1(`INSERT INTO action_approvals(id,workspace_id,google_subject,thread_id,tool,args_json,args_hash,resource_revision,status,expires_at,created_at) VALUES(${quote(changedReceiptId)},${quote(hosting.project_id)},${quote(googleSubject)},${quote(threadId)},'inquiries.update',${quote(canonicalAction(changedAction))},${quote(changedArgsHash)},${quote(canonicalAction(changedRevisions))},'pending',${Date.now() + 600000},${changedCreatedAt});`);
    await localD1(`UPDATE inquiries SET updated_at=updated_at+1 WHERE id=${quote(inquiryId)} AND workspace_id=${quote(hosting.project_id)};`);
    const staleApproval = await request('/api/admin/actions/confirm', { method: 'POST', body: { receiptId: changedReceiptId, threadId, argsHash: changedArgsHash, confirm: true } });
    assert.equal(staleApproval.status, 409, 'a receipt bound to a stale record revision cannot execute');
    const unchangedAfterStale = await result(await tool('inquiries.list', { limit: 10 }));
    const unchangedRecord = unchangedAfterStale.inquiries.find(row => row.id === inquiryId);
    assert.equal(unchangedRecord.status, 'booked');
    assert.equal(unchangedRecord.revenue_cents, 11123);

    await result(await tool('inquiries.update', { id: inquiryId, status: 'booked', revenueCents: 12345 }));
    await result(await tool('inquiries.update_details', { id: inquiryId, name: 'QA Revised Contact', contact: 'qa-revised@example.invalid', note: 'Updated local fixture only.' }));
    const revised = await result(await tool('inquiries.list', { status: 'booked' }));
    assert.equal(revised.inquiries.find(row => row.id === inquiryId).revenue_cents, 12345);
    const exported = await result(await tool('data.export', { scope: 'inquiries' }));
    assert.ok(exported.inquiries.inquiries.some(row => row.id === inquiryId && row.contact === 'qa-revised@example.invalid'));
    assert.match(exported.excluded, /Credentials, tokens/);

    await result(await tool('inquiries.delete', { id: inquiryId }));
    const trash = await result(await tool('inquiries.list', { deleted: true }));
    assert.equal(trash.inquiries.some(row => row.id === inquiryId), true);
    await result(await tool('inquiries.undo', { id: inquiryId }));
    const restored = await result(await tool('inquiries.list', {}));
    assert.equal(restored.inquiries.some(row => row.id === inquiryId), true);
    await result(await tool('inquiries.delete', { id: inquiryId }));
    const purged = await result(await tool('inquiries.purge', { id: inquiryId }));
    assert.equal(purged.erased, true);
    assert.match(purged.retained, /historical experiment evidence and audit references remain/);
    const afterPurge = await result(await tool('inquiries.list', { deleted: true }));
    assert.equal(afterPurge.inquiries.some(row => row.id === inquiryId), false);
  });

  await t.test('retention settings do not pretend a recurring schedule is active', async () => {
    const before = await result(await tool('settings.read', {}));
    assert.ok(before.every(row => !Object.hasOwn(row, 'nextScheduledRun') && !Object.hasOwn(row, 'scheduleActive')));
    const interactionSetting = before.find(row => row.key === 'interactionRetentionDays');
    try {
      const changed = await result(await tool('settings.retention', { key: 'interactionRetentionDays', days: 7, revision: interactionSetting.revision }));
      assert.match(changed.processing, /No recurring schedule has been activated/);
      assert.equal(changed.settings.find(row => row.key === 'interactionRetentionDays').days, 7);
      const sweep = await result(await tool('retention.apply', {}));
      assert.equal(sweep.bounded, true);
      assert.match(sweep.retained, /No recurring cleanup is active/);
      assert.equal(Object.hasOwn(sweep, 'nextScheduledRun'), false);
    } finally {
      const fresh = await result(await tool('settings.read', {}));
      const current = fresh.find(row => row.key === 'interactionRetentionDays');
      assert.ok(current);
      await result(await tool('settings.retention', {
        key: 'interactionRetentionDays', days: interactionSetting.days, revision: current.revision,
      }));
    }
  });

  await t.test('performance and database tools report only collected evidence', async () => {
    const home = await request('/');
    assert.equal(home.status, 200);
    await home.arrayBuffer();
    const stats = await result(await tool('database.stats', {}));
    assert.equal(stats.coreWebVitals, 'unavailable');
    assert.ok(stats.inquiries && stats.memories && stats.storage.description);

    const now = Date.now();
    const metrics = await result(await tool('performance.metrics', { from: now - 3600000, to: now + 1 }));
    assert.equal(metrics.coreWebVitals.status, 'unavailable');
    assert.match(metrics.source, /not network delivery or browser attention/);
    assert.ok(Array.isArray(metrics.rows));
    assert.ok(Array.isArray(metrics.histogramBoundsMs));
    assert.equal(Object.hasOwn(metrics, 'lcp'), false);
    assert.equal(Object.hasOwn(metrics, 'inp'), false);
    assert.equal(Object.hasOwn(metrics, 'cls'), false);
  });

  await t.test('each accepted operation is listed in the protected audit view', async () => {
    const audit = await result(await tool('audit.list', {}));
    assert.ok(audit.some(row => row.action === 'memory.add'));
    assert.ok(audit.some(row => row.action === 'inquiries.purge'));
    assert.ok(audit.every(row => !JSON.stringify(row).includes('qa-private@example.invalid')));
  });

  await t.test('private console routes require admin session, remain noindex, and include route payloads', async () => {
    const pages = [
      ['/admin', 'A clearer view of your business.'],
      ['/admin/inquiries', 'Every request, in one place.'],
      ['/admin/memory', 'Knowledge with a traceable source.'],
      ['/admin/performance', 'Know what the server is doing.'],
      ['/admin/settings', 'Your data. Deliberate controls.'],
      ['/admin/audit', 'A record of what happened.'],
      ['/admin/chat', 'Your workspace, in conversation.'],
    ];
    for (const [path, heading] of pages) {
      const response = await request(path);
      assert.equal(response.status, 200, `${path} should render for the seeded admin session`);
      const html = await response.text();
      assert.match(response.headers.get('x-robots-tag') ?? '', /noindex/i, `${path} must remain private/noindex`);
      assert.ok(html.includes(heading), `${path} should include its server-rendered route payload`);
      assert.doesNotMatch(html, /fixture-contact@example\.invalid|qa-private@example\.invalid/);
    }
    const anonymous = await request('/admin/inquiries', { cookie: null });
    assert.ok([302, 307, 308].includes(anonymous.status));
    assert.equal(anonymous.headers.get('location'), '/admin');
  });

  await t.test('chat remains available as a protected no-provider status and deduplicates the request', async () => {
    const input = { threadId: null, requestKey: crypto.randomUUID(), message: 'Check the protected inquiry workspace.' };
    const first = await request('/api/admin/chat', { method: 'POST', body: input });
    assert.equal(first.status, 200);
    const firstResult = await first.json();
    assert.equal(firstResult.status, 'unavailable');
    assert.equal(firstResult.generatedByModel, false);
    assert.equal(firstResult.reason, 'disabled');
    const replay = await request('/api/admin/chat', { method: 'POST', body: input });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), firstResult);

    const unauthenticated = await request('/api/admin/chat', { method: 'POST', cookie: null, body: { ...input, requestKey: crypto.randomUUID() } });
    assert.equal(unauthenticated.status, 403);
  });
});
