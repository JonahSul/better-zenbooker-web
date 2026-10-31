import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { decryptValue } from '../lib/encrypted-value.ts';

const baseUrl = process.env.TEST_CREDENTIAL_BASE_URL;
const ownerUserId = process.env.TEST_CREDENTIAL_OWNER_USER_ID;
const ownerEmail = process.env.TEST_CREDENTIAL_OWNER_EMAIL;
const viewerUserId = process.env.TEST_CREDENTIAL_VIEWER_USER_ID;
const viewerEmail = process.env.TEST_CREDENTIAL_VIEWER_EMAIL;
const d1Config = process.env.TEST_CREDENTIAL_D1_CONFIG;
const d1Persist = process.env.TEST_CREDENTIAL_D1_PERSIST;
const d1Name = process.env.TEST_CREDENTIAL_D1_NAME;
const loopback = /^https?:\/\/(127\.0\.0\.1|localhost):\d+$/i.test(baseUrl ?? '');
if (baseUrl && !loopback) throw new Error('Credential boundary tests may only target a loopback Worker.');
if (d1Config && !/\.sites-runtime\/credential-test-wrangler\.json$/i.test(d1Config.replaceAll('\\', '/'))) throw new Error('Credential tests require the isolated credential test config.');
if (d1Persist && !/\.wrangler\/credential-isolated-01$/i.test(d1Persist.replaceAll('\\', '/'))) throw new Error('Credential tests require the disposable credential-isolated-01 database.');
if (d1Name && d1Name !== 'site-creator-d1') throw new Error('Unexpected credential test database name.');
const run = baseUrl && ownerUserId && ownerEmail ? test : test.skip;

function headers(userId = ownerUserId, email = ownerEmail) {
  return { 'oai-authenticated-user-id': userId, 'oai-authenticated-user-email': email };
}

