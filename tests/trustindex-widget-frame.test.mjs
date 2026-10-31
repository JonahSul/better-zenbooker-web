import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const badgeId = 'FixtureBadge123';
const listId = 'FixtureList456';
const generation = 'f1000000-0000-4000-8000-000000000001';
const reviewsUrl = 'https://www.trustindex.io/reviews/example.invalid';
const config = { revision: 7, enabled: true, badgeWidgetId: badgeId, listWidgetId: listId, reviewsUrl };
const inputBudget = await loadTs('lib/input-budget.ts');

async function loadTs(relativePath, mocks = {}) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (specifier === 'zod/v3') return require('zod/v3');
    if (Object.hasOwn(mocks, specifier)) return mocks[specifier];
    throw new Error(`Unexpected import in ${relativePath}: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const googleReviewsCore = await loadTs('lib/google-reviews-core.ts', {
  './input-budget': inputBudget,
  './encrypted-value': { encryptValue() {}, decryptValue() {} },
  './site-config': { DEMO_ORIGIN: 'https://example.invalid' },
});
const publicReviewsUrl = await loadTs('lib/public-reviews-url.ts', { './google-reviews-core': googleReviewsCore });
const frame = await loadTs('lib/trustindex-widget-frame.ts');
const client = await loadTs('lib/trustindex-widget-client.ts', { './public-reviews-url': publicReviewsUrl });

test('frame document contains both validated placeholders and one shared Trustindex loader', () => {
  const result = frame.buildTrustindexWidgetFrame(config, generation);
  assert.equal((result.html.match(/https:\/\/cdn\.trustindex\.io\/loader\.js(?!\?)/g) ?? []).length, 1);
  assert.equal((result.html.match(/data-src=/g) ?? []).length, 2);
  assert.ok(result.html.includes(badgeId));
  assert.ok(result.html.includes(listId));
  assert.ok(result.html.includes(generation));
  assert.equal(result.html.includes(reviewsUrl), false, 'the fallback URL is not sent into the vendor frame');
  assert.doesNotMatch(result.html, /GTM-|measurementId|authorization|identity|cookie/i);
});

test('frame CSP isolates vendor scripts and excludes same-origin, forms, frames and top navigation', () => {
  const { csp } = frame.buildTrustindexWidgetFrame(config, generation);
  assert.match(csp, /sandbox[^;]*allow-scripts[^;]*allow-popups/);
  assert.doesNotMatch(csp, /allow-same-origin|allow-forms|allow-top-navigation|allow-frames/);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-src 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.match(csp, /script-src[^;]*cdn\.trustindex\.io/);
  assert.match(csp, /connect-src[^;]*cdn\.trustindex\.io/);
  assert.match(csp, /style-src[^;]*cdn\.trustindex\.io/);
  assert.match(csp, /font-src[^;]*cdn\.trustindex\.io/);
  assert.match(csp, /img-src[^;]*lh3\.googleusercontent\.com/);
});

test('public configuration bridge is a strict safe DTO and fixed local frame URL', () => {
  const parsed = client.parseTrustindexPublicConfiguration(config);
  assert.deepEqual(parsed, config);
  assert.deepEqual(client.parseTrustindexPublicConfiguration({ revision: 0, enabled: false, badgeWidgetId: null, listWidgetId: null, reviewsUrl: null }), {
    revision: 0, enabled: false, badgeWidgetId: null, listWidgetId: null, reviewsUrl: null,
  });
  for (const invalid of [
    { ...config, source: 'native' },
    { ...config, email: 'private@example.invalid' },
    { ...config, revision: -1 },
    { ...config, badgeWidgetId: null },
    { ...config, listWidgetId: 'x'.repeat(129) },
    { ...config, reviewsUrl: 'javascript:alert(1)' },
    { revision: 1, enabled: false, badgeWidgetId: badgeId, listWidgetId: listId },
  ]) assert.equal(client.parseTrustindexPublicConfiguration(invalid), null);
  const url = client.trustindexFrameUrl(parsed, generation);
  const parsedUrl = new URL(url, 'https://site.invalid');
  assert.equal(parsedUrl.pathname, '/reviews/widget-frame');
  assert.deepEqual([...parsedUrl.searchParams.keys()].sort(), ['badgeWidgetId', 'generation', 'listWidgetId', 'revision']);
  assert.equal(parsedUrl.searchParams.get('revision'), '7');
  assert.equal(parsedUrl.searchParams.get('badgeWidgetId'), badgeId);
  assert.equal(parsedUrl.searchParams.get('listWidgetId'), listId);
  assert.equal(parsedUrl.searchParams.get('generation'), generation);
  assert.equal(parsedUrl.searchParams.has('reviewsUrl'), false, 'the browser passes the fallback URL only outside the frame');
});

test('bridge accepts only the current iframe source, generation, and fixed ready/error shape', () => {
  const expectedWindow = {};
  const ready = { type: 'trustindex-widget', generation, state: 'ready', height: 600 };
  assert.deepEqual(client.acceptTrustindexFrameMessage({ source: expectedWindow, data: ready }, expectedWindow, generation), { state: 'ready', height: 600 });
  assert.deepEqual(client.acceptTrustindexFrameMessage({ source: expectedWindow, data: { ...ready, state: 'error' } }, expectedWindow, generation), { state: 'error', height: 600 });
  for (const event of [
    { source: {}, data: ready },
    { source: expectedWindow, data: { ...ready, generation: 'f1000000-0000-4000-8000-000000000002' } },
    { source: expectedWindow, data: { ...ready, height: 159 } },
    { source: expectedWindow, data: { ...ready, height: 2401 } },
    { source: expectedWindow, data: { ...ready, command: 'navigate', url: 'https://attacker.invalid' } },
    { source: expectedWindow, data: { ...ready, state: 'html', content: '<script>' } },
  ]) assert.equal(client.acceptTrustindexFrameMessage(event, expectedWindow, generation), null);
});

test('fallback keeps the last validated link through read failure and clears only on successful null config', () => {
  const choose = client.chooseValidatedReviewsUrl;
  assert.equal(typeof choose, 'function', 'the component uses the production fallback-state helper');
  const validated = 'https://www.trustindex.io/reviews/example.invalid';
  assert.equal(choose(validated, { ok: false }), validated, 'a transient config-read failure retains a previously validated link');
  assert.equal(choose(validated, { ok: true, reviewsUrl: null }), null, 'a successful explicit null clears the old fallback');
  assert.equal(choose(null, { ok: false }), null, 'failure cannot invent a fallback when none was validated');
  assert.equal(choose('https://attacker.invalid/reviews', { ok: false }), null, 'only the prior validated URL may survive');
});

test('frame route requires exact current configuration and sends isolated no-index response headers', async () => {
  const { trustindexWidgetFrameRoute } = await loadTs('lib/trustindex-widget-frame-server.ts', {
    './trustindex-widget-frame': frame,
    './trustindex-widget-configuration-server': { trustindexWidgetConfigurationService: () => ({ status: async () => config }) },
  });
  const query = `revision=7&badgeWidgetId=${badgeId}&listWidgetId=${listId}&generation=${generation}`;
  const good = await trustindexWidgetFrameRoute(new Request(`https://site.invalid/reviews/widget-frame?${query}`));
  assert.equal(good.status, 200);
  assert.match(good.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.match(good.headers.get('x-robots-tag') ?? '', /noindex/i);
  assert.match(good.headers.get('cache-control') ?? '', /no-store/i);
  const html = await good.text();
  assert.ok(html.includes(badgeId) && html.includes(listId));
  for (const suffix of [
    `&extra=${encodeURIComponent('secret-sentinel')}`,
    '&revision=6',
    `&badgeWidgetId=${listId}`,
  ]) {
    const rejected = await trustindexWidgetFrameRoute(new Request(`https://site.invalid/reviews/widget-frame?${query}${suffix}`));
    assert.notEqual(rejected.status, 200);
    assert.equal((await rejected.text()).includes('secret-sentinel'), false);
  }
});
