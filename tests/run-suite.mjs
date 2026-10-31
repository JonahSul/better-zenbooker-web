import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDirectory = path.join(root, 'tests');
const selected = readdirSync(testDirectory)
  .filter(name => name.endsWith('.test.mjs'))
  .sort()
  .map(name => path.join(testDirectory, name));

if (selected.length === 0) throw new Error('No test files were discovered');
const result = spawnSync(process.execPath, ['--test', ...selected], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
