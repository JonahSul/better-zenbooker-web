import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const baseUrl = process.env.TEST_ANALYSIS_BASE_URL;
const siteUserId = process.env.TEST_ANALYSIS_SITE_USER_ID;
const siteUserEmail = process.env.TEST_ANALYSIS_SITE_USER_EMAIL;
const adminCookie = process.env.TEST_ANALYSIS_ADMIN_COOKIE;
const ownerUserId = process.env.TEST_ANALYSIS_OWNER_USER_ID;
const measurementId = process.env.TEST_ANALYSIS_GA4_MEASUREMENT_ID;
const d1Config = process.env.TEST_ANALYSIS_D1_CONFIG;
const d1Persist = process.env.TEST_ANALYSIS_D1_PERSIST;
const d1Name = process.env.TEST_ANALYSIS_D1_NAME;
const loopback = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/i.test(baseUrl ?? '');
if (baseUrl && !loopback) throw new Error('Analysis acceptance tests may target loopback Workers only.');
if (d1Config && !/\.sites-runtime\/m2-test-wrangler\.json$/i.test(d1Config.replaceAll('\\', '/'))) throw new Error('Analysis tests require the isolated M2 test Worker config.');
if (d1Persist && !/\.wrangler\/m2-isolated-[^/]+$/i.test(d1Persist.replaceAll('\\', '/'))) throw new Error('Analysis tests require a disposable M2 local D1 directory.');
if (d1Name && d1Name !== 'site-creator-d1') throw new Error('Unexpected local test D1 name.');
const enabled = !!(baseUrl && siteUserId && siteUserEmail && adminCookie && ownerUserId && d1Config && d1Persist && d1Name);
const suite = enabled ? test : test.skip;
const execFileAsync = promisify(execFile);

function siteHeaders(userId = siteUserId, email = siteUserEmail) {
  return { 'oai-authenticated-user-id': userId, 'oai-authenticated-user-email': email };
}

