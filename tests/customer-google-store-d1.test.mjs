import test from 'node:test';
import assert from 'node:assert/strict';

const base = process.env.TEST_CUSTOMER_GOOGLE_STORE_BASE_URL ?? '';
const token = process.env.TEST_CUSTOMER_GOOGLE_STORE_FIXTURE_TOKEN ?? '';
const config = process.env.TEST_CUSTOMER_GOOGLE_STORE_D1_CONFIG ?? '';
const persist = process.env.TEST_CUSTOMER_GOOGLE_STORE_D1_PERSIST ?? '';
const dbName = process.env.TEST_CUSTOMER_GOOGLE_STORE_D1_NAME ?? '';
const parsed = base ? new URL(base) : null;
const enabled = !!parsed && parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1'
  && parsed.port === '8796' && !!token
  && /\.sites-runtime\/customer-google-store-fixture\/wrangler\.json$/i.test(config.replaceAll('\\', '/'))
  && /\.wrangler\/customer-google-store-local-0[1-4]$/i.test(persist.replaceAll('\\', '/'))
  && dbName === 'site-creator-d1';

if (base && !enabled) throw new Error('Customer Google store tests require the dedicated local D1 fixture and exact isolated paths.');

async function call(action, body = {}) {
  const response = await fetch(`${base}/__qa/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-QA-Customer-Google-Store': token, Connection: 'close' },
    body: JSON.stringify(body),
  });
  let result;
  try { result = await response.json(); } catch { throw new Error(`Local store fixture returned non-JSON for ${action} (${response.status}).`); }
  assert.equal(response.status, 200, `${action} fixture action failed`);
  return result;
}

const fingerprint = 'a'.repeat(64);
const rotatedFingerprint = 'b'.repeat(64);
const browserHash = 'c'.repeat(64);
const otherBrowserHash = 'd'.repeat(64);
const identity = { subject: 'fixture-google-subject', name: 'Fixture Customer', email: 'customer@gmail.com' };

test('CustomerGoogleStore actual local D1 applies browser/config-bound one-use OAuth state, encrypted session and one-use return intent', {
  skip: !enabled && 'Set TEST_CUSTOMER_GOOGLE_STORE_* from the isolated local 26-migration fixture only.',
}, async t => {
  const ready = await call('init');
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.counts, { states: 0, sessions: 0 });

  const state = await call('state/create', { browserHash, returnTo: 'support-booking', fingerprint });
  assert.equal(/^[0-9a-f]{64}$/.test(state.state), true);
  assert.equal(/^[0-9a-f]{64}$/.test(state.nonce), true);
  assert.match(state.verifier, /^[A-Za-z0-9._~-]{43,128}$/);
  assert.equal(state.expiresAt - state.createdAt, 600_000);
  const encrypted = await call('inspect', { markers: [state.state, state.nonce, state.verifier] });
  assert.equal(encrypted.stateRows, 1);
  assert.equal(encrypted.stateCipherPresent, true);
  assert.equal(encrypted.plaintextMarkerMatches, 0);

  await t.test('wrong browser/configuration cannot consume; matching state consumes once', async () => {
    assert.deepEqual(await call('state/consume', { state: state.state, browserHash: otherBrowserHash, fingerprint }), { accepted: false });
    assert.deepEqual(await call('state/consume', { state: state.state, browserHash, fingerprint: rotatedFingerprint }), { accepted: false });
    assert.deepEqual(await call('state/consume', { state: state.state, browserHash, fingerprint }), { accepted: true, returnTo: 'support-booking' });
    assert.deepEqual(await call('state/consume', { state: state.state, browserHash, fingerprint }), { accepted: false });
  });

  const issued = await call('session/issue', { state: state.state, fingerprint, identity });
  assert.equal(/^[0-9a-f]{64}$/.test(issued.token), true);
  assert.ok(issued.expiresAt > state.createdAt);
  const sessionState = await call('session/read', { token: issued.token, fingerprint });
  assert.deepEqual(sessionState, {
    authenticated: true, subjectMatches: true, profileMatches: true,
    prefillPending: true, prefillReturnTo: 'support-booking',
  });
  const encryptedSession = await call('inspect', { markers: [issued.token, identity.name, identity.email] });
  assert.equal(encryptedSession.sessionRows, 1);
  assert.equal(encryptedSession.profileCipherPresent, true);
  assert.equal(encryptedSession.plaintextMarkerMatches, 0);
  assert.deepEqual(await call('session/read', { token: issued.token, fingerprint: rotatedFingerprint }), {
    authenticated: false, subjectMatches: false, profileMatches: false, prefillPending: false, prefillReturnTo: null,
  });
  assert.deepEqual(await call('session/read-wrong-key', { token: issued.token, fingerprint }), {
    authenticated: false, subjectMatches: false, profileMatches: false, prefillPending: false, prefillReturnTo: null,
  });

  assert.deepEqual(await call('intent/consume', { token: issued.token, fingerprint, returnTo: 'book' }), { accepted: false });
  const claims = await Promise.all([1, 2].map(() => call('intent/consume', { token: issued.token, fingerprint, returnTo: 'support-booking' })));
  assert.deepEqual(claims.map(value => value.accepted).sort(), [false, true]);
  assert.deepEqual(await call('session/read', { token: issued.token, fingerprint }), {
    authenticated: true, subjectMatches: true, profileMatches: true, prefillPending: false, prefillReturnTo: null,
  });
  assert.deepEqual(await call('intent/consume', { token: issued.token, fingerprint, returnTo: 'support-booking' }), { accepted: false });
});

test('intent/session/state expiry and logout are enforced by D1 reads and cleanup reports bounded work', {
  skip: !enabled && 'Set TEST_CUSTOMER_GOOGLE_STORE_* from the isolated local 26-migration fixture only.',
}, async () => {
  await call('clock/reset');
  const state = await call('state/create', { browserHash: 'e'.repeat(64), returnTo: 'book', fingerprint });
  await call('state/consume', { state: state.state, browserHash: 'e'.repeat(64), fingerprint });
  const issued = await call('session/issue', { state: state.state, fingerprint, identity });
  await call('clock/set', { now: state.createdAt + 300_001 });
  assert.deepEqual(await call('session/read', { token: issued.token, fingerprint }), {
    authenticated: true, subjectMatches: true, profileMatches: true, prefillPending: false, prefillReturnTo: null,
  });
  assert.deepEqual(await call('intent/consume', { token: issued.token, fingerprint, returnTo: 'book' }), { accepted: false });
  await call('revoke', { token: issued.token, browserHash: 'e'.repeat(64) });
  assert.deepEqual(await call('session/read', { token: issued.token, fingerprint }), {
    authenticated: false, subjectMatches: false, profileMatches: false, prefillPending: false, prefillReturnTo: null,
  });
  await call('clock/set', { now: state.expiresAt + 1 });
  const cleaned = await call('cleanup');
  assert.equal(typeof cleaned.statesDeleted, 'number');
  assert.equal(typeof cleaned.sessionsDeleted, 'number');
  await call('clock/reset');
});

test('logout revokes both linked families, wipes payloads, blocks late issue/create, and preserves other families through marker retention', {
  skip: !enabled && 'Set TEST_CUSTOMER_GOOGLE_STORE_* from the isolated local D1 fixture only.',
}, async () => {
  await call('clock/reset');
  const familyA = '1'.repeat(64), familyB = '2'.repeat(64), cookieFamily = '3'.repeat(64);
  const pendingA = await call('state/create', { browserHash: familyA, returnTo: 'book', fingerprint });
  const consumedA = await call('state/create', { browserHash: familyA, returnTo: 'support-booking', fingerprint });
  assert.deepEqual(await call('state/consume', { state: consumedA.state, browserHash: familyA, fingerprint }), { accepted: true, returnTo: 'support-booking' });
  const sessionA = await call('session/issue', { state: consumedA.state, fingerprint, identity });
  const pendingCookieFamily = await call('state/create', { browserHash: cookieFamily, returnTo: 'book', fingerprint });

  const stateB = await call('state/create', { browserHash: familyB, returnTo: 'book', fingerprint });
  await call('state/consume', { state: stateB.state, browserHash: familyB, fingerprint });
  const sessionB = await call('session/issue', { state: stateB.state, fingerprint, identity });
  const before = await call('inspect');

  await call('revoke', { token: sessionA.token, browserHash: cookieFamily });
  assert.deepEqual(await call('session/read', { token: sessionA.token, fingerprint }), {
    authenticated: false, subjectMatches: false, profileMatches: false, prefillPending: false, prefillReturnTo: null,
  });
  assert.deepEqual(await call('session/read', { token: sessionB.token, fingerprint }), {
    authenticated: true, subjectMatches: true, profileMatches: true, prefillPending: true, prefillReturnTo: 'book',
  });
  assert.deepEqual(await call('state/consume', { state: pendingA.state, browserHash: familyA, fingerprint }), { accepted: false });
  assert.deepEqual(await call('state/consume', { state: pendingCookieFamily.state, browserHash: cookieFamily, fingerprint }), { accepted: false });
  assert.deepEqual(await call('session/issue-attempt', { state: consumedA.state, fingerprint }), { issued: false });
  assert.deepEqual(await call('state/create-attempt', { browserHash: familyA, returnTo: 'book', fingerprint }), { accepted: false, reason: 'family_revoked' });
  assert.deepEqual(await call('state/create-attempt', { browserHash: cookieFamily, returnTo: 'book', fingerprint }), { accepted: false, reason: 'family_revoked' });
  assert.deepEqual(await call('state/create-attempt', { browserHash: familyB, returnTo: 'book', fingerprint }), { accepted: true, reason: null });

  const duringMarker = await call('inspect');
  assert.ok(duringMarker.revokedStateRows >= 3);
  assert.ok(duringMarker.revokedSessionRows >= 1);
  assert.equal(duringMarker.revokedPayloadsErased, true);
  assert.equal(duringMarker.plaintextMarkerMatches, 0);
  assert.equal(duringMarker.stateRows - before.stateRows, 1);
  assert.equal(duringMarker.sessionRows - before.sessionRows, 0);

  await call('clock/set', { now: pendingA.createdAt + 600_001 });
  await call('cleanup');
  const retained = await call('inspect');
  assert.ok(retained.revokedStateRows >= 3, 'revocation markers survive beyond the original 10-minute state lifetime');
  assert.ok(retained.revokedSessionRows >= 1);
  assert.deepEqual(await call('session/read', { token: sessionB.token, fingerprint }), {
    authenticated: true, subjectMatches: true, profileMatches: true, prefillPending: false, prefillReturnTo: null,
  });

  await call('clock/set', { now: pendingA.createdAt + 3_600_001 });
  await call('cleanup');
  const afterRetention = await call('inspect');
  assert.equal(afterRetention.revokedStateRows, 0);
  assert.equal(afterRetention.revokedSessionRows, 0);
  assert.deepEqual(await call('state/create-attempt', { browserHash: familyA, returnTo: 'book', fingerprint }), { accepted: true, reason: null });
  await call('clock/reset');
});
