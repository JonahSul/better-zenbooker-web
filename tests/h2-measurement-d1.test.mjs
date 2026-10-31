import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';

const baseUrl = process.env.TEST_H2_MP_BASE_URL;
const fixtureToken = process.env.TEST_H2_MP_FIXTURE_TOKEN;
const enabled = Boolean(baseUrl && fixtureToken);
if (baseUrl && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/i.test(baseUrl)) throw new Error('Measurement dispatch fixture may target only a loopback Worker.');
const run = enabled ? test : test.skip;

async function fixture(path, body) {
  const response = await fetch(new URL(path, baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-h2-mp-fixture-token': fixtureToken },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
  assert.equal(response.status, 200, `fixture ${path} should complete locally`);
  return response.json();
}

function event() {
  return {
    name: 'experiment_conversion',
    eventId: randomBytes(32).toString('hex'),
    versionId: randomUUID(),
    composition: 'control',
    stage: 'production',
  };
}

run('Measurement Protocol dispatch uses actual D1 grants and tag identity with fake fetch only', async () => {
  const before = await fixture('/_fixture/setup', {});
  assert.match(before.analyticsHash, /^[0-9a-f]{64}$/);
  assert.match(before.experimentHash, /^[0-9a-f]{64}$/);
  assert.equal(before.analyticsRevision, 1);
  assert.equal(before.experimentRevision, 1);
  assert.equal(before.inquirySnapshot.count, 1);
  assert.match(before.inquirySnapshot.checksum, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(before), /GA4_MP_API_SECRET|fixture-only|api_secret/i);

  const acceptedEvent = event();
  const accepted = await fixture('/_fixture/dispatch', { cookies: before.cookies, event: acceptedEvent });
  assert.equal(accepted.result.status, 'transport_accepted');
  assert.equal(accepted.result.ingestionVerified, false, 'a fake 204 tests transport classification only, not analytics ingestion');
  assert.equal(accepted.calls, 1);
  assert.equal(accepted.target, 'https://www.google-analytics.com/mp/collect');
  assert.equal(accepted.payloadEvent, acceptedEvent.name);
  assert.equal(accepted.ledgerStatus, 'transport_accepted');

  const duplicate = await fixture('/_fixture/dispatch', { cookies: before.cookies, event: acceptedEvent });
  assert.equal(duplicate.result.status, 'deduplicated');
  assert.equal(duplicate.calls, 0, 'an already claimed event never makes a second outbound request');

  const analyticsRevoked = await fixture('/_fixture/setup', {});
  await fixture('/_fixture/withdraw', { ...analyticsRevoked, purpose: 'analytics' });
  const analyticsDenied = await fixture('/_fixture/dispatch', { cookies: analyticsRevoked.cookies, event: event() });
  assert.equal(analyticsDenied.result.status, 'suppressed');
  assert.equal(analyticsDenied.result.reason, 'consent');
  assert.equal(analyticsDenied.calls, 0);
  assert.equal(analyticsDenied.ledgerStatus, null, 'withdrawn analytics consent is rejected before dispatch is claimed');

  const experimentsRevoked = await fixture('/_fixture/setup', {});
  await fixture('/_fixture/withdraw', { ...experimentsRevoked, purpose: 'experiments' });
  const experimentsDenied = await fixture('/_fixture/dispatch', { cookies: experimentsRevoked.cookies, event: event() });
  assert.equal(experimentsDenied.result.status, 'suppressed');
  assert.equal(experimentsDenied.result.reason, 'consent');
  assert.equal(experimentsDenied.calls, 0);
  assert.equal(experimentsDenied.ledgerStatus, null, 'withdrawn experiment consent is rejected before dispatch is claimed');

  assert.deepEqual(accepted.inquirySnapshot, before.inquirySnapshot, 'MP dispatch leaves the seeded synthetic inquiry unchanged');
  assert.deepEqual(analyticsDenied.inquirySnapshot, before.inquirySnapshot, 'analytics withdrawal leaves the synthetic inquiry unchanged');
  assert.deepEqual(experimentsDenied.inquirySnapshot, before.inquirySnapshot, 'experiment withdrawal leaves the synthetic inquiry unchanged');
});
