import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { enabledModuleFixture } from './fixtures/module-config-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { env: providerEnv, moduleConfig: providerModuleConfig } = enabledModuleFixture('ai', 'admin_chat', 'vectorize', 'analytics', 'google', 'search');
const requireFromTest = createRequire(import.meta.url);
const cache = new Map();

async function loadTs(relative, overrides = {}) {
  if (cache.has(relative)) return cache.get(relative);
  const source = await readFile(path.join(root, relative), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  const ownRequire = (specifier) => {
    if (Object.hasOwn(overrides, specifier)) return overrides[specifier];
    if (specifier === 'zod/v3' && Object.hasOwn(overrides, 'zod')) return overrides.zod;
    if (specifier === 'zod/v3') return requireFromTest(specifier);
    throw new Error(`Unexpected ${relative} import: ${specifier}`);
  };
  new Function('require', 'module', 'exports', js)(ownRequire, loaded, loaded.exports);
  cache.set(relative, loaded.exports);
  return loaded.exports;
}

const experiments = await loadTs('lib/experiment-core.ts');
const sourceBinding = await loadTs('lib/analytics-source-binding.ts');
const analysis = await loadTs('lib/analysis-core.ts', { './experiment-core': experiments, './analytics-source-binding': sourceBinding });
const inputBudget = await loadTs('lib/input-budget.ts');
const providers = await loadTs('lib/provider-adapters.ts', {
  './analysis-core': analysis,
  './input-budget': inputBudget,
  'cloudflare:workers': { env: providerEnv },
  './module-config': providerModuleConfig,
});
const measurement = await loadTs('lib/measurement-core.ts', {
  './analysis-core': analysis,
  './provider-adapters': providers,
});

const event = {
  name: 'experiment_conversion',
  eventId: 'a'.repeat(64),
  versionId: 'b5b92dc2-0278-4ead-9132-4776a9666421',
  composition: 'A',
  stage: 'demo',
};

test('only a real, consented-format _ga identifier is accepted; no identifier is synthesized', () => {
  assert.equal(measurement.gaClientId('_ga=GA1.1.123456.987654; other=x'), '123456.987654');
  assert.equal(measurement.gaClientId('other=x; _ga=GA2.2.1.2'), '1.2');
  for (const value of [null, '', '_ga=not-google', '_ga=GA1.1.123', '_ga=GA1.1.123.456.789', '_ga=GA1.1.email@example.com.12']) {
    assert.equal(measurement.gaClientId(value), null);
  }
});

test('measurement payload is a fixed allowlist and never invents session or engagement fields', () => {
  const parsed = measurement.measurementInput.parse(event);
  const payload = measurement.measurementPayload(parsed, '123456.987654', false);
  assert.deepEqual(payload, {
    client_id: '123456.987654',
    consent: { ad_user_data: 'DENIED', ad_personalization: 'DENIED' },
    events: [{ name: 'experiment_conversion', params: {
      experiment_version: event.versionId,
      composition: 'A', traffic_stage: 'demo', event_id: 'a'.repeat(64),
    } }],
  });
  assert.doesNotMatch(JSON.stringify(payload), /session_id|engagement_time_msec|email|phone|contact|referrer|url|subject/i);
  assert.equal(measurement.measurementPayload(parsed, '123456.987654', true).events[0].params.traffic_stage, 'demo_test');

  const feedback = measurement.measurementInput.parse({
    ...event, name: 'experiment_feedback', section: 'reviews', vote: 'helpful',
  });
  assert.deepEqual(measurement.measurementPayload(feedback, '123456.987654', false).events[0].params, {
    experiment_version: event.versionId, composition: 'A', traffic_stage: 'demo', event_id: 'a'.repeat(64), section: 'reviews', vote: 'helpful',
  });
  assert.equal(measurement.measurementInput.safeParse({ ...event, email: 'person@example.com' }).success, false);
  assert.equal(measurement.measurementInput.safeParse({ ...event, session_id: 'invented' }).success, false);
});

test('debug endpoint validates-only and production 204 is reported as transport accepted, never verified ingestion', async () => {
  let observed;
  const validDebug = await measurement.sendMeasurement('G-S4J27S9VMH', 'fixture-secret', event, '123456.987654', true, false, async (url, init) => {
    observed = { url: new URL(url), init, body: JSON.parse(init.body) };
    return Response.json({ validationMessages: [] });
  });
  assert.deepEqual(validDebug, { status: 'validated_only', ingestionVerified: false });
  assert.equal(observed.url.origin + observed.url.pathname, 'https://www.google-analytics.com/debug/mp/collect');
  assert.equal(observed.url.searchParams.get('measurement_id'), 'G-S4J27S9VMH');
  assert.equal(observed.url.searchParams.get('api_secret'), 'fixture-secret');
  assert.equal(observed.init.redirect, 'manual');
  assert.equal(observed.init.headers.Authorization, undefined);
  assert.equal(JSON.stringify(observed.body).includes('fixture-secret'), false);

  let productionUrl;
  let productionInit;
  const transport = await measurement.sendMeasurement('G-S4J27S9VMH', 'fixture-secret', event, '123456.987654', false, false, async (url, init) => {
    productionUrl = String(url);
    productionInit = init;
    return new Response(null, { status: 204 });
  });
  assert.deepEqual(transport, { status: 'transport_accepted', ingestionVerified: false });
  assert.match(productionUrl, /^https:\/\/www\.google-analytics\.com\/mp\/collect\?/);
  assert.equal(productionInit.redirect, 'manual');
});

test('Measurement Protocol redirects are rejected after one manual request', async () => {
  const requests = [];
  const result = await measurement.sendMeasurement('G-S4J27S9VMH', 'fixture-secret', event, '123456.987654', false, false, async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(null, { status: 302, headers: { Location: 'https://redirect-target.invalid/collect?api_secret=must-not-follow' } });
  }).then(() => null, error => error);
  assert.equal(result.errorClass, 'transient');
  assert.equal(result.ambiguous, true);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /^https:\/\/www\.google-analytics\.com\/mp\/collect\?/);
  assert.equal(requests[0].init.redirect, 'manual');
  assert.doesNotMatch(JSON.stringify(requests[0].init), /redirect-target|must-not-follow/);
});

test('debug validation messages and provider errors remain non-sensitive and distinguish ambiguous delivery', async () => {
  await assert.rejects(measurement.sendMeasurement('G-S4J27S9VMH', 'fixture-secret', event, '123456.987654', true, false, async () => Response.json({ validationMessages: [{ message: 'invalid field' }] })), error => error.errorClass === 'schema');
  await assert.rejects(measurement.sendMeasurement('G-S4J27S9VMH', 'fixture-secret', event, '123456.987654', false, false, async () => new Response('secret=private response', { status: 503 })), error => {
    assert.equal(error.errorClass, 'transient');
    assert.equal(error.ambiguous, true);
    assert.doesNotMatch(error.message, /private response/);
    return true;
  });
  await assert.rejects(measurement.sendMeasurement('not-a-measurement', 'fixture-secret', event, '123456.987654', false, false, async () => { throw new Error('unexpected'); }), error => error.errorClass === 'configuration');
  await assert.rejects(measurement.sendMeasurement('G-S4J27S9VMH', 'fixture-secret', event, 'bad-client-id', false, false, async () => { throw new Error('unexpected'); }), error => error.errorClass === 'configuration');
});
