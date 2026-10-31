import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.TEST_PHOTO_APP_BASE_URL ?? '';
const parsed = base ? new URL(base) : null;
const ownerCookie = process.env.TEST_PHOTO_APP_OWNER_COOKIE ?? '';
const viewerCookie = process.env.TEST_PHOTO_APP_VIEWER_COOKIE ?? '';
const ownerSiteId = process.env.TEST_PHOTO_APP_OWNER_SITE_ID ?? '';
const ownerEmail = process.env.TEST_PHOTO_APP_OWNER_EMAIL ?? '';
const viewerSiteId = process.env.TEST_PHOTO_APP_VIEWER_SITE_ID ?? '';
const viewerEmail = process.env.TEST_PHOTO_APP_VIEWER_EMAIL ?? '';
const enabled = !!parsed && parsed.protocol === 'https:' && parsed.hostname === '127.0.0.1' && parsed.port === '8789'
  && ownerCookie && viewerCookie && ownerSiteId && ownerEmail && viewerSiteId && viewerEmail;
if (base && !enabled) throw new Error('Photo app HTTPS tests require the generated synthetic loopback fixture at https://127.0.0.1:8789.');

async function request(path, { method = 'GET', body, cookie, siteId, email, origin } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (siteId) headers['oai-authenticated-user-id'] = siteId;
  if (email) headers['oai-authenticated-user-email'] = email;
  if (origin) headers.Origin = origin;
  const response = await fetch(new URL(path, base), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* Keep non-JSON text available for safe assertions. */ }
  return { response, text, data };
}

const owner = (path, options = {}) => request(path, { ...options, cookie: ownerCookie, siteId: ownerSiteId, email: ownerEmail });
const viewer = (path, options = {}) => request(path, { ...options, cookie: viewerCookie, siteId: viewerSiteId, email: viewerEmail });

