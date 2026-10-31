import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = async (relativePath) => readFile(path.join(root, relativePath), 'utf8');

test('public reviews frame is lazy, independent of Analytics, bounded, and fails back to the existing business link', async () => {
  const component = await source('components/trustindex-reviews.tsx');
  assert.match(component, /fetch\('\/api\/reviews\/widget-configuration',\{cache:'no-store'/);
  assert.match(component, /parseTrustindexPublicConfiguration/);
  assert.match(component, /trustindexFrameUrl/);
  assert.match(component, /sandbox="allow-scripts allow-popups"/);
  assert.doesNotMatch(component, /allow-same-origin|allow-forms|allow-top-navigation/);
  assert.match(component, /referrerPolicy="no-referrer"/);
  assert.match(component, /window\.setTimeout\(fail,12000\)/);
  assert.match(component, /visibilitychange/);
  assert.match(component, /window\.addEventListener\('focus'/);
  assert.match(component, /readAbort\?\.abort\(\)/);
  assert.match(component, /current\.current=null;setSession\(null\);setStatus\('disabled'\)/);
  assert.match(component, /Customer reviews could not be loaded/);
  assert.match(component, /chooseValidatedReviewsUrl/);
  assert.match(component, /reviewsUrl!==null&&/);
  assert.doesNotMatch(component, /https:\/\/demoblowout406\.com\//,
    'do not substitute the business homepage for an unavailable review profile');
  assert.match(component, /rel="noopener noreferrer">Read customer reviews/);
  assert.doesNotMatch(component, /AnalyticsConsent|ExperimentsConsent|analyticsSuppressed|containerId|GTM-|googletagmanager|cdn\.trustindex\.io/,
    'the public page does not gate functional reviews on Analytics or load the vendor script directly');
});

test('normal home and cached home hydrate the same Reviews component without embedding widget configuration', async () => {
  const [home, template, islands, wrapper] = await Promise.all([
    source('app/page.tsx'), source('lib/public-template.tsx'), source('client/public-islands.tsx'), source('components/reviews.tsx'),
  ]);
  assert.match(home, /<Reviews\s*\/>/);
  assert.match(template, /<div data-public-island="reviews"><\/div>/);
  assert.match(islands, /reviews:Reviews/);
  assert.match(wrapper, /import TrustindexReviews from '\.\/trustindex-reviews'/);
  assert.match(wrapper, /<TrustindexReviews\s*\/>/);
  for (const sharedHtml of [home, template]) {
    assert.doesNotMatch(sharedHtml, /FixtureBadge123|FixtureList456|NativeBadge987|NativeList654|cdn\.trustindex\.io|data-src=/,
      'generic public HTML contains neither widget IDs nor the vendor loader');
  }
});

test('owner reviews settings edit the two widget IDs without previewing or executing vendor code', async () => {
  const [panel, page, adminTools, nativeTools, callContract] = await Promise.all([
    source('components/trustindex-widget-configuration-panel.tsx'),
    source('app/admin/reviews/page.tsx'),
    source('lib/admin-tools.ts'),
    source('lib/site-mcp.ts'),
    source('lib/mcp-call-contract.ts'),
  ]);
  assert.match(page, /<TrustindexWidgetConfigurationPanel\s*\/>/);
  assert.match(panel, /\/api\/admin\/reviews\/widget-configuration/);
  assert.match(panel, /pattern="\[A-Za-z0-9\]\{1,128\}"/);
  assert.match(panel, /Clear and disable/);
  assert.match(panel, /type="url" value=\{reviewsUrl\}/);
  assert.match(panel, /reviewsUrl:disable\?null:reviewsUrl/);
  assert.match(panel, /does not verify the vendor widget or its review contents/);
  assert.doesNotMatch(panel, /<iframe|cdn\.trustindex\.io|data-src=/);
  assert.match(adminTools, /reviews\.widget_configuration_status/);
  assert.match(adminTools, /reviews\.widget_configuration_save/);
  assert.match(nativeTools, /trustindex_widget_configuration_status/);
  assert.match(nativeTools, /trustindex_widget_configuration_save/);
  assert.match(callContract, /trustindex_widget_configuration_status/);
  assert.match(callContract, /trustindex_widget_configuration_save/);
});
