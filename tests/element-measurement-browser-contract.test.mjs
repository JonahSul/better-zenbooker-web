import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const read = relative => readFile(path.join(root, relative), 'utf8');

async function loadTs(relative, overrides = {}) {
  const source = await read(relative);
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (Object.hasOwn(overrides, specifier)) return overrides[specifier];
    if (specifier === 'zod/v3' && Object.hasOwn(overrides, 'zod')) return overrides.zod;
    if (specifier === 'zod/v3') return require('zod/v3');
    throw new Error(`Unexpected ${relative} import: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const purpose = await loadTs('lib/purpose-consent-core.ts');
const proof = await loadTs('lib/consent-proof.ts', { './purpose-consent-core': purpose });
const core = await loadTs('lib/element-measurement-core.ts', { './consent-proof': proof });
const browser = await loadTs('lib/element-measurement-browser.ts', {
  './element-measurement-core': core,
  './element-measurement-client': { createElementObservationController: () => ({}) },
  './consent-client': {
    consentSnapshot: () => ({ analytics: false, analyticsSuppressed: false }),
    subscribePurposeConsent: () => () => {},
    currentAnalyticsEpoch: () => 0,
    analyticsReferenceAllowed: () => false,
    refreshPurposeConsent: async () => {},
  },
  './feedback-client': { documentFeedbackReference: () => null },
  './analytics-contract': { publicAnalyticsPath: route => ['/', '/privacy', '/terms'].includes(route) ? route : null },
});

test('navigation descriptor reader accepts one signed Server-Timing token and rejects ambiguity or other sources', () => {
  const token = `${Buffer.from(JSON.stringify({ route: '/contact' })).toString('base64url')}.signature`;
  assert.equal(browser.readNavigationElementDescriptor([{ serverTiming: [{ name: 'edge', description: 'ignored' }, { name: 'element_document', description: token }] }]), token);
  for (const entries of [
    [],
    [{ serverTiming: [] }],
    [{ serverTiming: [{ name: 'element_document', description: 'bad token' }] }],
    [{ serverTiming: [{ name: 'element_document', description: token }, { name: 'element_document', description: token }] }],
  ]) assert.equal(browser.readNavigationElementDescriptor(entries), null);
});

test('browser collection starts without DOM or consent and exposes no document header before registration', () => {
  assert.deepEqual(browser.measurementDocumentHeader(), {});
  assert.equal(typeof browser.startElementMeasurement(), 'function');
  assert.deepEqual(browser.measurementDocumentHeader(), {});
});

test('normal and cached public surfaces carry the same fixed registry targets and mount collection once', async () => {
  const sources = await Promise.all([
    read('app/page.tsx'), read('lib/public-template.tsx'), read('app/book/page.tsx'),
    read('app/appointments/page.tsx'), read('app/contact/page.tsx'), read('app/privacy/page.tsx'),
    read('app/terms/page.tsx'), read('components/contact-form.tsx'), read('components/inquiry-form.tsx'),
    read('components/customer-shell.tsx'), read('components/hosted-booking-panel.tsx'), read('lib/business-compiler.ts'),
    read('components/hosted-appointment-help.tsx'), read('components/offering-tiles.tsx'),
  ]);
  const combined = sources.join('\n');
  const missingTargets = [];
  for (const item of core.elementRegistry) {
    if (/^home_service_[1-4]$/.test(item.id)) {
      if (!/index<4\?' data-measurement-element="home_service_'/s.test(combined)) missingTargets.push(item.id);
    } else {
      if (!combined.includes(item.id)) missingTargets.push(item.id);
    }
  }
  assert.deepEqual(missingTargets, [], 'each fixed registry target must be emitted by a public render path');
  const layout = await read('app/layout.tsx');
  assert.match(layout, /<ElementMeasurement\s*\/>/);
  assert.equal((layout.match(/<ElementMeasurement\s*\/>/g) ?? []).length, 1);
  const cached = await read('client/public-islands.tsx');
  assert.equal((cached.match(/startElementMeasurement\(\)/g) ?? []).length, 1);
  assert.match(cached, /data-public-island=/);
});

test('measurement integration reads no page or form content and leaves the GTM allowlist separate', async () => {
  const source = await read('lib/element-measurement-browser.ts');
  assert.match(source, /performance\.getEntriesByType\(['"]navigation['"]\)/);
  assert.match(source, /serverTiming/);
  assert.match(source, /data-measurement-element/);
  assert.doesNotMatch(source, /document\.cookie|textContent|innerHTML|\.value\b|\.href\b/);
  assert.match(source, /publicAnalyticsPath\(location\.pathname\)/);
  for (const formPath of ['components/contact-form.tsx', 'components/inquiry-form.tsx']) {
    const form = await read(formPath);
    assert.match(form, /measurementDocumentHeader\(\)/, `${formPath} attaches an outcome reference only when one is active`);
  }
  const contract = await read('lib/analytics-contract.ts');
  assert.match(contract, /publicAnalyticsPaths=\[['"]\/['"],['"]\/privacy['"],['"]\/terms['"]\]/);
  assert.doesNotMatch(contract, /element_view|element_action/);
});

test('declarative GTM handoff pins nine bounded data variables and safe location overrides without widening routes', async () => {
  const manifest = await read('lib/element-gtm-manifest.ts');
  assert.match(manifest, /format:'declarative-configuration-not-importable'/);
  assert.match(manifest, /routes:\['\/','\/privacy','\/terms'\]/);
  assert.match(manifest, /eventNamePattern:'\^element_\(view\|action\)\$'/);
  assert.match(manifest, /dataLayerVariables:\['page_location','page_referrer','element_id','element_placement','element_route','snapshot_hash','asset_manifest_hash','renderer_version','registry_version'\]/);
  assert.match(manifest, /eventParameterOverrides:\{page_location:'\{\{DLV - page_location\}\}',page_referrer:'\{\{DLV - page_referrer\}\}'\}/);
  assert.match(manifest, /automaticUserProvidedData:false,automaticFormInteractions:false,historyPageViews:false,duplicatePageView:false/);
  assert.match(manifest, /ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied'/);
  assert.match(manifest, /eventScopedCustomDimensions:\['element_id','element_placement','element_route','renderer_version','registry_version'\]/);
});

