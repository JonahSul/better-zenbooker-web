import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const badgeId = 'FixtureBadge123';
const listId = 'FixtureList456';
const reviewsUrl = 'https://www.trustindex.io/reviews/example.invalid';
const inputBudget = await loadTs('lib/input-budget.ts');

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
  async batch(statements) {
    const rowBefore = this.row && { ...this.row };
    const auditsBefore = this.audits.slice();
    try { return await Promise.all(statements.map((statement) => statement.run())); }
    catch (error) { this.row = rowBefore; this.audits = auditsBefore; throw error; }
  }
  prepare(sql) {
    const db = this;
    let values = [];
    return {
      bind(...bound) { values = bound; return this; },
      async first() {
        const [, subject, key] = values;
        return db.row?.google_subject === subject && db.row?.key === key ? { value_json: db.row.value_json, revision: db.row.revision } : null;
      },
      async run() {
        if (sql.startsWith('INSERT INTO admin_audit')) {
          const [id, actor, target, createdAt, workspace, subject, key, revision, writeToken] = values;
          const current = db.row ? JSON.parse(db.row.value_json) : null;
          const matches = db.row?.workspace_id === workspace && db.row?.google_subject === subject && db.row?.key === key && db.row?.revision === revision && current?.writeToken === writeToken;
          if (!matches) return { meta: { changes: 0 } };
          db.audits.push({ id, google_subject: actor, action: 'reviews.widget_configuration_save', target, created_at: createdAt });
          return { meta: { changes: 1 } };
        }
        const [workspace, subject, key, valueJson, updatedAt, expectedForInsert, expectedWorkspace, expectedSubject, expectedKey, expectedInSelect, expectedForUpdate] = values;
        assert.match(sql, /^INSERT INTO admin_settings/);
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

const googleReviewsCore = await loadTs('lib/google-reviews-core.ts', {
  './input-budget': inputBudget,
  './encrypted-value': { encryptValue() {}, decryptValue() {} },
  './site-config': { DEMO_ORIGIN: 'https://example.invalid' },
});
const publicReviewsUrl = await loadTs('lib/public-reviews-url.ts', { './google-reviews-core': googleReviewsCore });
const widgetConfiguration = await loadTs('lib/trustindex-widget-configuration.ts', { './public-reviews-url': publicReviewsUrl });
const widgetServer = await loadTs('lib/trustindex-widget-configuration-server.ts', {
  'cloudflare:workers': { env: {} },
  './trustindex-widget-configuration': widgetConfiguration,
  './runtime-secrets': { secretRuntime: () => ({ SITE_OWNER_USER_ID: 'owner-fixture', TRUSTINDEX_WIDGETS_ENABLED: 'true', TRUSTINDEX_BADGE_WIDGET_ID: badgeId, TRUSTINDEX_LIST_WIDGET_ID: listId }) },
  './admin-auth-server': {
    getGoogleAdmin: async () => null,
    rejected: (_request, message, status) => Response.json({ error: message }, { status }),
    safeJson: (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' } }),
    readSmallBody: async (request) => request.text(),
  },
});

test('Trustindex config accepts only bounded synthetic IDs when enabled and explicit null IDs when disabled', () => {
  const { trustindexWidgetInput } = widgetConfiguration;
  const enabled = { expectedRevision: 0, enabled: true, badgeWidgetId: badgeId, listWidgetId: listId };
  assert.equal(trustindexWidgetInput.safeParse(enabled).success, true);
  assert.equal(trustindexWidgetInput.safeParse({ ...enabled, reviewsUrl }).success, true);
  assert.equal(trustindexWidgetInput.safeParse({ expectedRevision: 1, enabled: false, badgeWidgetId: null, listWidgetId: null }).success, true);
  for (const invalid of [
    { ...enabled, extra: 'unrecognized' },
    { ...enabled, badgeWidgetId: null },
    { ...enabled, listWidgetId: '' },
    { ...enabled, badgeWidgetId: 'x'.repeat(129) },
    { ...enabled, reviewsUrl: 'https://www.trustindex.io/reviews/example.invalid?next=private' },
    { ...enabled, reviewsUrl: 'javascript:alert(1)' },
    { expectedRevision: 0, enabled: false, badgeWidgetId: badgeId, listWidgetId: listId },
    { expectedRevision: -1, enabled: false, badgeWidgetId: null, listWidgetId: null },
    { expectedRevision: 0.5, enabled: false, badgeWidgetId: null, listWidgetId: null },
  ]) assert.equal(trustindexWidgetInput.safeParse(invalid).success, false);
});

test('read is SELECT-only; native config needs the exact enabled flag and both IDs; persisted and malformed rows override environment', async () => {
  const { TrustindexWidgetConfigurationStore, TRUSTINDEX_SETTINGS_SUBJECT, TRUSTINDEX_SETTINGS_KEY } = widgetConfiguration;
  const db = new MemoryD1();
  const store = new TrustindexWidgetConfigurationStore(db, 'workspace-fixture', () => 1234);
  assert.deepEqual(await store.read({ enabled: 'true', badgeWidgetId: badgeId, listWidgetId: listId }), {
    revision: 0, enabled: true, badgeWidgetId: badgeId, listWidgetId: listId, reviewsUrl: null, source: 'native',
  });
  assert.deepEqual(await store.read({ enabled: 'true', badgeWidgetId: badgeId, listWidgetId: listId, reviewsUrl }), {
    revision: 0, enabled: true, badgeWidgetId: badgeId, listWidgetId: listId, reviewsUrl, source: 'native',
  });
  assert.equal(db.row, null, 'status does not initialize admin_settings');
  assert.equal(db.audits.length, 0);
  assert.deepEqual(await store.read({ enabled: 'TRUE', badgeWidgetId: badgeId, listWidgetId: listId }), {
    revision: 0, enabled: false, badgeWidgetId: null, listWidgetId: null, reviewsUrl: null, source: 'disabled',
  });
  assert.deepEqual(await store.read({ enabled: 'true', badgeWidgetId: badgeId, listWidgetId: '' }), {
    revision: 0, enabled: false, badgeWidgetId: null, listWidgetId: null, reviewsUrl: null, source: 'disabled',
  });
  assert.deepEqual(await store.read({ enabled: 'false', badgeWidgetId: badgeId, listWidgetId: listId, reviewsUrl }), {
    revision: 0, enabled: false, badgeWidgetId: null, listWidgetId: null, reviewsUrl, source: 'native',
  }, 'a valid fallback link is independent of whether the widgets are enabled');

  db.row = { workspace_id: 'workspace-fixture', google_subject: TRUSTINDEX_SETTINGS_SUBJECT, key: TRUSTINDEX_SETTINGS_KEY, value_json: JSON.stringify({ enabled: true, badgeWidgetId: badgeId, listWidgetId: listId }), revision: 4, updated_at: 10 };
  assert.deepEqual(await store.read({ enabled: 'true', badgeWidgetId: badgeId, listWidgetId: listId }), {
    revision: 4, enabled: true, badgeWidgetId: badgeId, listWidgetId: listId, reviewsUrl: null, source: 'persisted',
  }, 'legacy persisted rows with no fallback URL remain readable and do not pull one from environment');
  db.row.value_json = JSON.stringify({ enabled: false, badgeWidgetId: null, listWidgetId: null, reviewsUrl: null });
  db.row.revision = 5;
  assert.deepEqual(await store.read({ enabled: 'true', badgeWidgetId: badgeId, listWidgetId: listId, reviewsUrl }), {
    revision: 5, enabled: false, badgeWidgetId: null, listWidgetId: null, reviewsUrl: null, source: 'persisted',
  }, 'persisted disabled/null fallback values suppress environment values');
  db.row.value_json = '{malformed';
  assert.deepEqual(await store.read({ enabled: 'true', badgeWidgetId: badgeId, listWidgetId: listId }), {
    revision: 5, enabled: false, badgeWidgetId: null, listWidgetId: null, reviewsUrl: null, source: 'persisted',
  }, 'an invalid persisted row fails closed rather than reviving environment settings');
});

test('widget settings save carries the validated public fallback into the canonical DTO and safe audit target', async () => {
  const { TrustindexWidgetConfigurationStore } = widgetConfiguration;
  const db = new MemoryD1();
  const store = new TrustindexWidgetConfigurationStore(db, 'workspace-fixture', () => 5678);
  const saved = await store.save({ expectedRevision: 0, enabled: false, badgeWidgetId: null, listWidgetId: null, reviewsUrl }, 'verified-owner-subject');
  assert.deepEqual({ revision: saved.revision, enabled: saved.enabled, badgeWidgetId: saved.badgeWidgetId, listWidgetId: saved.listWidgetId, reviewsUrl: saved.reviewsUrl, source: saved.source }, {
    revision: 1, enabled: false, badgeWidgetId: null, listWidgetId: null, reviewsUrl, source: 'persisted',
  });
  assert.deepEqual(JSON.parse(db.audits[0].target), { workspaceId: 'workspace-fixture', revision: 1, enabled: false, badgeWidgetId: null, listWidgetId: null, reviewsUrl });
  assert.equal(JSON.stringify(saved).includes(JSON.parse(db.row.value_json).writeToken), false);
});

test('owner configuration route rejects unauthorized and unsafe requests without saving', async () => {
  let statusCalls = 0;
  let saveCalls = 0;
  const service = {
    async status() { statusCalls++; return { revision: 0, enabled: false, badgeWidgetId: null, listWidgetId: null, reviewsUrl: null, source: 'disabled' }; },
    async save(input, actor) { saveCalls++; return { revision: input.expectedRevision + 1, enabled: input.enabled, badgeWidgetId: input.badgeWidgetId, listWidgetId: input.listWidgetId, reviewsUrl: input.reviewsUrl ?? null, source: 'persisted', auditId: 'fixture-audit-id', actorSeen: actor }; },
  };
  const deps = { getAdmin: async () => ({ subject: 'verified-google-admin' }), service };
  const make = (method, body, { origin = 'https://site.invalid', url = 'https://site.invalid/api/admin/reviews/widget-configuration' } = {}) =>
    new Request(url, { method, headers: { ...(origin ? { origin } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });

  assert.equal((await widgetServer.trustindexWidgetConfigurationOwnerRoute(make('GET'), { ...deps, getAdmin: async () => null })).status, 403);
  assert.equal((await widgetServer.trustindexWidgetConfigurationOwnerRoute(make('GET', undefined, { url: 'http://site.invalid/api/admin/reviews/widget-configuration' }), deps)).status, 403);
  assert.equal((await widgetServer.trustindexWidgetConfigurationOwnerRoute(make('GET', undefined, { url: 'https://site.invalid/api/admin/reviews/widget-configuration?badgeWidgetId=secret' }), deps)).status, 403);
  assert.equal((await widgetServer.trustindexWidgetConfigurationOwnerRoute(make('POST', { expectedRevision: 0, enabled: true, badgeWidgetId: badgeId, listWidgetId: listId }, { origin: 'https://attacker.invalid' }), deps)).status, 403);
  assert.equal((await widgetServer.trustindexWidgetConfigurationOwnerRoute(make('POST', { expectedRevision: 0, enabled: true, badgeWidgetId: badgeId, listWidgetId: listId, actor: 'attacker' }), deps)).status, 400);
  assert.equal(statusCalls, 0);
  assert.equal(saveCalls, 0);

  const response = await widgetServer.trustindexWidgetConfigurationOwnerRoute(make('POST', { expectedRevision: 0, enabled: true, badgeWidgetId: badgeId, listWidgetId: listId, reviewsUrl }), deps);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await response.json(), { revision: 1, enabled: true, badgeWidgetId: badgeId, listWidgetId: listId, reviewsUrl, source: 'persisted', auditId: 'fixture-audit-id', actorSeen: 'verified-google-admin' });
  assert.equal(saveCalls, 1, 'audit actor comes from the verified admin session, not the request body');
});

test('public configuration projection exposes only revision, widget IDs, and the validated fallback URL', async () => {
  const service = { async status() { return { revision: 3, enabled: true, badgeWidgetId: badgeId, listWidgetId: listId, reviewsUrl, source: 'persisted', actor: 'private-actor', auditId: 'private-audit-id' }; } };
  const request = new Request('https://site.invalid/api/reviews/widget-configuration');
  const response = await widgetServer.trustindexWidgetConfigurationPublicRoute(request, { service });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/i);
  assert.deepEqual(await response.json(), { revision: 3, enabled: true, badgeWidgetId: badgeId, listWidgetId: listId, reviewsUrl });
  assert.equal((await widgetServer.trustindexWidgetConfigurationPublicRoute(new Request('https://site.invalid/api/reviews/widget-configuration?email=private'), { service })).status, 403);
  assert.equal((await widgetServer.trustindexWidgetConfigurationPublicRoute(new Request('https://site.invalid/api/reviews/widget-configuration', { method: 'POST' }), { service })).status, 403);
});

test('ConsoleStore shares only validated same-workspace Trustindex audit fields across actors', async () => {
  const rows = [
    { id: 'fixture-personal', google_subject: 'current-admin', action: 'profile.updated', target: 'personal-target-preserved', created_at: 1 },
    { id: 'fixture-trustindex', google_subject: `native-owner:${'a'.repeat(64)}`, action: 'reviews.widget_configuration_save', target: JSON.stringify({ workspaceId: 'workspace-fixture', revision: 4, enabled: true, badgeWidgetId: badgeId, listWidgetId: listId, reviewsUrl, privateSentinel: 'must-not-escape' }), created_at: 2 },
    { id: 'fixture-foreign', google_subject: `native-owner:${'b'.repeat(64)}`, action: 'reviews.widget_configuration_save', target: JSON.stringify({ workspaceId: 'other-workspace', revision: 4, enabled: true, badgeWidgetId: badgeId, listWidgetId: listId }), created_at: 3 },
    { id: 'fixture-private', google_subject: `native-owner:${'c'.repeat(64)}`, action: 'private.native.action', target: 'native-private-sentinel', created_at: 4 },
    { id: 'fixture-malformed', google_subject: `native-owner:${'d'.repeat(64)}`, action: 'reviews.widget_configuration_save', target: '{', created_at: 5 },
  ];
  let selectedSql = '';
  let selectedValues = [];
  const db = { prepare(sql) { selectedSql = sql; return { bind(...values) { selectedValues = values; return this; }, async all() { return { results: rows }; } }; } };
  const consoleModule = await loadTs('lib/console-store.ts', {
    './element-measurement-store': { ElementMeasurementStore: class ElementMeasurementStore {} },
    './inquiry-validation': { updateInput: {}, services: [], areas: [] },
    './public-reviews-url': publicReviewsUrl,
    './contact-store': { ContactStore: class ContactStore {} },
  });
  const store = new consoleModule.ConsoleStore(db, 'workspace-fixture', 'current-admin', 'site-user-fixture');
  const audit = await store.audit();
  assert.match(selectedSql, /reviews\.widget_configuration_save/);
  assert.match(selectedSql, /json_valid\(target\)/);
  assert.ok(selectedValues.includes('workspace-fixture'));
  assert.equal(audit.length, 2);
  const byId = Object.fromEntries(audit.map((row) => [row.id, row]));
  assert.deepEqual(byId['fixture-personal'], { id: 'fixture-personal', action: 'profile.updated', created_at: 1, actor: 'Admin', target: 'personal-target-preserved' });
  assert.deepEqual(byId['fixture-trustindex'], { id: 'fixture-trustindex', action: 'reviews.widget_configuration_save', created_at: 2, actor: 'Deployment owner', target: { workspaceId: 'workspace-fixture', revision: 4, enabled: true, badgeWidgetId: badgeId, listWidgetId: listId, reviewsUrl } });
  assert.equal(JSON.stringify(audit).includes('privateSentinel'), false);
  assert.equal(JSON.stringify(audit).includes('native-private-sentinel'), false);
  for (const id of ['fixture-foreign', 'fixture-private', 'fixture-malformed']) assert.equal(Object.hasOwn(byId, id), false);
});
