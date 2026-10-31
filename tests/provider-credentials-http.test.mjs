import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { decryptValue } from '../lib/encrypted-value.ts';

const baseUrl = process.env.TEST_PROVIDER_CREDENTIAL_BASE_URL;
const siteUserId = process.env.TEST_PROVIDER_CREDENTIAL_SITE_USER_ID;
const siteUserEmail = process.env.TEST_PROVIDER_CREDENTIAL_SITE_USER_EMAIL;
const adminCookie = process.env.TEST_PROVIDER_CREDENTIAL_ADMIN_COOKIE;
const d1Config = process.env.TEST_PROVIDER_CREDENTIAL_D1_CONFIG;
const d1Persist = process.env.TEST_PROVIDER_CREDENTIAL_D1_PERSIST;
const d1Name = process.env.TEST_PROVIDER_CREDENTIAL_D1_NAME;
const allowedConfig = /\.sites-runtime\/m2-test-wrangler\.json$/i;
const allowedPersist = /\.wrangler\/m2-isolated-[^/]+$/i;
if (baseUrl && !/^https:\/\/127\.0\.0\.1:8789$/i.test(baseUrl)) throw new Error('Provider credential tests require the trusted loopback HTTPS Worker on port 8789.');
if (d1Config && !allowedConfig.test(d1Config.replaceAll('\\', '/'))) throw new Error('Provider credential tests require the isolated M2 Worker config.');
if (d1Persist && !allowedPersist.test(d1Persist.replaceAll('\\', '/'))) throw new Error('Provider credential tests require a disposable M2 D1 directory.');
if (d1Name && d1Name !== 'site-creator-d1') throw new Error('Unexpected provider credential test D1 name.');
const enabled = !!(baseUrl && siteUserId && siteUserEmail && adminCookie && d1Config && d1Persist && d1Name);
const suite = enabled ? test : test.skip;
const execFileAsync = promisify(execFile);

function headers(userId = siteUserId, email = siteUserEmail, cookie = adminCookie) {
  return {
    'oai-authenticated-user-id': userId,
    'oai-authenticated-user-email': email,
    ...(cookie ? { cookie } : {}),
  };
}

