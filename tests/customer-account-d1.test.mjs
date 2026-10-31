import test from 'node:test';
import assert from 'node:assert/strict';

const base = process.env.TEST_CUSTOMER_ACCOUNT_D1_BASE_URL ?? '';
const token = process.env.TEST_CUSTOMER_ACCOUNT_D1_TOKEN ?? '';
const config = process.env.TEST_CUSTOMER_ACCOUNT_D1_CONFIG ?? '';
const persist = process.env.TEST_CUSTOMER_ACCOUNT_D1_PERSIST ?? '';
const dbName = process.env.TEST_CUSTOMER_ACCOUNT_D1_NAME ?? '';
const parsed = base ? new URL(base) : null;
const enabled = !!parsed && parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1'
  && parsed.port === '8800' && !!token
  && /\.sites-runtime\/customer-account-fixture\/wrangler\.json$/i.test(config.replaceAll('\\', '/'))
  && /\.wrangler\/customer-account-local-01$/i.test(persist.replaceAll('\\', '/'))
  && dbName === 'site-creator-d1';

if (base && !enabled) throw new Error('Customer account D1 tests require the dedicated fresh loopback fixture and exact isolated paths.');

async function call(action, body = {}) {
  const response = await fetch(`${base}/__qa/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-QA-Customer-Account-Fixture': token, Connection: 'close' },
    body: JSON.stringify(body),
  });
  let result;
  try { result = await response.json(); } catch { throw new Error(`Local account fixture returned non-JSON for ${action} (${response.status}).`); }
  return { status: response.status, result };
}

const workspaceA = 'qa-customer-account-workspace-a';
const workspaceB = 'qa-customer-account-workspace-b';
const visitorA = 'a'.repeat(64);
const visitorB = 'b'.repeat(64);
const browserA = 'c'.repeat(64);
const browserB = 'd'.repeat(64);
const primaryVisitId = '10000000-0000-4000-8000-000000000001';
const secondaryVisitId = '10000000-0000-4000-8000-000000000002';
const primaryThreadId = '20000000-0000-4000-8000-000000000001';
const secondaryThreadId = '20000000-0000-4000-8000-000000000002';
const requestKeys = {
  booking: '30000000-0000-4000-8000-000000000001',
  help: '30000000-0000-4000-8000-000000000002',
  preference: '30000000-0000-4000-8000-000000000003',
  forget: '30000000-0000-4000-8000-000000000004',
  anonymous: '30000000-0000-4000-8000-000000000005',
};

test('CustomerAccountStore actual local D1 scopes, claims, replays, exports and forgets current-visit metadata', {
  skip: !enabled && 'Set TEST_CUSTOMER_ACCOUNT_D1_* only from the fresh dedicated 29-migration local fixture.',
}, async () => {
  const init = await call('init');
  assert.equal(init.status, 200);
  assert.equal(init.result.ready, true, 'fixture has the expected migrations and empty customer/account tables');
  assert.equal(init.result.migrations, 29, 'fixture migration count is read from D1, not hard-coded by the test');

  const seededA = await call('visitor/seed', { visitorHash: visitorA, threadId: primaryThreadId });
  assert.equal(seededA.status, 200);
  assert.equal(seededA.result.seeded, true);
  const bookingEvent = { visitId: primaryVisitId, requestKey: requestKeys.booking, event: 'booking_opened', context: 'book' };
  assert.deepEqual((await call('visit/record', { visitorHash: visitorA, value: bookingEvent })).result, { recorded: true, duplicate: false });
  assert.deepEqual((await call('visit/record', { visitorHash: visitorA, value: bookingEvent })).result, { recorded: true, duplicate: true });
  assert.equal((await call('visit/prepare', { visitorHash: visitorA, visitId: primaryVisitId })).status, 200);

  const primaryState = await call('google/state-create', { visitorHash: visitorA, visitId: primaryVisitId, browserHash: browserA });
  assert.equal(primaryState.status, 200);
  assert.equal(primaryState.result.purpose, 'account');
  assert.equal(primaryState.result.returnContext, 'book');
  assert.equal(primaryState.result.visitRefPresent, true);
  const consumed = await call('google/state-consume', { state: primaryState.result.state, browserHash: browserA });
  assert.equal(consumed.status, 200);
  assert.deepEqual({ accepted: consumed.result.accepted, purpose: consumed.result.purpose, returnContext: consumed.result.returnContext, visitRefPresent: consumed.result.visitRefPresent }, {
    accepted: true, purpose: 'account', returnContext: 'book', visitRefPresent: true,
  });
  assert.deepEqual((await call('google/state-consume', { state: primaryState.result.state, browserHash: browserA })).result, { accepted: false });

  // Force the visit-claim statement to fail inside the session/account D1 batch.
  // The Worker fixture exposes only this local synthetic trigger; production has no such hook.
  assert.equal((await call('claim/failure-trigger/create')).result.installed, true);
  const beforeFailedClaim = (await call('inspect')).result.counts;
  const failedIssue = await call('google/session-issue', { stateHash: primaryState.result.stateHash, identity: 'primary' });
  assert.equal(failedIssue.status, 500);
  assert.deepEqual((await call('inspect')).result.counts, beforeFailedClaim, 'failed claim rolls back session, account, and visit association together');
  assert.equal((await call('claim/failure-trigger/drop')).result.removed, true);

  const issued = await call('google/session-issue', { stateHash: primaryState.result.stateHash, identity: 'primary' });
  assert.equal(issued.status, 200);
  assert.match(issued.result.token, /^[0-9a-f]{64}$/);
  assert.equal((await call('google/session-read', { token: issued.result.token })).result.authenticated, true);
  const account = await call('account/read', { token: issued.result.token });
  assert.equal(account.status, 200);
  assert.equal(account.result.exists, true);
  assert.equal(account.result.preferences.remember, false);

  const primaryLink = await call('inspect/visit', { visitorHash: visitorA, visitId: primaryVisitId, identity: 'primary' });
  assert.equal(primaryLink.result.headerPrimary, true);
  assert.equal(primaryLink.result.primaryEventCount, 1);

  // The same visit cannot be claimed by a different verified subject.
  const competingState = await call('google/state-create', { visitorHash: visitorA, visitId: primaryVisitId, browserHash: browserB });
  assert.equal(competingState.status, 200);
  assert.equal((await call('google/state-consume', { state: competingState.result.state, browserHash: browserB })).result.accepted, true);
  const competingSession = await call('google/session-issue', { stateHash: competingState.result.stateHash, identity: 'secondary' });
  assert.equal(competingSession.status, 200, 'account sign-in may succeed without claiming another account\'s visit');
  const afterCompetingClaim = await call('inspect/visit', { visitorHash: visitorA, visitId: primaryVisitId, identity: 'secondary' });
  assert.equal(afterCompetingClaim.result.headerPrimary, true);
  assert.equal(afterCompetingClaim.result.headerSecondary, false);
  assert.equal(afterCompetingClaim.result.primaryEventCount, 1);
  assert.equal(afterCompetingClaim.result.secondaryEventCount, 0);
  assert.deepEqual((await call('inspect/account-by-subject', { identity: 'secondary', workspace: 'default' })).result.export.interactions, []);

  // Booking-prefill OAuth can issue its separate session but never creates or claims an app account.
  const bookingState = await call('google/state-create', { purpose: 'booking_prefill', browserHash: '9'.repeat(64) });
  assert.equal(bookingState.status, 200);
  assert.equal(bookingState.result.purpose, 'booking_prefill');
  assert.equal(bookingState.result.visitRefPresent, false);
  assert.equal((await call('google/state-consume', { state: bookingState.result.state, browserHash: '9'.repeat(64) })).result.accepted, true);
  const bookingSession = await call('google/session-issue', { stateHash: bookingState.result.stateHash, identity: 'booking' });
  assert.equal(bookingSession.status, 200);
  assert.equal((await call('google/session-read', { token: bookingSession.result.token })).result.purpose, 'booking_prefill');
  assert.equal((await call('inspect/account-by-subject', { identity: 'booking' })).result.account.exists, false);

  // A different tenant cannot read the same issuer/subject or borrow the visit reference.
  assert.equal((await call('inspect/account-by-subject', { identity: 'primary', workspace: 'other' })).result.account.exists, false);
  assert.equal((await call('visit/prepare', { visitorHash: visitorA, visitId: primaryVisitId, workspace: 'other' })).status, 500);

  const helpEvent = { visitId: primaryVisitId, requestKey: requestKeys.help, event: 'help_thread_started', threadId: primaryThreadId, threadRevision: 1 };
  assert.deepEqual((await call('account/record-interaction', { visitorHash: visitorA, token: issued.result.token, value: helpEvent })).result, { recorded: true, duplicate: false });
  assert.deepEqual((await call('account/record-interaction', { visitorHash: visitorA, token: issued.result.token, value: helpEvent })).result, { recorded: true, duplicate: true });
  const interactionLink = await call('inspect/visit', { visitorHash: visitorA, visitId: primaryVisitId, identity: 'primary' });
  assert.equal(interactionLink.result.primaryEventCount, 2);
  assert.equal(interactionLink.result.secondaryEventCount, 0);

  const preferences = { expectedRevision: 1, requestKey: requestKeys.preference, remember: true, answerLength: 'short', serviceInterests: ['fall_blowout'] };
  const savedPreferences = await call('account/save-preferences', { token: issued.result.token, value: preferences });
  assert.equal(savedPreferences.status, 200);
  assert.equal(savedPreferences.result.revision, 2);
  assert.deepEqual(savedPreferences.result.preferences, { remember: true, answerLength: 'short', serviceInterests: ['fall_blowout'] });
  const replayedPreferences = await call('account/save-preferences', { token: issued.result.token, value: preferences });
  assert.equal(replayedPreferences.result.revision, 2, 'same-key preference replay does not advance revision');

  const exported = await call('account/export', { token: issued.result.token });
  assert.equal(exported.status, 200);
  assert.equal(exported.result.interactions.length, 2);
  assert.deepEqual(new Set(exported.result.interactions.map(row => row.event)), new Set(['booking_opened', 'help_thread_started']));
  const serializedExport = JSON.stringify(exported.result);
  for (const sentinel of ['Synthetic Customer Name', 'synthetic-customer@example.invalid', 'PRIVATE_DIAGNOSTIC_SENTINEL', 'iframe', 'Authorization']) {
    assert.equal(serializedExport.includes(sentinel), false);
  }

  // Keep another visitor's anonymous visit separate from this account's deletion.
  const seededB = await call('visitor/seed', { visitorHash: visitorB, threadId: secondaryThreadId });
  assert.equal(seededB.status, 200);
  assert.equal(seededB.result.seeded, true);
  const anonymousEvent = { visitId: secondaryVisitId, requestKey: requestKeys.anonymous, event: 'booking_opened', context: 'support-booking' };
  assert.deepEqual((await call('visit/record', { visitorHash: visitorB, value: anonymousEvent })).result, { recorded: true, duplicate: false });

  const forgotten = await call('account/forget', {
    token: issued.result.token, visitorHash: visitorA,
    value: { expectedRevision: 2, requestKey: requestKeys.forget },
  });
  assert.equal(forgotten.status, 200);
  assert.equal(forgotten.result.exists, false);
  assert.equal(forgotten.result.revision, 3, 'forget retains only the revision tombstone');
  assert.deepEqual((await call('account/export', { token: issued.result.token })).result.interactions, []);
  const staleRevisionSave = await call('account/save-preferences', {
    token: issued.result.token,
    value: { expectedRevision: 2, requestKey: '30000000-0000-4000-8000-000000000009', remember: true, answerLength: 'short', serviceInterests: ['maintenance'] },
  });
  assert.equal(staleRevisionSave.status, 500, 'old expected revision cannot revive an erased account');
  const replayedForget = await call('account/forget', {
    token: issued.result.token, visitorHash: visitorA,
    value: { expectedRevision: 2, requestKey: requestKeys.forget },
  });
  assert.equal(replayedForget.status, 200);
  assert.equal(replayedForget.result.exists, false);
  assert.equal(replayedForget.result.revision, 3, 'forget replay does not resurrect or advance tombstone');
  const countsAfterForget = (await call('inspect')).result;
  assert.equal(countsAfterForget.counts.customer_accounts, 2, 'account tombstones remain while the other subject account remains separate');
  assert.equal(countsAfterForget.counts.customer_account_preferences, 0, 'forget removes the deleted account preference row');
  assert.equal(countsAfterForget.counts.customer_account_interactions, 2, 'unrelated anonymous visit header and event survive account erasure');
  assert.deepEqual(countsAfterForget.interactionKinds, { visits: 1, events: 1 });
  assert.equal(countsAfterForget.anonymousEvents, 1);
  assert.equal(countsAfterForget.associatedEvents, 0);
  assert.equal(countsAfterForget.profilePlaintextAbsent, true);

  // A state created at the erasure boundary cannot recreate the erased account.
  const seededPreForget = await call('visitor/seed', { visitorHash: 'e'.repeat(64), threadId: '20000000-0000-4000-8000-000000000003' });
  assert.equal(seededPreForget.status, 200);
  assert.equal(seededPreForget.result.seeded, true);
  const preForgetVisit = '10000000-0000-4000-8000-000000000003';
  await call('visit/record', { visitorHash: 'e'.repeat(64), value: { visitId: preForgetVisit, requestKey: '30000000-0000-4000-8000-000000000006', event: 'booking_opened', context: 'book' } });
  const preForgetState = await call('google/state-create', { visitorHash: 'e'.repeat(64), visitId: preForgetVisit, browserHash: 'f'.repeat(64) });
  assert.equal((await call('google/state-consume', { state: preForgetState.result.state, browserHash: 'f'.repeat(64) })).result.accepted, true);
  const staleIdentitySession = await call('google/session-issue', { stateHash: preForgetState.result.stateHash, identity: 'primary' });
  assert.equal(staleIdentitySession.status, 200, 'local Google session issuance may succeed independently of account resurrection');
  assert.equal((await call('inspect/account-by-subject', { identity: 'primary' })).result.account.exists, false);
  assert.equal(countsAfterForget.profileCiphertextPresent, true);

  const noRemember = await call('account/save-preferences', {
    token: staleIdentitySession.result.token,
    value: { expectedRevision: 3, requestKey: '30000000-0000-4000-8000-000000000010', remember: false, answerLength: 'standard', serviceInterests: [] },
  });
  assert.equal(noRemember.status, 200);
  assert.equal(noRemember.result.exists, false, 'remember=false is a no-op for a forgotten account');
  const newPreferences = await call('account/save-preferences', {
    token: staleIdentitySession.result.token,
    value: { expectedRevision: 3, requestKey: '30000000-0000-4000-8000-000000000011', remember: true, answerLength: 'standard', serviceInterests: ['spring_turn_up'] },
  });
  assert.equal(newPreferences.status, 200);
  assert.equal(newPreferences.result.exists, true);
  assert.equal(newPreferences.result.revision, 4);
  assert.deepEqual(newPreferences.result.preferences, { remember: true, answerLength: 'standard', serviceInterests: ['spring_turn_up'] });
  const newExport = await call('account/export', { token: staleIdentitySession.result.token });
  assert.deepEqual(newExport.result.interactions, [], 'explicit new preferences do not restore forgotten interactions');
  assert.equal((await call('inspect/account-by-subject', { identity: 'primary' })).result.erasureFenceRetained, true);
  const oldVisitAfterRecreate = await call('inspect/visit', { visitorHash: 'e'.repeat(64), visitId: preForgetVisit, identity: 'primary' });
  assert.equal(oldVisitAfterRecreate.result.headerPrimary, false, 'fresh preferences do not claim a visit created at the erasure boundary');

  await call('google/revoke', { token: issued.result.token, browserHash: browserA, visitorHash: visitorA });
  assert.deepEqual((await call('google/session-read', { token: issued.result.token })).result, { authenticated: false });
  const revokedWrite = await call('account/save-preferences', {
    token: issued.result.token,
    value: { expectedRevision: 3, requestKey: '30000000-0000-4000-8000-000000000007', remember: true, answerLength: 'standard', serviceInterests: [] },
  });
  assert.equal(revokedWrite.status, 500);
  await call('google/revoke', { token: staleIdentitySession.result.token, browserHash: 'f'.repeat(64), visitorHash: 'e'.repeat(64) });
  const revokedNewSave = await call('account/save-preferences', {
    token: staleIdentitySession.result.token,
    value: { expectedRevision: 4, requestKey: '30000000-0000-4000-8000-000000000012', remember: true, answerLength: 'short', serviceInterests: [] },
  });
  assert.equal(revokedNewSave.status, 500, 'revoked customer session cannot write preferences');
  assert.equal((await call('inspect/account-by-subject', { identity: 'primary' })).result.account.exists, true, 'a later explicit preferences save is a new account state');

  // Logout before callback consumption prevents the pending visit from being claimed.
  const seededLogout = await call('visitor/seed', { visitorHash: '7'.repeat(64), threadId: '20000000-0000-4000-8000-000000000004' });
  assert.equal(seededLogout.status, 200);
  assert.equal(seededLogout.result.seeded, true);
  const logoutVisit = '10000000-0000-4000-8000-000000000004';
  await call('visit/record', { visitorHash: '7'.repeat(64), value: { visitId: logoutVisit, requestKey: '30000000-0000-4000-8000-000000000008', event: 'booking_opened', context: 'book' } });
  const logoutState = await call('google/state-create', { visitorHash: '7'.repeat(64), visitId: logoutVisit, browserHash: '8'.repeat(64) });
  await call('google/revoke-pending-visit', { visitorHash: '7'.repeat(64), browserHash: '8'.repeat(64) });
  assert.deepEqual((await call('google/state-consume', { state: logoutState.result.state, browserHash: '8'.repeat(64) })).result, { accepted: false });
  const lateSession = await call('google/session-issue', { stateHash: logoutState.result.stateHash, identity: 'primary' });
  assert.equal(lateSession.status, 500);
  assert.equal((await call('inspect/visit', { visitorHash: '7'.repeat(64), visitId: logoutVisit, identity: 'primary' })).result.headerRevoked, true);
});
