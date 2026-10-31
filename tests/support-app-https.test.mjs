import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const base = process.env.TEST_SUPPORT_APP_BASE_URL ?? '';
const parsed = base ? new URL(base) : null;
const ownerCookie = process.env.TEST_SUPPORT_APP_OWNER_COOKIE ?? '';
const viewerCookie = process.env.TEST_SUPPORT_APP_VIEWER_COOKIE ?? '';
const ownerSiteId = process.env.TEST_SUPPORT_APP_OWNER_SITE_ID ?? '';
const ownerEmail = process.env.TEST_SUPPORT_APP_OWNER_EMAIL ?? '';
const viewerSiteId = process.env.TEST_SUPPORT_APP_VIEWER_SITE_ID ?? '';
const viewerEmail = process.env.TEST_SUPPORT_APP_VIEWER_EMAIL ?? '';
const enabled = !!parsed && parsed.protocol === 'https:' && parsed.hostname === '127.0.0.1' && parsed.port === '8789'
  && ownerCookie && viewerCookie && ownerSiteId && ownerEmail && viewerSiteId && viewerEmail;
if (base && !enabled) throw new Error('Support app HTTPS tests require the dedicated synthetic loopback fixture at https://127.0.0.1:8789 and its generated owner/viewer sessions.');

async function request(path, { method = 'GET', body, cookie, siteId, email, origin, headers: extraHeaders = {} } = {}) {
  const headers = { Accept: path.startsWith('/api/') ? 'application/json' : 'text/html', ...extraHeaders };
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
  try { data = text ? JSON.parse(text) : null; } catch { /* HTML is retained as text for assertions. */ }
  return { response, text, data };
}

const owner = (path, options = {}) => request(path, { ...options, cookie: ownerCookie, siteId: ownerSiteId, email: ownerEmail });
const viewer = (path, options = {}) => request(path, { ...options, cookie: viewerCookie, siteId: viewerSiteId, email: viewerEmail });
const siteVisitor = (path, options = {}) => request(path, { ...options, siteId: ownerSiteId, email: ownerEmail });
const adminPaths = ['/admin', '/admin/chat', '/admin/support', '/admin/experiments', '/admin/performance', '/admin/analysis', '/admin/memory', '/admin/inquiries', '/admin/settings', '/admin/audit'];

test('admin shell keeps native navigation anchors and exact section destinations', () => {
  const source = readFileSync(new URL('../components/admin-shell.tsx', import.meta.url), 'utf8');
  const navigation = readFileSync(new URL('../components/admin-navigation.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from\s+['"]next\/link['"]|<Link\b/);
  assert.match(source, /<AdminNavigation section=\{section\} className="console-desktop-navigation"\/>/);
  assert.match(source, /<MobileAdminNavigation section=\{section\}\/>/);
  assert.match(navigation, /aria-current=\{section===path\?'page':undefined\}/);
  for (const path of ['', 'chat', 'support', 'experiments', 'performance', 'analysis', 'memory', 'inquiries', 'settings', 'audit']) {
    assert.ok(navigation.includes(`['${path}'`) || (path === '' && navigation.includes("['','Overview'")), `admin section map includes ${path || 'overview'}`);
  }
  for (const href of ['/admin', '/admin/chat', '/admin/support', '/admin/experiments', '/admin/performance', '/admin/analysis', '/admin/memory', '/admin/inquiries', '/admin/settings', '/admin/audit']) {
    assert.ok(navigation.includes(`href="${href}"`) || navigation.includes("href={'/admin'+(path?'/'+path:'')}"), `native navigation includes ${href}`);
  }
});

