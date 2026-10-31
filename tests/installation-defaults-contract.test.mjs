import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFile(path.join(root, file), 'utf8');

test('public/admin defaults do not carry the source business identity or assets', async () => {
  const files = [
    'app/page.tsx', 'app/layout.tsx', 'app/setup/business/page.tsx',
    'components/admin-shell.tsx', 'components/admin-navigation.tsx',
    'lib/business-site.ts', 'lib/site-config.ts', 'lib/public-compiler.ts',
  ];
  const contents = await Promise.all(files.map(read));
  const runtime = contents.join('\n');
  for (const retired of [
    'Sprinkler Blowout 406', 'sprinklerblowout406.com', 'jonahsullivan.com',
    'jonahsull.chatgpt.site', '+1-406-861-7757', '/brand/sprinkler-',
  ]) assert.doesNotMatch(runtime, new RegExp(retired.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  assert.match(await read('app/setup/business/page.tsx'), /name.*description.*phone.*email.*area/s,
    'business facts are entered in owner setup rather than supplied from a prior deployment');
});

test('onboarding offers manual source text and treats its HTTPS URL as provenance only', async () => {
  const setup = await read('app/setup/business/page.tsx');
  const service = await read('lib/business-site.ts');
  assert.match(setup, /name="sourceText"/);
  assert.match(setup, /does not fetch the page/i);
  assert.match(service, /publicUrl\(source\.url\)/);
  assert.doesNotMatch(service, /fetch\s*\(/, 'the current source URL flow must not make network requests');
});

test('owner setup default business facts and service vocabulary are not fixed to source geography or vertical', async () => {
  const setup = await read('app/setup/business/page.tsx');
  const inquiry = await read('lib/inquiry-validation.ts');
  const dates = await read('lib/dates.ts');
  const support = await read('lib/support-grounding.ts');
  assert.doesNotMatch(setup + inquiry + dates, /Heights|Billings|Lockwood|Montana|America\/Denver/i);
  assert.doesNotMatch(inquiry, /fall-blowout|spring-turn-up|fall blowout|spring turn-up/i);
  assert.match(inquiry, /business|offering|service/i);
  assert.doesNotMatch(support, /sprinkler|irrigation|winteriz|blow.?out/i,
    'support safety policy must not assume the original vertical');
});
