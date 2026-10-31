import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const baseUrl = process.env.TEST_EXPERIMENT_BASE_URL;
const siteUserId = process.env.TEST_EXPERIMENT_SITE_USER_ID;
const siteUserEmail = process.env.TEST_EXPERIMENT_SITE_USER_EMAIL;
const adminCookie = process.env.TEST_EXPERIMENT_ADMIN_COOKIE;
const d1Config = process.env.TEST_EXPERIMENT_D1_CONFIG;
const d1Persist = process.env.TEST_EXPERIMENT_D1_PERSIST;
const d1Name = process.env.TEST_EXPERIMENT_D1_NAME;
const loopbackBaseUrl = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/i.test(baseUrl ?? '');
if (baseUrl && !loopbackBaseUrl) throw new Error('M2 acceptance tests may only target a loopback Worker.');
if (d1Config && !/\.sites-runtime\/m2-test-wrangler\.json$/i.test(d1Config.replaceAll('\\', '/'))) {
  throw new Error('M2 acceptance tests require the isolated .sites-runtime/m2-test-wrangler.json config.');
}
if (d1Persist && !/\.wrangler\/m2-isolated-[^/]+$/i.test(d1Persist.replaceAll('\\', '/'))) {
  throw new Error('M2 acceptance tests require a disposable .wrangler/m2-isolated-* database directory.');
}
if (d1Name && d1Name !== 'site-creator-d1') throw new Error('Unexpected test D1 database name.');
const enabled = baseUrl && siteUserId && siteUserEmail && adminCookie && d1Config && d1Persist && d1Name;
const suite = enabled ? test : test.skip;
const allSections = ['hero', 'services', 'coverage', 'process', 'reviews', 'request', 'questions'];
const copyA = { headline: 'Prepare your demo system for fall', cta: 'Request your preferred date', processLayout: 'steps' };
const payload = {
  submissionKey: crypto.randomUUID(), name: 'M2 QA', contact: 'qa@example.invalid',
  service: 'fall-blowout', area: 'Billings', source: 'direct', preferredDate: '',
  note: 'Local isolated Worker QA; do not contact.',
};

