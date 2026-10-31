import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
process.env.NEXT_PUBLIC_HOSTED_BOOKING_URL = 'https://booking.example.test/calendar';
process.env.NEXT_PUBLIC_HOSTED_SERVICE_IDS = 'fixture-service-01';
process.env.NEXT_PUBLIC_HOSTED_BOOKING_URL = 'https://booking.example.test/calendar';
process.env.NEXT_PUBLIC_HOSTED_SERVICE_IDS = 'fixture-service-01';

async function loadTs(relative, overrides = {}) {
  const source = await readFile(path.join(root, relative), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (Object.hasOwn(overrides, specifier)) return overrides[specifier];
    if (specifier === 'zod/v3' && Object.hasOwn(overrides, 'zod')) return overrides.zod;
    if (specifier === 'zod/v3') return require(specifier);
    throw new Error(`Unexpected ${relative} import: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const hostedCore = await loadTs('lib/hosted-booking-core.ts', { zod: require('zod/v3') });
const booking = await loadTs('lib/hosted-booking-client.ts', {
  './hosted-booking-core': hostedCore,
  './consent-client': { currentAnalyticsEpoch: () => 0, analyticsReferenceAllowed: () => false, async refreshPurposeConsent() {} },
});

test('handoff response validator accepts only the fixed destination plus one exact opaque reference', () => {
  const canonical = hostedCore.buildHostedBookingUrl({ placement: 'hero' });
  const reference = 'app_ref_v1_' + 'd'.repeat(32);
  assert.equal(booking.validatedHandoffUrl(canonical, canonical), canonical);
  assert.equal(booking.validatedHandoffUrl(canonical + '?utm_content=' + reference, canonical), canonical + '?utm_content=' + reference);
  for (const url of [
    'https://attacker.invalid/?utm_content=' + reference,
    canonical + '?utm_content=' + reference + '&utm_content=' + reference,
    canonical + '?utm_content=bad',
    canonical + '?utm_content=' + reference + '&extra=unexpected',
    canonical.replace('booking.example.test', 'user@booking.example.test') + '?utm_content=' + reference,
  ]) assert.equal(booking.validatedHandoffUrl(url, canonical), null);
});

test('withdrawal while a handoff response is pending falls back to the undecorated canonical URL', async () => {
  let allowed = true;
  let epoch = 0;
  const fakeConsent = {
    currentAnalyticsEpoch: () => epoch,
    analyticsReferenceAllowed: (expected = epoch) => allowed && expected === epoch,
    async refreshPurposeConsent() {},
  };
  const client = await loadTs('lib/hosted-booking-client.ts', {
    './consent-client': fakeConsent,
    './hosted-booking-core': hostedCore,
  });
  const canonical = hostedCore.buildHostedBookingUrl({ serviceId: 'fixture-service-01', placement: 'hero' });
  let beginFetch;
  let finishFetch;
  const fetchStarted = new Promise(resolve => { beginFetch = resolve; });
  const pendingResponse = new Promise(resolve => { finishFetch = resolve; });
  let sentBody;
  const navigation = client.resolveHostedNavigation({ serviceId: 'fixture-service-01', placement: 'hero' }, async (url, init) => {
    assert.equal(url, '/api/hosted-booking/handoff');
    sentBody = JSON.parse(init.body);
    beginFetch();
    return pendingResponse;
  });
  await fetchStarted;
  assert.deepEqual(sentBody, { serviceId: 'fixture-service-01', placement: 'hero' });
  allowed = false;
  epoch++;
  finishFetch({ ok: true, async json() { return { url: canonical + '&utm_content=app_ref_v1_' + 'e'.repeat(32) }; } });
  assert.equal(await navigation, canonical);
});

test('handoff never requests a reference when analytics is unavailable', async () => {
  const fakeConsent = {
    currentAnalyticsEpoch: () => 0,
    analyticsReferenceAllowed: () => false,
    async refreshPurposeConsent() {},
  };
  const client = await loadTs('lib/hosted-booking-client.ts', {
    './consent-client': fakeConsent,
    './hosted-booking-core': hostedCore,
  });
  let fetches = 0;
  const input = { placement: 'services' };
  const result = await client.resolveHostedNavigation(input, async () => { fetches++; throw new Error('must not request'); });
  assert.equal(result, hostedCore.buildHostedBookingUrl(input));
  assert.equal(fetches, 0);
});
