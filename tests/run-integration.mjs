import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.QA_WORKER_BASE_URL ?? 'http://localhost:5178';
if (!['localhost', '127.0.0.1', '::1'].includes(new URL(base).hostname)) {
  throw new Error('Integration suite only accepts a local loopback Worker fixture');
}
const noProviderBase = process.env.QA_BASE_WORKER_BASE_URL;
if (noProviderBase && !['localhost', '127.0.0.1', '::1'].includes(new URL(noProviderBase).hostname)) {
  throw new Error('No-provider acceptance only accepts a local loopback Worker fixture');
}
const persistPath = path.join(root, '.wrangler', 'qa-disposable-d1');
if (process.env.QA_DISPOSABLE_D1_PATH && path.resolve(process.env.QA_DISPOSABLE_D1_PATH) !== persistPath) {
  throw new Error('QA_DISPOSABLE_D1_PATH must name this checkout’s dedicated disposable D1 directory');
}
const environment = {
  ...process.env,
  QA_WORKER_BASE_URL: base,
  QA_DISPOSABLE_D1_PATH: persistPath,
  QA_ENABLE_BRIDGE_INTEGRATION: '1',
  QA_ENABLE_MCP_INTEGRATION: '1',
};
const seeded = spawnSync(process.execPath, [path.join(root, 'tests/seed-local-owner.mjs')], {cwd: root, env: environment, stdio: 'inherit', windowsHide: true});
if (seeded.error) throw seeded.error;
if (seeded.status !== 0) throw new Error('Synthetic local owner seeding failed');
const result = spawnSync(process.execPath, [
  '--test', '--test-concurrency=1', '--test-timeout=60000',
  path.join(root, 'tests/worker-http-runtime.test.mjs'),
  path.join(root, 'tests/hosted-bridge-worker.integration.test.mjs'),
  path.join(root, 'tests/mcp-machine-approval.integration.test.mjs'),
  path.join(root, 'tests/no-provider-worker.integration.test.mjs'),
], {cwd: root, env: environment, stdio: 'inherit', windowsHide: true});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
