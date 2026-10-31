import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const keys = [
  'ADMIN_GOOGLE_CLIENT_SECRET', 'GOOGLE_BUSINESS_CLIENT_SECRET', 'GA4_MP_API_SECRET',
  'WORKERS_AI_API_TOKEN', 'VECTORIZE_API_TOKEN', 'ZENBOOKER_API_KEY', 'CLOUDFLARE_EMAIL_API_TOKEN',
];
let currentUser = { userId: 'owner-fixture' };
let currentAdmin = null;
let sealedAt = null;
const credentialServer = await (async () => {
  const source = await readFile(path.join(root, 'lib/credential-server.ts'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (specifier === 'zod/v3') return require('zod/v3');
    if (specifier === './credential-store') return { credentialKeys: keys };
    if (specifier === '../app/chatgpt-auth') return { getChatGPTUser: async () => currentUser };
    if (specifier === './admin-auth-server') return { getGoogleAdmin: async () => currentAdmin };
    if (specifier === './runtime-secrets') return {
      secretRuntime: () => ({ SITE_OWNER_USER_ID: 'owner-fixture' }),
      credentialStore: () => ({ state: async () => ({ sealed_at: sealedAt }) }),
    };
    if (specifier === './encrypted-value') return { validEncryptionKey: () => true };
    if (specifier === './admin-auth-core') return { sha256: async () => 'fixture-hash' };
    throw new Error(`Unexpected credential server import: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
})();

test('legacy credential GET destination preserves only an allowlisted purpose', () => {
  assert.equal(credentialServer.credentialDestination('ZENBOOKER_API_KEY'), '/admin/credentials?purpose=ZENBOOKER_API_KEY');
  assert.equal(credentialServer.credentialDestination('ADMIN_GOOGLE_CLIENT_SECRET'), '/admin/credentials?purpose=ADMIN_GOOGLE_CLIENT_SECRET');
  for (const value of ['next=https://attacker.invalid', '../admin', 'unknown', null, ['ZENBOOKER_API_KEY']]) {
    assert.equal(credentialServer.credentialDestination(value), '/admin/credentials');
  }
});

test('credential page access requires the separately verified Google owner session', async () => {
  currentUser = { userId: 'not-owner' };
  currentAdmin = null;
  sealedAt = null;
  assert.deepEqual(await credentialServer.credentialPageAccess(), { allowed: false, admin: null, bootstrapOnly: false });

  currentUser = { userId: 'owner-fixture' };
  assert.deepEqual(await credentialServer.credentialPageAccess(), { allowed: false, admin: null, bootstrapOnly: false },
    'a first-party visitor or installer identity cannot claim credential administration');

  sealedAt = 123;
  assert.deepEqual(await credentialServer.credentialPageAccess(), { allowed: false, admin: null, bootstrapOnly: false });

  currentAdmin = { email: 'owner@example.invalid', subject: 'verified-google-subject' };
  assert.deepEqual(await credentialServer.credentialPageAccess(), { allowed: true, admin: currentAdmin, bootstrapOnly: false });
});

test('canonical credential pages, API aliases, and domain cards use native same-origin links and guarded handlers', async () => {
  const [shell, navigation, credentialPage, oldPage, oldApi, canonicalApi, setup, dialog, dialogPrimitive] = await Promise.all([
    readFile(path.join(root, 'components/admin-shell.tsx'), 'utf8'),
    readFile(path.join(root, 'components/admin-navigation.tsx'), 'utf8'),
    readFile(path.join(root, 'app/admin/credentials/page.tsx'), 'utf8'),
    readFile(path.join(root, 'app/setup/credentials/page.tsx'), 'utf8'),
    readFile(path.join(root, 'app/api/setup/credentials/route.ts'), 'utf8'),
    readFile(path.join(root, 'app/api/admin/credentials/route.ts'), 'utf8'),
    readFile(path.join(root, 'components/credential-setup.tsx'), 'utf8'),
    readFile(path.join(root, 'components/credential-dialog.tsx'), 'utf8'),
    readFile(path.join(root, 'components/ui/dialog.tsx'), 'utf8'),
  ]);

  assert.match(navigation, /href=\{'\/admin'\+\(path\?'/);
  assert.match(navigation, /\['credentials','Credentials',[^\]]*,'Workspace'\]/);
  assert.match(navigation, /\['reviews','Reviews',[^\]]*,'Operations'\]/);
  assert.match(navigation, /\['bookings','Bookings',[^\]]*,'Operations'\]/);
  assert.match(shell, /<AdminNavigation section=\{section\} className="console-desktop-navigation"\s*\/>/);
  assert.match(credentialPage, /credentialPageAccess\(\)/);
  assert.match(credentialPage, /<AdminShell section="credentials"/);
  assert.match(oldPage, /redirect\(credentialDestination\(/);
  assert.doesNotMatch(oldPage, /CredentialSetup|<input|type=["']password/);
  assert.match(oldApi, /export async function GET\(request:Request\)\{return credentialRoute\(request\);\}/);
  assert.match(oldApi, /export async function POST\(request:Request\)\{return credentialRoute\(request\);\}/);
  assert.match(canonicalApi, /export const GET=credentialRoute/);
  assert.match(canonicalApi, /export const POST=credentialRoute/);
  assert.match(setup, /<CredentialDialog[^]*onSaved=\{\(\)=>void refresh\(\)\}/);
  assert.match(setup, /credentialPurposes\.filter\(\(\[key\]\)=>!status\.bootstrapOnly\|\|key==='ADMIN_GOOGLE_CLIENT_SECRET'\)/);

  assert.match(dialog, /<Dialog open=\{open\} onOpenChange=\{changeOpen\}/);
  assert.match(dialog, /form\.current\?\.reset\(\);setMessage\(''\);setOpen\(value\)/);
  assert.match(dialog, /element\.reset\(\);setBusy\(true\)/);
  assert.match(dialog, /finally\{setBusy\(false\);element\.reset\(\);\}/);
  assert.match(dialog, /type="password"[^>]*name="secret"/);
  assert.match(dialog, /<label>New key · required/);
  assert.match(dialog, /role="status" aria-live="polite"/);
  assert.match(dialog, /Keys stay private and cannot be displayed after saving/);
  assert.doesNotMatch(dialog, /localStorage|sessionStorage|console\.log\(|secret\s*:\s*\{[^}]*value/);
  assert.match(dialogPrimitive, /DialogPrimitive\.Content/);
  assert.match(dialogPrimitive, /DialogPrimitive\.Close/);
  assert.match(dialogPrimitive, /data-slot="dialog-close"/);
});

test('Administration links use canonical domain pages while legacy Google Reviews remains a safe GET redirect', async () => {
  const navigation = await readFile(path.join(root, 'components/admin-navigation.tsx'), 'utf8');
  const shell = await readFile(path.join(root, 'components/admin-shell.tsx'), 'utf8');
  assert.doesNotMatch(shell, /from ['"]next\/link['"]/);
  for (const [slug, label] of [
    ['bookings', 'Bookings'], ['reviews', 'Reviews'], ['experiments', 'Experiments'],
    ['analytics', 'Analytics'], ['performance', 'Performance'], ['analysis', 'Analysis'],
    ['support', 'Support'], ['memory', 'Memory'], ['credentials', 'Credentials'], ['settings', 'Settings'],
  ]) {
    assert.ok(navigation.includes(`['${slug}','${label}'`), `native Administration menu contains ${label}`);
    const page = await readFile(path.join(root, `app/admin/${slug}/page.tsx`), 'utf8');
    assert.match(page, new RegExp(`<AdminShell section="${slug}"`), `${slug} has its own domain pane`);
  }
  const legacyReviewsPage = await readFile(path.join(root, 'app/manage/google-reviews/page.tsx'), 'utf8');
  assert.match(legacyReviewsPage, /redirect\('\/admin\/reviews'\)/);
  assert.doesNotMatch(legacyReviewsPage, /GoogleReviewsManage|<form|<input/);
});

