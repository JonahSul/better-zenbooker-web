import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

const fixtureBase = process.env.TEST_CUSTOMER_D1_BASE_URL ?? '';
const fixtureToken = process.env.TEST_CUSTOMER_D1_FIXTURE_TOKEN ?? '';
const fixtureUrl = fixtureBase ? new URL(fixtureBase) : null;
const enabled = !!fixtureUrl && fixtureUrl.protocol === 'http:'
  && fixtureUrl.hostname === '127.0.0.1'
  && fixtureUrl.port === '8790'
  && !!fixtureToken;

if (fixtureBase && !enabled) {
  throw new Error('Customer D1 tests require the dedicated HTTP 127.0.0.1:8790 fixture and its local-only token.');
}

function browserSecret() { return randomBytes(32).toString('hex'); }
function email() { return `qa-${randomUUID()}@example.invalid`; }

async function call(path, body = {}) {
  const response = await fetch(`${fixtureBase}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-QA-Fixture-Token': fixtureToken },
    body: JSON.stringify(body),
  });
  let data;
  try { data = await response.json(); } catch { throw new Error(`Fixture response was not JSON (${response.status}).`); }
  return { status: response.status, data };
}

function dateAfterDenverDays(days) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const part = key => parts.find(value => value.type === key)?.value;
  const date = new Date(`${part('year')}-${part('month')}-${part('day')}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const selection = {
  serviceId: 'qa-demo-blowout',
  selections: [{ sectionId: 'qa-zone-count', optionIds: ['qa-8-zones'] }],
  address: { line1: '10 Fixture Lane', city: 'Bozeman', state: 'MT', postal_code: '59101' },
  customer: { name: 'QA Fixture Customer', phone: '+15555550123' },
};

async function registeredCustomer({ beforeOtpContext = false } = {}) {
  const browser = browserSecret();
  const recipient = email();
  const start = await call('/__qa/customer/begin', { email: recipient, browserSecret: browser });
  assert.equal(start.status, 200);
  assert.equal(/^[0-9a-f-]{36}$/i.test(start.data.challengeId), true);
  assert.equal(/^\d{6}$/.test(start.data.fixtureCode), true);
  let context = null;
  if (beforeOtpContext) {
    const created = await call('/__qa/booking/context', { browserSecret: browser, context: selection });
    assert.equal(created.status, 201);
    context = created.data;
  }
  const verified = await call('/__qa/customer/verify', {
    challengeId: start.data.challengeId,
    code: start.data.fixtureCode,
    browserSecret: browser,
  });
  assert.equal(verified.status, 200);
  assert.equal(verified.data.verified, true);
  assert.equal(/^[0-9a-f]{64}$/.test(verified.data.sessionToken), true);
  assert.equal((await call('/__qa/customer/session', { sessionToken: verified.data.sessionToken })).data.customer.email === recipient, true);
  return { browser, email: verified.data.customer.email, customerId: verified.data.customer.id, sessionToken: verified.data.sessionToken, context };
}

async function selectedContext(customer, date = dateAfterDenverDays(7), configFingerprint) {
  let context = customer.context;
  if (!context) {
    const created = await call('/__qa/booking/context', {
      browserSecret: customer.browser,
      customerId: customer.customerId,
      context: selection,
      configFingerprint,
    });
    assert.equal(created.status, 201);
    context = created.data;
  }
  const selected = await call('/__qa/booking/select', {
    contextId: context.contextId,
    browserSecret: customer.browser,
    customerId: customer.customerId,
    configFingerprint,
    date,
    slotId: `qa-slot-${date}`,
  });
  assert.equal(selected.status, 200);
  return { ...context, ...selected.data, date };
}

async function createAppointment(customer, selected, { operationKey = randomUUID(), mode = 'normal', concurrent = false, configFingerprint } = {}) {
  const input = {
    customerId: customer.customerId,
    email: customer.email,
    browserSecret: customer.browser,
    mode,
    configFingerprint,
    confirmation: {
      contextId: selected.contextId,
      selectionFingerprint: selected.selectionFingerprint,
      operationKey,
      confirm: true,
    },
  };
  return call(concurrent ? '/__qa/booking/create-concurrent' : '/__qa/booking/create', input);
}

test('real local D1 customer and booking stores enforce OTP, ownership, idempotency, unknown outcomes and erasure', {
  skip: !enabled && 'Set TEST_CUSTOMER_D1_BASE_URL and TEST_CUSTOMER_D1_FIXTURE_TOKEN from the isolated local fixture only.',
}, async t => {
  const ready = await call('/__qa/init');
  assert.equal(ready.status, 200);

  await t.test('OTP is browser-bound, one-use under concurrent verify, and sessions are opaque and revocable', async () => {
    const browser = browserSecret();
    const recipient = email();
    const request = await call('/__qa/customer/begin', { email: recipient, browserSecret: browser });
    assert.equal(request.status, 200);
    const challengeState = await call('/__qa/customer/challenge-state', { challengeId: request.data.challengeId, fixtureCode: request.data.fixtureCode });
    assert.deepEqual(challengeState.data, { challengePresent: true, otpCodeStored: false, digestLength: 64 });
    const otherBrowser = await call('/__qa/customer/verify', {
      challengeId: request.data.challengeId,
      code: request.data.fixtureCode,
      browserSecret: browserSecret(),
    });
    assert.equal(otherBrowser.data.verified, false);
    const attempts = await Promise.all(Array.from({ length: 2 }, () => call('/__qa/customer/verify', {
      challengeId: request.data.challengeId,
      code: request.data.fixtureCode,
      browserSecret: browser,
    })));
    assert.equal(attempts.filter(result => result.data.verified === true).length, 1);
    assert.equal(attempts.filter(result => result.data.verified === false).length, 1);
    const winner = attempts.find(result => result.data.verified);
    assert.equal(/^[0-9a-f]{64}$/.test(winner.data.sessionToken), true);
    assert.equal(winner.data.sessionToken !== request.data.challengeId, true);
    assert.deepEqual((await call('/__qa/customer/session-state', { sessionToken: winner.data.sessionToken })).data, { hashedSessionPresent: true, rawSessionPresent: false });
    assert.equal((await call('/__qa/customer/session', { sessionToken: winner.data.sessionToken })).data.customer.email === recipient, true);
    await call('/__qa/customer/logout', { sessionToken: winner.data.sessionToken });
    assert.equal((await call('/__qa/customer/session', { sessionToken: winner.data.sessionToken })).data.customer, null);
    assert.equal((await call('/__qa/customer/verify', {
      challengeId: request.data.challengeId,
      code: request.data.fixtureCode,
      browserSecret: browser,
    })).data.verified, false);
  });

  await t.test('five wrong codes exhaust one challenge and expiry is enforced by the D1 store', async () => {
    const baseTime = Date.now();
    assert.equal((await call('/__qa/clock', { now: baseTime })).data.updated, true);
    try {
      const browser = browserSecret();
      const start = await call('/__qa/customer/begin', { email: email(), browserSecret: browser });
      assert.equal(start.status, 200);
      const wrongCode = start.data.fixtureCode === '000000' ? '000001' : '000000';
      for (let i = 0; i < 5; i++) {
        assert.equal((await call('/__qa/customer/verify', { challengeId: start.data.challengeId, code: wrongCode, browserSecret: browser })).data.verified, false);
      }
      assert.equal((await call('/__qa/customer/verify', { challengeId: start.data.challengeId, code: start.data.fixtureCode, browserSecret: browser })).data.verified, false);

      const expiredBrowser = browserSecret();
      const expiring = await call('/__qa/customer/begin', { email: email(), browserSecret: expiredBrowser });
      assert.equal(expiring.status, 200);
      assert.equal((await call('/__qa/clock', { now: expiring.data.expiresAt + 1 })).data.updated, true);
      assert.equal((await call('/__qa/customer/verify', {
        challengeId: expiring.data.challengeId, code: expiring.data.fixtureCode, browserSecret: expiredBrowser,
      })).data.verified, false);
    } finally {
      await call('/__qa/clock', { now: baseTime });
    }
  });

  await t.test('customer session expiry is enforced server-side even while the opaque token is presented', async () => {
    const baseTime = Date.now();
    await call('/__qa/clock', { now: baseTime });
    try {
      const browser = browserSecret();
      const start = await call('/__qa/customer/begin', { email: email(), browserSecret: browser });
      const verified = await call('/__qa/customer/verify', { challengeId: start.data.challengeId, code: start.data.fixtureCode, browserSecret: browser });
      assert.equal(verified.data.verified, true);
      assert.equal((await call('/__qa/customer/session', { sessionToken: verified.data.sessionToken })).data.customer !== null, true);
      assert.equal((await call('/__qa/clock', { now: verified.data.expiresAt + 1 })).data.updated, true);
      assert.equal((await call('/__qa/customer/session', { sessionToken: verified.data.sessionToken })).data.customer, null);
    } finally {
      await call('/__qa/clock', { now: baseTime });
    }
  });

  await t.test('an anonymous pre-OTP context is attached only to the browser-verified customer', async () => {
    const customer = await registeredCustomer({ beforeOtpContext: true });
    const selected = await selectedContext(customer);
    assert.equal(selected.hold, false);
    assert.match(selected.selectionFingerprint, /^[0-9a-f]{64}$/);
  });

  await t.test('workspace ownership prevents a second customer from reading another appointment', async () => {
    const first = await registeredCustomer();
    const second = await registeredCustomer();
    const selected = await selectedContext(first);
    const created = await createAppointment(first, selected);
    assert.equal(created.status, 201);
    assert.equal(created.data.status, 'confirmed');
    assert.equal(created.data.collectedRevenue, null);
    const before = await call('/__qa/booking/call-counts');
    const unauthorized = await call('/__qa/booking/read', { customerId: second.customerId, appointmentId: created.data.appointmentId });
    assert.equal(unauthorized.status, 400);
    assert.equal(unauthorized.data.error, 'fixture_error');
    const after = await call('/__qa/booking/call-counts');
    assert.deepEqual(after.data.calls, before.data.calls);
  });

  await t.test('duplicate and concurrent create attempts produce one provider create and no invented revenue', async () => {
    const customer = await registeredCustomer();
    const selected = await selectedContext(customer);
    const operationKey = randomUUID();
    const before = await call('/__qa/booking/call-counts');
    const created = await createAppointment(customer, selected, { operationKey, concurrent: true });
    assert.equal(created.status, 200);
    assert.equal(created.data.results.length, 2);
    const concurrentStatuses = created.data.results.map(result => result.status);
    assert.equal(concurrentStatuses.every(status => status === 'dispatching' || status === 'confirmed'), true);
    assert.equal(concurrentStatuses.includes('confirmed'), true);
    const duplicate = await createAppointment(customer, selected, { operationKey });
    assert.equal(duplicate.status, 201);
    assert.equal(duplicate.data.status, 'confirmed');
    assert.equal(duplicate.data.collectedRevenue, null);
    const after = await call('/__qa/booking/call-counts');
    const count = rows => Number(rows.find(row => row.route === '/jobs' && row.method === 'POST')?.count ?? 0);
    assert.equal(count(after.data.calls) - count(before.data.calls), 1);
  });

  await t.test('a lost create response remains unknown and a retry cannot create a second job', async () => {
    const customer = await registeredCustomer();
    const selected = await selectedContext(customer);
    const operationKey = randomUUID();
    const before = await call('/__qa/booking/call-counts');
    const unknown = await createAppointment(customer, selected, { operationKey, mode: 'write-then-unknown' });
    assert.equal(unknown.status, 202);
    assert.equal(unknown.data.status, 'unknown');
    assert.equal(unknown.data.providerConfirmed, false);
    assert.equal(unknown.data.retrySubmitted, false);
    const retry = await createAppointment(customer, selected, { operationKey });
    assert.equal(retry.status, 202);
    assert.equal(retry.data.status, 'unknown');
    const after = await call('/__qa/booking/call-counts');
    const count = rows => Number(rows.find(row => row.route === '/jobs' && row.method === 'POST')?.count ?? 0);
    assert.equal(count(after.data.calls) - count(before.data.calls), 1);
    assert.equal((await call('/__qa/customer/session', { sessionToken: customer.sessionToken })).data.customer.email, customer.email);
  });

  await t.test('stale selected slots fail before a provider create request', async () => {
    const customer = await registeredCustomer();
    const selected = await selectedContext(customer);
    const before = await call('/__qa/booking/call-counts');
    const result = await createAppointment(customer, selected, { mode: 'slot-disappears' });
    assert.equal(result.status, 400);
    const after = await call('/__qa/booking/call-counts');
    const count = rows => Number(rows.find(row => row.route === '/jobs' && row.method === 'POST')?.count ?? 0);
    assert.equal(count(after.data.calls) - count(before.data.calls), 0);
  });

  await t.test('provider credential or configuration changes invalidate a frozen selection before create', async () => {
    const customer = await registeredCustomer();
    const selected = await selectedContext(customer, dateAfterDenverDays(7), 'old-config-fingerprint');
    const before = await call('/__qa/booking/call-counts');
    const result = await createAppointment(customer, selected, { configFingerprint: 'new-config-fingerprint' });
    assert.equal(result.status, 400);
    assert.equal(result.data.error, 'fixture_error');
    const after = await call('/__qa/booking/call-counts');
    assert.deepEqual(after.data.calls, before.data.calls);
  });

  await t.test('cancellation is confirmed only after provider readback, and local erasure removes provider PII', async () => {
    const customer = await registeredCustomer();
    const selected = await selectedContext(customer);
    const created = await createAppointment(customer, selected);
    assert.equal(created.status, 201);
    const initial = await call('/__qa/booking/read', { customerId: customer.customerId, appointmentId: created.data.appointmentId });
    assert.equal(initial.status, 200);
    const canceled = await call('/__qa/booking/change', {
      customerId: customer.customerId,
      appointmentId: created.data.appointmentId,
      browserSecret: customer.browser,
      kind: 'cancel',
      change: { revision: initial.data.revision, fingerprint: initial.data.fingerprint, operationKey: randomUUID(), confirm: true },
    });
    assert.equal(canceled.status, 200);
    assert.equal(canceled.data.status, 'confirmed');
    const readback = await call('/__qa/booking/read', { customerId: customer.customerId, appointmentId: created.data.appointmentId });
    assert.equal(readback.data.canceled, true);

    const erased = await call('/__qa/customer/erase', { customerId: customer.customerId });
    assert.deepEqual(erased.data, { localDataErased: true, providerSourceDeletion: false });
    const state = await call('/__qa/customer/erasure-state', { customerId: customer.customerId });
    assert.equal(state.data.customerRedacted, true);
    assert.equal(state.data.sessionCount, 0);
    assert.equal(state.data.contextCount, 0);
    assert.ok(state.data.appointments.length > 0);
    assert.ok(state.data.appointments.every(row => row.erased));
    assert.equal(state.data.providerSourceDeletion, false);
    assert.equal((await call('/__qa/customer/session', { sessionToken: customer.sessionToken })).data.customer, null);
  });

  await t.test('reschedule refuses a context changed during its final availability check', async () => {
    const customer = await registeredCustomer();
    const original = await selectedContext(customer);
    const created = await createAppointment(customer, original);
    assert.equal(created.status, 201);
    const current = await call('/__qa/booking/read', { customerId: customer.customerId, appointmentId: created.data.appointmentId });
    assert.equal(current.status, 200);

    const newDate = dateAfterDenverDays(14);
    const newContext = await call('/__qa/booking/context', {
      browserSecret: customer.browser,
      customerId: customer.customerId,
      context: selection,
    });
    assert.equal(newContext.status, 201);
    const newSelection = await call('/__qa/booking/select', {
      contextId: newContext.data.contextId,
      browserSecret: customer.browser,
      customerId: customer.customerId,
      date: newDate,
      slotId: `qa-slot-${newDate}`,
    });
    assert.equal(newSelection.status, 200);

    const before = await call('/__qa/booking/call-counts');
    const result = await call('/__qa/booking/change', {
      customerId: customer.customerId,
      appointmentId: created.data.appointmentId,
      browserSecret: customer.browser,
      kind: 'reschedule',
      mode: 'reschedule-context-mutated',
      change: {
        revision: current.data.revision,
        fingerprint: current.data.fingerprint,
        operationKey: randomUUID(),
        confirm: true,
        contextId: newContext.data.contextId,
        selectionFingerprint: newSelection.data.selectionFingerprint,
      },
    });
    assert.notEqual(result.status, 200);
    const after = await call('/__qa/booking/call-counts');
    const count = rows => rows
      .filter(row => row.method === 'POST' && /\/jobs\/[^/]+\/reschedule$/.test(row.route))
      .reduce((total, row) => total + Number(row.count ?? 0), 0);
    assert.equal(count(after.data.calls) - count(before.data.calls), 0);
    const afterRead = await call('/__qa/booking/read', { customerId: customer.customerId, appointmentId: created.data.appointmentId });
    assert.equal(afterRead.data.start, current.data.start);
  });

  await t.test('payment policy is owner-attested, catalog-bound, and checked atomically before provider create', async () => {
    const restored = await call('/__qa/payment/restore');
    assert.equal(restored.data.mode, 'no_online_payment_required');
    assert.equal(restored.data.source, 'owner_attested');
    assert.equal(restored.data.readEnabled, true);
    assert.equal(restored.data.writeEnabled, true);

    const unknown = await call('/__qa/payment/revoke');
    assert.equal(unknown.data.mode, 'unknown');
    assert.equal(unknown.data.writeEnabled, false);
    assert.equal((await call('/__qa/payment/direct-enable')).status, 409);
    assert.deepEqual((await call('/__qa/payment/state')).data.writeEnabled, false);

    const attested = await call('/__qa/payment/attest-disabled');
    assert.equal(attested.data.mode, 'no_online_payment_required');
    assert.equal(attested.data.source, 'owner_attested');
    assert.equal(attested.data.readEnabled, true);
    assert.equal(attested.data.writeEnabled, false, 'owner attestation must not itself enable booking writes');
    assert.deepEqual((await call('/__qa/payment/invalid-attestations')).data, {
      wrongRevisionRejected: true,
      wrongCatalogHashRejected: true,
      wrongProviderFingerprintRejected: true,
    });
    assert.equal((await call('/__qa/payment/direct-enable')).status, 200);

    const customer = await registeredCustomer();
    const selected = await selectedContext(customer);
    const matching = await createAppointment(customer, selected);
    assert.equal(matching.status, 201);
    assert.equal(matching.data.status, 'confirmed');
    assert.equal(matching.data.collectedRevenue, null);

    const changedCatalogCustomer = await registeredCustomer();
    const changedCatalogSelection = await selectedContext(changedCatalogCustomer);
    const beforeCatalog = await call('/__qa/booking/call-counts');
    const changedCatalog = await createAppointment(changedCatalogCustomer, changedCatalogSelection, { mode: 'catalog-price-changed' });
    assert.equal(changedCatalog.status, 400);
    const afterCatalog = await call('/__qa/booking/call-counts');
    const createPosts = rows => Number(rows.find(row => row.route === '/jobs' && row.method === 'POST')?.count ?? 0);
    assert.equal(createPosts(afterCatalog.data.calls) - createPosts(beforeCatalog.data.calls), 0);

    const changedProviderCustomer = await registeredCustomer();
    const changedProviderSelection = await selectedContext(changedProviderCustomer);
    const beforeProvider = await call('/__qa/booking/call-counts');
    const changedProvider = await createAppointment(changedProviderCustomer, changedProviderSelection, { configFingerprint: 'different-provider-fingerprint' });
    assert.equal(changedProvider.status, 400);
    const afterProvider = await call('/__qa/booking/call-counts');
    assert.deepEqual(afterProvider.data.calls, beforeProvider.data.calls);

    const raceCustomer = await registeredCustomer();
    const raceSelection = await selectedContext(raceCustomer);
    const beforeRace = await call('/__qa/booking/call-counts');
    const revokedDuringAvailability = await createAppointment(raceCustomer, raceSelection, { mode: 'payment-policy-revoked' });
    assert.equal(revokedDuringAvailability.status, 400);
    const afterRace = await call('/__qa/booking/call-counts');
    assert.equal(createPosts(afterRace.data.calls) - createPosts(beforeRace.data.calls), 0);
    assert.equal((await call('/__qa/payment/state')).data.writeEnabled, false);
  });
});