async function request(path, { method = 'GET', body, userId = siteUserId, email = siteUserEmail, cookie = adminCookie } = {}) {
  const url = new URL(path, baseUrl);
  return fetch(url, {
    method,
    redirect: 'manual',
    headers: {
      ...headers(userId, email, cookie),
      ...(body === undefined ? {} : { 'content-type': 'application/json', origin: url.origin }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function localD1(sql) {
  assert.match(baseUrl, /^https:\/\/127\.0\.0\.1:8789$/i);
  assert.match(d1Config.replaceAll('\\', '/'), allowedConfig);
  assert.match(d1Persist.replaceAll('\\', '/'), allowedPersist);
  const { stdout } = await execFileAsync(process.execPath, [
    resolve('node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', d1Name, '--local',
    '--config', d1Config, '--persist-to', d1Persist, '--command', sql,
  ], { cwd: process.cwd(), timeout: 30000, windowsHide: true });
  const start = stdout.indexOf('[\n');
  assert.notEqual(start, -1, 'Wrangler should return JSON D1 results');
  return JSON.parse(stdout.slice(start));
}

suite('provider secrets are encrypted, masked, and do not invalidate unrelated Google state', async () => {
  const config = JSON.parse(await readFile(d1Config, 'utf8'));
  const hosting = JSON.parse(await readFile(new URL('../.openai/hosting.json', import.meta.url), 'utf8'));
  const projectId = hosting.project_id;
  assert.match(projectId, /^[A-Za-z0-9_-]+$/);

  const initialResponse = await request('/api/setup/credentials');
  assert.equal(initialResponse.status, 200);
  const initial = await initialResponse.json();
  assert.equal(initial.sealed, true);
  assert.deepEqual(initial.admin, { present: true, source: 'native' }, 'native OAuth secret takes precedence over D1');
  const sessionSnapshotSql = `SELECT session_hash,site_user_id,google_subject,email,config_fingerprint,expires_at,created_at FROM admin_sessions WHERE site_user_id='${siteUserId}' ORDER BY google_subject,email,created_at;`;

  const inertToken = 'fixture-only-inert-ciphertext-do-not-use';
  await localD1(`INSERT OR REPLACE INTO google_connections(user_id,encrypted_refresh_token,account_name,location_name,location_title,updated_at,maps_url,config_fingerprint) VALUES('${siteUserId}','${inertToken}','accounts/fixture-only','locations/fixture-only','Fixture only',${Date.now()},NULL,NULL);`);
  const connectionBefore = await localD1(`SELECT COUNT(*) AS count FROM google_connections WHERE user_id='${siteUserId}' AND encrypted_refresh_token='${inertToken}';`);
  assert.equal(connectionBefore[0].results[0].count, 1);

  const nonOwnerSiteId = `fixture-provider-viewer-${randomBytes(8).toString('hex')}`;
  const nonOwnerToken = randomBytes(32).toString('hex');
  const nonOwnerHash = createHash('sha256').update(nonOwnerToken).digest('hex');
  const adminFingerprint = createHash('sha256')
    .update(`admin-oidc:v1:${projectId}:${config.vars.ADMIN_GOOGLE_CLIENT_ID}:${config.vars.ADMIN_GOOGLE_CLIENT_SECRET}`)
    .digest('hex');
  await localD1(`INSERT INTO admin_sessions(session_hash,site_user_id,google_subject,email,config_fingerprint,expires_at,created_at) VALUES('${nonOwnerHash}','${nonOwnerSiteId}','fixture-nonowner-subject','viewer@example.test','${adminFingerprint}',${Date.now() + 3600000},${Date.now()});`);
  const nonOwnerAuth = await request('/api/admin/auth/status', {
    userId: nonOwnerSiteId, email: 'viewer@example.test', cookie: `__Host-admin_session=${nonOwnerToken}`,
  });
  assert.equal(nonOwnerAuth.status, 200);
  assert.equal((await nonOwnerAuth.json()).authenticated, true, 'the denial below is the fixed-owner boundary, not a missing Google session');
  const ownerSessionsBefore = (await localD1(sessionSnapshotSql))[0].results;
  assert.ok(ownerSessionsBefore.length >= 1);

  const fixtures = [
    ['GA4_MP_API_SECRET', 'fixture-mp-secret-never-real-01'],
    ['WORKERS_AI_API_TOKEN', 'fixture-workers-ai-token-never-real-02'],
    ['VECTORIZE_API_TOKEN', 'fixture-vectorize-token-never-real-03'],
    ['ZENBOOKER_API_KEY', 'fixture-zenbooker-api-key-never-real-04'],
    ['CLOUDFLARE_EMAIL_API_TOKEN', 'fixture-cloudflare-email-token-never-real-05'],
  ];
  for (const [key, secret] of fixtures) {
    const denied = await request('/api/setup/credentials', {
      method: 'POST',
      userId: nonOwnerSiteId,
      email: 'viewer@example.test',
      cookie: `__Host-admin_session=${nonOwnerToken}`,
      body: { key, secret, shareWithBusiness: false },
    });
    assert.equal(denied.status, 403, `${key} must remain fixed-owner only even for another valid Google admin`);
    assert.doesNotMatch(await denied.text(), new RegExp(secret));

    const response = await request('/api/setup/credentials', { method: 'POST', body: { key, secret, shareWithBusiness: false } });
    assert.equal(response.status, 200, `${key} should save through the owner-authenticated encrypted D1 path`);
    const body = await response.json();
    assert.deepEqual(body, { saved: true, signInRequired: false, bootstrapSealed: true });
    assert.doesNotMatch(JSON.stringify(body), new RegExp(secret));

    const statusResponse = await request('/api/setup/credentials');
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    const provider = status.providers.find(row => row.key === key);
    assert.deepEqual(provider, { key, present: true, source: 'encrypted_d1' });
    assert.doesNotMatch(JSON.stringify(status), new RegExp(secret));

    const stored = await localD1(`SELECT ciphertext FROM app_credentials WHERE project_id='${projectId}' AND credential_key='${key}';`);
    const ciphertext = stored[0].results[0].ciphertext;
    assert.ok(ciphertext && !ciphertext.includes(secret));
    assert.equal(await decryptValue(ciphertext, `app-credential:v1:${projectId}:${key}`, config.vars.APP_CREDENTIAL_ENCRYPTION_KEY), secret);
    await assert.rejects(decryptValue(ciphertext, `app-credential:v1:${projectId}:OTHER_PURPOSE`, config.vars.APP_CREDENTIAL_ENCRYPTION_KEY));

    const auth = await request('/api/admin/auth/status');
    assert.equal(auth.status, 200);
    assert.equal((await auth.json()).authenticated, true, 'provider secret updates preserve the current Google admin session');
  }

  const overviewResponse = await request('/api/admin/tools', { method: 'POST', body: { tool: 'analysis.overview', arguments: {} } });
  assert.equal(overviewResponse.status, 200);
  const overview = (await overviewResponse.json()).result;
  assert.ok(overview.providers.every(provider => provider.enabled === false), 'credential presence alone must not enable provider calls');
  assert.doesNotMatch(JSON.stringify(overview), /fixture-zenbooker-api-key-never-real-04|fixture-cloudflare-email-token-never-real-05/);

  const auditRows = await localD1("SELECT target FROM admin_audit;");
  const auditText = JSON.stringify(auditRows);
  assert.doesNotMatch(auditText, /fixture-zenbooker-api-key-never-real-04|fixture-cloudflare-email-token-never-real-05/);

  const ownerSessionsAfter = (await localD1(sessionSnapshotSql))[0].results;
  assert.equal(createHash('sha256').update(JSON.stringify(ownerSessionsAfter)).digest('hex'),
    createHash('sha256').update(JSON.stringify(ownerSessionsBefore)).digest('hex'),
    'provider credential updates preserve the exact seeded owner session metadata');
  const connectionAfter = await localD1(`SELECT COUNT(*) AS count FROM google_connections WHERE user_id='${siteUserId}' AND encrypted_refresh_token='${inertToken}';`);
  assert.equal(connectionAfter[0].results[0].count, 1, 'provider credential changes preserve an unrelated inert GBP fixture row');
});
