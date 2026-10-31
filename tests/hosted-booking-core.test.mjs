import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const zod = require('zod/v3');
process.env.NEXT_PUBLIC_HOSTED_BOOKING_URL = 'https://booking.example.test/book/fixture';
process.env.NEXT_PUBLIC_HOSTED_SERVICE_IDS = 'svc_fixture_a,svc_fixture_b';
process.env.NEXT_PUBLIC_BUSINESS_SOURCE_URL = 'https://example.test/';

async function loadTs(relativePath, imports = {}) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (Object.hasOwn(imports, specifier)) return imports[specifier];
    throw new Error(`Unexpected import from ${relativePath}: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const hosted = await loadTs('lib/hosted-booking-core.ts', { zod, 'zod/v3': zod });
const expectedLinks = ['svc_fixture_a', 'svc_fixture_b'].map(serviceId => ({ serviceId, name: serviceId }));

test('hosted destination and preselection links are fixed to the reviewed Zenbooker origin', () => {
  assert.equal(hosted.HOSTED_BOOKING_URL, 'https://booking.example.test/book/fixture');
  assert.deepEqual(hosted.PUBLIC_SERVICE_LINKS.map(({ serviceId, name }) => ({ serviceId, name })), expectedLinks);

  for (const link of hosted.PUBLIC_SERVICE_LINKS) {
    const url = new URL(link.url);
    assert.equal(url.origin, 'https://booking.example.test');
    assert.equal(url.pathname, '/book/fixture');
    assert.deepEqual([...url.searchParams.keys()], ['preselected-service']);
    assert.equal(url.searchParams.get('preselected-service'), link.serviceId);
    assert.equal(url.username, '');
    assert.equal(url.password, '');
    assert.equal(url.hash, '');
  }
});

test('strict handoff accepts bounded IDs and fixed placements without caller-controlled URLs', () => {
  const placements = ['header', 'hero', 'services', 'footer', 'booking', 'account'];
  assert.equal(hosted.hostedHandoffInput.safeParse({ placement: 'hero' }).success, true);

  for (const { serviceId } of expectedLinks) {
    for (const placement of placements) {
      const input = hosted.hostedHandoffInput.parse({ serviceId, placement });
      const url = new URL(hosted.buildHostedBookingUrl(input));
      assert.equal(url.origin, 'https://booking.example.test');
      assert.equal(url.href, hosted.HOSTED_BOOKING_URL);
      assert.equal(url.searchParams.has('preselected-service'), false);
    }
  }

  for (const input of [
    { serviceId: expectedLinks[0].serviceId, placement: 'unknown' },
    { serviceId: expectedLinks[0].serviceId, placement: 'hero', url: 'https://attacker.invalid/' },
    { serviceId: expectedLinks[0].serviceId, placement: 'hero', click_id: 'external-id' },
    { serviceId: expectedLinks[0].serviceId, placement: 'hero', utm_source: 'campaign' },
    { serviceId: expectedLinks[0].serviceId, placement: 'hero', email: 'person@example.invalid' },
  ]) assert.equal(hosted.hostedHandoffInput.safeParse(input).success, false);

  assert.equal(hosted.buildHostedBookingUrl({ placement: 'hero' }), hosted.HOSTED_BOOKING_URL);
  assert.equal(hosted.buildHostedBookingUrl({ serviceId: 'forged', placement: 'hero' }), hosted.HOSTED_BOOKING_URL);
});

test('click-source parser explicitly reports unsupported correlation without echoing input', () => {
  const candidates = [
    null,
    { click_id: 'click-fixture', utm_source: 'fixture-campaign' },
    { email: 'customer@example.invalid', phone: '+15555550123', note: 'fixture PII' },
    'https://attacker.invalid/?click_id=fixture',
  ];
  for (const candidate of candidates) {
    const result = hosted.parseClickSource(candidate);
    assert.deepEqual(result, { status: 'unverified', clickId: null, correlationSupported: false });
    assert.equal(JSON.stringify(result).includes('fixture'), false);
    assert.equal(JSON.stringify(result).includes('customer@example.invalid'), false);
  }
});

test('public homepage snapshot extracts only known service links and keeps completeness unknown', () => {
  const anchors = hosted.PUBLIC_SERVICE_LINKS.map(link =>
    `<a href="${link.url}">${link.name}</a>`).join('\n');
  const html = `<main><h1>Public service list</h1>${anchors}`
    + '<a href="https://attacker.invalid/book?preselected-service=svc_fixture_a">Spoofed service</a>'
    + '<p>Fixture price $999 and same-day availability</p>'
    + '<script>window.fixture = "secret@example.invalid"; fetch("https://attacker.invalid");</script></main>';
  const result = hosted.parsePublicServiceSnapshot({
    sourceUrl: 'https://example.test/',
    html,
    fetchedAt: '2026-10-29T12:00:00.000Z',
  });

  assert.equal(result.status, 'candidate');
  assert.equal(result.source, 'business_site');
  assert.equal(result.completeness, 'unknown');
  assert.equal(result.fetchedAt, '2026-10-29T12:00:00.000Z');
  assert.deepEqual(result.services.map(({ serviceId, name }) => ({ serviceId, name })), expectedLinks);
  assert.ok(result.services.every(service => service.description === null));
  assert.equal(JSON.stringify(result).includes('secret@example.invalid'), false);
  assert.equal(JSON.stringify(result).includes('attacker.invalid'), false);
  assert.equal(JSON.stringify(result).includes('999'), false);
  assert.equal(JSON.stringify(result).match(/price|duration|availability|slot/gi), null);
});

test('widget address-entry render is not treated as a successful catalog or approved address', () => {
  const result = hosted.parsePublicServiceSnapshot({
    sourceUrl: hosted.HOSTED_BOOKING_URL,
    html: '<main><label>Enter your service address</label><input name="address"></main>',
    fetchedAt: '2026-10-29T12:00:00.000Z',
  });
  assert.equal(result.status, 'address_required');
  assert.equal(result.source, 'hosted_widget');
  assert.equal(result.completeness, 'unknown');
  assert.deepEqual(result.services, []);
});

test('public snapshot parser ignores links from unrecognized destinations and rejects malformed timestamps', () => {
  const input = {
    html: '<main><h1>Service</h1></main>',
    fetchedAt: '2026-10-29T12:00:00.000Z',
  };
  const unknownSource = hosted.parsePublicServiceSnapshot({
    ...input,
    sourceUrl: 'https://attacker.invalid/',
  });
  assert.deepEqual(unknownSource.services, []);
  assert.equal(unknownSource.status, 'unavailable');

  assert.throws(() => hosted.parsePublicServiceSnapshot({
    ...input,
    sourceUrl: 'https://example.test/',
    fetchedAt: 'not-a-date',
  }));
});
