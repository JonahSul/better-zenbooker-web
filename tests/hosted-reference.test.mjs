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

const hosted = await loadTs('lib/hosted-booking-core.ts', { zod: require('zod/v3') });
const references = await loadTs('lib/hosted-reference.ts', { './hosted-booking-core': hosted });

test('reference is random, fixed-prefix and 128-bit lowercase hex', () => {
  const first = references.freshHostedReference();
  const second = references.freshHostedReference();
  assert.match(first, /^app_ref_v1_[0-9a-f]{32}$/);
  assert.match(second, /^app_ref_v1_[0-9a-f]{32}$/);
  assert.notEqual(first, second);
});

test('optional reference appends without rewriting existing campaign or preselection bytes', () => {
  const canonical = `${hosted.HOSTED_BOOKING_URL}?preselected-service=fixture-service-01&campaign=a%2Fb%20c&empty=`;
  const reference = 'app_ref_v1_' + 'a'.repeat(32);
  const appended = references.appendHostedReference(canonical, reference);
  assert.deepEqual(appended, { url: canonical + '&utm_content=' + reference, referenceIncluded: true });
  assert.equal(new URL(appended.url).searchParams.get('preselected-service'), 'fixture-service-01');
});

test('no reference and any occupied utm_content preserve the canonical URL exactly', () => {
  const canonical = `${hosted.HOSTED_BOOKING_URL}?preselected-service=fixture-service-01&campaign=x%2Fy`;
  const reference = 'app_ref_v1_' + 'b'.repeat(32);
  assert.deepEqual(references.appendHostedReference(canonical, null), { url: canonical, referenceIncluded: false });
  for (const existing of ['utm_content=', 'utm_content=campaign%20tag', 'UTM_CONTENT=occupied']) {
    const occupied = canonical + '&' + existing;
    assert.deepEqual(references.appendHostedReference(occupied, reference), { url: occupied, referenceIncluded: false });
  }
  const similarlyNamed = canonical + '&utm_content_extra=keep';
  assert.deepEqual(references.appendHostedReference(similarlyNamed, reference), {
    url: similarlyNamed + '&utm_content=' + reference,
    referenceIncluded: true,
  });
});

test('reference helper fails closed for altered destinations and never emits a malformed reference', () => {
  const canonical = hosted.HOSTED_BOOKING_URL;
  const changed = new URL(canonical); changed.pathname += '/other';
  for (const destination of [
    'https://attacker.invalid/book/demoblowoutguttercleaning',
    changed.href,
    canonical.replace('booking.example.test', 'user@booking.example.test'),
    canonical + '#fragment',
  ]) assert.throws(() => references.appendHostedReference(destination, 'app_ref_v1_' + 'c'.repeat(32)));
  const invalid = references.appendHostedReference(canonical, 'customer@example.invalid');
  assert.deepEqual(invalid, { url: canonical, referenceIncluded: false });
});
