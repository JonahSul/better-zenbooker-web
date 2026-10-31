import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

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

const purpose = await loadTs('lib/purpose-consent-core.ts', { zod: require('zod/v3') });
const analytics = await loadTs('lib/analytics-consent-core.ts', {
  zod: require('zod/v3'),
  './consent-proof': await loadTs('lib/consent-proof.ts', { './purpose-consent-core': purpose }),
});
const experiments = await loadTs('lib/experiment-consent-core.ts', {
  zod: require('zod/v3'),
  './consent-proof': await loadTs('lib/consent-proof.ts', { './purpose-consent-core': purpose }),
});

const key = Buffer.alloc(32, 0x43).toString('base64');
const now = Date.now();
const expiresAt = now + 7 * 24 * 60 * 60 * 1000;
const analyticsChoice = { grantId: 'a6a46bb6-e4ad-4a6d-9f8a-2f6399a75f3e', revision: 2, granted: true, expiresAt };
const experimentChoice = { subject: '5cc92c86-5ccd-4dc8-8a91-6bedb6d6bbda', revision: 7, granted: false, expiresAt };

test('analytics and experiment choices use distinct signed cookie names and domains', async () => {
  const analyticsCookie = await analytics.signAnalyticsConsent(analyticsChoice, key);
  const experimentCookie = await experiments.signExperimentChoice(experimentChoice, key);

  assert.equal(analytics.ANALYTICS_COOKIE, '__Host-analytics_consent');
  assert.deepEqual(await analytics.verifyAnalyticsConsent(analyticsCookie, key, now), analyticsChoice);
  assert.deepEqual(await experiments.verifyExperimentChoice(experimentCookie, key, now), experimentChoice);
  assert.equal(await analytics.verifyAnalyticsConsent(experimentCookie, key, now), null);
  assert.equal(await experiments.verifyExperimentChoice(analyticsCookie, key, now), null);
});

test('purpose choices reject tampering, unknown fields, invalid revisions, and expired or overlong grants', async () => {
  const signed = await analytics.signAnalyticsConsent(analyticsChoice, key);
  const [body, signature] = signed.split('.');
  const changed = `${body}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
  assert.equal(await analytics.verifyAnalyticsConsent(changed, key, now), null);
  assert.equal(await analytics.verifyAnalyticsConsent(signed, Buffer.alloc(32, 0x44).toString('base64'), now), null);
  assert.equal(await analytics.verifyAnalyticsConsent(signed, key, expiresAt), null);
  await assert.rejects(analytics.signAnalyticsConsent({ ...analyticsChoice, revision: 0 }, key));
  await assert.rejects(analytics.signAnalyticsConsent({ ...analyticsChoice, extra: 'not allowed' }, key));
  await assert.rejects(analytics.signAnalyticsConsent({ ...analyticsChoice, expiresAt: now + 31 * 86400000 }, key));

  await assert.rejects(experiments.signExperimentChoice({ ...experimentChoice, granted: 'yes' }, key));
  await assert.rejects(experiments.signExperimentChoice({ ...experimentChoice, revision: 0 }, key));
  await assert.rejects(experiments.signExperimentChoice({ ...experimentChoice, extra: true }, key));
});