test('public visitor support works without Google/customer identity and remains private, bounded and owner-separated', { skip: !enabled && 'Set the generated TEST_SUPPORT_APP_* values for the disposable HTTPS Worker only.' }, async () => {
  const origin = parsed.origin;
  const home = await siteVisitor('/');
  assert.equal(home.response.status, 200);
  assert.match(home.response.headers.get('content-type') ?? '', /^text\/html\b/i);
  assert.match(home.text, /A little demo help/);
  assert.match(home.text, /Need help\?/);
  assert.equal((home.text.match(/class="support-launcher"/g) ?? []).length, 1, 'the homepage has one help launcher');
  assert.doesNotMatch(home.text, /googletagmanager\.com\/gtm\.js|googletagmanager\.com\/ns\.html|google-analytics\.com/i);
  for (const path of ['/book', '/appointments']) {
    const page = await siteVisitor(path);
    assert.equal(page.response.status, 200);
    assert.match(page.response.headers.get('content-type') ?? '', /^text\/html\b/i);
    assert.equal((page.text.match(/class="support-launcher"/g) ?? []).length, 1, `${path} has one help launcher`);
  }
  for (const path of [...adminPaths, '/setup/credentials']) {
    const page = await owner(path);
    assert.equal(page.response.status, 200, `authorized direct document GET succeeds for ${path}`);
    assert.match(page.response.headers.get('content-type') ?? '', /^text\/html\b/i);
    assert.doesNotMatch(page.text, /class="support-launcher"/, `${path} does not mount visitor help in a private area`);
    assert.doesNotMatch(page.text, /id="visitor-support-dialog"/);
    assert.match(page.response.headers.get('cache-control') ?? '', /private, no-store/i);
  }
  for (const path of ['/privacy', '/terms']) {
    const policy = await request(path);
    assert.equal(policy.response.status, 200);
    assert.match(policy.text, /Visitor support chat/);
    assert.match(policy.text, /24 hours/);
  }

  const noMemory = await request('/api/support/memory');
  assert.equal(noMemory.response.status, 200);
  assert.deepEqual(noMemory.data, { authenticated: false, revision: 0, remember: false, answerLength: 'standard', serviceInterests: [] });
  assert.equal(noMemory.response.headers.get('set-cookie'), null);

  const wrongOrigin = await request('/api/support/chat', {
    method: 'POST',
    origin: 'https://example.invalid',
    body: { requestKey: randomUUID(), message: 'This must not create a session.' },
  });
  assert.equal(wrongOrigin.response.status, 403);
  assert.equal(wrongOrigin.response.headers.get('set-cookie'), null);

  const malformed = await request('/api/support/chat', {
    method: 'POST',
    origin,
    body: { requestKey: randomUUID(), message: 'Strict visitor request.', googleSubject: 'attacker-controlled' },
  });
  assert.equal(malformed.response.status, 400);
  assert.equal(malformed.response.headers.get('set-cookie'), null);

  const first = await request('/api/support/chat', {
    method: 'POST',
    origin,
    body: { requestKey: randomUUID(), message: 'Where can I check current demo service choices?' },
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.data.status, 'help', 'uninitialized/disabled proxy must use static help');
  assert.ok(first.data.threadId && first.data.turnId);
  assert.equal(first.response.headers.get('cache-control'), 'private, no-store');
  assert.equal(first.response.headers.get('referrer-policy'), 'no-referrer');
  const firstSetCookie = first.response.headers.get('set-cookie') ?? '';
  assert.match(firstSetCookie, /__Host-support_visitor=/);
  assert.match(firstSetCookie, /HttpOnly/i);
  assert.match(firstSetCookie, /Secure/i);
  assert.match(firstSetCookie, /SameSite=Strict/i);
  const firstCookie = firstSetCookie.split(';')[0];
  assert.doesNotMatch(first.text, /googleSubject|siteUserId|customerId|appointmentId/i);

  const firstMemory = await request('/api/support/memory', { cookie: firstCookie });
  assert.equal(firstMemory.response.status, 200);
  assert.equal(firstMemory.data.authenticated, undefined);
  assert.equal(firstMemory.data.currentThreadId, first.data.threadId);

  const savedPreferences = await request('/api/support/memory', {
    method: 'PUT', origin, cookie: firstCookie,
    body: { revision: firstMemory.data.revision, remember: true, answerLength: 'short', serviceInterests: ['fall_blowout'] },
  });
  assert.equal(savedPreferences.response.status, 200);
  assert.equal(savedPreferences.data.remember, true);
  assert.equal(savedPreferences.data.answerLength, 'short');

  const acceptedFeedback = await request('/api/support/feedback', {
    method: 'POST', origin, cookie: firstCookie,
    body: { threadId: first.data.threadId, turnId: first.data.turnId, vote: 'up' },
  });
  assert.equal(acceptedFeedback.response.status, 200);
  assert.deepEqual(acceptedFeedback.data, { saved: true });
  const replacedFeedback = await request('/api/support/feedback', {
    method: 'POST', origin, cookie: firstCookie,
    body: { threadId: first.data.threadId, turnId: first.data.turnId, vote: 'down', reason: 'unhelpful' },
  });
  assert.equal(replacedFeedback.response.status, 200);

  const second = await request('/api/support/chat', {
    method: 'POST', origin,
    body: { requestKey: randomUUID(), message: 'How do I find help with my appointment?' },
  });
  assert.equal(second.response.status, 200);
  const secondCookie = (second.response.headers.get('set-cookie') ?? '').split(';')[0];
  assert.ok(secondCookie && secondCookie !== firstCookie, 'each visitor receives a distinct opaque session');
  const secondMemory = await request('/api/support/memory', { cookie: secondCookie });
  assert.equal(secondMemory.response.status, 200);
  assert.equal(secondMemory.data.remember, false);
  assert.equal(secondMemory.data.answerLength, 'standard');
  assert.notEqual(secondMemory.data.currentThreadId, first.data.threadId);

  const foreignRead = await request(`/api/support/threads/${encodeURIComponent(first.data.threadId)}`, { cookie: secondCookie });
  assert.notEqual(foreignRead.response.status, 200);
  assert.doesNotMatch(foreignRead.text, new RegExp(first.data.threadId));
  const foreignDelete = await request(`/api/support/threads/${encodeURIComponent(first.data.threadId)}`, {
    method: 'DELETE', origin, cookie: secondCookie, body: { revision: 0 },
  });
  assert.notEqual(foreignDelete.response.status, 200);
  assert.doesNotMatch(foreignDelete.text, new RegExp(first.data.threadId));

  const legacyAdmin = await request('/api/admin/tools', {
    method: 'POST', origin, cookie: firstCookie,
    body: { tool: 'support.readiness', arguments: {} },
  });
  assert.ok([401, 403].includes(legacyAdmin.response.status));
  assert.doesNotMatch(legacyAdmin.text, /support_proxy_state|credential_json|verifier/i);

  const invalidFeedback = await request('/api/support/feedback', {
    method: 'POST', origin, cookie: firstCookie,
    body: { threadId: first.data.threadId, turnId: first.data.turnId, vote: 'up', reason: 'free-form feedback is not allowed' },
  });
  assert.equal(invalidFeedback.response.status, 400, 'free-form feedback reasons remain rejected');
  const foreignFeedback = await request('/api/support/feedback', {
    method: 'POST', origin, cookie: secondCookie,
    body: { threadId: first.data.threadId, turnId: first.data.turnId, vote: 'up' },
  });
  assert.equal(foreignFeedback.response.status, 400, 'feedback cannot be attached to another visitor’s turn');

  const erase = await request('/api/support/session', { method: 'DELETE', origin, cookie: firstCookie, body: {} });
  assert.equal(erase.response.status, 200);
  assert.equal(erase.data.upstreamErasure, false);
  assert.match(erase.response.headers.get('set-cookie') ?? '', /Max-Age=0/);
  const replay = await request(`/api/support/threads/${encodeURIComponent(first.data.threadId)}`, { cookie: firstCookie });
  assert.equal(replay.response.status, 401);
  assert.doesNotMatch(replay.text, /Where can I check current/);

  const statusBefore = await owner('/api/admin/tools', { method: 'POST', origin, body: { tool: 'support.readiness', arguments: {} } });
  assert.equal(statusBefore.response.status, 200);
  assert.equal(statusBefore.data.result.initialized, false);
  assert.equal(statusBefore.data.result.enabled, false);
  assert.equal(statusBefore.data.result.configured, false);
  const metricsBefore = await owner('/api/admin/tools', { method: 'POST', origin, body: { tool: 'support.metrics', arguments: {} } });
  assert.equal(metricsBefore.response.status, 200);
  assert.equal(metricsBefore.data.result.reservedCallsToday, 0, 'static fallback must not reserve model calls');

  const visitorAsAdmin = await request('/api/admin/tools', {
    method: 'POST', origin, cookie: firstCookie, siteId: ownerSiteId, email: ownerEmail,
    body: { tool: 'support.readiness', arguments: {} },
  });
  assert.ok([401, 403].includes(visitorAsAdmin.response.status), 'visitor session cannot substitute for Google admin session');

  const noGoogle = await request('/api/admin/support/initialize', {
    method: 'POST', origin, siteId: ownerSiteId, email: ownerEmail,
    body: { requestKey: `support-init-${randomUUID()}` },
  });
  assert.equal(noGoogle.response.status, 403);
  const nonOwner = await viewer('/api/admin/support/initialize', {
    method: 'POST', origin, body: { requestKey: `support-init-${randomUUID()}` },
  });
  assert.equal(nonOwner.response.status, 403);
  const wrongOriginOwner = await owner('/api/admin/support/initialize', {
    method: 'POST', origin: 'https://example.invalid', body: { requestKey: `support-init-${randomUUID()}` },
  });
  assert.equal(wrongOriginOwner.response.status, 403);
  const malformedOwner = await owner('/api/admin/support/initialize', {
    method: 'POST', origin, body: { requestKey: `support-init-${randomUUID()}`, capability: 'do-not-accept' },
  });
  assert.equal(malformedOwner.response.status, 400);
  const stillUninitialized = await owner('/api/admin/tools', { method: 'POST', origin, body: { tool: 'support.readiness', arguments: {} } });
  assert.equal(stillUninitialized.data.result.initialized, false);

  const requestKey = `support-init-${randomUUID()}`;
  const initialized = await owner('/api/admin/support/initialize', { method: 'POST', origin, body: { requestKey } });
  assert.equal(initialized.response.status, 200);
  assert.deepEqual(Object.keys(initialized.data).sort(), ['initialized', 'revision', 'verifier']);
  assert.equal(initialized.data.initialized, true);
  assert.equal(initialized.data.revision, 1);
  assert.match(initialized.data.verifier, /^[0-9a-f]{64}$/);
  const repeatedSame = await owner('/api/admin/support/initialize', { method: 'POST', origin, body: { requestKey } });
  const repeatedNew = await owner('/api/admin/support/initialize', { method: 'POST', origin, body: { requestKey: `support-init-${randomUUID()}` } });
  for (const result of [repeatedSame, repeatedNew]) {
    assert.equal(result.response.status, 200);
    assert.equal(result.data.revision, initialized.data.revision);
    assert.equal(result.data.verifier, initialized.data.verifier);
  }
  const statusAfter = await owner('/api/admin/tools', { method: 'POST', origin, body: { tool: 'support.readiness', arguments: {} } });
  assert.equal(statusAfter.response.status, 200);
  assert.equal(statusAfter.data.result.initialized, true);
  assert.equal(statusAfter.data.result.enabled, false);
  assert.equal(statusAfter.data.result.health, 'not_checked');
  assert.equal(statusAfter.data.result.schedule, 'not_recorded');
  assert.equal(Object.hasOwn(statusAfter.data.result, 'credential_json'), false);
  assert.doesNotMatch(statusAfter.text, /support-init-[0-9a-f-]{36}/);
});
