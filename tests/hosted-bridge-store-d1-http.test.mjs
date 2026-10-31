import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const variables = ['TEST_HOSTED_STORE_BASE_URL', 'TEST_HOSTED_STORE_TOKEN'];
const configured = variables.filter(name => process.env[name]).length;
if (configured !== 0 && configured !== variables.length) throw new Error('Hosted Store fixture requires all local variables.');
const enabled = configured === variables.length;
let base;
let fixtureToken;
if (enabled) {
  base = new URL(process.env.TEST_HOSTED_STORE_BASE_URL);
  if (!['http:', 'https:'].includes(base.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
    throw new Error('Hosted Store tests are restricted to a loopback Worker.');
  }
  fixtureToken = process.env.TEST_HOSTED_STORE_TOKEN;
  if (fixtureToken.length < 16 || fixtureToken.length > 128) throw new Error('Hosted Store fixture token has an invalid length.');
}

async function call(path, { method = 'GET', body } = {}) {
  return fetch(new URL(path, base), {
    method,
    headers: {
      'x-qa-fixture-token': fixtureToken,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
    cache: 'no-store',
  });
}

async function payload(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { throw new Error(`Expected JSON from local fixture; status ${response.status}.`); }
}

test('real AES-GCM HostedBridgeStore initialize is D1-idempotent, concurrent-safe and verifier-only', { skip: !enabled }, async () => {
  const before = await payload(await call('/status'));
  assert.equal(before.initialized, false);
  assert.equal(Object.hasOwn(before, 'callbackUrl'), false);

  const [requestKeyA, requestKeyB, retryRequestKey] = [
    `qa-fixture-a-${randomUUID()}`,
    `qa-fixture-b-${randomUUID()}`,
    `qa-fixture-retry-${randomUUID()}`,
  ];
  const concurrentResponse = await call('/initialize-concurrent', {
    method: 'POST',
    body: { requestKeyA, requestKeyB },
  });
  assert.equal(concurrentResponse.status, 200);
  const concurrent = await payload(concurrentResponse);
  assert.equal(concurrent.initialized, true);
  assert.equal(concurrent.revision, 1);
  assert.equal(concurrent.sameRevision, true);
  assert.equal(concurrent.sameBridgeVerifier, true);
  assert.equal(concurrent.sameCallbackVerifier, true);
  assert.equal(concurrent.rawCapabilitiesReturned, false);
  assert.match(concurrent.bridgeVerifier, /^[0-9a-f]{64}$/);
  assert.match(concurrent.callbackVerifier, /^[0-9a-f]{64}$/);
  assert.notEqual(concurrent.bridgeVerifier, concurrent.callbackVerifier);
  assert.equal(JSON.stringify(concurrent).includes(requestKeyA), false);
  assert.equal(JSON.stringify(concurrent).includes(requestKeyB), false);

  const verified = await payload(await call('/verify'));
  assert.equal(verified.rowPresent, true);
  assert.equal(verified.initialized, true);
  assert.equal(verified.revision, 1);
  assert.equal(verified.credentialRevision, 1);
  assert.equal(verified.dbRevision, 1);
  assert.equal(verified.dbCredentialRevision, 1);
  assert.equal(verified.ciphertextVersion1, true);
  assert.equal(verified.ciphertextDistinct, true);
  assert.equal(verified.rawCapabilitiesAbsentFromCiphertext, true);
  assert.equal(verified.bearerVerifierMatches, true);
  assert.equal(verified.callbackVerifierMatches, true);
  assert.equal(verified.wrongKeyRejected, true);
  assert.equal(verified.wrongWorkspaceAadRejected, true);
  assert.equal(verified.swappedPurposeAadRejected, true);
  assert.equal(verified.corruptCiphertextRejected, true);
  assert.equal(verified.readinessInitialized, true);
  assert.equal(verified.readinessConfigured, false);
  assert.equal(verified.readinessLocallyReadable, true);
  assert.equal(verified.readinessHasRawCapabilities, false);
  assert.equal(verified.readinessHasCallbackUrl, false);
  assert.equal(verified.initializationAuditCount, 1);
  assert.equal(verified.rawCapabilitiesReturned, undefined);

  const statusFirst = await payload(await call('/status'));
  const statusSecond = await payload(await call('/status'));
  assert.equal(statusFirst.revision, 1);
  assert.equal(statusSecond.revision, statusFirst.revision);
  assert.equal(statusSecond.callbackVerifier, statusFirst.callbackVerifier);
  assert.equal(statusSecond.bridgeVerifier, statusFirst.bridgeVerifier);
  assert.equal(Object.hasOwn(statusSecond, 'callbackUrl'), false);

  const retryResponse = await call('/initialize', { method: 'POST', body: { requestKey: retryRequestKey } });
  assert.equal(retryResponse.status, 200);
  const retry = await payload(retryResponse);
  assert.equal(retry.revision, 1);
  assert.equal(retry.bridgeVerifier, concurrent.bridgeVerifier);
  assert.equal(retry.callbackVerifier, concurrent.callbackVerifier);
  assert.equal(retry.rawCapabilitiesReturned, false);
  const afterRetry = await payload(await call('/verify'));
  assert.equal(afterRetry.revision, verified.revision);
  assert.equal(afterRetry.credentialRevision, verified.credentialRevision);
  assert.equal(afterRetry.initializationAuditCount, 1);
  assert.equal(afterRetry.updatedAt, verified.updatedAt);
  assert.equal(afterRetry.rawCapabilitiesReturned, undefined);
});
