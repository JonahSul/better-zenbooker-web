import { CustomerGoogleStore } from '../../lib/customer-google-store';
import { CredentialStore } from '../../lib/credential-store';
import { encryptValue } from '../../lib/encrypted-value';
import { randomOpaque, sha256 } from '../../lib/admin-auth-core';

interface Env {
  DB: D1Database;
  QA_CUSTOMER_GOOGLE_MIGRATION_FIXTURE_TOKEN: string;
  QA_CUSTOMER_GOOGLE_MIGRATION_WORKSPACE: string;
  QA_CUSTOMER_GOOGLE_MIGRATION_PROJECT: string;
  APP_CREDENTIAL_ENCRYPTION_KEY: string;
}

const tokenHeader = 'x-qa-customer-google-migration';
const fingerprint = 'a'.repeat(64);
const browserHash = 'b'.repeat(64);
const subject = 'synthetic-legacy-google-subject';
const name = 'Synthetic Legacy Customer';
const email = 'legacy-customer@example.invalid';

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

async function migrations(db: D1Database) {
  try {
    const row = await db.prepare('SELECT COUNT(*) AS count FROM d1_migrations').first<{ count: number }>();
    return Number(row?.count ?? -1);
  } catch {
    return -1;
  }
}

async function snapshot(db: D1Database, workspace: string, projectId: string) {
  const states = await db.prepare(`SELECT state_hash,browser_hash,nonce_hash,verifier_ciphertext,return_to,config_fingerprint,expires_at,created_at,consumed_at,revoked_at
    FROM customer_google_oauth_states WHERE workspace_id=? ORDER BY state_hash`).bind(workspace).all<Record<string, unknown>>();
  const sessions = await db.prepare(`SELECT session_hash,workspace_id,issuer,google_subject,profile_ciphertext,config_fingerprint,expires_at,created_at,intent_return_to,intent_expires_at,intent_consumed_at,browser_hash,revoked_at
    FROM customer_google_prefill_sessions WHERE workspace_id=? ORDER BY session_hash`).bind(workspace).all<Record<string, unknown>>();
  const project = await db.prepare('SELECT project_id,revision,sealed_at,operation_token FROM app_credential_state WHERE project_id=?').bind(projectId).first<Record<string, unknown>>();
  const credential = await db.prepare("SELECT project_id,credential_key,ciphertext,updated_at FROM app_credentials WHERE project_id=? AND credential_key='ZENBOOKER_API_KEY'").bind(projectId).first<Record<string, unknown>>();
  const payload = JSON.stringify({ states: states.results ?? [], sessions: sessions.results ?? [], project, credential });
  return { digest: await sha256(payload), stateCount: states.results?.length ?? 0, sessionCount: sessions.results?.length ?? 0, credentialPresent: !!credential, credentialStatePresent: !!project };
}

