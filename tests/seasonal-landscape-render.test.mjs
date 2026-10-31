import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => readFile(path.join(root, relative), 'utf8');

test('generic public markup retains live business slots without source-demo seasonal artwork', async () => {
  const [home, template, artifact] = await Promise.all([
    read('app/page.tsx'), read('lib/public-template.tsx'), read('generated/public-artifacts.json'),
  ]);
  const publicSources = [home, template, artifact].join('\n');
  assert.match(template, /data-public-offerings="published"/);
  assert.match(template, /data-public-booking="navigation"/);
  assert.match(template, /data-public-island="inquiry"/);
  assert.match(template, /data-public-island="reviews"/);
  assert.match(template, /data-public-island="analytics"/);
  assert.match(template, /data-public-island="experiments"/);
  assert.match(template, /data-public-island="support"/);
  assert.match(home, /serviceOfferingStore\(\)\.publicOfferings\(\)/);
  assert.doesNotMatch(publicSources, /seasonal-landscape|data-public-island="seasonal"|Montana home and yard|Take good care\. Season after season\./i,
    'the unrelated, source-specific seasonal illustration is not part of the extracted public presentation');
  assert.doesNotMatch(publicSources, /Sprinkler Blowout|406-861-7757|Billings, Montana/i);
});
