import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

async function loadTs(relative, overrides = {}) {
  const source = await readFile(path.join(root, relative), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (Object.hasOwn(overrides, specifier)) return overrides[specifier];
    if (specifier === 'zod/v3' && Object.hasOwn(overrides, 'zod')) return overrides.zod;
    if (specifier === 'zod/v3') return require(specifier);
    throw new Error(`Unexpected ${relative} import: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const config = await loadTs('lib/ga4-property-configuration.ts');
const server = await loadTs('lib/ga4-property-configuration-server.ts', {
  'cloudflare:workers': { env: {} },
  './ga4-property-configuration': config,
  './runtime-secrets': { secretRuntime: () => ({ SITE_OWNER_USER_ID: 'fixture-owner' }), SITE_PROJECT_ID: 'qa-ga4-property-workspace' },
  './admin-auth-server': {
    getGoogleAdmin: async () => null,
    rejected: (_request, message, status) => Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } }),
    safeJson: (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } }),
    readSmallBody: async request => request.text(),
  },
});

function serverRequest(pathname, { method = 'GET', body, origin = 'https://measurement.example.invalid', protocol = 'https:' } = {}) {
  const url = `${protocol}//measurement.example.invalid${pathname}`;
  const headers = new Headers({ origin });
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new Request(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

class MemoryD1 {
  row = null;
  audits = [];
  writes = 0;
  failAudit = false;

  async batch(statements) {
    const oldRow = this.row && { ...this.row };
    const oldAudits = this.audits.slice();
    try { return await Promise.all(statements.map(statement => statement.run())); }
    catch (error) { this.row = oldRow; this.audits = oldAudits; throw error; }
  }

  prepare(sql) {
    const db = this;
    let values = [];
    return {
      bind(...bound) { values = bound; return this; },
      async first() {
        if (!sql.startsWith('SELECT')) throw new Error('Unexpected first() SQL');
        const [workspace, subject, key] = values;
        if (!db.row || db.row.workspace_id !== workspace || db.row.google_subject !== subject || db.row.key !== key) return null;
        return { value_json: db.row.value_json, revision: db.row.revision };
      },
      async run() {
        db.writes++;
        if (sql.startsWith('INSERT INTO admin_audit')) {
          if (db.failAudit) throw new Error('fixture audit failure');
          const [id, actor, target, createdAt, workspace, subject, key, revision, writeToken] = values;
          const stored = db.row && JSON.parse(db.row.value_json);
          if (!db.row || db.row.workspace_id !== workspace || db.row.google_subject !== subject || db.row.key !== key || db.row.revision !== revision || stored?.writeToken !== writeToken) return { meta: { changes: 0 } };
          db.audits.push({ id, actor, target, createdAt });
          return { meta: { changes: 1 } };
        }
        assert.match(sql, /^INSERT INTO admin_settings/);
        const [workspace, subject, key, valueJson, updatedAt, expectedForInsert, expectedWorkspace, expectedSubject, expectedKey, expectedForSelect, expectedForUpdate] = values;
        assert.equal(workspace, 'qa-ga4-property-workspace');
        assert.equal(subject, config.GA4_PROPERTY_SETTINGS_SUBJECT);
        assert.equal(key, config.GA4_PROPERTY_SETTINGS_KEY);
        if (expectedForUpdate === 0 && !db.row) {
          db.row = { workspace_id: workspace, google_subject: subject, key, value_json: valueJson, revision: 1, updated_at: updatedAt };
          return { meta: { changes: 1 } };
        }
        if (!db.row || db.row.revision !== expectedForUpdate) return { meta: { changes: 0 } };
        db.row = { ...db.row, value_json: valueJson, revision: db.row.revision + 1, updated_at: updatedAt };
        return { meta: { changes: 1 } };
      },
    };
  }
}

test('GA4 property input is a strict nullable numeric property ID', () => {
  const good = { expectedRevision: 0, propertyId: '1234567890123' };
  assert.equal(config.ga4PropertyConfigurationInput.safeParse(good).success, true);
  assert.equal(config.ga4PropertyConfigurationInput.safeParse({ ...good, propertyId: null }).success, true);
  for (const invalid of [
    { ...good, propertyId: '0' },
    { ...good, propertyId: '0123' },
    { ...good, propertyId: 'G-ABC123' },
    { ...good, propertyId: '1'.repeat(21) },
    { ...good, expectedRevision: -1 },
    { ...good, extra: 'ignored' },
  ]) assert.equal(config.ga4PropertyConfigurationInput.safeParse(invalid).success, false);
});

test('native property fallback is read-only and a persisted value or clear overrides it', async () => {
  const db = new MemoryD1();
  const store = new config.Ga4PropertyConfigurationStore(db, 'qa-ga4-property-workspace', () => 4321);
  assert.deepEqual(await store.read(undefined), { revision: 0, propertyId: null, source: 'unavailable' });
  assert.deepEqual(await store.read('1234567890123'), { revision: 0, propertyId: '1234567890123', source: 'native' });
  assert.equal(db.row, null, 'status reads never initialize settings');
  assert.equal(db.writes, 0);

  const saved = await store.save({ expectedRevision: 0, propertyId: '1234567890123' }, 'fixture-owner');
  assert.deepEqual({ revision: saved.revision, propertyId: saved.propertyId, source: saved.source }, { revision: 1, propertyId: '1234567890123', source: 'persisted' });
  assert.match(saved.auditId, /^[0-9a-f-]{36}$/i);
  assert.equal(JSON.stringify(saved).includes(JSON.parse(db.row.value_json).writeToken), false);
  assert.deepEqual(await store.read('987654321'), { revision: 1, propertyId: '1234567890123', source: 'persisted' });

  const cleared = await store.save({ expectedRevision: 1, propertyId: null }, 'fixture-owner');
  assert.deepEqual({ revision: cleared.revision, propertyId: cleared.propertyId, source: cleared.source }, { revision: 2, propertyId: null, source: 'persisted' });
  assert.deepEqual(await store.read('1234567890123'), { revision: 2, propertyId: null, source: 'persisted' }, 'an explicit persisted clear does not resurrect the native fallback');
});

test('stale writes create no audit and an audit failure rolls the setting back', async () => {
  const db = new MemoryD1();
  const store = new config.Ga4PropertyConfigurationStore(db, 'qa-ga4-property-workspace', () => 1234);
  await store.save({ expectedRevision: 0, propertyId: '1234567890123' }, 'fixture-owner');
  const auditCount = db.audits.length;
  const row = { ...db.row };
  await assert.rejects(store.save({ expectedRevision: 0, propertyId: '987654321' }, 'fixture-owner'), /configuration_changed/);
  assert.deepEqual(db.row, row);
  assert.equal(db.audits.length, auditCount);

  db.failAudit = true;
  await assert.rejects(store.save({ expectedRevision: 1, propertyId: '987654321' }, 'fixture-owner'));
  assert.deepEqual(db.row, row);
  assert.equal(db.audits.length, auditCount);
});

test('property configuration owner route is fixed-owner guarded, strict, no-store, and fetch-free', async () => {
  const saved = [];
  const publicStatus = { revision: 2, propertyId: '1234567890123', source: 'persisted' };
  const service = {
    status: async () => publicStatus,
    save: async (input, actor) => { saved.push({ input, actor }); return { ...publicStatus, revision: 3, auditId: 'e9b3a134-0779-44c0-a12d-37ddf00dbab4' }; },
  };
  const deps = { ownerId: 'fixture-owner', service, getAdmin: async () => ({ siteUserId: 'fixture-owner', subject: 'verified-google-subject' }) };
  const read = await server.ga4PropertyConfigurationOwnerRoute(serverRequest('/api/admin/analytics/property-configuration'), deps);
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), publicStatus);
  assert.match(read.headers.get('cache-control') ?? '', /no-store/i);

  const body = { expectedRevision: 2, propertyId: '987654321' };
  const write = await server.ga4PropertyConfigurationOwnerRoute(serverRequest('/api/admin/analytics/property-configuration', { method: 'POST', body }), deps);
  assert.equal(write.status, 200);
  assert.deepEqual(saved, [{ input: body, actor: 'verified-google-subject' }], 'actor comes from the verified server identity');

  for (const input of [
    { expectedRevision: 2, propertyId: '1234', actor: 'caller-controlled' },
    { expectedRevision: 2, propertyId: '01234' },
    { expectedRevision: -1, propertyId: null },
  ]) {
    const invalid = await server.ga4PropertyConfigurationOwnerRoute(serverRequest('/api/admin/analytics/property-configuration', { method: 'POST', body: input }), deps);
    assert.equal(invalid.status, 400);
  }
  const unauthenticated = await server.ga4PropertyConfigurationOwnerRoute(serverRequest('/api/admin/analytics/property-configuration'), { ...deps, getAdmin: async () => null });
  assert.equal(unauthenticated.status, 403, 'requests without a verified Google administrator session are denied');
  const wrongOrigin = await server.ga4PropertyConfigurationOwnerRoute(serverRequest('/api/admin/analytics/property-configuration', { method: 'POST', body, origin: 'https://elsewhere.invalid' }), deps);
  assert.equal(wrongOrigin.status, 403);
  assert.equal(saved.length, 1);
});
