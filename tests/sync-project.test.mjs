import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('standalone Cloudflare extraction does not include the source Sites checkout sync helper', async () => {
  await assert.rejects(access(path.join(root, 'scripts/sync-project.mjs')));
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(Object.values(packageJson.scripts ?? {}).some(command => /sync-project/.test(command)), false);
});
