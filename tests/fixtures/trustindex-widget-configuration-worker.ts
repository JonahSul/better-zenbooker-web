import { TrustindexWidgetConfigurationStore, TRUSTINDEX_SETTINGS_SUBJECT, TRUSTINDEX_SETTINGS_KEY } from '../../lib/trustindex-widget-configuration';

interface Env {
  DB: D1Database;
  QA_TOKEN: string;
  QA_WORKSPACE_ID: string;
}

const NATIVE = { enabled: 'true', badgeWidgetId: 'NativeBadge987', listWidgetId: 'NativeList654', reviewsUrl: 'https://www.trustindex.io/reviews/example.invalid' };
const FIXTURE_ACTOR = 'verified-google-subject-fixture';
function json(value: unknown, status = 200) { return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } }); }

export default {
  async fetch(request: Request, env: Env) {
    if (request.headers.get('authorization') !== `Bearer ${env.QA_TOKEN}`) return json({ error: 'unauthorized' }, 401);
    const url = new URL(request.url);
    if (url.hostname !== '127.0.0.1' || url.port !== '8802') return json({ error: 'loopback_fixture_only' }, 403);
    const store = new TrustindexWidgetConfigurationStore(env.DB, env.QA_WORKSPACE_ID);
    if (request.method === 'GET' && url.pathname === '/__qa/init') {
      const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM d1_migrations').first<{ count: number }>();
      const table = await env.DB.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='admin_settings'").first<{ count: number }>();
      const [setting, audit] = await Promise.all([
        env.DB.prepare('SELECT COUNT(*) AS count FROM admin_settings WHERE workspace_id=? AND google_subject=? AND key=?').bind(env.QA_WORKSPACE_ID, TRUSTINDEX_SETTINGS_SUBJECT, TRUSTINDEX_SETTINGS_KEY).first<{ count: number }>(),
        env.DB.prepare("SELECT COUNT(*) AS count FROM admin_audit WHERE action='reviews.widget_configuration_save'").first<{ count: number }>(),
      ]);
      return json({ ready: !!env.DB, migrationCount: count?.count ?? 0, tablesPresent: (table?.count ?? 0) === 1, settingRows: setting?.count ?? 0, auditRows: audit?.count ?? 0 });
    }
    if (request.method === 'GET' && url.pathname === '/__qa/state') {
      const [config, setting, audits, stored] = await Promise.all([
        store.read(NATIVE),
        env.DB.prepare('SELECT COUNT(*) AS count FROM admin_settings WHERE workspace_id=? AND google_subject=? AND key=?').bind(env.QA_WORKSPACE_ID, TRUSTINDEX_SETTINGS_SUBJECT, TRUSTINDEX_SETTINGS_KEY).first<{ count: number }>(),
        env.DB.prepare("SELECT id,google_subject,action,target,created_at FROM admin_audit WHERE action='reviews.widget_configuration_save' ORDER BY created_at,id").all<{ id: string; google_subject: string; action: string; target: string; created_at: number }>(),
        env.DB.prepare('SELECT value_json FROM admin_settings WHERE workspace_id=? AND google_subject=? AND key=?').bind(env.QA_WORKSPACE_ID, TRUSTINDEX_SETTINGS_SUBJECT, TRUSTINDEX_SETTINGS_KEY).first<{ value_json: string }>(),
      ]);
      return json({ config, rowCount: setting?.count ?? 0, audits: audits.results ?? [], storedValueJson: stored?.value_json ?? null });
    }
    if (request.method === 'POST' && url.pathname === '/__qa/save') {
      let input: unknown;
      try { input = await request.json(); } catch { return json({ error: 'invalid_input' }, 400); }
      try { return json(await store.save(input, FIXTURE_ACTOR)); }
      catch (error) { return json({ error: error instanceof Error && error.message === 'configuration_changed' ? 'configuration_changed' : 'invalid_input' }, error instanceof Error && error.message === 'configuration_changed' ? 409 : 400); }
    }
    if (request.method === 'POST' && url.pathname === '/__qa/arm-audit-failure') {
      await env.DB.prepare("CREATE TRIGGER IF NOT EXISTS qa_fail_trustindex_widget_audit BEFORE INSERT ON admin_audit WHEN NEW.action='reviews.widget_configuration_save' BEGIN SELECT RAISE(ABORT,'synthetic trustindex audit failure'); END").run();
      return json({ armed: true });
    }
    if (request.method === 'POST' && url.pathname === '/__qa/seed-invalid') {
      const row = await env.DB.prepare('SELECT revision FROM admin_settings WHERE workspace_id=? AND google_subject=? AND key=?').bind(env.QA_WORKSPACE_ID, TRUSTINDEX_SETTINGS_SUBJECT, TRUSTINDEX_SETTINGS_KEY).first<{ revision: number }>();
      if (!row) return json({ error: 'setting_missing' }, 409);
      await env.DB.prepare('UPDATE admin_settings SET value_json=?,revision=revision+1 WHERE workspace_id=? AND google_subject=? AND key=? AND revision=?').bind('{"enabled":true,"badgeWidgetId":"x","listWidgetId":null}', env.QA_WORKSPACE_ID, TRUSTINDEX_SETTINGS_SUBJECT, TRUSTINDEX_SETTINGS_KEY, row.revision).run();
      return json({ seeded: true });
    }
    return json({ error: 'not_found' }, 404);
  },
};