async function localD1(sql) {
  assert.match(baseUrl, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/i, 'test Worker must be loopback-only');
  assert.match(d1Config.replaceAll('\\', '/'), /\.sites-runtime\//i, 'test D1 must use the isolated test config');
  assert.match(d1Persist.replaceAll('\\', '/'), /\.wrangler\/m2-isolated-/i, 'test D1 must use a disposable isolated database directory');
  const wrangler = resolve('node_modules/wrangler/bin/wrangler.js');
  return promisify(execFile)(process.execPath, [
    wrangler, 'd1', 'execute', d1Name, '--local', '--config', d1Config,
    '--persist-to', d1Persist, '--command', sql,
  ], { cwd: process.cwd(), timeout: 30000, windowsHide: true });
}

async function localD1Rows(sql) {
  const { stdout } = await localD1(sql);
  const start = stdout.indexOf('[\n');
  assert.notEqual(start, -1, 'Wrangler should return JSON D1 results');
  return JSON.parse(stdout.slice(start))[0].results;
}

function siteHeaders(userId = siteUserId, email = siteUserEmail) {
  return { 'oai-authenticated-user-id': userId, 'oai-authenticated-user-email': email };
}

async function request(path, { method = 'GET', body, user = true, admin = false, consentCookie, exposureReferenceCookie, origin, extraHeaders = {} } = {}) {
  const url = new URL(path, baseUrl);
  const cookieHeader = [admin ? adminCookie : null, consentCookie, exposureReferenceCookie].filter(Boolean).join('; ');
  const headers = {
    ...(user ? siteHeaders() : {}),
    ...(cookieHeader ? { cookie: cookieHeader } : {}),
    ...(['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) ? { origin: origin ?? url.origin } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...extraHeaders,
  };
  return fetch(url, {
    method,
    redirect: 'manual',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function tool(name, args = {}, options = {}) {
  return request('/api/admin/tools', { method: 'POST', admin: true, body: { tool: name, arguments: args }, ...options });
}

async function result(response) {
  const body = await response.json();
  assert.equal(response.status, 200, `expected success; got ${response.status}: ${JSON.stringify(body)}`);
  assert.ok(body.auditId, 'successful admin operation should return its audit id');
  return body.result;
}

function tomorrowInDenver() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const next = new Date(`${today}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function feedbackReference(response) {
  const timing = response.headers.get('server-timing') ?? '';
  const metric = timing.split(',').map(value => value.trim()).find(value => value.startsWith('experiment_feedback;desc='));
  if (!metric) return null;
  const description = metric.slice('experiment_feedback;desc='.length);
  const reference = description.startsWith('"') && description.endsWith('"')
    ? description.slice(1, -1)
    : description;
  return /^[A-Za-z0-9_-]{20,4096}\.[A-Za-z0-9_-]{20,512}$/.test(reference) ? reference : null;
}

function feedbackPayload(reference) {
  return JSON.parse(Buffer.from(reference.split('.', 1)[0], 'base64url').toString('utf8'));
}

suite('M2 isolated Worker and actual local D1 acceptance', async (t) => {
  let versionId;
  let compositions;
  let consentCookie;
  let experimentRevision = 0;
  let exposureReferenceCookie;
  let firstNavigationFeedbackReference;
  let firstSnapshot;
  let firstExposureWindowStart;
  let savedRequest;

  await t.test('Sites identity and verified Google admin session are both required', async () => {
    const anonymous = await request('/api/admin/tools', { method: 'POST', user: false, body: { tool: 'experiments.list', arguments: {} } });
    assert.equal(anonymous.status, 403, 'anonymous caller without Sites identity must be denied');
    const siteOnly = await request('/api/admin/tools', { method: 'POST', user: true, body: { tool: 'experiments.list', arguments: {} } });
    assert.equal(siteOnly.status, 403, 'Sites-only user without the seeded Google session must be denied');

    const wrongSiteIdentity = await fetch(new URL('/api/admin/tools', baseUrl), {
      method: 'POST', headers: {
        ...siteHeaders(`${siteUserId}-wrong`, siteUserEmail), cookie: adminCookie,
        origin: new URL(baseUrl).origin, 'content-type': 'application/json',
      }, body: JSON.stringify({ tool: 'experiments.list', arguments: {} }),
    });
    assert.equal(wrongSiteIdentity.status, 403);

    const crossOrigin = await tool('experiments.list', {}, { origin: 'https://other.example' });
    assert.equal(crossOrigin.status, 403);

    const unknownTool = await tool('experiments.not_a_tool');
    assert.equal(unknownTool.status, 400);

    const adminStatus = await tool('admin.foundation_status');
    const status = await result(adminStatus);
    assert.equal(status.milestone, 'M4');
  });

  await t.test('create, configure, and compile immutable public snapshots', async () => {
    const created = await result(await tool('experiments.create', { title: `QA M2 ${crypto.randomUUID().slice(0, 8)}` }));
    versionId = created.versionId;
    assert.match(versionId, /^[0-9a-f-]{36}$/i);

    const draft = await result(await tool('experiments.inspect', { versionId }));
    assert.equal(draft.version.stage, 'draft');
    assert.equal(draft.compositions.length, 1);
    assert.equal(draft.compositions[0].label, 'control');
    assert.equal(draft.compositions[0].allocation, 10000);
    assert.deepEqual(JSON.parse(draft.compositions[0].definition_json), {});

    const allocation = [
      { label: 'control', allocation: 5000, definition: {} },
      { label: 'A', allocation: 5000, definition: { ...copyA, order: allSections } },
    ];
    const configured = await result(await tool('experiments.configure', { versionId, revision: 0, compositions: allocation }));
    assert.equal(configured.version.revision, 1);
    compositions = configured.compositions;
    assert.deepEqual(compositions.map(row => row.label), ['control', 'A']);

    const compiled = await result(await tool('experiments.compile', { versionId }));
    assert.equal(compiled.version.stage, 'draft');
    assert.equal(compiled.version.revision, 2);
    assert.ok(compiled.compositions.every(row => /^[a-f0-9]{64}$/.test(row.snapshot_hash)));
    compositions = compiled.compositions;

    const variant = compositions.find(row => row.label === 'A');
    const preview = await result(await tool('experiments.preview', { versionId, compositionId: variant.id }));
    assert.equal(preview.hash, variant.snapshot_hash);
    assert.match(preview.html, /Prepare your demo system for fall/);
    assert.match(preview.html, /data-public-island="inquiry"/);
    assert.doesNotMatch(preview.html, /oai-authenticated-user|__Host-admin_session|__Host-purpose_consent/i);
  });

  await t.test('unconsented traffic stays baseline; consented repeat visits persist one assignment and exposure', async () => {
    const started = await result(await tool('experiments.start', { versionId }));
    assert.equal(started.runningVersionId, versionId);

    const noConsent = await request('/');
    assert.equal(noConsent.status, 200);
    assert.equal(noConsent.headers.get('x-experiment-measured'), 'false');
    assert.match(noConsent.headers.get('x-public-snapshot') ?? '', /^[a-f0-9]{64}$/);

    const consentStatus = await request('/api/consent');
    const initialConsent = await consentStatus.json();
    assert.equal(initialConsent.configured, true);
    assert.equal(initialConsent.experiments, false);
    experimentRevision = initialConsent.experimentsRevision;
    const grant = await request('/api/consent', { method: 'POST', body: { purpose: 'experiments', grant: true, expectedPurposeRevision: experimentRevision } });
    assert.equal(grant.status, 200);
    consentCookie = (grant.headers.getSetCookie?.() ?? [grant.headers.get('set-cookie') ?? ''])
      .map(value => value.split(';', 1)[0]).find(value => value.startsWith('__Host-purpose_consent='));
    assert.ok(consentCookie);
    const grantBody = await grant.json();
    experimentRevision = grantBody.experimentsRevision;
    assert.match(consentCookie, /^__Host-purpose_consent=/);
    assert.match(grant.headers.get('set-cookie') ?? '', /Secure; HttpOnly; SameSite=Lax; Max-Age=2592000/i);
    assert.equal(grantBody.analytics, false, 'experiment opt-in must leave analytics off');

    const start = Date.now();
    const first = await request('/', { consentCookie });
    const firstHtml = await first.text();
    const after = Date.now();
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('x-experiment-measured'), 'true');
    firstSnapshot = first.headers.get('x-public-snapshot');
    assert.ok(compositions.some(row => row.snapshot_hash === firstSnapshot));
    assert.ok(compositions.some(row => row.snapshot_hash === firstSnapshot), 'a measured composition is selected from the compiled version');
    assert.ok(['miss', 'hit', 'unavailable'].includes(first.headers.get('x-snapshot-cache')));
    const exposureSetCookies = first.headers.getSetCookie?.() ?? [first.headers.get('set-cookie') ?? ''];
    exposureReferenceCookie = exposureSetCookies.map(value => value.split(';', 1)[0]).find(value => value.startsWith('__Host-exposure_reference='));
    assert.ok(exposureReferenceCookie, 'a durable measured exposure should issue a short-lived attribution reference');
    firstNavigationFeedbackReference = feedbackReference(first);
    assert.ok(firstNavigationFeedbackReference, 'the current navigation response carries a per-document feedback reference outside the shared HTML');
    assert.doesNotMatch(exposureReferenceCookie, new RegExp(siteUserId), 'the cookie must not contain the Site identity');
    assert.equal(firstHtml.includes(firstNavigationFeedbackReference), false, 'the signed token is not embedded in cacheable HTML');
    assert.doesNotMatch(firstHtml, /googletagmanager\.com|google-analytics\.com/i, 'experiment consent alone must not load Google analytics');
    firstExposureWindowStart = after + 1;

    const exposureStatus = await request('/api/experiments/exposure', { consentCookie, exposureReferenceCookie });
    assert.equal(exposureStatus.status, 200);
    const exposureState = await exposureStatus.json();
    assert.equal(exposureState.eligibleAttribution, true);
    assert.equal(exposureState.canGiveFeedback, true);
    assert.equal(Object.hasOwn(exposureState, 'subjectHash'), false);
    assert.equal(Object.hasOwn(exposureState, 'compositionId'), false);

    const repeated = await request('/', { consentCookie });
    assert.equal(repeated.headers.get('x-experiment-measured'), 'true');
    assert.equal(repeated.headers.get('x-public-snapshot'), firstSnapshot, 'one consented subject keeps the same assignment');
    assert.ok(feedbackReference(repeated), 'response-specific feedback metadata stays on the response headers');
    assert.equal(await repeated.text(), firstHtml, 'signed feedback references never alter immutable shared HTML bytes');
    assert.ok(start <= after);

    const concurrent = await Promise.all(Array.from({ length: 8 }, () => request('/', { consentCookie })));
    for (const response of concurrent) {
      assert.equal(response.headers.get('x-experiment-measured'), 'true');
      assert.equal(response.headers.get('x-public-snapshot'), firstSnapshot);
    }

    const metrics = await result(await tool('experiments.metrics', { from: start - 1000, to: after + 10000, versionId }));
    assert.ok(metrics.rows.some(row => row.exposures === 1), 'repeat visits should deduplicate the D1 exposure');

    const cachePath = `/__snapshot-cache/${firstSnapshot}`;
    const hidden = await request(cachePath);
    assert.equal(hidden.status, 404, 'the synthetic cache key is not a public route');
  });

  await t.test('successful inquiries become one atomic conversion; failures and duplicate submissions do not inflate counts', async () => {
    payload.preferredDate = tomorrowInDenver();

    const sentinel = `M2 rollback QA ${crypto.randomUUID()}`;
    await localD1("CREATE TRIGGER IF NOT EXISTS qa_fail_conversion BEFORE INSERT ON exp_conversions BEGIN SELECT RAISE(ABORT,'injected QA conversion failure'); END");
    try {
      const failedBatch = await request('/api/inquiries', {
        method: 'POST', body: { ...payload, submissionKey: crypto.randomUUID(), note: sentinel }, consentCookie, exposureReferenceCookie,
      });
      assert.equal(failedBatch.status, 503, 'conversion write failure should reject the inquiry transaction');
      const records = await request('/api/inquiries', { admin: true });
      assert.equal(records.status, 200);
      assert.equal((await records.json()).inquiries.some(record => record.note === sentinel), false,
        'failed conversion batch must not leave a saved inquiry without its conversion');
    } finally {
      await localD1('DROP TRIGGER IF EXISTS qa_fail_conversion');
    }

    const created = await request('/api/inquiries', { method: 'POST', body: payload, consentCookie, exposureReferenceCookie });
    assert.equal(created.status, 201, await created.clone().text());
    const createdBody = await created.json();
    assert.equal(createdBody.saved, true);
    savedRequest = createdBody.id;

    const retry = await request('/api/inquiries', { method: 'POST', body: payload, consentCookie, exposureReferenceCookie });
    assert.ok([200, 201].includes(retry.status));
    assert.equal((await retry.json()).id, savedRequest);

    const invalid = await request('/api/inquiries', { method: 'POST', body: { ...payload, submissionKey: crypto.randomUUID(), service: 'not-a-service' }, consentCookie, exposureReferenceCookie });
    assert.equal(invalid.status, 400);

    const to = Date.now() + 10000;
    const cohort = await result(await tool('experiments.metrics', { from: Date.now() - 10000, to, versionId }));
    const row = cohort.rows.find(item => item.exposures === 1);
    assert.ok(row);
    assert.equal(row.conversions, 1, 'conversion numerator is distinct exposed subjects');
    assert.equal(row.saved_requests, 1, 'idempotent retry is one saved request');

    const laterWindow = await result(await tool('experiments.metrics', { from: firstExposureWindowStart, to: Date.now() + 10000, versionId }));
    const excluded = laterWindow.rows.find(item => item.label === row.label);
    assert.equal(excluded.exposures, 0, 'the earlier exposure is outside the selected cohort window');
    assert.equal(excluded.conversions, 0, 'a lead after an out-of-window exposure cannot inflate cohort conversion');
    assert.equal(excluded.saved_requests, 0);
  });

  await t.test('feedback is replaceable per subject/section, but requires current consent and active exposure', async () => {
    const consentOnly = await request('/api/experiments/feedback', { method: 'POST', body: { section: 'process', vote: 1 }, consentCookie });
    assert.equal(consentOnly.status, 400, 'the strict feedback body rejects consent-only input without a signed reference for a displayed variant');
    const positive = await request('/api/experiments/feedback', { method: 'POST', body: { section: 'process', vote: 1, reference: firstNavigationFeedbackReference }, consentCookie });
    assert.equal(positive.status, 200);
    const replacement = await request('/api/experiments/feedback', { method: 'POST', body: { section: 'process', vote: -1, reference: firstNavigationFeedbackReference }, consentCookie });
    assert.equal(replacement.status, 200);
    const invalidVote = await request('/api/experiments/feedback', { method: 'POST', body: { section: 'process', vote: 0, reference: firstNavigationFeedbackReference }, consentCookie });
    assert.equal(invalidVote.status, 400);
    const wrongOrigin = await request('/api/experiments/feedback', { method: 'POST', body: { section: 'process', vote: 1, reference: firstNavigationFeedbackReference }, consentCookie, origin: 'https://other.example' });
    assert.equal(wrongOrigin.status, 403);

    const metrics = await result(await tool('experiments.metrics', { from: Date.now() - 60000, to: Date.now() + 10000, versionId }));
    const row = metrics.rows.find(item => item.exposures === 1);
    assert.equal(row.thumbs_up, 0);
    assert.equal(row.thumbs_down, 1);
  });

  await t.test('pause restores unmeasured serving, a recombination creates a new draft, promotion/rollback are explicit', async () => {
    const immutable = await tool('experiments.configure', {
      versionId, revision: 2,
      compositions: [{ label: 'control', allocation: 10000, definition: {} }],
    });
    assert.equal(immutable.status, 400, 'a running version is immutable');

    const paused = await result(await tool('experiments.pause', { versionId }));
    assert.equal(paused.paused, true);
    const pausedExposure = await request('/api/experiments/exposure', { consentCookie, exposureReferenceCookie });
    const pausedExposureState = await pausedExposure.json();
    assert.equal(pausedExposureState.eligibleAttribution, true, 'the last served reference remains eligible after pause');
    assert.equal(pausedExposureState.canGiveFeedback, false, 'a paused version cannot accept new feedback');

    const pausedInquiry = await request('/api/inquiries', {
      method: 'POST',
      body: { ...payload, submissionKey: crypto.randomUUID(), note: 'Post-pause attribution fixture; do not contact.' },
      consentCookie,
      exposureReferenceCookie,
    });
    assert.equal(pausedInquiry.status, 201, await pausedInquiry.clone().text());
    const pausedMetrics = await result(await tool('experiments.metrics', {
      from: firstExposureWindowStart - 10000,
      to: Date.now() + 10000,
      versionId,
    }));
    const pausedRow = pausedMetrics.rows.find(row => row.exposures === 1);
    assert.ok(pausedRow);
    assert.equal(pausedRow.mature_exposures, 0);
    assert.equal(pausedRow.pending_exposures, 1);
    assert.equal(pausedRow.provisional, true, 'a recent cohort remains provisional until its seven-day conversion window matures');
    assert.equal(pausedRow.conversions, 1, 'post-pause request remains attributed once to the exposed subject');
    assert.equal(pausedRow.saved_requests, 2, 'distinct saved requests remain separate from distinct converted subjects');

    const baseline = await request('/', { consentCookie });
    assert.equal(baseline.headers.get('x-experiment-measured'), 'false');

    const newDraft = await result(await tool('experiments.recombine', { versionId, title: 'QA recombination draft' }));
    assert.notEqual(newDraft.versionId, versionId);
    const copied = await result(await tool('experiments.inspect', { versionId: newDraft.versionId }));
    assert.equal(copied.version.stage, 'draft');
    assert.deepEqual(copied.compositions.map(row => row.label), ['control', 'A']);

    const selected = compositions.find(row => row.label === 'A');
    const promoted = await result(await tool('experiments.promote', { versionId, compositionId: selected.id, rationale: 'QA verifies explicit baseline promotion.' }));
    assert.equal(promoted.promotedCompositionId, selected.id);
    const promotedResponse = await request('/');
    assert.equal(promotedResponse.headers.get('x-experiment-measured'), 'false');
    assert.equal(promotedResponse.headers.get('x-public-snapshot'), selected.snapshot_hash);

    const rollback = await result(await tool('experiments.rollback', { rationale: 'QA restores the reviewed built baseline.' }));
    assert.equal(rollback.baseline, 'current-approved-build');
    const restored = await request('/');
    assert.equal(restored.headers.get('x-experiment-measured'), 'false');
    assert.notEqual(restored.headers.get('x-public-snapshot'), selected.snapshot_hash);
  });

  await t.test('concurrent start CAS permits one running version and no second success response', async () => {
    const ids = [];
    let cleanupError;
    try {
    for (const title of ['QA start race A', 'QA start race B']) {
      const created = await result(await tool('experiments.create', { title }));
      ids.push(created.versionId);
      const draft = await result(await tool('experiments.inspect', { versionId: created.versionId }));
      await result(await tool('experiments.configure', {
        versionId: created.versionId,
        revision: draft.version.revision,
        compositions: [{ label: 'control', allocation: 10000, definition: {} }],
      }));
      await result(await tool('experiments.compile', { versionId: created.versionId }));
    }
    const race = await Promise.all(ids.map(id => tool('experiments.start', { versionId: id })));
    assert.equal(race.filter(response => response.status === 200).length, 1);
    assert.equal(race.filter(response => response.status === 400).length, 1);
    const listing = await result(await tool('experiments.list'));
    assert.equal(listing.versions.filter(version => version.stage === 'running').length, 1);
    const winner = listing.versions.find(version => version.stage === 'running');
    assert.ok(ids.includes(winner.id));
    const newVersionPage = await request('/', { consentCookie });
    const newVersionFeedbackReference = feedbackReference(newVersionPage);
    assert.ok(newVersionFeedbackReference, 'the new navigation receives a token for its own displayed version');
    const newReferencePayload = feedbackPayload(newVersionFeedbackReference);
    const oldReferencePayload = feedbackPayload(firstNavigationFeedbackReference);
    const winnerDetails = await result(await tool('experiments.inspect', { versionId: winner.id }));
    assert.equal(newReferencePayload.versionId, winner.id, 'the signed navigation reference identifies the current winner');
    assert.notEqual(newReferencePayload.versionId, oldReferencePayload.versionId, 'the new tab receives a reference for a different experiment version');
    assert.equal(newReferencePayload.snapshotHash, newVersionPage.headers.get('x-public-snapshot'));
    assert.ok(winnerDetails.compositions.some(composition => composition.id === newReferencePayload.compositionId));
    const sqlQuote = value => `'${String(value).replaceAll("'", "''")}'`;
    const feedbackSql = `SELECT version_id,composition_id,vote,created_at FROM exp_feedback WHERE version_id IN (${sqlQuote(oldReferencePayload.versionId)},${sqlQuote(winner.id)}) AND subject_hash=${sqlQuote(oldReferencePayload.subjectHash)} AND section='process' ORDER BY version_id,composition_id`;
    const rowsBeforeStaleVote = await localD1Rows(feedbackSql);
    const oldTabVote = await request('/api/experiments/feedback', { method: 'POST', body: { section: 'process', vote: 1, reference: firstNavigationFeedbackReference }, consentCookie });
    assert.ok([400, 403].includes(oldTabVote.status), 'a stale signed reference is rejected after another version becomes active');
    assert.deepEqual(await localD1Rows(feedbackSql), rowsBeforeStaleVote, 'the rejected old-tab vote leaves both versions\' complete feedback rows unchanged');
    const newTabVote = await request('/api/experiments/feedback', { method: 'POST', body: { section: 'process', vote: 1, reference: newVersionFeedbackReference }, consentCookie });
    assert.equal(newTabVote.status, 200);
    const rowsAfterNewTabVote = await localD1Rows(feedbackSql);
    assert.deepEqual(rowsAfterNewTabVote.filter(row => row.version_id === oldReferencePayload.versionId), rowsBeforeStaleVote.filter(row => row.version_id === oldReferencePayload.versionId));
    const winnerRows = rowsAfterNewTabVote.filter(row => row.version_id === winner.id);
    assert.equal(winnerRows.length, 1);
    assert.equal(winnerRows[0].composition_id, newReferencePayload.compositionId);
    assert.equal(winnerRows[0].vote, 1);
    assert.ok(Number.isInteger(winnerRows[0].created_at) && winnerRows[0].created_at > 0);
    await result(await tool('experiments.pause', { versionId: winner.id }));

    const edit = await result(await tool('experiments.create', { title: 'QA configure race' }));
    const candidateA = [
      { label: 'control', allocation: 5000, definition: {} },
      { label: 'A', allocation: 5000, definition: { headline: 'Prepare your demo system for fall' } },
    ];
    const candidateB = [
      { label: 'control', allocation: 5000, definition: {} },
      { label: 'B', allocation: 5000, definition: { headline: 'Care for demo systems through every season' } },
    ];
    const configureRace = await Promise.all([
      tool('experiments.configure', { versionId: edit.versionId, revision: 0, compositions: candidateA }),
      tool('experiments.configure', { versionId: edit.versionId, revision: 0, compositions: candidateB }),
    ]);
    assert.equal(configureRace.filter(response => response.status === 200).length, 1);
    assert.equal(configureRace.filter(response => response.status === 400).length, 1);
    const edited = await result(await tool('experiments.inspect', { versionId: edit.versionId }));
    assert.equal(edited.version.revision, 1);
    assert.equal(edited.compositions.length, 2);
    } finally {
      try {
        const response = await tool('experiments.list');
        if (response.status === 200) {
          const current = await response.json();
          const active = current.result.versions.filter(version => ids.includes(version.id) && version.stage === 'running');
          for (const version of active) await tool('experiments.pause', { versionId: version.id });
          const verified = await result(await tool('experiments.list'));
          if (verified.versions.some(version => ids.includes(version.id) && version.stage === 'running')) cleanupError = new Error('Race fixture left a running experiment version.');
        }
      } catch (error) {
        cleanupError = error;
      }
    }
    if (cleanupError) throw cleanupError;
  });

  await t.test('consent can be withdrawn and does not delete prior records or expose its subject', async () => {
    const status = await request('/api/consent', { consentCookie });
    const state = await status.json();
    assert.equal(state.experiments, true);
    assert.equal(Object.hasOwn(state, 'subject'), false);

    const revoke = await request('/api/consent', { method: 'POST', body: { purpose: 'experiments', grant: false, expectedPurposeRevision: experimentRevision }, consentCookie });
    assert.equal(revoke.status, 200);
    const revokedStatus = await revoke.json();
    assert.equal(revokedStatus.experiments, false);
    experimentRevision = revokedStatus.experimentsRevision;
    const clearedCookie = (revoke.headers.get('set-cookie') ?? '');
    assert.match(clearedCookie, /__Host-purpose_consent=;.*Max-Age=0/i);
    assert.match(clearedCookie, /__Host-exposure_reference=;.*Max-Age=0/i);
    const revokedVote = await request('/api/experiments/feedback', { method: 'POST', body: { section: 'process', vote: 1, reference: firstNavigationFeedbackReference }, consentCookie });
    assert.equal(revokedVote.status, 403, 'an already-open tab cannot write feedback after its server-side grant is revoked');

    const noGrant = await request('/', { consentCookie: '' });
    assert.equal(noGrant.headers.get('x-experiment-measured'), 'false');

    const staleSignedCookieRequest = await request('/api/inquiries', {
      method: 'POST',
      body: { ...payload, submissionKey: crypto.randomUUID(), note: 'Stale signed consent fixture; no contact.' },
      consentCookie,
      exposureReferenceCookie,
    });
    assert.equal(staleSignedCookieRequest.status, 201, 'saving a request remains available without optional measurement attribution');

    const unconsentedInquiry = await request('/api/inquiries', {
      method: 'POST',
      body: { ...payload, submissionKey: crypto.randomUUID(), note: 'Revoked consent fixture; do not contact.' },
      exposureReferenceCookie,
    });
    assert.equal(unconsentedInquiry.status, 201);
    const revokedMetrics = await result(await tool('experiments.metrics', {
      from: firstExposureWindowStart - 10000,
      to: Date.now() + 10000,
      versionId,
    }));
    const revokedRow = revokedMetrics.rows.find(row => row.exposures === 1);
    assert.equal(revokedRow.conversions, 1, 'revoked consent prevents a later request from creating another conversion');
    assert.equal(revokedRow.saved_requests, 2, 'the old signed cookie cannot add a conversion after the durable consent revision changed');
    const readback = await tool('experiments.metrics', { from: Date.now() - 60000, to: Date.now() + 10000, versionId });
    const metrics = await result(readback);
    assert.ok(metrics.rows.some(row => row.exposures >= 1), 'withdrawal does not retroactively erase aggregate evidence');
    assert.ok(savedRequest);

    const regrant = await request('/api/consent', { method: 'POST', body: { purpose: 'experiments', grant: true, expectedPurposeRevision: experimentRevision }, consentCookie });
    assert.equal(regrant.status, 200);
    consentCookie = (regrant.headers.getSetCookie?.() ?? [regrant.headers.get('set-cookie') ?? ''])
      .map(value => value.split(';', 1)[0]).find(value => value.startsWith('__Host-purpose_consent='));
    assert.ok(consentCookie);
    experimentRevision = (await regrant.json()).experimentsRevision;
    const staleNavigationAfterRegrant = await request('/api/experiments/feedback', { method: 'POST', body: { section: 'process', vote: 1, reference: firstNavigationFeedbackReference }, consentCookie });
    assert.equal(staleNavigationAfterRegrant.status, 403, 're-granting does not revive an old navigation token from the prior durable consent revision');
  });

  await t.test('old immutable experiment HTML is withheld and recompilation preserves the prior snapshot', async () => {
    const baseline = await result(await tool('baseline.setup'));
    const beforeGrant = await (await request('/api/consent')).json();
    const grant = await request('/api/consent', { method: 'POST', body: { purpose: 'experiments', grant: true, expectedPurposeRevision: beforeGrant.experimentsRevision } });
    assert.equal(grant.status, 200);
    consentCookie = (grant.headers.getSetCookie?.() ?? [grant.headers.get('set-cookie') ?? ''])
      .map(value => value.split(';', 1)[0]).find(value => value.startsWith('__Host-purpose_consent='));
    assert.ok(consentCookie);

    const oldHtml = `<!doctype html><html><body><h1>Historical compiled page ${crypto.randomUUID()}</h1><img src="/brand/removed-asset.png"></body></html>`;
    const oldHash = createHash('sha256').update(oldHtml).digest('hex');
    const oldVersionId = crypto.randomUUID();
    const oldCompositionId = crypto.randomUUID();
    const incompatibleDraftId = crypto.randomUUID();
    const incompatibleCompositionId = crypto.randomUUID();
    const now = Date.now();
    const sqlQuote = value => `'${String(value).replaceAll("'", "''")}'`;
    await localD1([
      `INSERT INTO exp_snapshots(hash,html,renderer_version,asset_manifest_hash,rules_version,created_at) VALUES(${sqlQuote(oldHash)},${sqlQuote(oldHtml)},'renderer-before-v4','assets-before-v4','rules-before-v4',${now})`,
      `INSERT INTO exp_versions(id,title,stage,revision,edit_token,rules_json,source_version,created_by,created_at) VALUES(${sqlQuote(oldVersionId)},'QA old deployed version','draft',2,${sqlQuote(crypto.randomUUID())},'{}',NULL,${sqlQuote(siteUserId)},${now})`,
      `INSERT INTO exp_compositions(id,version_id,label,allocation,definition_json,snapshot_hash) VALUES(${sqlQuote(oldCompositionId)},${sqlQuote(oldVersionId)},'control',10000,'{}',${sqlQuote(oldHash)})`,
      `UPDATE exp_versions SET stage='running' WHERE id=${sqlQuote(oldVersionId)}`,
      `INSERT INTO exp_versions(id,title,stage,revision,edit_token,rules_json,source_version,created_by,created_at) VALUES(${sqlQuote(incompatibleDraftId)},'QA incompatible draft','draft',0,${sqlQuote(crypto.randomUUID())},'{}',NULL,${sqlQuote(siteUserId)},${now})`,
      `INSERT INTO exp_compositions(id,version_id,label,allocation,definition_json,snapshot_hash) VALUES(${sqlQuote(incompatibleCompositionId)},${sqlQuote(incompatibleDraftId)},'control',10000,'{}',${sqlQuote(oldHash)})`,
      `UPDATE exp_runtime SET active_version_id=${sqlQuote(oldVersionId)},baseline_hash=${sqlQuote(baseline.baseline.hash)},revision=revision+1 WHERE id=1`,
    ].join('; '));

    const fallback = await request('/', { consentCookie });
    assert.equal(fallback.status, 200);
    assert.equal(fallback.headers.get('x-public-snapshot'), baseline.baseline.hash);
    assert.equal(fallback.headers.get('x-experiment-measured'), 'false');
    assert.equal(fallback.headers.get('x-snapshot-cache'), 'incompatible-assets');
    assert.match(fallback.headers.get('set-cookie') ?? '', /__Host-exposure_reference=;.*Max-Age=0/i);

    assert.equal((await tool('experiments.start', { versionId: incompatibleDraftId })).status, 400);
    assert.equal((await tool('experiments.preview', { versionId: oldVersionId, compositionId: oldCompositionId })).status, 400);
    assert.equal((await tool('experiments.promote', { versionId: oldVersionId, compositionId: oldCompositionId, rationale: 'QA rejects an old incompatible compiled artifact.' })).status, 400);

    const rollback = await result(await tool('experiments.rollback', { rationale: 'QA restores the current approved build after an old snapshot fixture.' }));
    assert.equal(rollback.baseline, 'current-approved-build');
    const recompilation = await result(await tool('experiments.recombine', { versionId: oldVersionId, title: 'QA recompilation draft' }));
    assert.notEqual(recompilation.versionId, oldVersionId);
    const compiled = await result(await tool('experiments.compile', { versionId: recompilation.versionId }));
    assert.equal(compiled.version.stage, 'draft');
    assert.ok(compiled.compositions.every(composition => composition.snapshot_hash && composition.snapshot_hash !== oldHash));
    const preview = await result(await tool('experiments.preview', { versionId: recompilation.versionId, compositionId: compiled.compositions[0].id }));
    assert.match(preview.hash, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(preview.html, /Historical compiled page|removed-asset\.png/);

    const preservation = await localD1(`SELECT CASE WHEN html=${sqlQuote(oldHtml)} AND renderer_version='renderer-before-v4' AND asset_manifest_hash='assets-before-v4' THEN 'old-immutable-snapshot-preserved' ELSE 'preservation-failed' END AS proof FROM exp_snapshots WHERE hash=${sqlQuote(oldHash)}`);
    assert.match(preservation.stdout, /old-immutable-snapshot-preserved/);
  });
});
