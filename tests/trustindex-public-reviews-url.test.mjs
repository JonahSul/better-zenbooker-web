import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const inputBudget = await loadTs('lib/input-budget.ts');

async function loadTs(relativePath, mocks = {}) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
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
const urls = await loadTs('lib/public-reviews-url.ts', { './google-reviews-core': googleReviewsCore });

test('safe fallback accepts the prior approved Google Maps URL and only the exact Trustindex review path', () => {
  assert.equal(urls.safePublicReviewsUrl('https://maps.google.com/maps?cid=123'), 'https://maps.google.com/maps?cid=123');
  assert.equal(urls.safePublicReviewsUrl('https://www.trustindex.io/reviews/example.invalid'), 'https://www.trustindex.io/reviews/example.invalid');
  assert.equal(urls.safePublicReviewsUrl('https://www.trustindex.io/reviews/demo.example'), 'https://www.trustindex.io/reviews/demo.example');
});

test('fallback URL rejects credentials, nondefault ports, query/fragment and other host/path shapes', () => {
  for (const value of [
    'http://www.trustindex.io/reviews/example.invalid',
    'https://trustindex.io/reviews/example.invalid',
    'https://www.trustindex.io:444/reviews/example.invalid',
    'https://user:pass@www.trustindex.io/reviews/example.invalid',
    'https://www.trustindex.io/reviews/example.invalid?next=https://attacker.invalid',
    'https://www.trustindex.io/reviews/example.invalid#fragment',
    'https://www.trustindex.io/reviews/example.invalid/',
    'https://www.trustindex.io/reviews/example.invalid/extra',
    'https://www.trustindex.io/reviews/-invalid.example',
    'https://www.trustindex.io/reviews/example-.invalid',
    'https://www.trustindex.io/reviews/example..invalid',
    'https://www.trustindex.io/reviews/localhost',
    'https://www.trustindex.io/reviews/127.0.0.1',
    'javascript:alert(1)',
    '',
    null,
    12,
  ]) assert.equal(urls.safePublicReviewsUrl(value), null, String(value));
});
