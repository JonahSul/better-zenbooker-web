import { CustomerGoogleFamilyRevokedError, CustomerGoogleStore } from '../../lib/customer-google-store';
import { sha256 } from '../../lib/admin-auth-core';
import { customerGoogleRoute } from '../../lib/customer-google-server';

interface Env {
  DB: D1Database;
  QA_CUSTOMER_GOOGLE_FIXTURE_TOKEN: string;
  QA_CUSTOMER_GOOGLE_WORKSPACE: string;
  APP_CREDENTIAL_ENCRYPTION_KEY: string;
}

const TOKEN_HEADER = 'x-qa-customer-google-store';
const FIXTURE_ORIGIN = 'https://demo.example.test';
const FIXTURE_CONFIG = {
  clientId: 'customer-connect-fixture.apps.googleusercontent.com',
  clientSecret: 'synthetic-only-client-secret',
  fingerprint: 'a'.repeat(64),
  revision: 7,
};
const FIXTURE_IDENTITY = {
  subject: 'fixture-google-subject',
  name: 'Fixture Customer',
  email: 'customer@gmail.com',
  expiresAt: 0,
};
let fixtureNow = Date.now();

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

async function count(db: D1Database, table: 'customer_google_oauth_states' | 'customer_google_prefill_sessions', workspace: string) {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id=?`).bind(workspace).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export default {
  async fetch(request: Request, env: Env) {
    if (request.headers.get(TOKEN_HEADER) !== env.QA_CUSTOMER_GOOGLE_FIXTURE_TOKEN) return json({ error: 'fixture_unavailable' }, 404);
    if (new URL(request.url).hostname !== '127.0.0.1') return json({ error: 'fixture_unavailable' }, 404);
    const path = new URL(request.url).pathname.replace(/^\/__qa\//, '');
    let body: Record<string, unknown> = {};
    if (request.method === 'POST') {
      try { body = await request.json() as Record<string, unknown>; }
      catch { return json({ error: 'fixture_unavailable' }, 400); }
    }
    const store = (key = env.APP_CREDENTIAL_ENCRYPTION_KEY) => new CustomerGoogleStore(env.DB, env.QA_CUSTOMER_GOOGLE_WORKSPACE, key, () => fixtureNow);
    try {
      if (path === 'init') {
        const [states, sessions] = await Promise.all([
          count(env.DB, 'customer_google_oauth_states', env.QA_CUSTOMER_GOOGLE_WORKSPACE),
          count(env.DB, 'customer_google_prefill_sessions', env.QA_CUSTOMER_GOOGLE_WORKSPACE),
        ]);
        return json({ ready: states === 0 && sessions === 0, counts: { states, sessions } });
      }
      if (path === 'google/connect') {
        const connectRequest = new Request(`${FIXTURE_ORIGIN}/api/customer/google/connect`, {
          method: 'POST',
          headers: { Origin: FIXTURE_ORIGIN, 'Content-Type': 'application/json' },
          body: JSON.stringify(body.input),
        });
        return await customerGoogleRoute('connect', connectRequest, {
          store: store(),
          resolveConfig: async () => FIXTURE_CONFIG,
        });
      }
      if (path === 'state/contracts') {
        const rows = await env.DB.prepare('SELECT return_to,purpose,return_context FROM customer_google_oauth_states WHERE workspace_id=? ORDER BY created_at,state_hash')
          .bind(env.QA_CUSTOMER_GOOGLE_WORKSPACE)
          .all<{ return_to: string; purpose: string | null; return_context: string | null }>();
        const allowedContexts = new Set([
          'home', 'book', 'appointments', 'privacy', 'terms', 'support-chat', 'support-booking',
          'admin', 'admin-chat', 'admin-credentials', 'admin-bookings', 'admin-reviews', 'admin-analytics',
          'admin-experiments', 'admin-performance', 'admin-analysis', 'admin-support', 'admin-memory', 'admin-settings', 'admin-audit',
        ]);
        return json({ states: (rows.results ?? []).map(row => ({
          returnTo: ['book', 'support-booking'].includes(row.return_to) ? row.return_to : null,
          purpose: ['account', 'booking_prefill'].includes(String(row.purpose)) ? row.purpose : null,
          returnContext: row.return_context && allowedContexts.has(row.return_context) ? row.return_context : null,
        })) });
      }
      if (path === 'clock/reset') {
        const [states, sessions] = await Promise.all([
          env.DB.prepare('SELECT MAX(expires_at) AS latest FROM customer_google_oauth_states WHERE workspace_id=?').bind(env.QA_CUSTOMER_GOOGLE_WORKSPACE).first<{ latest: number | null }>(),
          env.DB.prepare('SELECT MAX(expires_at) AS latest FROM customer_google_prefill_sessions WHERE workspace_id=?').bind(env.QA_CUSTOMER_GOOGLE_WORKSPACE).first<{ latest: number | null }>(),
        ]);
        fixtureNow = Math.max(Date.now(), Number(states?.latest ?? 0) + 3_600_001, Number(sessions?.latest ?? 0) + 3_600_001);
        return json({ reset: true });
      }
      if (path === 'clock/set') {
        const now = body.now;
        if (!Number.isSafeInteger(now) || Number(now) < 1) return json({ error: 'invalid_clock' }, 400);
        fixtureNow = Number(now);
        return json({ updated: true });
      }
      if (path === 'state/create') {
        const browserHash = String(body.browserHash ?? ''), returnTo = body.returnTo, fingerprint = String(body.fingerprint ?? '');
        if (!/^[0-9a-f]{64}$/.test(browserHash) || !['book', 'support-booking'].includes(String(returnTo)) || !/^[0-9a-f]{64}$/.test(fingerprint)) return json({ error: 'invalid_state_input' }, 400);
        const createdAt = fixtureNow;
        const value = await store().createState(browserHash, returnTo as 'book' | 'support-booking', fingerprint);
        const stateHash = await sha256(value.state);
        const row = await env.DB.prepare('SELECT expires_at FROM customer_google_oauth_states WHERE state_hash=? AND workspace_id=?').bind(stateHash, env.QA_CUSTOMER_GOOGLE_WORKSPACE).first<{ expires_at: number }>();
        return json({ ...value, createdAt, expiresAt: row?.expires_at ?? null });
      }
      if (path === 'state/create-attempt') {
        try {
          await store().createState(String(body.browserHash ?? ''), String(body.returnTo ?? '') as 'book' | 'support-booking', String(body.fingerprint ?? ''));
          return json({ accepted: true, reason: null });
        } catch (error) {
          return json({ accepted: false, reason: error instanceof CustomerGoogleFamilyRevokedError ? 'family_revoked' : 'unavailable' });
        }
      }
      if (path === 'state/consume') {
        const value = await store().consumeState(String(body.state ?? ''), String(body.browserHash ?? ''), String(body.fingerprint ?? ''));
        return json(value ? { accepted: true, returnTo: value.returnTo } : { accepted: false });
      }
      if (path === 'session/issue') {
        const state = String(body.state ?? ''), fingerprint = String(body.fingerprint ?? '');
        if (!/^[0-9a-f]{64}$/.test(state) || !/^[0-9a-f]{64}$/.test(fingerprint)) return json({ error: 'invalid_session_input' }, 400);
        const stateHash = await sha256(state);
        const identity = { ...FIXTURE_IDENTITY, expiresAt: fixtureNow + 3_600_000 };
        const value = await store().issueSession(identity, fingerprint, 0, stateHash);
        return json(value);
      }
      if (path === 'session/issue-attempt') {
        const state = String(body.state ?? ''), fingerprint = String(body.fingerprint ?? '');
        if (!/^[0-9a-f]{64}$/.test(state) || !/^[0-9a-f]{64}$/.test(fingerprint)) return json({ error: 'invalid_session_input' }, 400);
        try {
          const stateHash = await sha256(state);
          await store().issueSession({ ...FIXTURE_IDENTITY, expiresAt: fixtureNow + 3_600_000 }, fingerprint, 0, stateHash);
          return json({ issued: true });
        } catch {
          return json({ issued: false });
        }
      }
      if (path === 'session/read' || path === 'session/read-wrong-key') {
        const selectedStore = path.endsWith('wrong-key') ? store(btoa(String.fromCharCode(...new Uint8Array(32).fill(0x71)))) : store();
        const value = await selectedStore.session(String(body.token ?? ''), String(body.fingerprint ?? ''));
        return json(value ? {
          authenticated: true,
          subjectMatches: value.subject === FIXTURE_IDENTITY.subject,
          profileMatches: value.name === FIXTURE_IDENTITY.name && value.email === FIXTURE_IDENTITY.email,
          prefillPending: value.prefillPending,
          prefillReturnTo: value.prefillPending ? value.prefillReturnTo : null,
        } : { authenticated: false, subjectMatches: false, profileMatches: false, prefillPending: false, prefillReturnTo: null });
      }
      if (path === 'intent/consume') {
        const accepted = await store().consumePrefillIntent(String(body.token ?? ''), String(body.fingerprint ?? ''), String(body.returnTo ?? '') as 'book' | 'support-booking');
        return json({ accepted });
      }
      if (path === 'revoke') {
        await store().revoke(String(body.token ?? ''), String(body.browserHash ?? ''));
        return json({ revoked: true, revokedAt: fixtureNow });
      }
      if (path === 'cleanup') {
        const before = await Promise.all([
          count(env.DB, 'customer_google_oauth_states', env.QA_CUSTOMER_GOOGLE_WORKSPACE),
          count(env.DB, 'customer_google_prefill_sessions', env.QA_CUSTOMER_GOOGLE_WORKSPACE),
        ]);
        await store().cleanup();
        const after = await Promise.all([
          count(env.DB, 'customer_google_oauth_states', env.QA_CUSTOMER_GOOGLE_WORKSPACE),
          count(env.DB, 'customer_google_prefill_sessions', env.QA_CUSTOMER_GOOGLE_WORKSPACE),
        ]);
        return json({ statesDeleted: before[0] - after[0], sessionsDeleted: before[1] - after[1] });
      }
      if (path === 'inspect') {
        const markers = Array.isArray(body.markers) ? body.markers.filter((item): item is string => typeof item === 'string' && item.length < 256) : [];
        const [stateRows, sessionRows] = await Promise.all([
          env.DB.prepare('SELECT verifier_ciphertext,nonce_hash,revoked_at,browser_hash FROM customer_google_oauth_states WHERE workspace_id=?').bind(env.QA_CUSTOMER_GOOGLE_WORKSPACE).all<{ verifier_ciphertext: string; nonce_hash: string; revoked_at: number | null; browser_hash: string }>(),
          env.DB.prepare('SELECT profile_ciphertext,google_subject,revoked_at,browser_hash FROM customer_google_prefill_sessions WHERE workspace_id=?').bind(env.QA_CUSTOMER_GOOGLE_WORKSPACE).all<{ profile_ciphertext: string; google_subject: string; revoked_at: number | null; browser_hash: string }>(),
        ]);
        const stored = [...(stateRows.results ?? []).map(row => row.verifier_ciphertext), ...(sessionRows.results ?? []).map(row => row.profile_ciphertext)];
        const revokedStates = (stateRows.results ?? []).filter(row => row.revoked_at !== null);
        const revokedSessions = (sessionRows.results ?? []).filter(row => row.revoked_at !== null);
        return json({
          stateRows: (stateRows.results ?? []).length,
          sessionRows: (sessionRows.results ?? []).length,
          stateCipherPresent: (stateRows.results ?? []).every(row => /^v1\./.test(row.verifier_ciphertext)),
          profileCipherPresent: (sessionRows.results ?? []).every(row => /^v1\./.test(row.profile_ciphertext)),
          plaintextMarkerMatches: markers.filter(marker => stored.some(value => value.includes(marker))).length,
          revokedStateRows: revokedStates.length,
          revokedSessionRows: revokedSessions.length,
          revokedPayloadsErased: revokedStates.every(row => row.verifier_ciphertext === '' && row.nonce_hash === '')
            && revokedSessions.every(row => row.profile_ciphertext === '' && row.google_subject === ''),
        });
      }
      return json({ error: 'fixture_unavailable' }, 404);
    } catch {
      return json({ error: 'fixture_operation_failed' }, 500);
    }
  },
};
