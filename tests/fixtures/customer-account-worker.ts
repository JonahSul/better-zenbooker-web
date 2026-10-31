import { CustomerAccountStore } from '../../lib/customer-account-store';
import { customerAccountSubjectKey } from '../../lib/customer-account-core';
import { CustomerGoogleStore } from '../../lib/customer-google-store';
import { sha256 } from '../../lib/admin-auth-core';

interface Env {
  DB: D1Database;
  QA_CUSTOMER_ACCOUNT_FIXTURE_TOKEN: string;
  QA_CUSTOMER_ACCOUNT_WORKSPACE: string;
  QA_CUSTOMER_ACCOUNT_OTHER_WORKSPACE: string;
  APP_CREDENTIAL_ENCRYPTION_KEY: string;
}

const TOKEN_HEADER = 'x-qa-customer-account-fixture';
const FINGERPRINT = 'a'.repeat(64);
const FAKE_IDENTITIES = {
  primary: { subject: 'synthetic-customer-subject-primary', name: 'Synthetic Customer Name', email: 'synthetic-customer@example.invalid' },
  secondary: { subject: 'synthetic-customer-subject-secondary', name: 'Other Synthetic Name', email: 'other-synthetic@example.invalid' },
  booking: { subject: 'synthetic-customer-subject-booking-only', name: 'Booking Purpose Name', email: 'booking-purpose@example.invalid' },
};
let fixtureNow = Date.UTC(2026, 9, 30, 12, 0, 0);

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

function stores(env: Env, workspace = env.QA_CUSTOMER_ACCOUNT_WORKSPACE) {
  return {
    accounts: new CustomerAccountStore(env.DB, workspace, () => fixtureNow),
    google: new CustomerGoogleStore(env.DB, workspace, env.APP_CREDENTIAL_ENCRYPTION_KEY, () => fixtureNow),
  };
}

function validHash(value: unknown) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error('fixture_unavailable');
  return value;
}

function validUuid(value: unknown) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error('fixture_unavailable');
  return value;
}

