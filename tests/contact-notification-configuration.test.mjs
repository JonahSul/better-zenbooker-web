import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

async function loadTs(relativePath) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (specifier === 'zod/v3') return require('zod/v3');
    throw new Error(`Unexpected import in ${relativePath}: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const config = await loadTs('lib/contact-notification-configuration.ts');
const base = {
  expectedRevision: 0,
  enabled: false,
  events: [],
  from: null,
  zoneId: null,
  subdomainId: null,
};

test('notification settings require an explicit bounded DTO and support an off/no-events state', () => {
  assert.deepEqual(config.contactNotificationConfigurationInput.parse(base), base);
  const configured = {
    expectedRevision: 3,
    enabled: true,
    events: ['contact.message_created', 'inquiry.demo_saved'],
    from: 'notifications@example.invalid',
    zoneId: 'a'.repeat(32),
    subdomainId: 'b'.repeat(32),
  };
  assert.deepEqual(config.contactNotificationConfigurationInput.parse(configured), configured);
  for (const invalid of [
    { ...base, extra: 'unexpected' },
    { ...base, expectedRevision: -1 },
    { ...base, enabled: true, events: ['contact.message_created', 'contact.message_created'] },
    { ...base, enabled: true, events: ['contact.message_created', 'inquiry.demo_saved', 'other.event'] },
    { ...base, from: 'not-an-email' },
    { ...base, zoneId: 'not-a-zone-id' },
    { ...base, subdomainId: 'not-a-subdomain-id' },
    { ...base, from: undefined },
  ]) assert.equal(config.contactNotificationConfigurationInput.safeParse(invalid).success, false);
});

test('saved notification settings read back through the public store DTO without its private write token', async () => {
  let row = null;
  let auditRows = [];
  const db = {
    prepare(sql) {
      let args = [];
      const statement = {
        bind(...values) { args = values; return statement; },
        async first() {
          if (sql.startsWith('SELECT revision,value_json FROM admin_settings')) return row;
          return null;
        },
      };
      Object.defineProperty(statement, '_qa', { get: () => ({ sql, args }) });
      return statement;
    },
    async batch(statements) {
      const [settings, audit] = statements.map(statement => statement._qa);
      assert.match(settings.sql, /^INSERT INTO admin_settings/);
      assert.match(audit.sql, /^INSERT INTO admin_audit/);
      const [workspaceId, subject, key, valueJson, updatedAt] = settings.args;
      row = { revision: 1, value_json: valueJson };
      auditRows.push({ action: 'contact.notifications_save', created_at: updatedAt, workspaceId, subject, key });
      return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
    },
  };
  const store = new config.ContactNotificationConfigurationStore(db, 'qa-contact-workspace', () => 1234);
  const saved = await store.save({ ...base, enabled: true, events: ['contact.message_created'], from: 'alerts@example.invalid', zoneId: 'a'.repeat(32), subdomainId: 'b'.repeat(32) }, 'fixture-owner');
  const reread = await store.read();

  assert.deepEqual(reread, {
    revision: 1,
    enabled: true,
    events: ['contact.message_created'],
    from: 'alerts@example.invalid',
    zoneId: 'a'.repeat(32),
    subdomainId: 'b'.repeat(32),
  });
  assert.deepEqual(saved, { ...reread, auditId: saved.auditId });
  assert.equal(typeof saved.auditId, 'string');
  assert.equal(auditRows.length, 1);
  const persisted = JSON.parse(row.value_json);
  assert.equal(typeof persisted.writeToken, 'string');
  assert.equal(Object.hasOwn(reread, 'writeToken'), false);
  assert.equal(Object.hasOwn(saved, 'writeToken'), false);
});
