import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const read = (file) => readFile(path.join(root, file), 'utf8');
const menu = await read('components/admin-account-menu.tsx');
const connectedMenu = await read('components/connected-account-menu.tsx');
const accountMenu = await read('components/account-menu.tsx');
const login = await read('components/admin-login.tsx');
const shell = await read('components/admin-shell.tsx');
const runtime = await read('lib/support-runtime.ts');
const proxySource = await read('lib/support-proxy.ts');
const adminTools = await read('lib/admin-tools.ts');
const siteMcp = await read('lib/site-mcp.ts');

function loadSupportProxy() {
  const source = proxySource;
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  const z = require('zod/v3');
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (specifier === 'cloudflare:workers') return { env: {} };
    if (specifier === './module-config') return {
      assertAi: async () => { throw new Error('provider disabled in photo configuration fixture'); },
      assertModule: async () => { throw new Error('provider disabled in photo configuration fixture'); },
    };
    if (specifier === '../integrations/visitor-ai/worker') return { handleVisitorAi: async () => { throw new Error('unexpected provider call'); } };
    if (specifier === 'zod/v3') return z;
    if (specifier === './support-photo-core') return { validateUpload() {}, normalizedPhotoSchema: z.z.object({}), stripWebpMetadata: (value) => value, normalizeVisionResult: (value) => value, VISION_MODEL: 'fixed-photo-model' };
    if (specifier === './visitor-budget-core') return {};
    if (specifier === './support-schedule') return { SupportScheduleStore: class { async read() { return { status: 'not_recorded' }; } } };
    if (specifier === './encrypted-value') return { encryptValue: async () => '', decryptValue: async () => '', validEncryptionKey: () => false };
    if (specifier === '../integrations/zenbooker-bridge/core') return { capabilityVerifier: async () => '0'.repeat(64) };
    if (specifier === './support-store') return { SupportStore: class {} };
    if (specifier === './support-core') return {
      SUPPORT_MODEL: 'fixed-text-model', SUPPORT_PROXY_ORIGIN: 'https://visitor-proxy.invalid',
      normalizeSupportModelResult: (value) => value,
      supportConfigInput: z.z.object({ revision: z.z.number().int().positive(), enabled: z.z.boolean(), dailyModelCalls: z.z.number().int().min(1).max(100) }).strict(),
      requestKeySchema: z.z.string().min(16).max(80),
    };
    throw new Error(`Unexpected SupportProxy dependency: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports.SupportProxy;
}

function proxyFixture({ revision = 4, photoHealth = 'verified', storage = false, missing = false, race = false } = {}) {
  let row = missing ? null : {
    workspace_id: 'fixture-workspace', revision, credential_json: 'synthetic-ciphertext', verifier: 'synthetic-verifier',
    config_json: JSON.stringify({ enabled: false, dailyModelCalls: 100, health: 'not_checked', checkedAt: null, failures: 0, circuitUntil: 0, photoEnabled: false, photoHealth }),
  };
  const calls = { updates: 0, audits: 0, fetches: 0 };
  const store = {
    workspaceId: 'fixture-workspace', key: undefined, db: {}, now: () => 123456,
    statement(sql, ...args) {
      if (sql.startsWith('SELECT * FROM support_proxy_state')) return { first: async () => row && structuredClone(row) };
      if (sql.startsWith('UPDATE support_proxy_state SET revision=revision+1,config_json=?')) return { run: async () => {
        calls.updates++;
        if (race && row) row = { ...row, revision: row.revision + 1 };
        if (!row || row.revision !== args[3]) return { meta: { changes: 0 } };
        row = { ...row, revision: row.revision + 1, config_json: String(args[0]), updated_at: Number(args[1]) };
        return { meta: { changes: 1 } };
      } };
      throw new Error(`Unexpected SupportProxy SQL in test: ${sql}`);
    },
    async audit() { calls.audits++; },
  };
  const SupportProxy = loadSupportProxy();
  const proxy = new SupportProxy(store, undefined, async () => { calls.fetches++; throw new Error('no provider calls allowed'); }, () => storage);
  return { proxy, calls, readRow: () => row && structuredClone(row) };
}

test('admin account entry delegates to the shared verified account controller without embedded credentials', async () => {
  assert.match(menu, /ConnectedAccountMenu/);
  assert.match(menu, /explicitAdminEntry=\{!!onSignIn\}/);
  assert.match(menu, /onAdminSignIn=\{onSignIn\}/);
  assert.match(connectedMenu, /AccountMenu/);
  assert.match(accountMenu, /admin\.email/);
  assert.match(accountMenu, /Sign out of administration/);
  assert.doesNotMatch(menu + login, /GoogleIdentityServices|accounts\.google\.com\/gsi|client_id|client_secret|redirect_uri|SITE_OWNER_USER_ID|allowedAdminEmail|Business Profile|measurementId/i);
  assert.match(login, /fetch\('\/api\/admin\/auth\/status'/);
  assert.match(login, /fetch\('\/api\/admin\/auth\/connect'/);
  assert.match(login, /adminOutcomeMessage\(/, 'existing OAuth outcomes continue through the generic safe message mapper');
  assert.match(shell, /<AdminAccountMenu email=\{email\}\/?>/);
});

test('every protected admin page passes the server-verified Google email to the shared account menu', async () => {
  const files = ['app/admin/analysis/page.tsx', 'app/admin/audit/page.tsx', 'app/admin/chat/page.tsx', 'app/admin/experiments/page.tsx', 'app/admin/inquiries/page.tsx', 'app/admin/memory/page.tsx', 'app/admin/performance/page.tsx', 'app/admin/settings/page.tsx', 'app/admin/support/page.tsx', 'app/admin/reviews/page.tsx'];
  for (const file of files) {
    const source = await read(file);
    assert.match(source, /const admin=await getGoogleAdmin\(\)/, `${file} must obtain the verified admin server-side`);
    assert.match(source, /<AdminShell[^>]*email=\{admin\.email\}/, `${file} must pass only the verified email to the shared menu`);
  }
  assert.match(await read('app/manage/google-reviews/page.tsx'), /redirect\('\/admin\/reviews'\)/, 'the legacy route delegates to the protected reviews page');
  const landing = await read('app/admin/page.tsx');
  assert.match(landing, /admin\?<AdminShell section="" email=\{admin\.email\}/);
});

test('photo configuration is revision checked and cannot enable without storage and verified health', async (t) => {
  assert.match(runtime, /new SupportProxy\(supportStore\(runtime\),'https:\/\/internal\.invalid',fetch,\(\)=>!!runtime\.BUCKET,runtime\)/);
  assert.match(proxySource, /enabled&&\(!this\.storageAvailable\(\)\|\|config\.photoHealth!=='verified'\)/);
  assert.match(proxySource, /WHERE workspace_id=\? AND revision=\?/);
  assert.match(adminTools, /'support\.photo_configure':tool\(z\.object\(\{revision:z\.number\(\)\.int\(\)\.positive\(\),enabled:z\.boolean\(\)\}\)\.strict\(\),async\(admin,args\)=>\{return supportProxy\(\)\.configurePhotos\(args\.revision,args\.enabled,admin\.subject\);\}\)/);
  const toolIndex = siteMcp.indexOf("name:'visitor_assistant_photo_configure'");
  assert.ok(toolIndex >= 0);
  assert.match(siteMcp.slice(toolIndex, toolIndex + 350), /revision:\{type:'integer',minimum:1\},enabled:\{type:'boolean'\}.*additionalProperties:false/);
  const dispatch = siteMcp.indexOf("call.data.name==='visitor_assistant_photo_configure'");
  assert.match(siteMcp, /visitor_assistant_photo_configure":"support\.photo_configure"/);
  assert.match(siteMcp, /MCP_OWNER_EMAIL\|\|!runtime\.MCP_OWNER_SUBJECT\|\|!allowedAdminEmail\(runtime\.MCP_OWNER_EMAIL,true\)/, 'machine MCP requires a configured admin identity');
  assert.match(siteMcp.slice(dispatch, dispatch + 250), /configurePhotos\(call\.data\.arguments\.revision,call\.data\.arguments\.enabled,actor\)/);

  await t.test('missing proxy state and stale revision reject without a write', async () => {
    const missing = proxyFixture({ missing: true });
    await assert.rejects(missing.proxy.configurePhotos(4, true, 'fixture-owner'));
    assert.equal(missing.calls.updates, 0);
    const stale = proxyFixture({ revision: 5 });
    await assert.rejects(stale.proxy.configurePhotos(4, true, 'fixture-owner'));
    assert.equal(stale.calls.updates, 0);
  });
  await t.test('enable requires both actual storage availability and verified photo health', async () => {
    const noStorage = proxyFixture({ storage: false, photoHealth: 'verified' });
    await assert.rejects(noStorage.proxy.configurePhotos(4, true, 'fixture-owner'));
    assert.equal(noStorage.calls.updates, 0);
    const noHealth = proxyFixture({ storage: true, photoHealth: 'not_checked' });
    await assert.rejects(noHealth.proxy.configurePhotos(4, true, 'fixture-owner'));
    assert.equal(noHealth.calls.updates, 0);
  });
  await t.test('disable remains available without storage, and enabled state uses revision CAS/audit without a provider fetch', async () => {
    const disable = proxyFixture({ storage: false, photoHealth: 'unavailable' });
    const disabled = await disable.proxy.configurePhotos(4, false, 'fixture-owner');
    assert.equal(disabled.photoEnabled, false);
    assert.equal(disable.calls.updates, 1);
    assert.equal(disable.calls.audits, 1);
    const enabled = proxyFixture({ storage: true, photoHealth: 'verified' });
    const status = await enabled.proxy.configurePhotos(4, true, 'fixture-owner');
    assert.equal(status.photoEnabled, true);
    assert.equal(status.revision, 5);
    assert.equal(enabled.calls.updates, 1);
    assert.equal(enabled.calls.audits, 1);
    assert.equal(enabled.calls.fetches, 0);
    const race = proxyFixture({ storage: true, photoHealth: 'verified', race: true });
    await assert.rejects(race.proxy.configurePhotos(4, true, 'fixture-owner'));
    assert.equal(race.calls.updates, 1);
    assert.equal(race.calls.audits, 0);
  });
});
