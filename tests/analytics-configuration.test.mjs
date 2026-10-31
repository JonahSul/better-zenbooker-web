import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

async function loadTs(relativePath, mocks = {}) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (specifier === 'zod/v3') return require('zod/v3');
    if (Object.hasOwn(mocks, specifier)) return mocks[specifier];
    throw new Error(`Unexpected import in ${relativePath}: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

class MemoryD1 {
  row = null;
  audits = [];
  reads = 0;
  writes = 0;
  async batch(statements) {
    const previousRow=this.row&&{...this.row},previousAudits=this.audits.slice();
    try { return await Promise.all(statements.map(statement=>statement.run())); }
    catch(error){this.row=previousRow;this.audits=previousAudits;throw error;}
  }
  prepare(sql) {
    const db = this;
    let values = [];
    return {
      bind(...bound) { values = bound; return this; },
      async first() { db.reads++; return db.row ? { ...db.row } : null; },
      async run() {
        db.writes++;
        if(sql.startsWith('INSERT INTO admin_audit')){
          const [id,actor,target,createdAt,workspace,subject,key,revision,writeToken]=values;
          const current=db.row?JSON.parse(db.row.value_json):null;
          const matches=db.row&&db.row.workspace_id===workspace&&db.row.google_subject===subject&&db.row.key===key&&db.row.revision===revision&&current?.writeToken===writeToken;
          if(!matches)return {meta:{changes:0}};
          db.audits.push({id,google_subject:actor,action:'analytics.configuration_save',target,created_at:createdAt});
          return {meta:{changes:1}};
        }
        const [workspace, subject, key, valueJson, updatedAt, expectedForInsert, expectedWorkspace, expectedSubject, expectedKey, expectedInSelect, expectedForUpdate] = values;
        assert.match(sql, /^INSERT INTO admin_settings/);
        assert.equal(workspace, 'workspace-fixture');
        assert.equal(subject, 'system:analytics-configuration');
        assert.equal(key, 'gtm-container-v1');
        const expected = expectedForUpdate;
        if (expected === 0 && !db.row) {
          db.row = { workspace_id: workspace, google_subject: subject, key, value_json: valueJson, revision: 1, updated_at: updatedAt };
          return { meta: { changes: 1 } };
        }
        if (!db.row || db.row.revision !== expected) return { meta: { changes: 0 } };
        db.row = { ...db.row, value_json: valueJson, revision: db.row.revision + 1, updated_at: updatedAt };
        return { meta: { changes: 1 } };
      },
    };
  }
}

const analyticsContract = await loadTs('lib/analytics-contract.ts', { './site-config': { DEMO_ORIGIN: 'https://example.invalid' } });
const analyticsConfiguration = await loadTs('lib/analytics-configuration.ts', { './analytics-contract': analyticsContract });
const analyticsServer = await loadTs('lib/analytics-configuration-server.ts', {
  'cloudflare:workers': { env: {} },
  zod: require('zod/v3'),
  './analytics-configuration': analyticsConfiguration,
  './runtime-secrets': { secretRuntime: () => ({ SITE_OWNER_USER_ID: 'owner-fixture' }) },
  './admin-auth-server': {
    getGoogleAdmin: async () => null,
    rejected: (_request, message, status) => Response.json({ error: message }, { status }),
    safeJson: (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } }),
    readSmallBody: async (request) => request.text(),
  },
});

test('container settings are strict, require a valid GTM ID when enabled, and persist an explicit disabled state', async () => {
  const { analyticsConfigurationInput, AnalyticsConfigurationStore } = analyticsConfiguration;
  const valid = { expectedRevision: 0, enabled: true, containerId: 'GTM-PQ3SVPTK' };
  assert.equal(analyticsConfigurationInput.safeParse(valid).success, true);
  for (const invalid of [
    { ...valid, containerId: 'G-S4J27S9VMH' },
    { ...valid, containerId: 'GTM-abc12345' },
    { ...valid, extra: 'ignored no more' },
    { expectedRevision: 0, enabled: true, containerId: null },
    { expectedRevision: 0, enabled: false, containerId: 'GTM-PQ3SVPTK' },
    { expectedRevision: -1, enabled: false, containerId: null },
  ]) assert.equal(analyticsConfigurationInput.safeParse(invalid).success, false);

  const db = new MemoryD1();
  const store = new AnalyticsConfigurationStore(db, 'workspace-fixture', () => 1234);
  assert.deepEqual(await store.read('GTM-PQ3SVPTK'), { revision: 0, enabled: true, containerId: 'GTM-PQ3SVPTK', source: 'native' });
  assert.equal(db.row, null, 'status with only a native fallback must not initialize a persisted setting');
  assert.equal(db.writes, 0);

  const first=await store.save(valid,'owner-fixture-subject');
  assert.deepEqual({revision:first.revision,enabled:first.enabled,containerId:first.containerId,source:first.source},{revision:1,enabled:true,containerId:'GTM-PQ3SVPTK',source:'persisted'});
  assert.match(first.auditId,/^[0-9a-f-]{36}$/i);
  assert.equal(JSON.stringify(first).includes(JSON.parse(db.row.value_json).writeToken),false);
  assert.deepEqual(await store.read('GTM-OTHER123'), { revision: 1, enabled: true, containerId: 'GTM-PQ3SVPTK', source: 'persisted' });
  await assert.rejects(store.save({ expectedRevision: 0, enabled: false, containerId: null },'owner-fixture-subject'), /configuration_changed/);
  assert.deepEqual(await store.read(), { revision: 1, enabled: true, containerId: 'GTM-PQ3SVPTK', source: 'persisted' });
  const disabled=await store.save({ expectedRevision: 1, enabled: false, containerId: null },'owner-fixture-subject');
  assert.deepEqual({revision:disabled.revision,enabled:disabled.enabled,containerId:disabled.containerId,source:disabled.source},{revision:2,enabled:false,containerId:null,source:'persisted'});
  assert.equal(db.audits.length,2);
  assert.deepEqual(await store.read('GTM-OTHER123'), { revision: 2, enabled: false, containerId: null, source: 'persisted' }, 'explicit disable must override native fallback without reset resurrection');
});

test('consent projection exposes only the configured container to a current Analytics grant', () => {
  const { projectAnalyticsConfiguration } = analyticsConfiguration;
  const enabled = { revision: 5, enabled: true, containerId: 'GTM-PQ3SVPTK', source: 'persisted' };
  assert.deepEqual(projectAnalyticsConfiguration(enabled, { analytics: true, analyticsSuppressed: false }), { containerId: 'GTM-PQ3SVPTK', configRevision: 5 });
  for (const consent of [
    { analytics: false, analyticsSuppressed: false },
    { analytics: true, analyticsSuppressed: true },
    { analytics: false, analyticsSuppressed: true },
  ]) assert.deepEqual(projectAnalyticsConfiguration(enabled, consent), { containerId: null, configRevision: null });
  assert.deepEqual(projectAnalyticsConfiguration({ ...enabled, enabled: false, containerId: null }, { analytics: true, analyticsSuppressed: false }), { containerId: null, configRevision: 5 });
});

test('out-of-order consent refresh cannot roll back a newer analytics configuration revision', async () => {
  const consentClient = await loadTs('lib/consent-client.ts', { './tag-identity-client': { resetGoogleTagIdentityBinding() {} } });
  const originalFetch = globalThis.fetch;
  const pending = [];
  globalThis.fetch = () => new Promise((resolve) => pending.push(resolve));
  const response = (containerId, configRevision) => Response.json({
    configured: true, analytics: true, analyticsSaved: true, analyticsSuppressed: false,
    experiments: false, analyticsRevision: 4, experimentsRevision: 0, measurementId: null,
    containerId, configRevision,
  });
  try {
    const oldRead = consentClient.refreshPurposeConsent();
    const currentRead = consentClient.refreshPurposeConsent();
    assert.equal(pending.length, 2);
    pending[1](response('GTM-PQ3SVPTK', 7));
    await currentRead;
    assert.equal(consentClient.consentSnapshot().containerId, 'GTM-PQ3SVPTK');
    assert.equal(consentClient.consentSnapshot().configRevision, 7);
    pending[0](response('GTM-OLD1234', 6));
    await oldRead;
    assert.equal(consentClient.consentSnapshot().containerId, 'GTM-PQ3SVPTK');
    assert.equal(consentClient.consentSnapshot().configRevision, 7);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Analytics configuration route requires verified administration, HTTPS, same-origin writes, and strict CAS payloads', async () => {
  let statuses = 0;
  let saves = 0;
  const service = {
    async status() { statuses++; return { revision: 2, enabled: false, containerId: null, source: 'persisted' }; },
    async save(value) { saves++; return { revision: value.expectedRevision + 1, enabled: value.enabled, containerId: value.containerId, source: 'persisted' }; },
  };
  const deps = { ownerId: 'owner-fixture', getAdmin: async () => ({ siteUserId: 'synthetic-installation', subject: 'google-admin-fixture' }), service };
  const make = (method, body, { origin = 'https://site.invalid', url = 'https://site.invalid/api/admin/analytics/configuration', admin = true } = {}) =>
    new Request(url, { method, headers: { ...(origin ? { origin } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });

  const goodRead = await analyticsServer.analyticsConfigurationOwnerRoute(make('GET'), deps);
  assert.equal(goodRead.status, 200);
  assert.equal(goodRead.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await goodRead.json(), { revision: 2, enabled: false, containerId: null, source: 'persisted' });
  assert.equal(statuses, 1);

  const unauthorized = await analyticsServer.analyticsConfigurationOwnerRoute(make('GET'), { ...deps, getAdmin: async () => null });
  assert.equal(unauthorized.status, 403);
  const insecure = await analyticsServer.analyticsConfigurationOwnerRoute(make('GET', undefined, { url: 'http://site.invalid/api/admin/analytics/configuration' }), deps);
  assert.equal(insecure.status, 403);
  const query = await analyticsServer.analyticsConfigurationOwnerRoute(make('GET', undefined, { url: 'https://site.invalid/api/admin/analytics/configuration?containerId=secret' }), deps);
  assert.equal(query.status, 403);

  const crossOrigin = await analyticsServer.analyticsConfigurationOwnerRoute(make('POST', { expectedRevision: 2, enabled: true, containerId: 'GTM-PQ3SVPTK' }, { origin: 'https://attacker.invalid' }), deps);
  assert.equal(crossOrigin.status, 403);
  const invalid = await analyticsServer.analyticsConfigurationOwnerRoute(make('POST', { expectedRevision: 2, enabled: true, containerId: 'G-S4J27S9VMH' }), deps);
  assert.equal(invalid.status, 400);
  const saved = await analyticsServer.analyticsConfigurationOwnerRoute(make('POST', { expectedRevision: 2, enabled: true, containerId: 'GTM-PQ3SVPTK' }), deps);
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { revision: 3, enabled: true, containerId: 'GTM-PQ3SVPTK', source: 'persisted' });
  assert.equal(saves, 1);
});

test('consent API and analytics loader are dynamic, uncached, single-loader, and never personalize shared markup', async () => {
  const [consentRoute, consentServer, analytics, consentClient, layout] = await Promise.all([
    readFile(path.join(root, 'app/api/consent/route.ts'), 'utf8'),
    readFile(path.join(root, 'lib/purpose-consent-server.ts'), 'utf8'),
    readFile(path.join(root, 'components/analytics.tsx'), 'utf8'),
    readFile(path.join(root, 'lib/consent-client.ts'), 'utf8'),
    readFile(path.join(root, 'app/layout.tsx'), 'utf8'),
  ]);
  assert.match(consentRoute, /dynamic='force-dynamic'/);
  assert.match(consentServer, /projectAnalyticsConfiguration/);
  assert.match(consentServer, /containerId/);
  assert.match(analytics, /result\?\.containerId/);
  assert.match(analytics, /result\?\.configRevision/);
  assert.match(analytics, /JSON\.stringify\(\[valid,containerId\?\?null,configRevision\?\?null\]\)/);
  assert.match(analytics, /loadedContainerIdentity!==identity/);
  assert.match(analytics, /reloadRequested=true;window\.location\.reload\(\)/);
  assert.equal((analytics.match(/https:\/\/www\.googletagmanager\.com\/gtm\.js/g) ?? []).length, 1);
  assert.match(consentClient, /cache:'no-store'/);
  assert.doesNotMatch(layout, /GTM-PQ3SVPTK|GTM-THR2KRPF|containerId:/);
  assert.doesNotMatch(analytics, /localStorage|sessionStorage/);
});