async function count(env: Env, table: 'customer_accounts' | 'customer_account_preferences' | 'customer_account_interactions' | 'customer_google_oauth_states' | 'customer_google_prefill_sessions', workspace: string) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id=?`).bind(workspace).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function identityFor(env: Env, token: string, workspace = env.QA_CUSTOMER_ACCOUNT_WORKSPACE) {
  const { google } = stores(env, workspace);
  const profile = await google.session(token, FINGERPRINT);
  if (!profile) throw new Error('fixture_identity_unavailable');
  return {
    profile,
    identity: {
      subjectKey: await customerAccountSubjectKey(workspace, 'https://accounts.google.com', profile.subject),
      sessionHash: await sha256(token), googleSubject: profile.subject, fingerprint: FINGERPRINT,
    },
  };
}

export default {
  async fetch(request: Request, env: Env) {
    if (request.headers.get(TOKEN_HEADER) !== env.QA_CUSTOMER_ACCOUNT_FIXTURE_TOKEN) return json({ error: 'fixture_unavailable' }, 404);
    if (new URL(request.url).hostname !== '127.0.0.1') return json({ error: 'fixture_unavailable' }, 404);
    const action = new URL(request.url).pathname.replace(/^\/__qa\//, '');
    let body: Record<string, unknown> = {};
    if (request.method === 'POST') {
      try { body = await request.json() as Record<string, unknown>; }
      catch { return json({ error: 'fixture_unavailable' }, 400); }
    }
    try {
      const workspace = body.workspace === 'other' ? env.QA_CUSTOMER_ACCOUNT_OTHER_WORKSPACE : env.QA_CUSTOMER_ACCOUNT_WORKSPACE;
      const { accounts, google } = stores(env, workspace);
      if (action === 'init') {
        const required = ['customer_accounts', 'customer_account_preferences', 'customer_account_interactions', 'customer_google_oauth_states', 'customer_google_prefill_sessions'] as const;
        const present = await Promise.all(required.map(async name => !!await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").bind(name).first()));
        const counts = await Promise.all(required.map(name => count(env, name as typeof required[number], env.QA_CUSTOMER_ACCOUNT_WORKSPACE)));
        const migrationRow = await env.DB.prepare('SELECT COUNT(*) AS count FROM d1_migrations').first<{ count: number }>();
        const migrations = Number(migrationRow?.count ?? 0);
        return json({ ready: present.every(Boolean) && counts.every(value => value === 0) && migrations > 0, migrations, tablesPresent: present.every(Boolean), counts: Object.fromEntries(required.map((name, i) => [name, counts[i]])) });
      }
      if (action === 'clock/reset') {
        fixtureNow = Date.UTC(2026, 9, 30, 12, 0, 0);
        return json({ reset: true });
      }
      if (action === 'clock/set') {
        if (!Number.isSafeInteger(body.now) || Number(body.now) < 1) return json({ error: 'invalid_clock' }, 400);
        fixtureNow = Number(body.now);
        return json({ updated: true });
      }
      if (action === 'visitor/seed') {
        const visitorHash = validHash(body.visitorHash), now = fixtureNow;
        await env.DB.prepare('INSERT INTO support_sessions(hash,workspace_id,revision,preferences_json,expires_at,memory_expires_at,created_at,revoked_at) VALUES(?,?,1,?, ?,NULL,?,NULL)')
          .bind(visitorHash, workspace, '{}', now + 2 * 3600000, now).run();
        const threadId = validUuid(body.threadId);
        await env.DB.prepare('INSERT INTO support_threads(id,workspace_id,visitor_hash,revision,expires_at,deleted_at,created_at) VALUES(?,?,?,1,?,NULL,?)')
          .bind(threadId, workspace, visitorHash, now + 2 * 3600000, now).run();
        return json({ seeded: true, threadExpiresAt: now + 2 * 3600000 });
      }
      if (action === 'visit/record') {
        const value = await accounts.recordInteraction(validHash(body.visitorHash), body.value);
        return json(value);
      }
      if (action === 'visit/prepare') {
        return json(await accounts.prepareVisit(validHash(body.visitorHash), validUuid(body.visitId)));
      }
      if (action === 'visit/revoke-pending') {
        await accounts.revokePendingVisits(validHash(body.visitorHash));
        return json({ revoked: true });
      }
      if (action === 'google/state-create') {
        const browserHash = validHash(body.browserHash);
        const purpose = body.purpose === 'booking_prefill' ? 'booking_prefill' : body.purpose === undefined || body.purpose === 'account' ? 'account' : null;
        if (!purpose) throw new Error('fixture_unavailable');
        const visitId = purpose === 'account' ? validUuid(body.visitId) : undefined;
        const visitorHash = purpose === 'account' ? validHash(body.visitorHash) : undefined;
        const visit = visitorHash && visitId ? await accounts.prepareVisit(visitorHash, visitId) : undefined;
        const connect = purpose === 'account'
          ? { purpose, returnContext: 'book', visitId }
          : { purpose, returnContext: 'book' };
        const value = await google.createState(browserHash, connect, FINGERPRINT, visit);
        const stateHash = await sha256(value.state);
        const row = await env.DB.prepare('SELECT expires_at,purpose,return_context,visit_ref FROM customer_google_oauth_states WHERE state_hash=? AND workspace_id=?')
          .bind(stateHash, workspace).first<{ expires_at: number; purpose: string; return_context: string; visit_ref: string | null }>();
        return json({ state: value.state, stateHash, createdAt: fixtureNow, expiresAt: row?.expires_at ?? null, purpose: row?.purpose ?? null, returnContext: row?.return_context ?? null, visitRefPresent: !!row?.visit_ref });
      }
      if (action === 'google/state-consume') {
        const consumed = await google.consumeState(String(body.state ?? ''), validHash(body.browserHash), FINGERPRINT);
        return json(consumed ? { accepted: true, stateHash: consumed.stateHash, purpose: consumed.purpose, returnContext: consumed.returnContext, visitRefPresent: !!consumed.visitRef } : { accepted: false });
      }
      if (action === 'google/session-issue') {
        const profile = FAKE_IDENTITIES[body.identity === 'secondary' ? 'secondary' : body.identity === 'booking' ? 'booking' : 'primary'];
        const issued = await google.issueSession({ ...profile, expiresAt: fixtureNow + 3600000 }, FINGERPRINT, 0, validHash(body.stateHash));
        return json(issued);
      }
      if (action === 'google/session-read') {
        const profile = await google.session(String(body.token ?? ''), FINGERPRINT);
        return json(profile ? { authenticated: true, purpose: profile.purpose, visitRefPresent: !!profile.visitRef, expiresAt: profile.expiresAt } : { authenticated: false });
      }
      if (action === 'google/revoke') {
        await google.revoke(typeof body.token === 'string' ? body.token : null, validHash(body.browserHash), validHash(body.visitorHash));
        return json({ revoked: true });
      }
      if (action === 'google/revoke-pending-visit') {
        await google.revoke(null, validHash(body.browserHash), validHash(body.visitorHash));
        return json({ revoked: true });
      }
      if (action === 'account/read') {
        const { identity } = await identityFor(env, String(body.token ?? ''), workspace);
        return json(await accounts.read(identity.subjectKey));
      }
      if (action === 'account/export') {
        const { identity } = await identityFor(env, String(body.token ?? ''), workspace);
        return json(await accounts.export(identity.subjectKey));
      }
      if (action === 'account/save-preferences') {
        const { identity } = await identityFor(env, String(body.token ?? ''), workspace);
        return json(await accounts.savePreferences(identity, body.value));
      }
      if (action === 'account/forget') {
        const { identity } = await identityFor(env, String(body.token ?? ''), workspace);
        return json(await accounts.forget(identity, body.value, body.visitorHash ? validHash(body.visitorHash) : undefined));
      }
      if (action === 'account/record-interaction') {
        const visitorHash = validHash(body.visitorHash);
        const { identity } = body.token ? await identityFor(env, String(body.token), workspace) : { identity: null };
        return json(await accounts.recordInteraction(visitorHash, body.value, identity));
      }
      if (action === 'claim/failure-trigger/create') {
        await env.DB.prepare("CREATE TRIGGER qa_customer_account_claim_failure BEFORE UPDATE ON customer_account_interactions WHEN OLD.kind='visit' BEGIN SELECT RAISE(ABORT,'synthetic visit claim failure'); END").run();
        return json({ installed: true });
      }
      if (action === 'claim/failure-trigger/drop') {
        await env.DB.prepare('DROP TRIGGER IF EXISTS qa_customer_account_claim_failure').run();
        return json({ removed: true });
      }
      if (action === 'inspect') {
        const names = ['customer_accounts', 'customer_account_preferences', 'customer_account_interactions', 'customer_google_oauth_states', 'customer_google_prefill_sessions'] as const;
        const counts = Object.fromEntries(await Promise.all(names.map(async name => [name, await count(env, name, workspace)] as const)));
        const interactions = await env.DB.prepare('SELECT kind,account_id,event,app_ref_json,request_key,expires_at,revoked_at FROM customer_account_interactions WHERE workspace_id=?')
          .bind(workspace).all<{ kind: string; account_id: string | null; event: string | null; app_ref_json: string; request_key: string; expires_at: number; revoked_at: number | null }>();
        const profiles = await env.DB.prepare('SELECT profile_ciphertext,google_subject,revoked_at FROM customer_google_prefill_sessions WHERE workspace_id=?').bind(workspace)
          .all<{ profile_ciphertext: string; google_subject: string; revoked_at: number | null }>();
        const eventRows = interactions.results ?? [];
        return json({
          counts,
          interactionKinds: { visits: eventRows.filter(row => row.kind === 'visit').length, events: eventRows.filter(row => row.kind === 'event').length },
          associatedEvents: eventRows.filter(row => row.kind === 'event' && row.account_id !== null).length,
          anonymousEvents: eventRows.filter(row => row.kind === 'event' && row.account_id === null).length,
          revokedVisits: eventRows.filter(row => row.kind === 'visit' && row.revoked_at !== null).length,
          profileCiphertextPresent: (profiles.results ?? []).every(row => /^v1\./.test(row.profile_ciphertext)),
          profilePlaintextAbsent: (profiles.results ?? []).every(row => !row.profile_ciphertext.includes(FAKE_IDENTITIES.primary.email) && !row.profile_ciphertext.includes(FAKE_IDENTITIES.primary.name)),
        });
      }
      if (action === 'inspect/account-by-subject') {
        const identityName = body.identity === 'secondary' ? 'secondary' : body.identity === 'booking' ? 'booking' : 'primary';
        const subjectKey = await customerAccountSubjectKey(workspace, 'https://accounts.google.com', FAKE_IDENTITIES[identityName].subject);
        const row = await env.DB.prepare('SELECT erased_at FROM customer_accounts WHERE workspace_id=? AND subject_key=?').bind(workspace, subjectKey).first<{ erased_at: number | null }>();
        return json({ account: await accounts.read(subjectKey), export: await accounts.export(subjectKey), erasureFenceRetained: row?.erased_at !== null && row?.erased_at !== undefined });
      }
      if (action === 'inspect/visit') {
        const visitorHash = validHash(body.visitorHash), visitHash = await sha256(validUuid(body.visitId));
        const primarySubject = await customerAccountSubjectKey(workspace, 'https://accounts.google.com', FAKE_IDENTITIES.primary.subject);
        const secondarySubject = await customerAccountSubjectKey(workspace, 'https://accounts.google.com', FAKE_IDENTITIES.secondary.subject);
        const [primary, secondary, header, events] = await Promise.all([
          env.DB.prepare('SELECT id FROM customer_accounts WHERE workspace_id=? AND subject_key=?').bind(workspace, primarySubject).first<{ id: string }>(),
          env.DB.prepare('SELECT id FROM customer_accounts WHERE workspace_id=? AND subject_key=?').bind(workspace, secondarySubject).first<{ id: string }>(),
          env.DB.prepare("SELECT account_id,revoked_at FROM customer_account_interactions WHERE workspace_id=? AND visitor_hash=? AND visit_hash=? AND kind='visit'").bind(workspace, visitorHash, visitHash).first<{ account_id: string | null; revoked_at: number | null }>(),
          env.DB.prepare("SELECT account_id FROM customer_account_interactions WHERE workspace_id=? AND visitor_hash=? AND visit_hash=? AND kind='event'").bind(workspace, visitorHash, visitHash).all<{ account_id: string | null }>(),
        ]);
        const rows = events.results ?? [];
        return json({
          headerPrimary: !!header && !!primary && header.account_id === primary.id,
          headerSecondary: !!header && !!secondary && header.account_id === secondary.id,
          headerRevoked: !!header && header.revoked_at !== null,
          primaryEventCount: primary ? rows.filter(row => row.account_id === primary.id).length : 0,
          secondaryEventCount: secondary ? rows.filter(row => row.account_id === secondary.id).length : 0,
          anonymousEventCount: rows.filter(row => row.account_id === null).length,
        });
      }
      return json({ error: 'fixture_unavailable' }, 404);
    } catch {
      return json({ error: 'fixture_operation_failed' }, 500);
    }
  },
};