async function request(path, { method = 'GET', body, userId = siteUserId, email = siteUserEmail, admin = false, origin, extraHeaders = {} } = {}) {
  const url = new URL(path, baseUrl);
  return fetch(url, {
    method,
    redirect: 'manual',
    headers: {
      ...(userId ? siteHeaders(userId, email) : {}),
      ...(admin ? { cookie: adminCookie } : {}),
      ...(['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) ? { origin: origin ?? url.origin } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function localD1(...statements) {
  assert.ok(loopback, 'Worker URL must be loopback-only');
  assert.match(d1Config.replaceAll('\\', '/'), /\.sites-runtime\//i);
  assert.match(d1Persist.replaceAll('\\', '/'), /\.wrangler\/m2-isolated-/i);
  for (const sql of statements) {
    await execFileAsync(process.execPath, [
      resolve('node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', d1Name, '--local',
      '--config', d1Config, '--persist-to', d1Persist, '--command', sql,
    ], { cwd: process.cwd(), timeout: 30000, windowsHide: true });
  }
}

async function adminTool(name, args = {}, options = {}) {
  return request('/api/admin/tools', { method: 'POST', admin: true, body: { tool: name, arguments: args }, ...options });
}

async function adminResult(response) {
  const body = await response.json();
  assert.equal(response.status, 200, `admin tool failed: ${JSON.stringify(body)}`);
  assert.ok(body.auditId);
  return body.result;
}

async function mcp(method, params, user = siteUserId) {
  return request('/mcp', { method: 'POST', userId: user, body: { jsonrpc: '2.0', id: crypto.randomUUID(), method, params } });
}

function mcpText(responseBody) {
  const content = responseBody.result?.content;
  return content?.find(item => item.type === 'text')?.text ?? '';
}

suite('M3 provider, batch, provenance, health, and native MCP acceptance against isolated D1', async t => {
  const now = Date.now();
  const from = now - 86_400_000;
  const to = now - 1_000;
  const versionId = crypto.randomUUID();
  const idempotencyKey = `analysis-qa-${crypto.randomUUID()}`;
  const windowInput = { from, to, asOf: now };
  let dryRun;

  await t.test('admin APIs remain Site and Google session scoped; provider overview redacts credentials', async () => {
    const noGoogle = await request('/api/admin/tools', { method: 'POST', body: { tool: 'analysis.overview', arguments: {} } });
    assert.equal(noGoogle.status, 403);
    const crossOrigin = await adminTool('analysis.overview', {}, { origin: 'https://other.example' });
    assert.equal(crossOrigin.status, 403);

    const overview = await adminResult(await adminTool('analysis.overview'));
    assert.ok(Array.isArray(overview.providers));
    assert.ok(Array.isArray(overview.snapshots));
    assert.ok(Array.isArray(overview.diagnostics));
    assert.equal(Object.hasOwn(overview, 'apiToken'), false);
    assert.equal(Object.hasOwn(overview, 'secret'), false);
    assert.doesNotMatch(JSON.stringify(overview), /fixture-ai-token|fixture-vector-token|GOCSPX-|AIza/);
    const invalidConfig = await adminTool('provider.configure', {
      provider: 'workers_ai', enabled: false, revision: 0,
      config: { ...overview.providers.find(row => row.provider === 'workers_ai').config, aiToken: 'never-return-this-fixture' },
    });
    assert.equal(invalidConfig.status, 400);
    assert.doesNotMatch(await invalidConfig.text(), /never-return-this-fixture/);
  });

  await t.test('fixed-resource numeric snapshots keep production Search Console separate from the unverified GA4 property scope', async () => {
    const searchSnapshot = {
      source: 'search_console', searcherriesProjectId: 458, resource: 'sc-domain:example.test',
      from, to, fetchedAt: now,
      metrics: { clicks: 11, impressions: 203 },
      sample: { rowsReturned: 10, rowLimit: 1000, exhaustive: false },
    };
    const gaSnapshot = {
      source: 'ga4', searcherriesProjectId: 458, resource: 'properties/561314662',
      from, to, fetchedAt: now,
      metrics: { sessions: 0, activeUsers: 0, pageViews: 0 },
      sample: { rowsReturned: 0, rowLimit: 1000, exhaustive: true },
    };
    const searchFirst = await adminResult(await adminTool('analytics.ingest_snapshot', searchSnapshot));
    assert.equal(searchFirst.created, true);
    assert.equal(searchFirst.scope, 'production_search');
    const searchAgain = await adminResult(await adminTool('analytics.ingest_snapshot', searchSnapshot));
    assert.equal(searchAgain.created, false);
    assert.equal(searchAgain.snapshotId, searchFirst.snapshotId);

    const ga = await adminResult(await adminTool('analytics.ingest_snapshot', gaSnapshot));
    assert.equal(ga.created, true);
    assert.equal(ga.scope, 'ga4_property');

    const wrongSourceResource = await adminTool('analytics.ingest_snapshot', { ...searchSnapshot, resource: 'properties/561314662' });
    assert.equal(wrongSourceResource.status, 400);
    const wrongProject = await adminTool('analytics.ingest_snapshot', { ...searchSnapshot, searcherriesProjectId: 999 });
    assert.equal(wrongProject.status, 400);

    const overview = await adminResult(await adminTool('analysis.overview'));
    const storedSearch = overview.snapshots.find(row => row.id === searchFirst.snapshotId);
    const storedGa = overview.snapshots.find(row => row.id === ga.snapshotId);
    assert.equal(storedSearch.scope, 'production_search');
    assert.equal(storedGa.scope, 'ga4_property');
    assert.equal(storedSearch.resource, 'sc-domain:example.test');
    assert.equal(storedGa.resource, 'properties/561314662');

    const endDate = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const startDate = new Date(Date.parse(`${endDate}T12:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
    const calendarSnapshot = {
      schemaVersion: 2, source: 'ga4', searcherriesProjectId: 458,
      resource: 'properties/561314662', scope: 'ga4_property',
      window: { kind: 'calendar_dates', startDate, endDateInclusive: endDate, timeZone: 'America/Denver' },
      fetchedAt: new Date(Date.parse(`${startDate}T12:00:00Z`)).toISOString(),
      summary: { kind: 'provider_reported', metrics: { sessions: 0 }, completeness: 'unknown' },
      detailSample: { rowsReturned: 0, rowLimit: 1000, exhaustive: true },
    };
    const v2First = await adminResult(await adminTool('analytics.ingest_snapshot', calendarSnapshot));
    assert.equal(v2First.created, true);
    assert.equal(v2First.schemaVersion, 2);
    assert.equal(v2First.scope, 'ga4_property');
    const v2Again = await adminResult(await adminTool('analytics.ingest_snapshot', calendarSnapshot));
    assert.equal(v2Again.created, false);
    assert.equal(v2Again.snapshotId, v2First.snapshotId);

    const unauthV2 = await request('/api/admin/tools', { method: 'POST', body: { tool: 'analytics.ingest_snapshot', arguments: calendarSnapshot } });
    assert.equal(unauthV2.status, 403);
    assert.equal((await adminTool('analytics.ingest_snapshot', { ...calendarSnapshot, resource: 'sc-domain:example.test' })).status, 400);
    assert.equal((await adminTool('analytics.ingest_snapshot', { ...calendarSnapshot, scope: 'production_search' })).status, 400);

    const afterV2 = await adminResult(await adminTool('analysis.overview'));
    const storedV2 = afterV2.snapshots.find(row => row.id === v2First.snapshotId);
    const storedLegacy = afterV2.snapshots.find(row => row.id === ga.snapshotId);
    assert.equal(storedV2.schemaVersion, 2);
    assert.equal(storedV2.window_json, JSON.stringify(calendarSnapshot.window));
    assert.match(storedV2.windowLabel, new RegExp(`${startDate}.*${endDate}.*inclusive \\(America/Denver\\)`));
    assert.equal(storedV2.summaryCompleteness, 'unknown');
    assert.deepEqual(JSON.parse(storedV2.metrics_json), { sessions: 0 });
    assert.deepEqual(JSON.parse(storedV2.sample_json), calendarSnapshot.detailSample);
    assert.equal(storedLegacy.schemaVersion, 1, 'legacy V1 snapshots remain readable with their original semantics');
    assert.match(storedLegacy.windowLabel, /Legacy numeric window/);
  });

  await t.test('dry-run persists one idempotent batch and never calls AI or Vectorize', async () => {
    const created = await adminResult(await adminTool('experiments.create', { title: `M3 analysis QA ${crypto.randomUUID().slice(0, 8)}` }));
    assert.match(created.versionId, /^[0-9a-f-]{36}$/i);
    const input = { versionId: created.versionId, ...windowInput, mode: 'dry_run', idempotencyKey };
    dryRun = await adminResult(await adminTool('analysis.run', input));
    assert.equal(dryRun.version_id, created.versionId);
    assert.equal(dryRun.mode, 'dry_run');
    assert.equal(dryRun.status, 'completed');
    const report = JSON.parse(dryRun.result_json);
    assert.equal(report.ai.status, 'not_called_dry_run');
    assert.equal(report.vectorize.status, 'not_called_dry_run');
    const sources = report.externalReports.map(row => ({ source: row.source, scope: row.scope, resource: row.resource }));
    assert.ok(sources.some(row => row.source === 'search_console' && row.scope === 'production_search' && row.resource === 'sc-domain:example.test'));
    assert.ok(sources.some(row => row.source === 'ga4' && row.scope === 'ga4_property' && row.resource === 'properties/561314662'));
    assert.match(report.interpretation, /insufficient for automatic winners/i);
    assert.doesNotMatch(JSON.stringify(report), /qa@example\.invalid|owner@sample-ownerivan\.com|fixture-ai-token/);

    const retry = await adminResult(await adminTool('analysis.run', input));
    assert.equal(retry.id, dryRun.id);
    const conflictingKey = await adminTool('analysis.run', { ...input, to: to - 1 });
    assert.equal(conflictingKey.status, 400);
    assert.doesNotMatch(await conflictingKey.text(), /owner@|fixture-ai-token/);
  });

  await t.test('real mode with default-disabled providers records disabled status without remote calls', async () => {
    const overview = await adminResult(await adminTool('analysis.overview'));
    for (const provider of ['workers_ai', 'vectorize']) {
      const row = overview.providers.find(item => item.provider === provider);
      const configured = await adminResult(await adminTool('provider.configure', {
        provider, enabled: false, revision: row.revision, config: row.config,
      }));
      assert.equal(configured.enabled, 0);
    }
    const run = await adminResult(await adminTool('analysis.run', {
      versionId: dryRun.version_id, ...windowInput, mode: 'real', idempotencyKey: `analysis-real-${crypto.randomUUID()}`,
    }));
    const result = JSON.parse(run.result_json);
    assert.equal(run.status, 'completed');
    assert.equal(result.ai.status, 'disabled');
    assert.equal(result.vectorize.status, 'disabled');
  });

  await t.test('stored provider circuit/diagnostic state is visible and owner-resettable without provider calls', async () => {
    const provider = 'workers_ai';
    const now = Date.now();
    const diagnosticId = 'd'.repeat(64);
    await localD1(
      `INSERT OR REPLACE INTO provider_health(provider,status,error_class,latency_ms,failure_count,next_retry_at,circuit_until,source_fetched_at,updated_at) VALUES('${provider}','error','timeout',2,3,${now + 30000},${now + 900000},NULL,${now})`,
      `INSERT OR REPLACE INTO provider_diagnostics(id,provider,kind,evidence_json,proposed_fix,status,created_at) VALUES('${diagnosticId}','${provider}','timeout','{"errorClass":"timeout","failures":3}','Wait for backoff and inspect approved budgets.','open',${now})`,
    );
    const overview = await adminResult(await adminTool('analysis.overview'));
    const health = overview.providers.find(row => row.provider === provider).health;
    assert.equal(health.status, 'error');
    assert.equal(health.failure_count, 3);
    assert.equal(health.error_class, 'timeout');
    const diagnostic = overview.diagnostics.find(row => row.id === diagnosticId);
    assert.equal(diagnostic.status, 'open');
    assert.equal(diagnostic.proposed_fix, 'Wait for backoff and inspect approved budgets.');

    const acknowledged = await adminResult(await adminTool('provider.diagnostic_acknowledge', { diagnosticId }));
    assert.equal(acknowledged.acknowledged, true);
    const reset = await adminResult(await adminTool('provider.health_reset', { provider }));
    assert.equal(reset.reset, true);
    const after = await adminResult(await adminTool('analysis.overview'));
    const cleared = after.providers.find(row => row.provider === provider).health;
    assert.equal(cleared.status, 'unchecked');
    assert.equal(cleared.failure_count, 0);
    assert.equal(cleared.next_retry_at, null);
    assert.equal(cleared.circuit_until, null);
    assert.equal(after.diagnostics.find(row => row.id === diagnosticId).status, 'acknowledged');
  });

  await t.test('native MCP lists typed tools, enforces fixed owner, and shares the same idempotent dry-run', async () => {
    const anonymous = await request('/mcp', { method: 'POST', userId: null, body: { jsonrpc: '2.0', id: 'anon', method: 'server/discover' } });
    assert.equal(anonymous.status, 401);
    const discovery = await mcp('server/discover', {});
    assert.equal((await discovery.json()).result.supportedVersions.includes('2026-07-28'), true);
    const listed = await mcp('tools/list', {});
    const tools = (await listed.json()).result.tools.map(item => item.name);
    for (const name of ['experiment_batch_dry_run', 'experiment_batch_run', 'experiment_batch_status', 'analytics_ingest_snapshot']) assert.ok(tools.includes(name));

    const statusBody = await (await mcp('tools/call', { name: 'experiment_connection_status', arguments: {}, _meta: { trace_id: 'qa-private-metadata' } })).json();
    const status = JSON.parse(mcpText(statusBody));
    assert.equal(status.siteUserId, siteUserId);
    assert.equal(status.isOwner, true);
    assert.doesNotMatch(JSON.stringify(statusBody), /qa-private-metadata/);

    const viewerBody = await (await mcp('tools/call', { name: 'experiment_connection_status', arguments: {} }, `${siteUserId}-viewer`)).json();
    const viewerStatus = JSON.parse(mcpText(viewerBody));
    assert.equal(viewerStatus.isOwner, false);
    assert.equal(Object.hasOwn(viewerStatus, 'unexpiredAdminSessionCount'), false);
    const denied = await (await mcp('tools/call', {
      name: 'experiment_batch_dry_run', arguments: {
        versionId: dryRun.version_id, window: windowInput, idempotencyKey,
      },
    }, `${siteUserId}-viewer`)).json();
    assert.equal(denied.result.isError, true);
    assert.match(mcpText(denied), /Fixed Site-owner authorization required/);

    const shared = await (await mcp('tools/call', {
      name: 'experiment_batch_dry_run',
      arguments: { versionId: dryRun.version_id, window: windowInput, idempotencyKey },
      _meta: { debug: { token: 'never-reflect-this' } },
    })).json();
    assert.equal(shared.result.isError, undefined);
    const sharedRun = JSON.parse(mcpText(shared));
    assert.equal(sharedRun.id, dryRun.id);
    assert.doesNotMatch(JSON.stringify(shared), /never-reflect-this/);

    const invalid = await (await mcp('tools/call', {
      name: 'experiment_batch_dry_run', arguments: {
        versionId: dryRun.version_id, window: windowInput, idempotencyKey, email: 'private@example.com',
      },
    })).json();
    assert.equal(invalid.result.isError, true);
    assert.doesNotMatch(JSON.stringify(invalid), /private@example\.com/);
  });

  await t.test('native owner status projects only a strictly parsed auth diagnostic', async () => {
    const quote = value => `'${String(value).replaceAll("'", "''")}'`;
    const now = Date.now();
    const safeDto = JSON.stringify({ stage: 'token_exchange', result: 'http_rejected', httpStatus: 401, oauthError: 'invalid_client' });
    await localD1(`INSERT INTO admin_audit(id,google_subject,action,target,created_at) VALUES(${quote(crypto.randomUUID())},'system:google-oidc-diagnostic','google_auth.diagnostic',${quote(safeDto)},${now})`);

    const ownerBody = await (await mcp('tools/call', { name: 'experiment_connection_status', arguments: {} })).json();
    const ownerStatus = JSON.parse(mcpText(ownerBody));
    assert.deepEqual(ownerStatus.lastAdminAuthDiagnostic, {
      stage: 'token_exchange', result: 'http_rejected', httpStatus: 401, oauthError: 'invalid_client', at: now,
    });
    assert.doesNotMatch(JSON.stringify(ownerBody), /secret|error_description|provider body/i);

    const viewerBody = await (await mcp('tools/call', { name: 'experiment_connection_status', arguments: {} }, `${siteUserId}-diagnostic-viewer`)).json();
    const viewerStatus = JSON.parse(mcpText(viewerBody));
    assert.equal(viewerStatus.isOwner, false);
    assert.equal(Object.hasOwn(viewerStatus, 'lastAdminAuthDiagnostic'), false);

    const malicious = JSON.stringify({ ...JSON.parse(safeDto), error_description: 'do-not-reflect-this-secret' });
    await localD1(`INSERT INTO admin_audit(id,google_subject,action,target,created_at) VALUES(${quote(crypto.randomUUID())},'system:google-oidc-diagnostic','google_auth.diagnostic',${quote(malicious)},${now + 1})`);
    const strictBody = await (await mcp('tools/call', { name: 'experiment_connection_status', arguments: {} })).json();
    const strictStatus = JSON.parse(mcpText(strictBody));
    assert.equal(Object.hasOwn(strictStatus, 'lastAdminAuthDiagnostic'), false, 'unknown fields in persisted diagnostics are rejected');
    assert.doesNotMatch(JSON.stringify(strictBody), /do-not-reflect-this-secret/);
  });

  await t.test('tag identity requires both independent grants and purpose revisions', async t => {
    if (!measurementId) return t.skip('Fixture has no synthetic GA4 Measurement ID; no tag identity can be bound.');
    assert.match(measurementId, /^G-[A-Z0-9]{6,15}$/);
    const cookies = response => response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];
    const cookieValue = (response, name) => cookies(response).map(value => value.split(';', 1)[0]).find(value => value.startsWith(name + '='));
    const before = await (await request('/api/consent')).json();
    const denied = await request('/api/analytics/tag-identity', {
      method: 'POST', body: { clientId: '123456789.987654321' },
    });
    assert.equal(denied.status, 403, 'no consent grants means no client-ID binding');

    const analyticsGrant = await request('/api/consent', { method: 'POST', body: { purpose: 'analytics', grant: true, expectedPurposeRevision: before.analyticsRevision } });
    assert.equal(analyticsGrant.status, 200);
    let analyticsCookie = cookieValue(analyticsGrant, '__Host-analytics_consent');
    assert.ok(analyticsCookie);
    assert.equal(cookies(analyticsGrant).some(value => value.startsWith('__Host-purpose_consent=')), false, 'analytics write must not rewrite the experiment cookie');
    const analyticsOnly = await request('/api/analytics/tag-identity', {
      method: 'POST', body: { clientId: '123456789.987654321' }, extraHeaders: { cookie: analyticsCookie },
    });
    assert.equal(analyticsOnly.status, 403, 'analytics-only permission does not enable experiment MP identity');

    const experimentBefore = await (await request('/api/consent', { extraHeaders: { cookie: analyticsCookie } })).json();
    const experimentGrant = await request('/api/consent', {
      method: 'POST', body: { purpose: 'experiments', grant: true, expectedPurposeRevision: experimentBefore.experimentsRevision }, extraHeaders: { cookie: analyticsCookie },
    });
    assert.equal(experimentGrant.status, 200);
    let experimentCookie = cookieValue(experimentGrant, '__Host-purpose_consent');
    assert.ok(experimentCookie);
    assert.equal(cookies(experimentGrant).some(value => value.startsWith('__Host-analytics_consent=')), false, 'experiment write must not rewrite the analytics cookie');
    assert.equal((await experimentGrant.json()).measurementId, measurementId);

    let current = await (await request('/api/consent', { extraHeaders: { cookie: `${analyticsCookie}; ${experimentCookie}` } })).json();
    const analyticsRefresh = await request('/api/consent', {
      method: 'POST', body: { purpose: 'analytics', grant: true, expectedPurposeRevision: current.analyticsRevision },
      extraHeaders: { cookie: `${analyticsCookie}; ${experimentCookie}` },
    });
    assert.equal(analyticsRefresh.status, 200);
    analyticsCookie = cookieValue(analyticsRefresh, '__Host-analytics_consent');
    assert.ok(analyticsCookie);
    assert.equal(cookies(analyticsRefresh).some(value => value.startsWith('__Host-purpose_consent=')), false);
    current = await (await request('/api/consent', { extraHeaders: { cookie: `${analyticsCookie}; ${experimentCookie}` } })).json();
    assert.equal(current.analytics, true);
    assert.equal(current.experiments, true, 'analytics revision change preserves the independent experiment grant');

    const invalidId = await request('/api/analytics/tag-identity', {
      method: 'POST', body: { clientId: 'not-an-id' }, extraHeaders: { cookie: `${analyticsCookie}; ${experimentCookie}` },
    });
    assert.equal(invalidId.status, 400);
    const wrongOrigin = await request('/api/analytics/tag-identity', {
      method: 'POST', body: { clientId: '123456789.987654321' }, origin: 'https://other.example', extraHeaders: { cookie: `${analyticsCookie}; ${experimentCookie}` },
    });
    assert.equal(wrongOrigin.status, 403);
    const withAdminCookie = await request('/api/analytics/tag-identity', {
      method: 'POST', body: { clientId: '123456789.987654321' }, admin: true, extraHeaders: { cookie: `${adminCookie}; ${analyticsCookie}; ${experimentCookie}` },
    });
    assert.equal(withAdminCookie.status, 403);

    const bound = await request('/api/analytics/tag-identity', {
      method: 'POST', body: { clientId: '123456789.987654321' }, extraHeaders: { cookie: `${analyticsCookie}; ${experimentCookie}` },
    });
    assert.equal(bound.status, 200);
    const boundBody = await bound.json();
    assert.deepEqual(boundBody, { bound: true });
    const boundCookies = bound.headers.getSetCookie?.() ?? [bound.headers.get('set-cookie') ?? ''];
    const tagCookie = boundCookies
      .map(value => value.split(';', 1)[0]).find(value => value.startsWith('__Host-ga_tag_identity='));
    assert.ok(tagCookie);
    assert.match(boundCookies.find(value => value.startsWith('__Host-ga_tag_identity=')) ?? '', /Secure; HttpOnly; SameSite=Lax; Max-Age=\d+/i);
    assert.doesNotMatch(JSON.stringify(boundBody), /123456789\.987654321/);

    const boundPayload = JSON.parse(Buffer.from(tagCookie.split('.', 1)[0], 'base64url').toString('utf8'));
    assert.match(boundPayload.analyticsGrantHash, /^[0-9a-f]{64}$/);
    assert.equal(boundPayload.analyticsRevision, current.analyticsRevision);
    assert.equal(boundPayload.grantRevision, current.experimentsRevision);

    current = await (await request('/api/consent', { extraHeaders: { cookie: `${analyticsCookie}; ${experimentCookie}` } })).json();
    const withdrawn = await request('/api/consent', {
      method: 'POST', body: { purpose: 'experiments', grant: false, expectedPurposeRevision: current.experimentsRevision }, extraHeaders: { cookie: `${analyticsCookie}; ${experimentCookie}` },
    });
    assert.equal(withdrawn.status, 200);
    const setCookies = withdrawn.headers.getSetCookie?.() ?? [];
    assert.ok(setCookies.some(value => value.startsWith('__Host-ga_tag_identity=') && /Max-Age=0/.test(value)));
    experimentCookie = cookieValue(withdrawn, '__Host-purpose_consent');
    assert.ok(experimentCookie);
    assert.equal(setCookies.some(value => value.startsWith('__Host-analytics_consent=')), false, 'experiment withdrawal must preserve the analytics cookie');
    const status = await request('/api/consent', { extraHeaders: { cookie: `${analyticsCookie}; ${experimentCookie}` } });
    current = await status.json();
    assert.equal(current.analytics, true);
    assert.equal(current.experiments, false);
  });
});
