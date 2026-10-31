import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const baseUrl = process.env.TEST_H2_BASE_URL;
const d1Config = process.env.TEST_H2_D1_CONFIG;
const d1Persist = process.env.TEST_H2_D1_PERSIST;
const d1Name = process.env.TEST_H2_D1_NAME;
const siteUserId = process.env.TEST_H2_SITE_USER_ID;
const siteUserEmail = process.env.TEST_H2_SITE_USER_EMAIL;
const ownerUserId = process.env.TEST_H2_OWNER_USER_ID;
const ownerEmail = process.env.TEST_H2_OWNER_EMAIL;
const ownerCookie = process.env.TEST_H2_OWNER_COOKIE;
const viewerUserId = process.env.TEST_H2_VIEWER_USER_ID;
const viewerEmail = process.env.TEST_H2_VIEWER_EMAIL;
const viewerCookie = process.env.TEST_H2_VIEWER_COOKIE;
const measurementId = process.env.TEST_H2_MEASUREMENT_ID;
const enabled = Boolean(baseUrl && d1Config && d1Persist && d1Name && siteUserId && siteUserEmail && ownerUserId && ownerEmail && ownerCookie && viewerUserId && viewerEmail && viewerCookie && measurementId);
if (baseUrl && !/^https:\/\/(127\.0\.0\.1|localhost):\d+$/i.test(baseUrl)) throw new Error('H2 acceptance may target only a loopback HTTPS Worker.');
if (d1Config && !/\.sites-runtime\/h2-app-fixture\/wrangler\.json$/i.test(d1Config.replaceAll('\\', '/'))) throw new Error('H2 acceptance requires the dedicated isolated H2 app fixture config.');
if (d1Persist && !/\.wrangler\/h2-app-local-0[12]$/i.test(d1Persist.replaceAll('\\', '/'))) throw new Error('H2 acceptance requires the dedicated isolated H2 app D1 directory.');
if (d1Name && d1Name !== 'site-creator-d1') throw new Error('Unexpected H2 fixture D1 binding name.');

const run = enabled ? test : test.skip;

function siteHeaders(userId = siteUserId, email = siteUserEmail) {
  return { 'oai-authenticated-user-id': userId, 'oai-authenticated-user-email': email };
}

