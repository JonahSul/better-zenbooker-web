import test from 'node:test';
import assert from 'node:assert/strict';

const baseUrl = process.env.TEST_EXPERIMENT_BASE_URL;
const siteUserId = process.env.TEST_EXPERIMENT_SITE_USER_ID;
const siteUserEmail = process.env.TEST_EXPERIMENT_SITE_USER_EMAIL;
const ownerUserId = process.env.TEST_EXPERIMENT_OWNER_USER_ID;
const adminCookie = process.env.TEST_EXPERIMENT_ADMIN_COOKIE;
const d1Config = process.env.TEST_EXPERIMENT_D1_CONFIG;
const d1Persist = process.env.TEST_EXPERIMENT_D1_PERSIST;
const d1Name = process.env.TEST_EXPERIMENT_D1_NAME;
if (baseUrl && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/i.test(baseUrl)) throw new Error('Baseline acceptance tests may target loopback Workers only.');
if (d1Config && !/\.sites-runtime\/m2-test-wrangler\.json$/i.test(d1Config.replaceAll('\\', '/'))) throw new Error('Baseline tests require the isolated local Worker config.');
if (d1Persist && !/\.wrangler\/m2-isolated-[^/]+$/i.test(d1Persist.replaceAll('\\', '/'))) throw new Error('Baseline tests require a disposable local D1 directory.');
if (d1Name && d1Name !== 'site-creator-d1') throw new Error('Unexpected local D1 database name.');
const enabled = !!(baseUrl && siteUserId && siteUserEmail && adminCookie && d1Config && d1Persist && d1Name);
const suite = enabled ? test : test.skip;

async function request(path, { method = 'GET', body, auth = true, cookie = adminCookie, origin } = {}) {
  const url = new URL(path, baseUrl);
  return fetch(url, {
    method,
    redirect: 'manual',
    headers: {
      ...(auth ? { 'oai-authenticated-user-id': siteUserId, 'oai-authenticated-user-email': siteUserEmail } : {}),
      ...(cookie === null ? {} : { cookie }),
      ...(['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) ? { origin: origin ?? url.origin } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function tool(name, args = {}, options = {}) {
  return request('/api/admin/tools', { method: 'POST', body: { tool: name, arguments: args }, ...options });
}

async function result(response) {
  const body = await response.json();
  assert.equal(response.status, 200, `tool failed: ${JSON.stringify(body)}`);
  assert.ok(body.auditId);
  return body.result;
}

suite('approved public baseline uses the exact built artifact and creates no experiment exposure', async (t) => {
  let rootBefore;
  let htmlBefore;

  await t.test('Site-authenticated public page serves current built bytes without Google admin session or measurement', async () => {
    const response = await request('/', { cookie: null });
    assert.equal(response.status, 200);
    htmlBefore = await response.text();
    rootBefore = response.headers.get('x-public-snapshot');
    assert.match(rootBefore ?? '', /^[a-f0-9]{64}$/);
    assert.equal(response.headers.get('x-experiment-measured'), 'false');
    assert.match(htmlBefore, /^<!doctype html>/i);
    assert.equal((htmlBefore.match(/<h1\b/gi) ?? []).length, 1, 'the public document keeps one semantic server-rendered H1');
    assert.match(htmlBefore, /<title>Demo Business\b/);
    assert.match(htmlBefore, /<link rel="canonical" href="https:\/\/demo-site-20261028\.sample-owner\.chatgpt\.site\/"/);
    assert.match(htmlBefore, /<script type="application\/ld\+json">/);
    assert.match(htmlBefore, /"@type":"Service"/);
    assert.match(htmlBefore, /class="section wrap process/);
    assert.doesNotMatch(htmlBefore, /lorem ipsum|TODO|placeholder text/i);
  });

  await t.test('only an authenticated admin can inspect and approve the built baseline', async () => {
    const denied = await tool('baseline.setup', {}, { auth: false });
    assert.equal(denied.status, 403);
    const crossOrigin = await tool('baseline.setup', {}, { origin: 'https://other.example' });
    assert.equal(crossOrigin.status, 403);
    const injectedMarkup = await tool('baseline.setup', { html: '<script>alert(1)</script>' });
    assert.equal(injectedMarkup.status, 400);

    const before = await result(await tool('baseline.status'));
    const setup = await result(await tool('baseline.setup'));
    assert.equal(setup.persisted, true);
    assert.equal(setup.compatible, true);
    assert.equal(setup.exactHtmlReadback, true);
    assert.equal(setup.baseline.hash, rootBefore);
    assert.ok(setup.currentBuildHash);

    const afterStatus = await result(await tool('baseline.status'));
    assert.equal(afterStatus.persisted, true);
    assert.equal(afterStatus.compatible, true);
    assert.equal(afterStatus.baseline.hash, rootBefore);
    if (before.persisted) assert.equal(before.baseline.hash, rootBefore);
  });

  await t.test('approval leaves the public document byte-identical and does not create an exposure', async () => {
    const response = await request('/', { cookie: null });
    assert.equal(response.status, 200);
    const htmlAfter = await response.text();
    assert.equal(htmlAfter, htmlBefore);
    assert.equal(response.headers.get('x-public-snapshot'), rootBefore);
    assert.equal(response.headers.get('x-experiment-measured'), 'false');
  });

  await t.test('native fixed-owner MCP exposes the same strict setup and status operation', { skip: !ownerUserId }, async () => {
    async function mcp(userId, name, args = {}) {
      return fetch(new URL('/mcp', baseUrl), {
        method: 'POST', headers: {
          'oai-authenticated-user-id': userId,
          'oai-authenticated-user-email': siteUserEmail,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call', params: { name, arguments: args } }),
      });
    }
    const nonOwner = await mcp(`${ownerUserId}-other`, 'experiment_baseline_setup');
    const denied = await nonOwner.json();
    assert.equal(denied.result.isError, true);

    const ownerStatus = await mcp(ownerUserId, 'experiment_baseline_status');
    const statusBody = await ownerStatus.json();
    const statusText = statusBody.result.content.find(block => block.type === 'text').text;
    const status = JSON.parse(statusText);
    assert.equal(status.persisted, true);
    assert.equal(status.compatible, true);

    const ownerSetup = await mcp(ownerUserId, 'experiment_baseline_setup');
    const setupBody = await ownerSetup.json();
    const setup = JSON.parse(setupBody.result.content.find(block => block.type === 'text').text);
    assert.equal(setup.exactHtmlReadback, true);
  });
});
