import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(root, 'lib/discovery.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
const requireMock = (specifier) => {
  if (specifier === './site-config') {
    return { DEMO_ORIGIN: 'https://business.example.test' };
  }
  throw new Error(`Unexpected discovery contract import: ${specifier}`);
};
new Function('require', 'module', 'exports', compiled)(requireMock, module, module.exports);
const { discoveryConfig, pageMetadata, publicSitemap, homeStructuredData } = module.exports;

test('public discovery is conservative and publishes no business URLs by default', () => {
  assert.equal(discoveryConfig.sitemapEnabled, false);
  assert.equal(discoveryConfig.publicOrigin, '');
  assert.deepEqual(discoveryConfig.publicPaths, ['/', '/privacy']);
  const xml = publicSitemap();
  assert.match(xml, /<urlset\b/);
  assert.doesNotMatch(xml, /<loc>/i);
});

test('route metadata uses the configured installation origin and generic site identity', () => {
  const result = pageMetadata('/privacy', 'Privacy | Business website', 'How this business website handles data.');
  assert.equal(result.alternates.canonical, 'https://business.example.test/privacy');
  assert.equal(result.openGraph.url, result.alternates.canonical);
  assert.equal(result.openGraph.siteName, 'Business website');
});

test('structured metadata does not invent unverified organization, service, rating, or location facts', () => {
  assert.equal(homeStructuredData['@context'], 'https://schema.org');
  assert.equal(homeStructuredData['@type'], 'WebSite');
  assert.equal(homeStructuredData.name, 'Business website');
  assert.equal(homeStructuredData.url, 'https://business.example.test');
  assert.equal(homeStructuredData['@graph'], undefined);
  assert.doesNotMatch(JSON.stringify(homeStructuredData), /telephone|address|areaServed|aggregateRating|serviceType/i);
});
