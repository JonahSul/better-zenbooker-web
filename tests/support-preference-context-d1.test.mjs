import test from 'node:test';
import assert from 'node:assert/strict';

const base = process.env.TEST_SUPPORT_PREFERENCE_D1_BASE_URL ?? '';
const token = process.env.TEST_SUPPORT_PREFERENCE_D1_TOKEN ?? '';
const config = process.env.TEST_SUPPORT_PREFERENCE_D1_CONFIG ?? '';
const persist = process.env.TEST_SUPPORT_PREFERENCE_D1_PERSIST ?? '';
const dbName = process.env.TEST_SUPPORT_PREFERENCE_D1_NAME ?? '';
const parsed = base ? new URL(base) : null;
const enabled = !!parsed && parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1'
  && parsed.port === '8800' && !!token
  && /\.sites-runtime\/support-preference-fixture\/wrangler\.json$/i.test(config.replaceAll('\\', '/'))
  && /\.wrangler\/support-preference-local-01$/i.test(persist.replaceAll('\\', '/'))
  && dbName === 'site-creator-d1';
if (base && !enabled) throw new Error('Support preference SQL proof requires its exact fresh loopback fixture.');

async function call(action, body = {}) {
  const response = await fetch(`${base}/__qa/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-QA-Support-Preference': token, Connection: 'close' },
    body: JSON.stringify(body),
  });
  let result;
  try { result = await response.json(); } catch { throw new Error(`Support preference fixture returned non-JSON for ${action} (${response.status}).`); }
  return { status: response.status, result };
}

const requestKeys = {
  positive: 'support-pref-positive-0000',
  revision: 'support-pref-revision-0001',
  revoked: 'support-pref-revoked-0002',
  forgotten: 'support-pref-forgotten-0003',
  accountSave: '40000000-0000-4000-8000-000000000001',
  accountForget: '40000000-0000-4000-8000-000000000002',
};

test('SupportStore local D1 completion is fenced by account revision, Google revocation, and preference erasure', {
  skip: !enabled && 'Set TEST_SUPPORT_PREFERENCE_D1_* only for the isolated fresh 30-migration fixture.',
}, async () => {
  const init = await call('init');
  assert.equal(init.status, 200);
  assert.equal(init.result.ready, true);
  assert.equal(init.result.migrations, 30);
  assert.equal(init.result.contextColumn, true);

  const seeded = await call('seed');
  assert.equal(seeded.status, 200);
  assert.equal(seeded.result.seeded, true);
  assert.deepEqual((await call('record-booking')).result, { recorded: true, duplicate: false });
  const baseline = (await call('snapshot')).result;
  assert.deepEqual(baseline, { turns: 0, completed: 0, accounts: 1, prefs: 1 });

  const positiveTurn = await call('begin', { requestKey: requestKeys.positive });
  assert.equal(positiveTurn.status, 200);
  assert.deepEqual({ begun: positiveTurn.result.begun, source: positiveTurn.result.source, accountRevision: positiveTurn.result.accountRevision, threadRevision: positiveTurn.result.threadRevision }, {
    begun: true, source: 'account', accountRevision: 2, threadRevision: 0,
  });
  assert.deepEqual((await call('record-help', { threadId: positiveTurn.result.threadId, threadRevision: positiveTurn.result.threadRevision })).result, {
    recorded: true, duplicate: false,
  });
  assert.deepEqual((await call('export-help')).result.helpReferences, [{ threadId: positiveTurn.result.threadId, threadRevision: 0 }],
    'the account export retains a real SupportStore-created revision-zero thread reference');
  const positiveCompletion = await call('complete', { requestKey: requestKeys.positive });
  assert.equal(positiveCompletion.result.committed, true, 'the unchanged eligible account control can complete');
  assert.equal(positiveCompletion.result.status, 'complete');
  assert.equal(positiveCompletion.result.answerStored, true);
  assert.equal(positiveCompletion.result.resultStored, true);
  assert.equal(positiveCompletion.result.containsProfileFields, false);
  assert.deepEqual(positiveCompletion.result.counts, { turns: 1, completed: 1, accounts: 1, prefs: 1 });

  const firstTurn = await call('begin', { requestKey: requestKeys.revision });
  assert.equal(firstTurn.status, 200);
  assert.deepEqual({ begun: firstTurn.result.begun, source: firstTurn.result.source, accountRevision: firstTurn.result.accountRevision }, {
    begun: true, source: 'account', accountRevision: 2,
  });
  const saved = await call('save', { value: { expectedRevision: 2, requestKey: requestKeys.accountSave,
    remember: true, answerLength: 'standard', serviceInterests: ['repair'] } });
  assert.equal(saved.status, 200);
  assert.equal(saved.result.revision, 3);
  const staleRevision = await call('complete', { requestKey: requestKeys.revision });
  assert.equal(staleRevision.status, 200);
  assert.equal(staleRevision.result.committed, false);
  assert.equal(staleRevision.result.status, 'pending');
  assert.equal(staleRevision.result.answerStored, false);
  assert.equal(staleRevision.result.resultStored, false);
  assert.equal(staleRevision.result.containsProfileFields, false);
  assert.deepEqual(staleRevision.result.contextKeys, [
    'accountId', 'accountRevision', 'browserMemoryExpiresAt', 'browserRevision', 'credentialRevision',
    'expiresAt', 'fingerprint', 'sessionHash', 'source', 'subjectKey', 'version',
  ]);
  assert.deepEqual(staleRevision.result.counts, { turns: 2, completed: 1, accounts: 1, prefs: 1 });
  const replay = await call('replay-check', { requestKey: requestKeys.revision });
  assert.deepEqual(replay.result, { replayed: true, contextRejected: true, status: 'pending', answerStored: false, resultStored: false });

  assert.equal((await call('rotate-session', { kind: 'revoked' })).status, 200);
  const revokedTurn = await call('begin', { requestKey: requestKeys.revoked });
  assert.deepEqual({ source: revokedTurn.result.source, accountRevision: revokedTurn.result.accountRevision }, { source: 'account', accountRevision: 3 });
  assert.equal((await call('revoke-session')).status, 200);
  const revoked = await call('complete', { requestKey: requestKeys.revoked });
  assert.equal(revoked.result.committed, false);
  assert.equal(revoked.result.answerStored, false);
  assert.equal(revoked.result.resultStored, false);
  assert.equal(revoked.result.counts.completed, 1);

  assert.equal((await call('rotate-session', { kind: 'forgotten' })).status, 200);
  const forgottenTurn = await call('begin', { requestKey: requestKeys.forgotten });
  assert.deepEqual({ source: forgottenTurn.result.source, accountRevision: forgottenTurn.result.accountRevision }, { source: 'account', accountRevision: 3 });
  const forgotten = await call('forget', { value: { expectedRevision: 3, requestKey: requestKeys.accountForget } });
  assert.equal(forgotten.status, 200);
  assert.equal(forgotten.result.revision, 4);
  assert.equal(forgotten.result.exists, false, 'Forget retains only the inaccessible minimal revision fence');
  assert.equal(forgotten.result.remember, false);
  const erased = await call('complete', { requestKey: requestKeys.forgotten });
  assert.equal(erased.result.committed, false);
  assert.equal(erased.result.answerStored, false);
  assert.equal(erased.result.resultStored, false);
  assert.equal(erased.result.counts.completed, 1);
  assert.equal(erased.result.counts.turns, 4);
  assert.equal(erased.result.counts.accounts, 1);
  assert.equal(erased.result.counts.prefs, 0);
});
