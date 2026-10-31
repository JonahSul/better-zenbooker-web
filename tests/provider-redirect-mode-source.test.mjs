import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('server-side provider requests use supported manual redirect handling and reject redirects by status', async () => {
  const files = [
    ['lib/admin-auth-core.ts', 1],
    ['lib/google-reviews-core.ts', 2],
    ['lib/measurement-core.ts', 1],
    ['lib/provider-adapters.ts', 1],
  ];
  for (const [file, expectedManualCalls] of files) {
    const source = await readFile(path.join(root, file), 'utf8');
    assert.doesNotMatch(source, /redirect\s*:\s*['"]error['"]/, `${file} must not construct unsupported redirect:error requests`);
    assert.equal((source.match(/redirect\s*:\s*['"]manual['"]/g) ?? []).length, expectedManualCalls, `${file} should explicitly use manual mode at each outbound provider fetch`);
  }
});