async function request(path, { method = 'GET', body, cookie = '', userId = siteUserId, email = siteUserEmail, siteIdentity = true } = {}) {
  const url = new URL(path, baseUrl);
  const headers = {
    ...(siteIdentity ? siteHeaders(userId, email) : {}),
    ...(cookie ? { cookie } : {}),
    ...(['POST', 'PATCH', 'DELETE'].includes(method) ? { origin: url.origin } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  };
  return fetch(url, {
    method,
    headers,
    redirect: 'manual',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function setCookie(response, name) {
  const values = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];
  return values.map(value => value.split(';', 1)[0]).find(value => value.startsWith(`${name}=`)) ?? null;
}

async function localD1(sql) {
  assert.ok(d1Config && d1Persist && d1Name, 'local D1 fixture variables are required');
  const wrangler = resolve('node_modules/wrangler/bin/wrangler.js');
  const { stdout } = await promisify(execFile)(process.execPath, [
    wrangler, 'd1', 'execute', d1Name, '--local', '--config', d1Config,
    '--persist-to', d1Persist, '--command', sql, '--json',
  ], { cwd: process.cwd(), timeout: 30000, windowsHide: true });
  const start = stdout.indexOf('[\n');
  assert.notEqual(start, -1, 'Wrangler should return local D1 JSON results');
  return JSON.parse(stdout.slice(start));
}

function firstRow(result) {
  return result?.[0]?.results?.[0] ?? null;
}

run('H2 independent consent, hash-only booking reference, and owner schedule observation against isolated HTTPS Worker and D1', async () => {
  assert.match(measurementId, /^G-[A-Z0-9]{6,15}$/);
  const initial = firstRow(await localD1("SELECT (SELECT COUNT(*) FROM measurement_grants) AS grants, (SELECT COUNT(*) FROM hosted_booking_references) AS refs, (SELECT COUNT(*) FROM admin_settings WHERE google_subject='system:visitor-support' AND key='native_schedule_observation') AS schedules"));
  assert.deepEqual(initial, { grants: 0, refs: 0, schedules: 0 }, 'fixture must start without consent, reference, or schedule rows');

  const readOnly = await request('/api/consent');
  assert.equal(readOnly.status, 200);
  const initialConsent = await readOnly.json();
  assert.equal(initialConsent.analytics, false);
  assert.equal(initialConsent.experiments, false);
  assert.equal(readOnly.headers.get('set-cookie'), null, 'reading consent does not create or rotate browser grants');
  assert.deepEqual(firstRow(await localD1("SELECT (SELECT COUNT(*) FROM measurement_grants) AS grants, (SELECT COUNT(*) FROM hosted_booking_references) AS refs")), { grants: 0, refs: 0 });

  const experimentGrant = await request('/api/consent', {
    method: 'POST',
    body: { purpose: 'experiments', grant: true, expectedPurposeRevision: initialConsent.experimentsRevision },
  });
  assert.equal(experimentGrant.status, 200);
  const experimentCookie = setCookie(experimentGrant, '__Host-purpose_consent');
  assert.ok(experimentCookie);
  assert.equal(setCookie(experimentGrant, '__Host-analytics_consent'), null, 'experiment choice does not rewrite analytics consent');
  const experimentOnlyHandoff = await request('/api/hosted-booking/handoff', {
    method: 'POST', cookie: experimentCookie, body: { placement: 'services' },
  });
  assert.equal(experimentOnlyHandoff.status, 200);
  const noAnalyticsHandoff = await experimentOnlyHandoff.json();
  assert.equal(noAnalyticsHandoff.measurement.recorded, false, 'experiment consent alone never creates a booking reference');
  assert.equal(new URL(noAnalyticsHandoff.url).searchParams.has('utm_content'), false);
  assert.deepEqual(firstRow(await localD1('SELECT COUNT(*) AS refs FROM hosted_booking_references')), { refs: 0 });

  const beforeAnalytics = await (await request('/api/consent', { cookie: experimentCookie })).json();
  const analyticsGrant = await request('/api/consent', {
    method: 'POST', cookie: experimentCookie,
    body: { purpose: 'analytics', grant: true, expectedPurposeRevision: beforeAnalytics.analyticsRevision },
  });
  assert.equal(analyticsGrant.status, 200);
  const analyticsCookie = setCookie(analyticsGrant, '__Host-analytics_consent');
  assert.ok(analyticsCookie);
  assert.equal(setCookie(analyticsGrant, '__Host-purpose_consent'), null, 'analytics choice does not rewrite experiment consent');
  const both = await (await request('/api/consent', { cookie: `${analyticsCookie}; ${experimentCookie}` })).json();
  assert.equal(both.analytics, true);
  assert.equal(both.experiments, true);
  assert.equal(both.measurementId, measurementId);

  const handoff = await request('/api/hosted-booking/handoff', {
    method: 'POST', cookie: `${analyticsCookie}; ${experimentCookie}`,
    body: { serviceId: '1687501866150x983884188069396500', placement: 'services' },
  });
  assert.equal(handoff.status, 200);
  const handoffBody = await handoff.json();
  const handoffUrl = new URL(handoffBody.url);
  assert.equal(handoffBody.opensExternal, true);
  assert.equal(handoffBody.bookingConfirmed, false);
  assert.equal(handoffBody.correlation, 'unverified');
  assert.equal(handoffBody.measurement.recorded, true);
  assert.equal(handoffBody.reference.providerReceipt, 'unverified');
  assert.equal(handoffBody.reference.callbackJoin, 'unverified');
  assert.equal(handoffUrl.origin, 'https://widget.zenbooker.com');
  assert.equal(handoffUrl.pathname, '/book/demoblowoutguttercleaning');
  assert.equal(handoffUrl.searchParams.get('preselected-service'), '1687501866150x983884188069396500');
  const rawReference = handoffUrl.searchParams.get('utm_content');
  assert.match(rawReference ?? '', /^sb406_ref_v1_[0-9a-f]{32}$/);
  const referenceHash = createHash('sha256').update(rawReference).digest('hex');
  const refReadback = firstRow(await localD1(`SELECT COUNT(*) AS refs, SUM(CASE WHEN ref_hash='${referenceHash}' AND length(analytics_grant_hash)=64 AND expires_at>issued_at AND expires_at-issued_at<=604800000 THEN 1 ELSE 0 END) AS matching_safe_rows FROM hosted_booking_references`));
  assert.deepEqual(refReadback, { refs: 1, matching_safe_rows: 1 }, 'D1 retains only the reference hash, the analytics grant hash, and a maximum seven-day window');

  const staleChoice = await request('/api/consent', {
    method: 'POST', cookie: `${analyticsCookie}; ${experimentCookie}`,
    body: { purpose: 'analytics', grant: false, expectedPurposeRevision: initialConsent.analyticsRevision },
  });
  assert.equal(staleChoice.status, 409, 'stale consent CAS is rejected');
  assert.equal(staleChoice.headers.get('set-cookie'), null);
  assert.deepEqual(firstRow(await localD1(`SELECT analytics AS allowed, revision FROM measurement_grants WHERE subject_hash=(SELECT analytics_grant_hash FROM hosted_booking_references LIMIT 1)`)), { allowed: 1, revision: both.analyticsRevision });

  const experimentDecline = await request('/api/consent', {
    method: 'POST', cookie: `${analyticsCookie}; ${experimentCookie}`,
    body: { purpose: 'experiments', grant: false, expectedPurposeRevision: both.experimentsRevision },
  });
  assert.equal(experimentDecline.status, 200);
  const declinedExperimentCookie = setCookie(experimentDecline, '__Host-purpose_consent');
  assert.ok(declinedExperimentCookie);
  assert.equal(setCookie(experimentDecline, '__Host-analytics_consent'), null);
  const afterExperimentDecline = await (await request('/api/consent', { cookie: `${analyticsCookie}; ${declinedExperimentCookie}` })).json();
  assert.equal(afterExperimentDecline.analytics, true);
  assert.equal(afterExperimentDecline.experiments, false);
  assert.deepEqual(firstRow(await localD1(`SELECT analytics AS allowed, revision FROM measurement_grants WHERE subject_hash=(SELECT analytics_grant_hash FROM hosted_booking_references LIMIT 1)`)), { allowed: 1, revision: both.analyticsRevision });

  const analyticsDecline = await request('/api/consent', {
    method: 'POST', cookie: `${analyticsCookie}; ${declinedExperimentCookie}`,
    body: { purpose: 'analytics', grant: false, expectedPurposeRevision: both.analyticsRevision },
  });
  assert.equal(analyticsDecline.status, 200);
  const deniedAnalyticsCookie = setCookie(analyticsDecline, '__Host-analytics_consent');
  assert.ok(deniedAnalyticsCookie, 'withdrawal persists an explicit false Analytics choice in its own cookie');
  assert.equal(setCookie(analyticsDecline, '__Host-purpose_consent'), null, 'Analytics withdrawal does not rewrite the experiment choice');
  const deniedAnalyticsPayload = JSON.parse(Buffer.from(deniedAnalyticsCookie.split('=', 2)[1].split('.', 1)[0], 'base64url').toString('utf8'));
  assert.equal(deniedAnalyticsPayload.granted, false);
  assert.equal(deniedAnalyticsPayload.revision, both.analyticsRevision + 1);
  assert.equal(setCookie(analyticsDecline, '__Host-purpose_consent'), null);
  assert.deepEqual(firstRow(await localD1('SELECT COUNT(*) AS refs FROM hosted_booking_references')), { refs: 0 }, 'analytics withdrawal deletes optional reference hashes');
  const staleHandoff = await request('/api/hosted-booking/handoff', {
    method: 'POST', cookie: `${analyticsCookie}; ${declinedExperimentCookie}`, body: { placement: 'services' },
  });
  assert.equal((await staleHandoff.json()).measurement.recorded, false, 'the withdrawn signed cookie cannot issue a new reference');
  assert.deepEqual(firstRow(await localD1('SELECT COUNT(*) AS refs FROM hosted_booking_references')), { refs: 0 });

  const beforeSchedule = firstRow(await localD1("SELECT COUNT(*) AS count FROM admin_settings WHERE google_subject='system:visitor-support' AND key='native_schedule_observation'"));
  assert.deepEqual(beforeSchedule, { count: 0 });
  const fakeObservedAt = new Date().toISOString();
  const scheduleRecord = {
    revision: 0,
    taskId: 'fixture-task-qa-01',
    taskUrl: null,
    cadence: '30 3 * * *',
    timeZone: 'America/Denver',
    nativeStatus: 'enabled',
    observedAt: fakeObservedAt,
  };
  const viewerDenied = await request('/api/admin/support/schedule', {
    method: 'POST', cookie: viewerCookie, userId: viewerUserId, email: viewerEmail, body: scheduleRecord,
  });
  assert.equal(viewerDenied.status, 403, 'a non-owner Google principal cannot record the fixed-owner schedule observation');
  assert.deepEqual(firstRow(await localD1("SELECT COUNT(*) AS count FROM admin_settings WHERE google_subject='system:visitor-support' AND key='native_schedule_observation'")), { count: 0 });

  const recorded = await request('/api/admin/support/schedule', { method: 'POST', cookie: ownerCookie, userId: ownerUserId, email: ownerEmail, body: scheduleRecord });
  assert.equal(recorded.status, 200);
  const stored = await recorded.json();
  assert.equal(stored.status, 'recorded');
  assert.equal(stored.revision, 1);
  assert.equal(stored.record.source, 'owner_recorded_native_readback');
  assert.equal(stored.record.livePlatformState, undefined);
  assert.equal(stored.livePlatformState, 'not_polled');
  assert.equal(stored.record.taskId, scheduleRecord.taskId);
  assert.equal(stored.record.taskUrl, null);

  const staleSchedule = await request('/api/admin/support/schedule', { method: 'POST', cookie: ownerCookie, userId: ownerUserId, email: ownerEmail, body: scheduleRecord });
  assert.equal(staleSchedule.status, 409, 'schedule observations use revision CAS');
  assert.deepEqual(firstRow(await localD1("SELECT revision AS revision, COUNT(*) AS count FROM admin_settings WHERE google_subject='system:visitor-support' AND key='native_schedule_observation'")), { revision: 1, count: 1 });
});