async function call(path, { method = 'GET', body, cookie = '', user = true, userId = ownerUserId, email = ownerEmail, origin } = {}) {
  const url = new URL(path, baseUrl);
  const requestHeaders = {
    ...(user ? headers(userId, email) : {}),
    ...(cookie ? { cookie } : {}),
    ...(['POST', 'PATCH'].includes(method) ? { origin: origin ?? url.origin } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  };
  return fetch(url, {
    method, headers: requestHeaders, redirect: 'manual',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function grantAnalytics(cookie = '') {
  const status = await call('/api/consent', { cookie });
  assert.equal(status.status, 200);
  const current = await status.json();
  const response = await call('/api/consent', {
    method: 'POST', cookie,
    body: { purpose: 'analytics', grant: true, expectedPurposeRevision: current.analyticsRevision },
  });
  assert.equal(response.status, 200);
  const consentCookie = (response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''])
    .map(value => value.split(';', 1)[0]).find(value => value.startsWith('__Host-analytics_consent='));
  assert.ok(consentCookie, 'analytics choice should set only its own purpose cookie');
  return consentCookie;
}

async function localD1(sql) {
  assert.ok(d1Config && d1Persist && d1Name, 'credential D1 fixture variables are required for persistent-secret checks');
  assert.match(baseUrl, /^https:\/\/(127\.0\.0\.1|localhost):\d+$/i, 'credential POST tests must use verified loopback HTTPS');
  const wrangler = resolve('node_modules/wrangler/bin/wrangler.js');
  const { stdout } = await promisify(execFile)(process.execPath, [
    wrangler, 'd1', 'execute', d1Name, '--local', '--config', d1Config,
    '--persist-to', d1Persist, '--command', sql,
  ], { cwd: process.cwd(), timeout: 30000, windowsHide: true });
  const start = stdout.indexOf('[\n');
  assert.notEqual(start, -1, 'Wrangler should return JSON D1 results');
  return JSON.parse(stdout.slice(start));
}

run('local consent state remains saved but is ineffective while an admin cookie is present', async () => {
  const consentCookie = await grantAnalytics();

  const publicStatus = await call('/api/consent', { cookie: consentCookie });
  const publicConsent = await publicStatus.json();
  assert.equal(publicConsent.analytics, true);
  assert.equal(publicConsent.analyticsSaved, true);
  assert.equal(publicConsent.analyticsSuppressed, false);

  const adminStatus = await call('/api/consent', { cookie: `${consentCookie}; __Host-admin_session=${'ab'.repeat(32)}` });
  const adminConsent = await adminStatus.json();
  assert.equal(adminConsent.analytics, false, 'effective analytics must be off while an admin session cookie is present');
  assert.equal(adminConsent.analyticsSaved, true, 'suppression must not erase the saved public choice');
  assert.equal(adminConsent.analyticsSuppressed, true);
});

run('privileged SSR routes omit analytics UI and third-party script/font destinations', async () => {
  const consentCookie = await grantAnalytics();
  const sessionCookie = '__Host-admin_session=' + 'ab'.repeat(32);

  for (const path of ['/admin', '/manage', '/setup/credentials']) {
    const response = await call(path, { cookie: `${consentCookie}; ${sessionCookie}` });
    assert.ok(response.status < 400 || response.status === 401 || response.status === 403,
      `${path} should render or fail closed, got ${response.status}`);
    const html = await response.text();
    assert.doesNotMatch(html, /googletagmanager\.com|google-analytics\.com|fonts\.googleapis\.com/i, `${path} must not embed analytics or remote fonts`);
    assert.doesNotMatch(html, /<summary[^>]*>\s*Analytics\b/i, `${path} must not expose the analytics consent control`);
    if (path === '/setup/credentials') assert.doesNotMatch(html, /type=["']password["']/i, 'the credential field is client-gated until the private boundary check completes');
  }
});

run('admin callback redirects without exposing OAuth query values or provider assets', async () => {
  const state = 'fixture-state-not-a-valid-login';
  const response = await call(`/api/admin/auth/callback?code=fixture-code-not-exchanged&state=${state}`);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.doesNotMatch(response.headers.get('location') ?? '', /[?&](?:code|state|nonce)=/i);
  assert.doesNotMatch(await response.text(), /fixture-code-not-exchanged|fixture-state-not-a-valid-login/);
});

run('native Site MCP requires Site identity and exposes only the fixed protocol/tool surface', async () => {
  const anonymous = await call('/mcp', { method: 'POST', user: false, body: { jsonrpc: '2.0', id: 1, method: 'server/discover' } });
  assert.equal(anonymous.status, 401);

  const discovery = await call('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 2, method: 'server/discover' } });
  assert.equal(discovery.status, 200);
  const description = await discovery.json();
  assert.deepEqual(description.result.supportedVersions, ['2026-07-28']);

  const status = await call('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'experiment_connection_status', arguments: {} } } });
  const statusResponse = await status.json();
  const statusValue = JSON.parse(statusResponse.result.content[0].text);
  assert.deepEqual(Object.keys(statusValue).sort(), ['configured', 'isOwner', 'siteUserId']);
  assert.deepEqual(statusValue, { siteUserId: ownerUserId, configured: true, isOwner: true });

  const metadata = { progressToken: 'do-not-echo-meta-secret', 'trace.example/context': { bearer: 'do-not-echo-nested-secret' } };
  const withMetadata = await call('/mcp', {
    method: 'POST',
    body: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'experiment_connection_status', arguments: {}, _meta: metadata } },
  });
  assert.equal(withMetadata.status, 200);
  const metadataBody = await withMetadata.text();
  assert.deepEqual(JSON.parse(metadataBody).result, statusResponse.result, 'protocol metadata is ignored and cannot alter tool output');
  assert.doesNotMatch(metadataBody, /do-not-echo|bearer/);

  for (const params of [
    { name: 'experiment_connection_status', arguments: { userId: 'attacker-chosen-id' } },
    { name: 'secret_tool_name', arguments: {} },
    { name: 'experiment_connection_status', arguments: {}, _meta: 'malformed-metadata-secret' },
  ]) {
    const rejected = await call('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 8, method: 'tools/call', params } });
    assert.equal(rejected.status, 200);
    const rejectedBody = await rejected.text();
    const result = JSON.parse(rejectedBody).result;
    assert.equal(result.isError, true);
    assert.doesNotMatch(rejectedBody, /attacker-chosen-id|secret_tool_name|malformed-metadata-secret/);
  }

  const viewerId = viewerUserId ?? 'credential-mcp-viewer';
  const viewerStatus = await call('/mcp', {
    method: 'POST', userId: viewerId, email: viewerEmail ?? 'viewer@example.invalid',
    body: { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'experiment_connection_status', arguments: {} } },
  });
  const viewerStatusValue = JSON.parse((await viewerStatus.json()).result.content[0].text);
  assert.deepEqual(Object.keys(viewerStatusValue).sort(), ['configured', 'isOwner', 'siteUserId']);
  assert.deepEqual(viewerStatusValue, { siteUserId: viewerId, configured: true, isOwner: false });

  const viewerProbe = await call('/mcp', {
    method: 'POST', userId: viewerId, email: viewerEmail ?? 'viewer@example.invalid',
    body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'experiment_cache_probe', arguments: {}, _meta: { claimedOwner: true, siteUserId: ownerUserId } } },
  });
  const viewerResult = (await viewerProbe.json()).result;
  assert.equal(viewerResult.isError, true);
  assert.match(viewerResult.content[0].text, /Fixed Site-owner authorization required/);
  assert.doesNotMatch(viewerResult.content[0].text, /secret|cache-key|credential/i);
});

run('fixed Site owner MCP cache probe writes, reads and deletes only a non-PII marker', async () => {
  const response = await call('/mcp', {
    method: 'POST',
    body: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'experiment_cache_probe', arguments: {} } },
  });
  assert.equal(response.status, 200);
  const value = JSON.parse((await response.json()).result.content[0].text);
  assert.deepEqual(Object.keys(value).sort(), ['available', 'deleted', 'writeReadMatch']);
  assert.deepEqual(value, { available: true, writeReadMatch: true, deleted: true });
});

const runPersistent = run === test && d1Config && d1Persist && d1Name && !process.env.TEST_CREDENTIAL_MCP_ONLY ? test : test.skip;
runPersistent('owner secret bootstrap is encrypted, redacted, correctable until verified, and rate limited', async () => {
  const wrongSecret = 'fixture-wrong-secret-not-real';
  const correctSecret = 'fixture-correct-secret-not-real';

  const anonymous = await call('/api/setup/credentials', { user: false });
  assert.equal(anonymous.status, 401);
  const viewer = await call('/api/setup/credentials', { userId: viewerUserId ?? 'credential-viewer', email: viewerEmail ?? 'viewer@example.invalid' });
  assert.equal(viewer.status, 403);

  const initial = await call('/api/setup/credentials');
  assert.equal(initial.status, 200);
  const initialStatus = await initial.json();
  assert.equal(initialStatus.sealed, false);
  assert.equal(initialStatus.secureTransport, true);
  assert.equal(initialStatus.canShare, true);
  assert.deepEqual(initialStatus.admin, { present: false, source: 'missing' });
  assert.deepEqual(initialStatus.business, { present: false, source: 'missing' });

  const invalidOrigin = await call('/api/setup/credentials', {
    method: 'POST', body: { key: 'ADMIN_GOOGLE_CLIENT_SECRET', secret: wrongSecret, shareWithBusiness: false },
    origin: 'https://attacker.example',
  });
  assert.equal(invalidOrigin.status, 403);
  assert.doesNotMatch(await invalidOrigin.text(), new RegExp(wrongSecret));

  const url = new URL('/api/setup/credentials', baseUrl);
  const oversized = await fetch(url, {
    method: 'POST', headers: { ...headers(), origin: url.origin, 'content-type': 'application/json' },
    body: 'x'.repeat(9000), redirect: 'manual',
  });
  assert.equal(oversized.status, 400);
  assert.doesNotMatch(await oversized.text(), /xxxxxx/);

  const shortSecret = await call('/api/setup/credentials', {
    method: 'POST', body: { key: 'ADMIN_GOOGLE_CLIENT_SECRET', secret: 'short', shareWithBusiness: false },
  });
  assert.equal(shortSecret.status, 400);

  const unknownCredential = await call('/api/setup/credentials', {
    method: 'POST', body: { key: 'UNKNOWN_SECRET', secret: wrongSecret, shareWithBusiness: false },
  });
  assert.equal(unknownCredential.status, 400);

  const saveWrong = await call('/api/setup/credentials', {
    method: 'POST', body: { key: 'ADMIN_GOOGLE_CLIENT_SECRET', secret: wrongSecret, shareWithBusiness: false },
  });
  assert.equal(saveWrong.status, 200);
  const wrongSaved = await saveWrong.json();
  assert.deepEqual(wrongSaved, { saved: true, signInRequired: true, bootstrapSealed: false });
  assert.doesNotMatch(JSON.stringify(wrongSaved), new RegExp(wrongSecret));

  const firstStatus = await call('/api/setup/credentials');
  const firstBody = await firstStatus.json();
  assert.equal(firstBody.sealed, false);
  assert.deepEqual(firstBody.admin, { present: true, source: 'encrypted_d1' });
  const stored = await localD1("SELECT ciphertext FROM app_credentials WHERE credential_key='ADMIN_GOOGLE_CLIENT_SECRET' LIMIT 1;");
  const ciphertext = stored[0]?.results?.[0]?.ciphertext;
  assert.ok(ciphertext && !ciphertext.includes(wrongSecret), 'the D1 value must be ciphertext, not the submitted secret');
  const config = JSON.parse(await readFile(d1Config, 'utf8'));
  const hosting = JSON.parse(await readFile(new URL('../.openai/hosting.json', import.meta.url), 'utf8'));
  assert.equal(await decryptValue(ciphertext, `app-credential:v1:${hosting.project_id}:ADMIN_GOOGLE_CLIENT_SECRET`, config.vars.APP_CREDENTIAL_ENCRYPTION_KEY), wrongSecret);
  await assert.rejects(decryptValue(ciphertext, `app-credential:v1:${hosting.project_id}:GOOGLE_BUSINESS_CLIENT_SECRET`, config.vars.APP_CREDENTIAL_ENCRYPTION_KEY));

  const connect = await call('/api/admin/auth/connect', { method: 'POST', body: {} });
  assert.equal(connect.status, 200);
  const authorizationUrl = (await connect.json()).authorizationUrl;
  const state = new URL(authorizationUrl).searchParams.get('state');
  assert.ok(state);
  const denied = await call(`/api/admin/auth/callback?state=${encodeURIComponent(state)}&error=access_denied`);
  assert.equal(denied.status, 303);
  assert.equal(denied.headers.get('location'), '/admin?auth=denied');
  const stillEditable = await call('/api/setup/credentials');
  assert.equal((await stillEditable.json()).sealed, false, 'a denied callback does not seal bootstrap');

  const correction = await call('/api/setup/credentials', {
    method: 'POST', body: { key: 'ADMIN_GOOGLE_CLIENT_SECRET', secret: correctSecret, shareWithBusiness: true },
  });
  assert.equal(correction.status, 200, 'the fixed owner can replace a wrong secret before verified login');
  assert.doesNotMatch(await correction.text(), new RegExp(correctSecret));
  const correctedRows = await localD1("SELECT ciphertext FROM app_credentials WHERE credential_key='ADMIN_GOOGLE_CLIENT_SECRET' LIMIT 1;");
  const correctedCiphertext = correctedRows[0]?.results?.[0]?.ciphertext;
  assert.ok(correctedCiphertext && correctedCiphertext !== ciphertext);
  assert.equal(await decryptValue(correctedCiphertext, `app-credential:v1:${hosting.project_id}:ADMIN_GOOGLE_CLIENT_SECRET`, config.vars.APP_CREDENTIAL_ENCRYPTION_KEY), correctSecret);
  const correctedStatus = await call('/api/setup/credentials');
  const correctedBody = await correctedStatus.json();
  assert.equal(correctedBody.sealed, false);
  assert.doesNotMatch(JSON.stringify(correctedBody), new RegExp(correctSecret));
  assert.deepEqual(correctedBody.admin, { present: true, source: 'encrypted_d1' });
  assert.deepEqual(correctedBody.business, { present: true, source: 'encrypted_d1' }, 'explicit sharing is available only for matching public client IDs');

  const limited = await call('/api/setup/credentials', {
    method: 'POST', body: { key: 'ADMIN_GOOGLE_CLIENT_SECRET', secret: 'another-fixture-secret', shareWithBusiness: false },
  });
  assert.equal(limited.status, 429, 'the sixth attempt within the window must be rate limited');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.doesNotMatch(await limited.text(), /another-fixture-secret/);

  assert.match(hosting.project_id, /^[A-Za-z0-9_-]+$/);
  await localD1(`DELETE FROM app_credential_attempts WHERE project_id='${hosting.project_id}';`);
  await localD1(`UPDATE app_credential_state SET sealed_at=1234567890000 WHERE project_id='${hosting.project_id}';`);
  const ownerWithoutAdmin = await call('/api/setup/credentials');
  assert.equal(ownerWithoutAdmin.status, 403, 'the fixed owner alone cannot rotate after the fixture state is sealed');
  const ownerWriteWithoutAdmin = await call('/api/setup/credentials', {
    method: 'POST', body: { key: 'ADMIN_GOOGLE_CLIENT_SECRET', secret: 'fixture-unauthorized-rotation', shareWithBusiness: false },
  });
  assert.equal(ownerWriteWithoutAdmin.status, 403);
  assert.doesNotMatch(await ownerWriteWithoutAdmin.text(), /fixture-unauthorized-rotation/);

  const sessionToken = 'ab'.repeat(32);
  const sessionHash = createHash('sha256').update(sessionToken).digest('hex');
  const fingerprint = createHash('sha256').update(`admin-oidc:v1:${hosting.project_id}:${config.vars.ADMIN_GOOGLE_CLIENT_ID}:${correctSecret}`).digest('hex');
  await localD1(`INSERT INTO admin_sessions(session_hash,site_user_id,google_subject,email,config_fingerprint,expires_at,created_at) VALUES('${sessionHash}','${ownerUserId}','fixture-google-subject','owner@business.example.test','${fingerprint}',${Date.now() + 3600000},${Date.now()});`);
  const authorizedRotation = await call('/api/setup/credentials', {
    method: 'POST', cookie: `__Host-admin_session=${sessionToken}`,
    body: { key: 'ADMIN_GOOGLE_CLIENT_SECRET', secret: 'fixture-postseal-rotation-secret', shareWithBusiness: true },
  });
  assert.equal(authorizedRotation.status, 200, 'post-seal rotation requires and accepts both owner and a valid Google admin session');
  assert.doesNotMatch(await authorizedRotation.text(), /fixture-postseal-rotation-secret/);
  const statusAfterRotation = await call('/api/admin/auth/status', { cookie: `__Host-admin_session=${sessionToken}` });
  assert.equal(statusAfterRotation.status, 200);
  const authAfterRotation = await statusAfterRotation.json();
  assert.equal(authAfterRotation.configured, true);
  assert.equal(authAfterRotation.authenticated, false, 'credential rotation invalidates the session used to authorize it');
});
