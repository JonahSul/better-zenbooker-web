import test from 'node:test';
import assert from 'node:assert/strict';

const baseUrl = process.env.TEST_BASE_URL;
const userA = process.env.TEST_USER_A_ID;
const userB = process.env.TEST_USER_B_ID;
const authEmail = process.env.TEST_AUTH_EMAIL ?? 'qa@example.invalid';

const suite = baseUrl && userA && userB ? test : test.skip;

function authHeaders(userId) {
  return {
    'oai-authenticated-user-id': userId,
    'oai-authenticated-user-email': authEmail,
  };
}

async function call(path, { userId, method = 'GET', body, headers = {}, redirect = 'follow' } = {}) {
  const url = new URL(path, baseUrl);
  return fetch(new URL(path, baseUrl), {
    method,
    redirect,
    headers: {
      ...(userId ? authHeaders(userId) : {}),
      ...(['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) ? { origin: url.origin } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function denverToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function plusDays(date, count) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}

function inquiry(overrides = {}) {
  return {
    submissionKey: crypto.randomUUID(),
    name: 'QA sample',
    contact: 'qa@example.invalid',
    service: 'fall-blowout',
    area: 'Billings',
    source: 'direct',
    preferredDate: plusDays(denverToday(), 1),
    note: 'Automated QA sample; do not contact.',
    ...overrides,
  };
}

suite('private inquiry API acceptance', async (t) => {
  await t.test('anonymous read and write fail closed', async () => {
    const read = await call('/api/inquiries');
    assert.equal(read.status, 401);
    const write = await call('/api/inquiries', { method: 'POST', body: inquiry() });
    assert.equal(write.status, 401);
  });

  await t.test('valid preferred date persists and is visible to its owner after a fresh read', async () => {
    const payload = inquiry();
    const created = await call('/api/inquiries', { userId: userA, method: 'POST', body: payload });
    assert.ok([200, 201].includes(created.status), `expected create success, got ${created.status}`);
    const createdBody = await created.json();
    assert.equal(createdBody.saved, true);
    assert.ok(createdBody.id);

    const read = await call('/api/inquiries', { userId: userA });
    assert.equal(read.status, 200);
    const rows = (await read.json()).inquiries;
    const saved = rows.find((row) => row.id === createdBody.id);
    assert.ok(saved, 'saved inquiry should appear in a fresh list response');
    assert.equal(saved.preferredDate, payload.preferredDate);
    assert.equal(saved.status, 'new');
    assert.equal(saved.revenueCents, null);
    assert.equal(JSON.stringify(saved).includes(userA), false, 'response must not expose the auth subject');
  });

  await t.test('invalid date, enums, and oversized body are rejected', async () => {
    for (const preferredDate of [
      denverToday(),
      plusDays(denverToday(), -1),
      '2026-02-30',
      'not-a-date',
    ]) {
      const response = await call('/api/inquiries', {
        userId: userA, method: 'POST', body: inquiry({ preferredDate }),
      });
      assert.equal(response.status, 400, `expected ${preferredDate} to fail validation`);
    }

    const invalidEnum = await call('/api/inquiries', {
      userId: userA, method: 'POST', body: inquiry({ service: 'invented-service' }),
    });
    assert.equal(invalidEnum.status, 400);

    const oversized = await call('/api/inquiries', {
      userId: userA,
      method: 'POST',
      body: inquiry({ note: 'x'.repeat(9000) }),
    });
    assert.ok([400, 413].includes(oversized.status));
  });

  await t.test('same-origin mutation is required', async () => {
    const response = await call('/api/inquiries', {
      userId: userA,
      method: 'POST',
      body: inquiry(),
      headers: { origin: 'https://other.example' },
    });
    assert.equal(response.status, 403);
  });

  await t.test('duplicate submission key returns the original record without a second insert', async () => {
    const payload = inquiry();
    const first = await call('/api/inquiries', { userId: userA, method: 'POST', body: payload });
    assert.ok([200, 201].includes(first.status), `first idempotency request returned ${first.status}: ${await first.clone().text()}`);
    const firstBody = await first.json();
    const second = await call('/api/inquiries', { userId: userA, method: 'POST', body: payload });
    assert.ok([200, 201].includes(second.status), `retry returned ${second.status}: ${await second.clone().text()}`);
    const secondBody = await second.json();
    assert.equal(secondBody.id, firstBody.id);
    assert.equal(secondBody.created, false);
  });

  await t.test('authenticated users cannot see or change each other records', async () => {
    const payload = inquiry();
    const create = await call('/api/inquiries', { userId: userA, method: 'POST', body: payload });
    assert.ok([200, 201].includes(create.status));
    const id = (await create.json()).id;

    const otherRead = await call('/api/inquiries', { userId: userB });
    assert.equal(otherRead.status, 200);
    assert.equal((await otherRead.json()).inquiries.some((row) => row.id === id), false);

    const otherUpdate = await call('/api/inquiries', {
      userId: userB,
      method: 'PATCH',
      body: { id, status: 'completed', revenueCents: 99999 },
    });
    assert.equal(otherUpdate.status, 404);

    const ownerRead = await call('/api/inquiries', { userId: userA });
    const saved = (await ownerRead.json()).inquiries.find((row) => row.id === id);
    assert.equal(saved.status, 'new');
    assert.equal(saved.revenueCents, null);
  });

  await t.test('status and revenue are distinct, validated manager fields', async () => {
    const create = await call('/api/inquiries', {
      userId: userA, method: 'POST', body: inquiry(),
    });
    assert.ok([200, 201].includes(create.status));
    const id = (await create.json()).id;

    for (const body of [
      { id, status: 'paid', revenueCents: 100 },
      { id, status: 'booked', revenueCents: -1 },
      { id, status: 'completed', revenueCents: 10.25 },
    ]) {
      const invalid = await call('/api/inquiries', { userId: userA, method: 'PATCH', body });
      assert.equal(invalid.status, 400);
    }

    const update = await call('/api/inquiries', {
      userId: userA,
      method: 'PATCH',
      body: { id, status: 'completed', revenueCents: 12500 },
    });
    assert.equal(update.status, 200);
    const read = await call('/api/inquiries', { userId: userA });
    const saved = (await read.json()).inquiries.find((row) => row.id === id);
    assert.equal(saved.status, 'completed');
    assert.equal(saved.revenueCents, 12500);
  });
});

suite('private landing page HTTP metadata', async (t) => {
  await t.test('response is private and carries noindex directives', async () => {
    const response = await call('/', { userId: userA });
    assert.equal(response.status, 200);
    const robotsHeader = response.headers.get('x-robots-tag') ?? '';
    const html = await response.text();
    assert.match(robotsHeader.toLowerCase(), /noindex/);
    assert.match(html, /<meta[^>]+name=["']robots["'][^>]+noindex/i);
    assert.match(html, /Demo Business/i);
    assert.doesNotMatch(html, /Starter Project|clean starting point/i);
    assert.match(html, /<title>[^<]+Demo[^<]*<\/title>/i);
    assert.match(html, /<meta[^>]+name=["']description["'][^>]+content=/i);
    assert.match(html, /<link[^>]+rel=["']canonical["'][^>]+href=/i);
    assert.equal((html.match(/<h1\b/gi) ?? []).length, 1, 'home should render exactly one H1');

    const jsonLd = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
    assert.ok(jsonLd, 'truthful service structured data should be present');
    const structured = JSON.parse(jsonLd[1]);
    assert.ok(Array.isArray(structured['@graph']));
    const organization = structured['@graph'].find((item) => item['@type'] === 'Organization');
    const service = structured['@graph'].find((item) => item['@type'] === 'Service');
    assert.ok(organization && service, 'truthful WebSite, Organization, and Service graph should be present');
    assert.equal(organization.name, 'Demo Business');
    assert.equal(organization.telephone, '+1-406-861-7757');
    assert.deepEqual(organization.areaServed, ['Billings, Montana', 'Lockwood, Montana']);
    assert.match(service.name, /Billings and Lockwood/i);
    assert.deepEqual(service.areaServed, ['Billings, Montana', 'Lockwood, Montana']);
    assert.equal(organization.address, undefined, 'do not invent an address');
    assert.equal(organization.aggregateRating, undefined, 'do not add unverified ratings');
    for (const visibleFact of [
      'Fall blowouts', 'Spring turn-up', 'Demo repair', 'Ongoing maintenance',
      'Billings', 'Lockwood', '(406) 861-7757',
    ]) {
      assert.ok(html.includes(visibleFact), `metadata and structured facts must agree with visible content: ${visibleFact}`);
    }
    assert.match(html, /Demo Business/i);
  });

  await t.test('privacy and authenticated manager responses remain noindex', async () => {
    for (const path of ['/privacy', '/manage']) {
      const response = await call(path, { userId: userA });
      assert.equal(response.status, 200, `${path} should load for the signed-in Site user`);
      assert.match((response.headers.get('x-robots-tag') ?? '').toLowerCase(), /noindex/);
      assert.match(await response.text(), /<meta[^>]+name=["']robots["'][^>]+noindex/i);
    }
    const anonymous = await call('/manage', { redirect: 'manual' });
    assert.equal(anonymous.status, 307, `manager must require authentication; got ${anonymous.status}`);
    assert.match(anonymous.headers.get('location') ?? '', /^\/signin-with-chatgpt\?return_to=/);
  });

  await t.test('private robots policy and sitemap remain non-indexing and fail closed', async () => {
    const robots = await call('/robots.txt');
    assert.equal(robots.status, 200);
    assert.match(robots.headers.get('content-type') ?? '', /text\/plain/i);
    assert.match((robots.headers.get('x-robots-tag') ?? '').toLowerCase(), /noindex/);
    const rules = await robots.text();
    assert.match(rules, /User-agent:\s*\*/i);
    assert.match(rules, /Allow:\s*\//i);
    assert.match(rules, /Disallow:\s*\/manage/i);
    assert.doesNotMatch(rules, /Sitemap:/i, 'private site must not advertise a public sitemap');

    const sitemap = await call('/sitemap.xml');
    assert.equal(sitemap.status, 200);
    assert.match(sitemap.headers.get('content-type') ?? '', /application\/xml/i);
    assert.match((sitemap.headers.get('x-robots-tag') ?? '').toLowerCase(), /noindex/);
    const xml = await sitemap.text();
    assert.match(xml, /<urlset\b/);
    assert.doesNotMatch(xml, /<loc>/i, 'private sitemap must stay empty');
  });
});

test('API acceptance suite configuration', { skip: !(baseUrl && userA && userB) }, () => {
  assert.ok(baseUrl && userA && userB);
});