export default {
  async fetch(request: Request, env: Env) {
    if (request.headers.get(tokenHeader) !== env.QA_CUSTOMER_GOOGLE_MIGRATION_FIXTURE_TOKEN || new URL(request.url).hostname !== '127.0.0.1') {
      return json({ error: 'fixture_unavailable' }, 404);
    }
    if (request.method !== 'POST') return json({ error: 'fixture_unavailable' }, 404);
    let body: Record<string, unknown>;
    try { body = await request.json() as Record<string, unknown>; }
    catch { return json({ error: 'fixture_unavailable' }, 400); }
    const action = new URL(request.url).pathname.replace(/^\/__qa\//, '');
    const workspace = env.QA_CUSTOMER_GOOGLE_MIGRATION_WORKSPACE;
    try {
      if (action === 'seed-legacy') {
        const now = Number(body.now);
        if (!Number.isSafeInteger(now) || now < 1) return json({ error: 'invalid_fixture_clock' }, 400);
        const sessionState = randomOpaque();
        const sessionStateHash = await sha256(sessionState);
        const stateNonce = randomOpaque();
        const verifier = randomOpaque();
        const encryptedVerifier = await encryptValue(verifier, `customer-google:v1:${workspace}:pkce:${sessionStateHash}`, env.APP_CREDENTIAL_ENCRYPTION_KEY);
        const pendingState = randomOpaque();
        const pendingStateHash = await sha256(pendingState);
        const pendingNonce = randomOpaque();
        const pendingVerifier = randomOpaque();
        const encryptedPendingVerifier = await encryptValue(pendingVerifier, `customer-google:v1:${workspace}:pkce:${pendingStateHash}`, env.APP_CREDENTIAL_ENCRYPTION_KEY);
        const sessionToken = randomOpaque();
        const sessionHash = await sha256(sessionToken);
        const profile = JSON.stringify({ name, email });
        const encryptedProfile = await encryptValue(profile, `customer-google:v1:${workspace}:profile:${sessionHash}`, env.APP_CREDENTIAL_ENCRYPTION_KEY);
        const credentialProject = env.QA_CUSTOMER_GOOGLE_MIGRATION_PROJECT;
        const credentialCiphertext = await encryptValue('synthetic-zenbooker-api-key-fixture-only', `app-credential:v1:${credentialProject}:ZENBOOKER_API_KEY`, env.APP_CREDENTIAL_ENCRYPTION_KEY);
        await env.DB.batch([
          env.DB.prepare(`INSERT INTO customer_google_oauth_states(state_hash,workspace_id,browser_hash,nonce_hash,verifier_ciphertext,return_to,config_fingerprint,expires_at,created_at,consumed_at,revoked_at)
            VALUES(?,?,?,?,?,'book',?,?,?, ?,NULL)`).bind(sessionStateHash, workspace, browserHash, await sha256(stateNonce), encryptedVerifier, fingerprint, now + 600_000, now, now),
          env.DB.prepare(`INSERT INTO customer_google_oauth_states(state_hash,workspace_id,browser_hash,nonce_hash,verifier_ciphertext,return_to,config_fingerprint,expires_at,created_at,consumed_at,revoked_at)
            VALUES(?,?,?,?,?,'support-booking',?,?,?,NULL,NULL)`).bind(pendingStateHash, workspace, browserHash, await sha256(pendingNonce), encryptedPendingVerifier, fingerprint, now + 600_000, now),
          env.DB.prepare(`INSERT INTO customer_google_prefill_sessions(session_hash,workspace_id,issuer,google_subject,profile_ciphertext,config_fingerprint,expires_at,created_at,intent_return_to,intent_expires_at,intent_consumed_at,browser_hash,revoked_at)
            VALUES(?,?,'https://accounts.google.com',?,?,?,?,?,'book',?,NULL,?,NULL)`).bind(sessionHash, workspace, subject, encryptedProfile, fingerprint, now + 3_600_000, now, now + 300_000, browserHash),
          env.DB.prepare('INSERT INTO app_credential_state(project_id,revision,sealed_at,operation_token) VALUES(?,4,?,NULL)').bind(credentialProject, now - 1_000),
          env.DB.prepare("INSERT INTO app_credentials(project_id,credential_key,ciphertext,updated_at) VALUES(?,'ZENBOOKER_API_KEY',?,?)").bind(credentialProject, credentialCiphertext, now),
        ]);
        return json({ seeded: true, now, state: pendingState, verifier: pendingVerifier, token: sessionToken, fingerprint, snapshot: await snapshot(env.DB, workspace, credentialProject), migrations: await migrations(env.DB) });
      }
      if (action === 'verify-legacy') {
        const now = Number(body.now);
        const before = String(body.beforeDigest ?? '');
        const current = await snapshot(env.DB, workspace, env.QA_CUSTOMER_GOOGLE_MIGRATION_PROJECT);
        const migrationCount = await migrations(env.DB);
        if (!Number.isSafeInteger(now) || now < 1 || !/^[0-9a-f]{64}$/.test(before)) return json({ error: 'invalid_fixture_input' }, 400);
        const store = new CustomerGoogleStore(env.DB, workspace, env.APP_CREDENTIAL_ENCRYPTION_KEY, () => now);
        const credentialStore = new CredentialStore(env.DB, env.QA_CUSTOMER_GOOGLE_MIGRATION_PROJECT, env.APP_CREDENTIAL_ENCRYPTION_KEY);
        const credential = await credentialStore.resolve('ZENBOOKER_API_KEY');
        const credentialState = await credentialStore.state();
        const session = await store.session(String(body.sessionToken ?? ''), fingerprint);
        const state = await store.consumeState(String(body.pendingState ?? ''), browserHash, fingerprint);
        const beforeIntent = await store.session(String(body.sessionToken ?? ''), fingerprint);
        const intentAccepted = await store.consumePrefillIntent(String(body.sessionToken ?? ''), fingerprint, 'book');
        const afterIntent = await store.session(String(body.sessionToken ?? ''), fingerprint);
        return json({
          migrations: migrationCount,
          preservedBeforeReads: current.digest === before,
          counts: { states: current.stateCount, sessions: current.sessionCount },
          legacyCredentialPreserved: current.credentialPresent && current.credentialStatePresent && credential.source === 'encrypted_d1' && credential.value === 'synthetic-zenbooker-api-key-fixture-only' && credentialState.revision === 4 && credentialState.sealed_at === now - 1_000,
          migratedColumnsPresent: await hasMigratedColumns(env.DB),
          sessionReadable: !!session,
          syntheticProfileMatches: session?.subject === subject && session.name === name && session.email === email,
          legacyPurposeDefaultsToBooking: session?.purpose === 'booking_prefill',
          pendingIntentPreserved: session?.prefillPending === true && session.prefillReturnTo === 'book',
          stateReadable: !!state,
          pendingStatePurposeDefaultsToBooking: state?.purpose === 'booking_prefill',
          stateReturnContextFallsBack: state?.returnContext === 'support-booking',
          verifierDecrypts: state?.verifier === String(body.expectedVerifier ?? ''),
          intentConsumableOnce: intentAccepted === true && beforeIntent?.prefillPending === true && afterIntent?.prefillPending === false,
          finalDigest: (await snapshot(env.DB, workspace, env.QA_CUSTOMER_GOOGLE_MIGRATION_PROJECT)).digest,
        });
      }
      return json({ error: 'fixture_unavailable' }, 404);
    } catch {
      return json({ error: 'fixture_operation_failed' }, 500);
    }
  },
};

async function hasMigratedColumns(db: D1Database) {
  const stateColumns = await db.prepare('PRAGMA table_info(customer_google_oauth_states)').all<{ name: string }>();
  const sessionColumns = await db.prepare('PRAGMA table_info(customer_google_prefill_sessions)').all<{ name: string }>();
  const stateNames = new Set((stateColumns.results ?? []).map(row => row.name));
  const sessionNames = new Set((sessionColumns.results ?? []).map(row => row.name));
  return ['purpose', 'return_context', 'visit_ref'].every(name => stateNames.has(name))
    && ['intent_purpose', 'visit_ref'].every(name => sessionNames.has(name));
}