test('photo API stays private and the owner diagnostic fails closed without proxy setup', {
  skip: !enabled && 'Run only with Lead’s generated disposable local HTTPS photo fixture.',
}, async () => {
  const origin = parsed.origin;
  const absentId = randomUUID();

  const anonymousList = await request('/api/support/photos');
  assert.equal(anonymousList.response.status, 200);
  assert.deepEqual(anonymousList.data.photos, []);
  assert.equal(anonymousList.data.available, false);
  assert.equal(anonymousList.data.maxBytes, 5 * 1024 * 1024);
  assert.equal(anonymousList.data.retentionHours, 24);
  assert.match(anonymousList.response.headers.get('cache-control') ?? '', /private, no-store/i);
  assert.equal(anonymousList.response.headers.get('set-cookie'), null);

  const anonymousRead = await request(`/api/support/photos/${absentId}`);
  assert.equal(anonymousRead.response.status, 401);
  assert.equal(anonymousRead.response.headers.get('set-cookie'), null);
  const anonymousDelete = await request(`/api/support/photos/${absentId}`, { method: 'DELETE', origin, body: {} });
  assert.equal(anonymousDelete.response.status, 401);
  assert.equal(anonymousDelete.response.headers.get('set-cookie'), null);

  const wrongOriginUpload = await request('/api/support/photos', { method: 'POST', origin: 'https://example.invalid' });
  assert.equal(wrongOriginUpload.response.status, 403);
  assert.equal(wrongOriginUpload.response.headers.get('set-cookie'), null);

  const visitorTurn = await request('/api/support/chat', {
    method: 'POST', origin,
    body: { requestKey: `photo-app-${randomUUID()}`, message: 'Where can I check current service choices?' },
  });
  assert.equal(visitorTurn.response.status, 200);
  assert.equal(visitorTurn.data.status, 'help');
  const visitorCookie = (visitorTurn.response.headers.get('set-cookie') ?? '').split(';')[0];
  assert.match(visitorCookie, /^__Host-support_visitor=/);

  const ownList = await request('/api/support/photos', { cookie: visitorCookie });
  assert.equal(ownList.response.status, 200);
  assert.equal(ownList.data.available, false, 'photo processing remains off without verified proxy/photo configuration');
  assert.deepEqual(ownList.data.photos, []);
  assert.equal(ownList.response.headers.get('cache-control'), 'private, no-store');

  const disabledUpload = await request('/api/support/photos', { method: 'POST', origin, cookie: visitorCookie });
  assert.equal(disabledUpload.response.status, 503);
  assert.match(disabledUpload.data.error, /not available|Text help still works/i);
  assert.equal(disabledUpload.response.headers.get('set-cookie'), null);
  assert.doesNotMatch(disabledUpload.text, /data:image|Bearer|credential/i);

  const ownerStatus = await owner('/api/admin/tools', { method: 'POST', origin, body: { tool: 'support.readiness', arguments: {} } });
  assert.equal(ownerStatus.response.status, 200);
  assert.equal(ownerStatus.data.result.initialized, false);
  assert.equal(ownerStatus.data.result.configured, false);
  assert.equal(ownerStatus.data.result.enabled, false);

  const noGoogle = await request('/api/admin/support/photos/check', {
    method: 'POST', origin, siteId: ownerSiteId, email: ownerEmail,
    body: { requestKey: `photo-check-${randomUUID()}` },
  });
  assert.equal(noGoogle.response.status, 403);
  const viewerCheck = await viewer('/api/admin/support/photos/check', {
    method: 'POST', origin, body: { requestKey: `photo-check-${randomUUID()}` },
  });
  assert.equal(viewerCheck.response.status, 403);
  const wrongOriginCheck = await owner('/api/admin/support/photos/check', {
    method: 'POST', origin: 'https://example.invalid', body: { requestKey: `photo-check-${randomUUID()}` },
  });
  assert.equal(wrongOriginCheck.response.status, 403);
  const malformedCheck = await owner('/api/admin/support/photos/check', {
    method: 'POST', origin, body: { requestKey: 'short', model: 'attacker-choice' },
  });
  assert.equal(malformedCheck.response.status, 400);

  const metricsBefore = await owner('/api/admin/tools', { method: 'POST', origin, body: { tool: 'support.metrics', arguments: {} } });
  assert.equal(metricsBefore.response.status, 200);
  assert.equal(metricsBefore.data.result.reservedCallsToday, 0);
  const requestKey = `photo-check-${randomUUID()}`;
  const check = await owner('/api/admin/support/photos/check', { method: 'POST', origin, body: { requestKey } });
  assert.equal(check.response.status, 200);
  assert.equal(check.data.status, 'unconfirmed');
  assert.equal(check.data.stage, 'images');
  assert.equal(check.data.storageVerified, true, 'the fixture R2 marker is locally read back and deleted');
  assert.equal(check.data.imagesVerified, false);
  assert.equal(check.data.visionVerified, false);
  assert.equal(check.data.modelAttempted, false);
  assert.equal(check.data.modelCompleted, false);
  assert.deepEqual(Object.keys(check.data).sort(), [
    'imagesVerified', 'modelAttempted', 'modelCompleted', 'modelResponseValidated', 'retry', 'runId', 'stage', 'status', 'storageVerified', 'usagePersisted', 'visionVerified',
  ]);
  assert.equal(check.data.modelResponseValidated, null, 'no Worker evidence means model response status remains unknown');
  assert.equal(check.data.usagePersisted, null, 'no model request means no usage write was attempted');
  assert.match(check.data.runId, /^[0-9a-f-]{36}$/i);
  assert.doesNotMatch(check.text, /data:image|Bearer|credential|secret|token/i);

  const replay = await owner('/api/admin/support/photos/check', { method: 'POST', origin, body: { requestKey } });
  assert.equal(replay.response.status, 200);
  assert.deepEqual(replay.data, check.data, 'same diagnostic request replays its stored result instead of retrying processing');
  const metricsAfter = await owner('/api/admin/tools', { method: 'POST', origin, body: { tool: 'support.metrics', arguments: {} } });
  assert.equal(metricsAfter.response.status, 200);
  assert.equal(metricsAfter.data.result.reservedCallsToday, metricsBefore.data.result.reservedCallsToday, 'unconfigured diagnostics make no AI model call');

  const nativeRpc = (siteId, email, params, id) => request('/mcp', {
    method: 'POST', origin, siteId, email,
    body: { jsonrpc: '2.0', id, method: 'tools/call', params },
  });
  const list = await request('/mcp', {
    method: 'POST', origin, siteId: ownerSiteId, email: ownerEmail,
    body: { jsonrpc: '2.0', id: 'photo-tools', method: 'tools/list' },
  });
  assert.equal(list.response.status, 200);
  const configureTool = list.data.result.tools.find((tool) => tool.name === 'visitor_assistant_photo_configure');
  assert.ok(configureTool);
  assert.deepEqual(configureTool.inputSchema.required, ['revision', 'enabled']);
  assert.deepEqual(Object.keys(configureTool.inputSchema.properties).sort(), ['enabled', 'revision']);
  assert.equal(configureTool.inputSchema.additionalProperties, false);

  const beforeMcpConfig = await owner('/api/admin/tools', { method: 'POST', origin, body: { tool: 'support.readiness', arguments: {} } });
  assert.equal(beforeMcpConfig.data.result.initialized, false);
  const malformedMcpCall = await nativeRpc(ownerSiteId, ownerEmail, {
    name: 'visitor_assistant_photo_configure', arguments: { revision: 1, enabled: true, secret: 'must-not-be-accepted' },
  }, 'photo-malformed');
  assert.equal(malformedMcpCall.response.status, 200);
  assert.equal(malformedMcpCall.data.result.isError, true);
  assert.doesNotMatch(malformedMcpCall.text, /must-not-be-accepted/);

  const ownerUnconfiguredCall = await nativeRpc(ownerSiteId, ownerEmail, {
    name: 'visitor_assistant_photo_configure', arguments: { revision: 1, enabled: true },
  }, 'photo-unconfigured');
  assert.equal(ownerUnconfiguredCall.response.status, 200);
  assert.equal(ownerUnconfiguredCall.data.result.isError, true, 'owner call against absent proxy state fails closed');
  assert.match(JSON.stringify(ownerUnconfiguredCall.data.result), /Operation unavailable or rejected/);

  const viewerCall = await nativeRpc(viewerSiteId, viewerEmail, {
    name: 'visitor_assistant_photo_configure', arguments: { revision: 1, enabled: true },
  }, 'photo-nonowner');
  assert.equal(viewerCall.response.status, 200);
  assert.equal(viewerCall.data.result.isError, true);
  assert.match(JSON.stringify(viewerCall.data.result), /Fixed Site-owner authorization required/);

  const afterMcpConfig = await owner('/api/admin/tools', { method: 'POST', origin, body: { tool: 'support.readiness', arguments: {} } });
  assert.equal(afterMcpConfig.response.status, 200);
  assert.equal(afterMcpConfig.data.result.initialized, false, 'failed/malformed/non-owner calls do not create proxy state');
  assert.equal(afterMcpConfig.data.result.photoEnabled, false);
});
