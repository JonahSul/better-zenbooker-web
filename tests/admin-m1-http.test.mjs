import test from 'node:test';
import assert from 'node:assert/strict';

const baseUrl = process.env.TEST_BASE_URL;
const userId = process.env.TEST_USER_A_ID;
const userEmail = process.env.TEST_AUTH_EMAIL ?? 'qa@example.invalid';
const suite = baseUrl && userId ? test : test.skip;

function headers(method = 'GET', extra = {}) {
  const origin = new URL(baseUrl).origin;
  return {
    'oai-authenticated-user-id': userId,
    'oai-authenticated-user-email': userEmail,
    ...(method === 'GET' || method === 'HEAD' ? {} : { origin }),
    ...extra,
  };
}

async function call(path, { method = 'GET', body, redirect = 'manual', extraHeaders = {} } = {}) {
  return fetch(new URL(path, baseUrl), {
    method,
    redirect,
    headers: {
      ...headers(method, extraHeaders),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

suite('M1 built Worker HTTP checks', async (t) => {
  await t.test('Sites-gated root serves static baseline and only local island assets', async () => {
    const response = await call('/');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('x-public-snapshot') ?? '', /^[a-f0-9]{64}$/);
    assert.match((response.headers.get('x-robots-tag') ?? '').toLowerCase(), /noindex/);
    const html = await response.text();
    assert.equal((html.match(/<h1\b/gi) ?? []).length, 1);
    assert.match(html, /data-public-island="inquiry"/);
    assert.doesNotMatch(html, /<script[^>]+src=["']https?:/i);
    const modules = [...html.matchAll(/(?:src|href)="([^"?#]*_islands[^"?#]*)/g)].map((match) => match[1]);
    assert.ok(modules.length, 'static baseline should reference generated island assets');
    for (const asset of new Set(modules)) {
      const file = await call(asset);
      assert.equal(file.status, 200, `${asset} should be served locally`);
      assert.match(file.headers.get('content-type') ?? '', /javascript|text\/javascript|text\/css/i);
    }
  });

  await t.test('anonymous root retains the existing Sites sign-in gate', async () => {
    const response = await fetch(new URL('/', baseUrl), { redirect: 'manual' });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location') ?? '', /^\/signin-with-chatgpt\?return_to=/);
  });

  await t.test('Google admin status is disconnected and legacy inquiry reads/updates stay guarded', async () => {
    const status = await call('/api/admin/auth/status');
    assert.equal(status.status, 200);
    const statusBody = await status.json();
    assert.equal(statusBody.configured, false);
    assert.equal(statusBody.authenticated, false);

    const read = await call('/api/inquiries');
    assert.equal(read.status, 403);
    const update = await call('/api/inquiries', { method: 'PATCH', body: { id: crypto.randomUUID(), status: 'booked' } });
    assert.equal(update.status, 403);

    const gbp = await call('/api/google-reviews/locations');
    assert.equal(gbp.status, 403);
  });

  await t.test('public inquiry POST still works without Google admin sign-in', async () => {
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 2);
    const preferredDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(tomorrow);
    const response = await call('/api/inquiries', {
      method: 'POST',
      body: {
        submissionKey: crypto.randomUUID(), name: 'QA M1', contact: 'qa@example.invalid',
        service: 'fall-blowout', area: 'Billings', source: 'direct', preferredDate,
        note: 'Local automated QA; do not contact.',
      },
    });
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal((await response.json()).saved, true);
  });

  await t.test('optional purpose status defaults off and cannot be saved without signing configuration', async () => {
    const status = await call('/api/consent');
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), {
      configured: false,
      analytics: false,
      analyticsSaved: false,
      analyticsSuppressed: false,
      experiments: false,
      analyticsRevision: 0,
      experimentsRevision: 0,
      measurementId: null,
    });
    const save = await call('/api/consent', { method: 'POST', body: { purpose: 'experiments', grant: true, expectedPurposeRevision: 0 } });
    assert.equal(save.status, 503);
    assert.doesNotMatch(save.headers.get('set-cookie') ?? '', /__Host-(?:purpose|analytics)_consent=.*Max-Age=\d{2,}/);
  });
});
