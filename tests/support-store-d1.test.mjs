import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.TEST_SUPPORT_D1_BASE_URL;
const token = process.env.TEST_SUPPORT_D1_FIXTURE_TOKEN;
const enabled = Boolean(base && token);
const synthetic = {
  a: 'fixture-visitor-a',
  b: 'fixture-visitor-b',
  c: 'fixture-visitor-c',
  d: 'fixture-visitor-d',
  e: 'fixture-visitor-e',
  f: 'fixture-visitor-f',
  g: 'fixture-visitor-g',
  uploadFault: 'fixture-visitor-upload-fault',
};

function checkedBase() {
  assert.ok(base, 'TEST_SUPPORT_D1_BASE_URL is required for this local fixture suite');
  const url = new URL(base);
  assert.equal(url.protocol, 'http:');
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'support D1 acceptance may only target loopback');
  assert.equal(url.port, '8794', 'support D1 acceptance is pinned to its disposable fixture port');
  return url;
}

async function call(path, body, authToken = token) {
  const response = await fetch(new URL(path, checkedBase()), {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(authToken ? { 'x-support-fixture-token': authToken } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  return { status: response.status, payload };
}

async function post(path, body) {
  const result = await call(path, body);
  assert.equal(result.status, 200, `${path} returned ${result.status}: ${JSON.stringify(result.payload)}`);
  return result.payload;
}

const unique = (prefix) => `${prefix}_${randomUUID().replaceAll('-', '')}`;

describe('isolated SupportStore and runSupportTurn D1 acceptance', { skip: !enabled }, () => {
  test('requires the fixture token and confirms loopback Worker readiness', async () => {
    checkedBase();
    const denied = await call('/_fixture/ready', undefined, 'wrong-local-fixture-token');
    assert.equal(denied.status, 401);
    const ready = await call('/_fixture/ready');
    assert.equal(ready.status, 200);
    assert.equal(ready.payload.ready, true);
  });

  test('searches current approved FTS rows and excludes edited or retired revisions', async () => {
    const initial = await post('/_fixture/kb-edit', {
      visitor: synthetic.a,
      revision: 0,
      title: 'Loquaciouswintertoken marker',
      body: 'This isolated fixture record checks revision replacement and retirement. The unique loquaciouswintertoken is only test text, not a business fact.',
      source: 'owner_reviewed',
      sourceUrl: 'https://example.test/',
    });
    const documentId = initial.documentId;
    const indexed = await post('/_fixture/kb-search', { visitor: synthetic.a, query: 'loquaciouswintertoken' });
    assert.deepEqual(indexed.revisions, [{ id: documentId, revision: initial.revision }]);
    assert.equal((await post('/_fixture/foreign-kb-search', { visitor: synthetic.a, query: 'fall demo services' })).count, 0);
    const unsafe = await call('/_fixture/kb-edit', {
      visitor: synthetic.a,
      revision: 0,
      title: 'Unsafe fixture contact note',
      body: 'This record includes fixture-sensitive@example.invalid and must be rejected before it enters public knowledge.',
      source: 'owner_reviewed',
      sourceUrl: 'https://example.test/',
    });
    assert.equal(unsafe.status, 400);
    const updated = await post('/_fixture/kb-edit', {
      visitor: synthetic.a,
      documentId,
      revision: initial.revision,
      title: 'Winterpreparationtoken guidance',
      body: 'For this isolated test, the current approved record advises using the hosted booking page for fall demo service choices.',
      source: 'owner_reviewed',
      sourceUrl: 'https://example.test/',
    });
    assert.equal(updated.revision, initial.revision + 1);
    const current = await post('/_fixture/kb-search', { visitor: synthetic.a, query: 'winterpreparationtoken' });
    assert.deepEqual(current.revisions, [{ id: documentId, revision: updated.revision }]);
    const stale = await post('/_fixture/kb-search', { visitor: synthetic.a, query: 'loquaciouswintertoken' });
    assert.equal(stale.count, 0);
    await post('/_fixture/kb-retire', { visitor: synthetic.a, documentId, revision: updated.revision });
    const retired = await post('/_fixture/kb-search', { visitor: synthetic.a, query: 'winterpreparationtoken' });
    assert.equal(retired.count, 0);
  });

  test('answers from approved knowledge, redacts visitor contact data, and does not call a disabled model', async () => {
    await post('/_fixture/session', { visitor: synthetic.a });
    const result = await post('/_fixture/turn', {
      visitor: synthetic.a,
      mode: 'answer',
      input: { requestKey: unique('support_answer'), message: 'What should I do for fall demo services? My email is fixture-sensitive@example.invalid and my phone is 406-555-0199. Bearer qaFixtureSecretA1B2C3D4E5F6G7H8J9K0LmNoPqRsTuv.' },
    });
    assert.equal(result.result.status, 'answered');
    assert.ok(result.observations.knowledgeRounds[0] > 0);
    assert.equal(result.observations.sawEmail, false);
    assert.equal(result.observations.sawPhone, false);
    assert.equal(result.observations.sawFullSecret, false);
    const persisted = await post('/_fixture/inspect', { visitor: synthetic.a });
    assert.equal(persisted.containsEmail, false);
    assert.equal(persisted.containsPhone, false);
    assert.equal(persisted.containsFullSecret, false);

    await post('/_fixture/session', { visitor: synthetic.c });
    const disabled = await post('/_fixture/turn', {
      visitor: synthetic.c,
      mode: 'disabled',
      enabled: false,
      input: { requestKey: unique('support_disabled'), message: 'Where can I find booking help?' },
    });
    assert.equal(disabled.observations.providerCalls, 0);
    assert.notEqual(disabled.result.status, 'answered');
    assert.equal((await post('/_fixture/inspect', { visitor: synthetic.c })).modelCallCount, 0);
  });

  test('idempotent request replay returns the stored turn without another model call', async () => {
    const requestKey = unique('support_replay');
    const input = { requestKey, message: 'How do fall blowout choices work?' };
    const baseline = await post('/_fixture/inspect', { visitor: synthetic.a });
    const first = await post('/_fixture/turn', { visitor: synthetic.a, mode: 'answer', input });
    const afterFirst = await post('/_fixture/inspect', { visitor: synthetic.a });
    assert.equal(afterFirst.modelCallCount, baseline.modelCallCount + 1);
    const second = await post('/_fixture/turn', { visitor: synthetic.a, mode: 'answer', input });
    assert.equal(second.result.turnId, first.result.turnId);
    assert.equal(second.observations.providerCalls, 0);
    const afterReplay = await post('/_fixture/inspect', { visitor: synthetic.a });
    assert.equal(afterReplay.modelCallCount, afterFirst.modelCallCount);
  });

  test('runs approved KB search before each model round and respects the real one-call budget', async () => {
    await post('/_fixture/session', { visitor: synthetic.c });
    const before = await post('/_fixture/inspect', { visitor: synthetic.c });
    const result = await post('/_fixture/turn', {
      visitor: synthetic.c,
      mode: 'search_again',
      input: { requestKey: unique('support_search'), message: 'Tell me about fall demo services.' },
    });
    assert.equal(result.observations.providerCalls, 2);
    assert.equal(result.observations.knowledgeRounds.length, 2);
    assert.ok(result.observations.knowledgeRounds.every((count) => count > 0));
    const after = await post('/_fixture/inspect', { visitor: synthetic.c });
    assert.equal(after.modelCallCount, before.modelCallCount + 2);
  });

  test('enforces the D1 turn window, per-turn model-call ceiling and UTF-8 input-byte ceiling', async () => {
    await post('/_fixture/session', { visitor: synthetic.e });
    const turns = await post('/_fixture/limits', { visitor: synthetic.e });
    assert.equal(turns.created, 10);
    assert.equal(turns.eleventhRejected, true);

    await post('/_fixture/session', { visitor: synthetic.f });
    const calls = await post('/_fixture/call-limits', { visitor: synthetic.f });
    assert.equal(calls.thirdRejected, true);
    assert.equal(calls.callsForLimitedTurn, 2);
    assert.equal(calls.oversizedRejected, true);
    assert.equal(calls.callsForOversizedTurn, 0);

    const dailyCap = await post('/_fixture/daily-cap-race', { visitor: synthetic.g });
    assert.equal(dailyCap.successfulReservations, 1);
    assert.equal(dailyCap.finalDailyUsage, 100);
    assert.equal(dailyCap.insertedCalls, 1);
  });

  test('stores photos in local R2 with D1 ownership, isolates photo turns, and tombstones before cleanup', async () => {
    await post('/_fixture/session', { visitor: synthetic.a });
    const added = await post('/_fixture/photo-add', { visitor: synthetic.a });
    assert.equal(added.r2Stored, true, 'the fixture must persist the normalized object through its actual R2 binding');
    assert.equal(added.rawBytesReturned, false);
    assert.equal(added.metadata.width, 96);
    assert.equal(added.metadata.height, 64);
    assert.equal(added.metadata.byteLength > 0, true);
    assert.deepEqual(Object.keys(added.metadata).sort(), ['byteLength', 'expiresAt', 'height', 'id', 'revision', 'threadId', 'width']);

    await post('/_fixture/session', { visitor: synthetic.b });
    const foreignRead = await call('/_fixture/photo-read', { visitor: synthetic.b, id: added.metadata.id });
    assert.equal(foreignRead.status, 404, 'a different visitor cannot read the photo metadata or bytes');
    const ownRead = await post('/_fixture/photo-read', { visitor: synthetic.a, id: added.metadata.id });
    assert.equal(ownRead.available, true);
    assert.equal(ownRead.bytesReturned, false);
    assert.equal(ownRead.byteLength, added.metadata.byteLength);

    const photoTurn = await post('/_fixture/photo-turn', {
      visitor: synthetic.a,
      threadId: added.metadata.threadId,
      attachmentId: added.metadata.id,
      requestKey: unique('photo_turn'),
      mode: 'normal',
    });
    assert.equal(photoTurn.result.status, 'answered');
    assert.equal(photoTurn.visionCalls, 1);
    assert.equal(photoTurn.visionReceivedBytes, true);
    assert.equal(photoTurn.modelCalls, 1);
    assert.equal(photoTurn.sawImageBytesInTextInput, false);
    assert.equal(photoTurn.sawObservation, true, 'only the bounded visible observation reaches text assistance');
    assert.equal(photoTurn.turnPhotoDerived, true);
    assert.deepEqual(photoTurn.callKinds.slice().sort(), ['text', 'vision']);
    assert.ok(photoTurn.callStatuses.every((status) => status === 'complete'));

    const followup = await post('/_fixture/photo-turn', {
      visitor: synthetic.a,
      threadId: added.metadata.threadId,
      requestKey: unique('photo_followup'),
      mode: 'followup',
    });
    assert.equal(followup.priorAnswerSeen, true, 'the visitor can refer to the immediately preceding response');
    assert.equal(followup.visionCalls, 0);
    assert.equal(followup.sawImageBytesInTextInput, false);
    assert.equal(followup.turnPhotoDerived, true, 'photo-derived followups retain provenance for curation exclusion');
    assert.deepEqual(followup.callKinds, ['text']);

    await post('/_fixture/feedback', { visitor: synthetic.a, threadId: added.metadata.threadId, turnId: photoTurn.result.turnId, vote: 'down', reason: 'unclear' });
    await post('/_fixture/feedback', { visitor: synthetic.a, threadId: added.metadata.threadId, turnId: followup.result.turnId, vote: 'down', reason: 'unclear' });
    assert.equal((await post('/_fixture/inspect', { visitor: synthetic.a })).feedbackCount, 2, 'both the attachment turn and its photo-derived followup exist as feedback before curation filtering');
    const curation = await post('/_fixture/curate', { visitor: synthetic.a, requestKey: unique('photo_feedback'), mode: 'draft' });
    assert.equal(curation.result.status, 'no_evidence', 'photo-derived feedback is not eligible as public knowledge evidence');
    assert.equal(curation.noEvidenceModelCalled, false);
    const removed = await post('/_fixture/photo-delete', { visitor: synthetic.a, id: added.metadata.id });
    assert.equal(removed.deleted, true);
    assert.equal(removed.tombstoned, true);
    assert.equal(removed.cleanupComplete, true);
    assert.equal(removed.r2ObjectStillPresent, false, 'explicit deletion removes the local R2 object after D1 access is revoked');
    assert.equal((await call('/_fixture/photo-read', { visitor: synthetic.a, id: added.metadata.id })).status, 404);

    await post('/_fixture/session', { visitor: synthetic.c });
    const duringVision = await post('/_fixture/photo-add', { visitor: synthetic.c });
    const deletedDuringVision = await post('/_fixture/photo-turn', {
      visitor: synthetic.c,
      threadId: duringVision.metadata.threadId,
      attachmentId: duringVision.metadata.id,
      requestKey: unique('photo_delete_race'),
      mode: 'delete_during_vision',
    });
    assert.equal(deletedDuringVision.result.status, 'superseded');
    assert.equal(deletedDuringVision.modelCalls, 0, 'text generation cannot continue after photo deletion');
    assert.equal(deletedDuringVision.turnStatus, 'superseded');
    assert.equal(deletedDuringVision.sawImageBytesInTextInput, false);
    assert.deepEqual(deletedDuringVision.callKinds, ['vision']);
    assert.deepEqual(deletedDuringVision.callStatuses, ['complete']);
    assert.equal((await call('/_fixture/photo-read', { visitor: synthetic.c, id: duringVision.metadata.id })).status, 404);

    await post('/_fixture/session', { visitor: synthetic.d });
    const expiring = await post('/_fixture/photo-add', { visitor: synthetic.d, failDelete: true });
    const expiryRequestKey = unique('photo_expiry_cache');
    const cachedPhotoTurn = await post('/_fixture/photo-turn', {
      visitor: synthetic.d,
      threadId: expiring.metadata.threadId,
      attachmentId: expiring.metadata.id,
      requestKey: expiryRequestKey,
      mode: 'normal',
    });
    assert.equal(cachedPhotoTurn.result.status, 'answered');
    const historyBeforeExpiry = await post('/_fixture/photo-history', { visitor: synthetic.d, threadId: expiring.metadata.threadId });
    assert.equal(historyBeforeExpiry.derivedTurnCount, 1);
    assert.equal(historyBeforeExpiry.clearedDerivedTurns, false);
    assert.equal(historyBeforeExpiry.answerPresentCount, 1);
    const tombstoned = await post('/_fixture/photo-expire', { visitor: synthetic.d, id: expiring.metadata.id });
    assert.equal(tombstoned.expired, true);
    assert.equal(tombstoned.cleanupAttempts >= 1, true);
    assert.equal(tombstoned.cleanupComplete, false, 'failed object removal remains pending after immediate tombstoning');
    assert.equal(tombstoned.r2ObjectStillPresent, true, 'the fake local R2 failure preserves the object for retry proof');
    assert.equal((await call('/_fixture/photo-read', { visitor: synthetic.d, id: expiring.metadata.id })).status, 404, 'expired photos are immediately unreadable');
    const historyAfterExpiry = await post('/_fixture/photo-history', { visitor: synthetic.d, threadId: expiring.metadata.threadId });
    assert.equal(historyAfterExpiry.derivedTurnCount, 1);
    assert.equal(historyAfterExpiry.clearedDerivedTurns, true, 'expiry through production prune clears cached photo-derived conversation text');
    assert.equal(historyAfterExpiry.answerPresentCount, 0);
    const replayAfterExpiry = await call('/_fixture/photo-turn', {
      visitor: synthetic.d,
      threadId: expiring.metadata.threadId,
      attachmentId: expiring.metadata.id,
      requestKey: expiryRequestKey,
      mode: 'normal',
    });
    assert.equal(replayAfterExpiry.status, 200);
    assert.equal(replayAfterExpiry.payload.result.status, 'pending', 'a stale request key cannot replay completed photo-derived content after expiry');
    assert.equal(replayAfterExpiry.payload.modelCalls, 0);
    assert.doesNotMatch(JSON.stringify(replayAfterExpiry.payload), /demo control box|hosted booking page/i);
    const retried = await post('/_fixture/photo-retry-cleanup', { visitor: synthetic.d, id: expiring.metadata.id });
    assert.equal(retried.cleanupAttempts >= 2, true);
    assert.equal(retried.cleanupComplete, true);
    assert.equal(retried.r2ObjectStillPresent, false, 'a later cleanup retry removes the local R2 object');
  });

  test('photo upload failures leave no untracked or readable R2 object and cleanup retries tracked compensation', async () => {
    const session = await post('/_fixture/session', { visitor: synthetic.uploadFault });
    assert.equal(session.created, true, 'the fault-injection cases run with an active owned visitor session');

    const insertFailure = await post('/_fixture/photo-upload-failure', {
      visitor: synthetic.uploadFault,
      failAt: 'insert',
    });
    assert.equal(insertFailure.failedAsExpected, true);
    assert.equal(insertFailure.injectedFailure, true);
    assert.equal(insertFailure.r2PutCalls, 0, 'durable metadata failure happens before any R2 write');
    assert.equal(insertFailure.photoRowDelta, 0);
    assert.equal(insertFailure.r2ObjectPresent, false);

    const activationFailure = await post('/_fixture/photo-upload-failure', {
      visitor: synthetic.uploadFault,
      failAt: 'activate',
      failCompensatingDelete: true,
    });
    assert.equal(activationFailure.failedAsExpected, true);
    assert.equal(activationFailure.injectedFailure, true);
    assert.equal(activationFailure.r2PutCalls, 1);
    assert.equal(activationFailure.photoRowDelta, 1);
    assert.equal(activationFailure.pendingRowCount, 1);
    assert.equal(activationFailure.uploadState, 'cleanup');
    assert.equal(activationFailure.uploadLeaseCleared, true, 'the failed upload is no longer protected by an active lease');
    assert.equal(activationFailure.tombstoned, true);
    assert.equal(activationFailure.readDenied, true);
    assert.equal(activationFailure.r2ObjectPresentBeforeRetry, true, 'the one-shot cleanup failure leaves a tracked object for production prune');
    assert.equal(activationFailure.cleanupPendingAfterFailure, true);
    assert.equal(activationFailure.cleanupCompleteAfterRetry, true);
    assert.equal(activationFailure.r2ObjectPresentAfterRetry, false);
    assert.equal(activationFailure.readStillDenied, true);
  });

  test('uses only this visitor’s current preferences and conversation, and supports replacement feedback', async () => {
    await post('/_fixture/session', { visitor: synthetic.b });
    const first = await post('/_fixture/turn', {
      visitor: synthetic.b,
      mode: 'remember',
      input: { requestKey: unique('support_remember'), message: 'Please remember that I prefer short answers about maintenance.' },
    });
    assert.equal(first.result.status, 'answered');
    assert.equal(first.observations.providerCalls, 2);
    const preference = await post('/_fixture/preferences', { visitor: synthetic.b });
    assert.equal(preference.remember, true);
    assert.equal(preference.answerLength, 'short');

    const followup = await post('/_fixture/turn', {
      visitor: synthetic.b,
      mode: 'answer',
      input: { threadId: first.result.threadId, requestKey: unique('support_followup'), message: 'Make it shorter.' },
    });
    assert.equal(followup.observations.answerLength, 'short');
    assert.equal(followup.observations.sawPriorTurn, true);
    assert.equal(followup.observations.priorAnswer, first.result.answer);
    await post('/_fixture/feedback', { visitor: synthetic.b, threadId: followup.result.threadId, turnId: followup.result.turnId, vote: 'up', reason: 'unclear' });
    await post('/_fixture/feedback', { visitor: synthetic.b, threadId: followup.result.threadId, turnId: followup.result.turnId, vote: 'down', reason: 'unhelpful' });
    const state = await post('/_fixture/inspect', { visitor: synthetic.b });
    assert.equal(state.feedbackCount, 1, 'replacement feedback should retain one current vote');

    const foreignThread = await call('/_fixture/thread', { visitor: synthetic.c, threadId: followup.result.threadId });
    assert.equal(foreignThread.status, 404);
    const foreignVote = await call('/_fixture/feedback', { visitor: synthetic.c, threadId: followup.result.threadId, turnId: followup.result.turnId, vote: 'up' });
    assert.equal(foreignVote.status, 404);
    assert.equal((await post('/_fixture/inspect', { visitor: synthetic.c })).feedbackCount, 0);

    const ownedThread = await post('/_fixture/thread', { visitor: synthetic.b, threadId: followup.result.threadId });
    assert.ok(ownedThread.thread.turnCount > 0);
    await post('/_fixture/delete-thread', { visitor: synthetic.b, threadId: followup.result.threadId, revision: ownedThread.thread.revision });
    assert.equal((await post('/_fixture/inspect', { visitor: synthetic.b })).feedbackCount, 0);
    assert.ok((await post('/_fixture/inspect', { visitor: synthetic.b })).erasedTurnCount > 0);
    assert.equal((await call('/_fixture/thread', { visitor: synthetic.b, threadId: followup.result.threadId })).status, 404);
  });

  test('erasure during an awaited model call prevents stale answer return and persistence', async () => {
    await post('/_fixture/session', { visitor: synthetic.d });
    const before = await post('/_fixture/inspect', { visitor: synthetic.d });
    const result = await post('/_fixture/turn', {
      visitor: synthetic.d,
      mode: 'erase_during_model',
      input: { requestKey: unique('support_erase'), message: 'A private question before I clear this conversation.' },
    });
    assert.equal(result.result.status, 'superseded');
    assert.doesNotMatch(result.result.answer, /STALE ANSWER/);
    const persisted = await post('/_fixture/inspect', { visitor: synthetic.d });
    assert.equal(persisted.erasedTurnCount - before.erasedTurnCount, 1);
    assert.equal(persisted.modelCallCount - before.modelCallCount, 1);
    assert.equal(await post('/_fixture/erase', { visitor: synthetic.d }).then((value) => value.upstreamErasure), false);
  });

  test('stores curation as an unpublished draft from redacted local feedback only', async () => {
    await post('/_fixture/session', { visitor: synthetic.c });
    const turn = await post('/_fixture/turn', {
      visitor: synthetic.c,
      mode: 'answer',
      input: { requestKey: unique('support_curate'), message: 'How does the hosted booking page work? fixture-sensitive@example.invalid Bearer qaFixtureSecretA1B2C3D4E5F6G7H8J9K0LmNoPqRsTuv.' },
    });
    await post('/_fixture/feedback', { visitor: synthetic.c, threadId: turn.result.threadId, turnId: turn.result.turnId, vote: 'down', reason: 'unclear' });
    const before = await post('/_fixture/kb-search', { visitor: synthetic.c, query: 'hosted booking help' });
    const draft = await post('/_fixture/curate', { visitor: synthetic.c, requestKey: unique('support_curate_draft'), mode: 'draft' });
    assert.equal(draft.result.status, 'draft');
    assert.equal(draft.proposalStatus, 'draft');
    assert.equal(draft.result.published, false);
    assert.equal(draft.receivedSafeEvidence, true);
    const after = await post('/_fixture/kb-search', { visitor: synthetic.c, query: 'hosted booking help' });
    assert.deepEqual(after.revisions, before.revisions, 'model curation must not publish its proposal');

    const metrics = await post('/_fixture/metrics', { visitor: synthetic.c });
    assert.equal(metrics.knowledge.seedVersion, 'verified-business-source-v1');
    assert.equal(metrics.knowledge.seedVersionCount, 6);
    assert.equal(metrics.knowledge.approvedDocumentCount, 6);
    assert.equal(metrics.knowledge.ftsProbe.available, true);
    assert.ok(metrics.knowledge.ftsProbe.matchedApprovedDocuments > 0);
    assert.equal(metrics.latestCurationRun.resultStatus, 'draft');
    assert.equal(metrics.latestCurationRun.modelCalled, true);
    assert.equal(metrics.latestCurationRun.published, false);
    const metricsJson = JSON.stringify(metrics);
    assert.doesNotMatch(metricsJson, /fixture-sensitive@example\.invalid|406-555-0199|qaFixtureSecretA1B2C3D4E5F6G7H8J9K0LmNoPqRsTuv/);
    assert.doesNotMatch(metricsJson, /question|answer|body|feedback/i);

    const beforeInvalidDraft = await post('/_fixture/kb-search', { visitor: synthetic.c, query: 'hosted booking help' });
    const invalidJson = await post('/_fixture/curate', { visitor: synthetic.c, requestKey: unique('support_curate_invalid_json'), mode: 'invalid_json' });
    assert.equal(invalidJson.result.status, 'unavailable');
    assert.equal(invalidJson.result.stage, 'json');
    assert.equal(invalidJson.result.modelReserved, true);
    assert.equal(invalidJson.result.modelAttempted, true);
    assert.equal(invalidJson.result.modelCompleted, true);
    assert.equal(invalidJson.result.modelCalled, true);
    assert.equal(invalidJson.result.published, false);
    assert.equal(invalidJson.modelCallStatus, 'complete', 'transport-complete usage is retained after a later JSON-validation failure');
    assert.deepEqual(invalidJson.modelUsage, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
    assert.doesNotMatch(JSON.stringify(invalidJson), /fixture-invalid-json-not-persisted/, 'provider response text is never returned or persisted in diagnostics');
    const afterInvalidDraft = await post('/_fixture/kb-search', { visitor: synthetic.c, query: 'hosted booking help' });
    assert.deepEqual(afterInvalidDraft.revisions, beforeInvalidDraft.revisions, 'invalid model JSON cannot publish or alter approved knowledge');

    const noEvidence = await post('/_fixture/curate', { visitor: synthetic.g, requestKey: unique('support_no_evidence'), mode: 'empty' });
    assert.equal(noEvidence.result.status, 'no_evidence');
    assert.equal(noEvidence.result.modelCalled, false);
    assert.equal(noEvidence.noEvidenceModelCalled, false);
  });
});
