import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowedPersistPath = path.join(root, '.wrangler', 'qa-disposable-d1');
const persistPath = process.env.QA_DISPOSABLE_D1_PATH ? path.resolve(process.env.QA_DISPOSABLE_D1_PATH) : '';
if (persistPath !== allowedPersistPath) throw new Error('Set QA_DISPOSABLE_D1_PATH to the dedicated .wrangler/qa-disposable-d1 fixture directory');
await mkdir(path.dirname(persistPath), {recursive: true});
try {
  if ((await lstat(persistPath)).isSymbolicLink()) throw new Error('Disposable D1 fixture path cannot be a symlink');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const raw = await readFile(path.join(root, '.dev.vars'), 'utf8');
const vars = Object.fromEntries(raw.split(/\r?\n/).filter(Boolean).map(line => {
  const split = line.indexOf('=');
  let value = line.slice(split + 1).trim();
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  return [line.slice(0, split), value];
}));
const { INSTALLATION_ID, PUBLIC_ORIGIN, ADMIN_GOOGLE_CLIENT_ID, ADMIN_GOOGLE_CLIENT_SECRET, OWNER_EMAILS } = vars;
const ownerEmail = 'owner@example.com';
if (!/^test-[a-z0-9-]+$/i.test(INSTALLATION_ID ?? '') || !/^http:\/\/localhost:\d+$/.test(PUBLIC_ORIGIN ?? '') || !ADMIN_GOOGLE_CLIENT_ID?.startsWith('local-fixture.') || !ADMIN_GOOGLE_CLIENT_SECRET || !(OWNER_EMAILS ?? '').split(',').includes(ownerEmail)) {
  throw new Error('Refusing to seed anything except the isolated synthetic local Worker fixture');
}
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const browserToken = 'a'.repeat(64);
const adminToken = 'b'.repeat(64);
const browserUser = `browser:${sha256(browserToken)}`;
const fingerprint = sha256(`admin-oidc:v1:${INSTALLATION_ID}:${ADMIN_GOOGLE_CLIENT_ID}:${ADMIN_GOOGLE_CLIENT_SECRET}`);
const now = Date.now();
const sql = `INSERT OR REPLACE INTO admin_sessions(session_hash,site_user_id,google_subject,email,config_fingerprint,expires_at,created_at) VALUES('${sha256(adminToken)}','${browserUser}','fixture-owner','${ownerEmail}','${fingerprint}',${now + 3600000},${now});`;
const wrangler = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
const child = spawnSync(process.execPath, [wrangler, 'd1', 'execute', 'DB', '--local', '--persist-to', persistPath, '--command', sql], { cwd: root, encoding: 'utf8', windowsHide: true });
if (child.status !== 0) throw new Error('Could not seed synthetic local admin session');
console.log('Seeded synthetic local owner session. Cookie values are fixed test-only fixtures; no provider calls were made.');
