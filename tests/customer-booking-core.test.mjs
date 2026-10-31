import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { enabledModuleFixture } from './fixtures/module-config-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const zod = require('zod/v3');
const inputBudget = await loadTs('lib/input-budget.ts');
const { env: emailEnv, moduleConfig: emailModuleConfig } = enabledModuleFixture('booking', 'notifications');

async function loadTs(relativePath, imports = {}) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (Object.hasOwn(imports, specifier)) return imports[specifier];
    throw new Error(`Unexpected import from ${relativePath}: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const auth = await loadTs('lib/customer-auth-core.ts');
const booking = await loadTs('lib/zenbooker-core.ts', { zod, 'zod/v3': zod, './input-budget': inputBudget });
const bookingStoreCore = await loadTs('lib/booking-store.ts', {
  zod,
  'zod/v3': zod,
  './booking-settings': { BookingSettingsStore: class {} },
  './booking-payment-policy': {
    catalogEvidence: async () => ({ catalogHash: 'a'.repeat(64), serviceIds: [] }),
    paymentConfigHash: async () => 'b'.repeat(64),
    paymentPolicyMatches: () => false,
  },
  './admin-auth-core': { sha256: async () => 'a'.repeat(64) },
  './action-approval-core': { canonicalAction: value => JSON.stringify(value) },
  './attribution-core': { ATTRIBUTION_WINDOW_MS: 604_800_000 },
  './zenbooker-core': booking,
});
const email = await loadTs('lib/customer-email.ts', {
  'cloudflare:workers': { env: emailEnv },
  './module-config': emailModuleConfig,
  './customer-auth-core': auth,
  './zenbooker-core': booking,
});
const secret = Buffer.alloc(32, 0x6d).toString('base64');

function catalog({ required = true } = {}) {
  return {
    results: [{
      service_id: 'blowout-basic',
      name: 'Demo blowout',
      base_duration: 45,
      base_price: '89.00',
      sections: [{
        section_id: 'zone-count',
        section_type: 'price_modifier',
        title: 'Number of zones',
        input_type: 'radio_buttons',
        required,
        options: [
          { option_id: 'up-to-8', name: 'Up to 8 zones', price: '0', duration: 0 },
          { option_id: '9-to-16', name: '9 to 16 zones', price: '25.50', duration: 20 },
        ],
      }],
    }],
    remaining: 0,
  };
}

function slotResponse(start = new Date(Date.now() + 3_600_000).toISOString()) {
  return {
    territory_id: 'territory-406',
    timezone: 'America/Denver',
    days: [{
      date: start.slice(0, 10),
      timeslots: [{
        id: 'slot-1',
        start,
        end: new Date(Date.parse(start) + 3_600_000).toISOString(),
        type: 'arrival_window',
      }],
    }],
  };
}

test('customer OTP digest binds challenge, recipient, purpose, browser secret, expiry and code', async () => {
  const binding = {
    challengeId: 'challenge-1',
    recipient: ' Customer@Example.com ',
    purpose: 'customer-login',
    browserSecret: 'browser-secret-a',
    expiresAt: 1_900_000_000_000,
  };
  const digest = await auth.otpDigest(secret, binding, '004219');
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(await auth.verifyOtpDigest(secret, { ...binding, recipient: 'customer@example.com' }, '004219', digest), true);
  assert.equal(await auth.verifyOtpDigest(secret, binding, '004218', digest), false);
  assert.equal(await auth.verifyOtpDigest(secret, { ...binding, challengeId: 'challenge-2' }, '004219', digest), false);
  assert.equal(await auth.verifyOtpDigest(secret, { ...binding, browserSecret: 'browser-secret-b' }, '004219', digest), false);
  assert.equal(await auth.verifyOtpDigest(secret, { ...binding, expiresAt: binding.expiresAt + 1 }, '004219', digest), false);
  assert.equal(await auth.verifyOtpDigest(Buffer.alloc(32, 0x70).toString('base64'), binding, '004219', digest), false);
  assert.equal(await auth.verifyOtpDigest(secret, binding, '4219', digest), false);
  assert.equal(digest.includes('004219'), false);
  assert.equal(digest.includes('customer@example.com'), false);
});

test('OTP generation and email normalization preserve the six-digit code boundary', async () => {
  assert.equal(auth.normalizeEmail('  CUSTOMER@Example.COM '), 'customer@example.com');
  for (let i = 0; i < 20; i++) assert.match(auth.randomOtp(), /^\d{6}$/);
  assert.throws(() => auth.normalizeEmail('not-an-email'));
  assert.throws(() => auth.normalizeEmail('a'.repeat(250) + '@example.com'));
  await assert.rejects(auth.otpDigest(secret, {
    challengeId: 'challenge-1', recipient: 'customer@example.com', purpose: 'customer-login',
    browserSecret: 'browser-secret-a', expiresAt: 1_900_000_000_000,
  }, '12345'));
  assert.equal(auth.CUSTOMER_SESSION_COOKIE, '__Host-customer_session');
  assert.equal(auth.CUSTOMER_BROWSER_COOKIE, '__Host-customer_browser');
  assert.notEqual(auth.CUSTOMER_SESSION_COOKIE, auth.CUSTOMER_BROWSER_COOKIE);
});

test('service choice and price are derived from the validated provider catalog', () => {
  const data = booking.catalogSchema.parse(catalog());
  const chosen = booking.deriveServiceSelection(data, {
    serviceId: 'blowout-basic',
    selections: [{ sectionId: 'zone-count', optionIds: ['9-to-16'] }],
  });
  assert.deepEqual(chosen, {
    service_id: 'blowout-basic',
    selections: [{ section_id: 'zone-count', selected_options: [{ option_id: '9-to-16', quantity: 1 }] }],
    duration: 65,
    quotedPrice: 114.5,
  });
  assert.throws(() => booking.deriveServiceSelection(data, {
    serviceId: 'blowout-basic', selections: [{ sectionId: 'zone-count', optionIds: ['forged-option'] }],
  }));
  assert.throws(() => booking.deriveServiceSelection(data, {
    serviceId: 'forged-service', selections: [],
  }));
  assert.throws(() => booking.deriveServiceSelection(data, {
    serviceId: 'blowout-basic', selections: [
      { sectionId: 'zone-count', optionIds: ['up-to-8'] },
      { sectionId: 'zone-count', optionIds: ['9-to-16'] },
    ],
  }));
});

test('booking context schema accepts only the selected catalog option and exact Montana address/customer fields', () => {
  const parsed = bookingStoreCore.bookingContextInput.parse({
    serviceId: 'qa-demo-blowout',
    selections: [{ sectionId: 'qa-zone-count', optionIds: ['qa-8-zones'] }],
    address: { line1: '10 Fixture Lane', city: 'Bozeman', state: 'MT', postal_code: '59101' },
    customer: { name: 'QA Fixture Customer', phone: '+15555550123' },
  });
  assert.equal(parsed.address.state, 'MT');
  assert.equal(parsed.selections[0].optionIds.length, 1);
  assert.equal(bookingStoreCore.bookingContextInput.safeParse({ ...parsed, total: 123 }).success, false);
  assert.equal(bookingStoreCore.bookingContextInput.safeParse({ ...parsed, address: { ...parsed.address, state: 'ID' } }).success, false);
});

test('unknown option requirements fail closed rather than guessing a complete quote', () => {
  const missingRule = catalog();
  delete missingRule.results[0].sections[0].required;
  const unknownRequirement = booking.catalogSchema.parse(missingRule);
  assert.throws(() => booking.deriveServiceSelection(unknownRequirement, {
    serviceId: 'blowout-basic', selections: [{ sectionId: 'zone-count', optionIds: ['up-to-8'] }],
  }), /Required-option rules unavailable/);
  const required = booking.catalogSchema.parse(catalog({ required: true }));
  assert.throws(() => booking.deriveServiceSelection(required, { serviceId: 'blowout-basic', selections: [] }), /Required option missing/);
  const unknownSchema = catalog();
  unknownSchema.results[0].sections[0].section_type = 'free_text';
  assert.equal(booking.catalogSchema.safeParse(unknownSchema).success, false);
});

test('territories retain the provider IANA timezone and reject invalid timezone or malformed slots', () => {
  assert.equal(booking.territorySchema.parse({
    in_service_area: true,
    service_territory: { id: 'territory-406', name: 'Bozeman', timezone: 'America/Denver' },
  }).service_territory.timezone, 'America/Denver');
  assert.equal(booking.territorySchema.safeParse({
    in_service_area: true,
    service_territory: { id: 'territory-406', name: 'Bozeman', timezone: 'Mars/Olympus' },
  }).success, false);
  assert.equal(booking.slotsSchema.safeParse(slotResponse()).success, true);
  const invalid = slotResponse();
  invalid.days[0].timeslots[0].end = invalid.days[0].timeslots[0].start;
  assert.equal(booking.slotsSchema.safeParse(invalid).success, false);
  const impossibleDate = slotResponse();
  impossibleDate.days[0].date = '2026-02-30';
  assert.equal(booking.slotsSchema.safeParse(impossibleDate).success, false);
});

test('a selected slot must be present exactly once and still be in the future', () => {
  const future = slotResponse();
  assert.equal(booking.validateSlot(booking.slotsSchema.parse(future), 'slot-1').id, 'slot-1');
  assert.throws(() => booking.validateSlot(booking.slotsSchema.parse(future), 'forged-slot'), /Slot unavailable/);
  const duplicate = structuredClone(future);
  duplicate.days.push({ ...duplicate.days[0] });
  assert.throws(() => booking.validateSlot(booking.slotsSchema.parse(duplicate), 'slot-1'), /Slot unavailable/);
  assert.throws(() => booking.validateSlot(booking.slotsSchema.parse(slotResponse(new Date(Date.now() - 60_000).toISOString())), 'slot-1'), /Slot unavailable/);
});

test('repeated wall-clock times at the fall DST transition remain distinct provider instants', () => {
  const slots = booking.slotsSchema.parse({
    territory_id: 'territory-406',
    timezone: 'America/Denver',
    days: [{ date: '2027-11-07', timeslots: [
      { id: 'first-0130', start: '2027-11-07T07:30:00Z', end: '2027-11-07T08:00:00Z', type: 'exact_time' },
      { id: 'second-0130', start: '2027-11-07T08:30:00Z', end: '2027-11-07T09:00:00Z', type: 'exact_time' },
    ] }],
  });
  assert.notEqual(slots.days[0].timeslots[0].start, slots.days[0].timeslots[1].start);
  assert.equal(booking.validateSlot(slots, 'first-0130').start, '2027-11-07T07:30:00Z');
  assert.equal(booking.validateSlot(slots, 'second-0130').start, '2027-11-07T08:30:00Z');
});

test('Zenbooker requests use the fixed origin, bearer header, manual redirects and no secret in the URL', async () => {
  const calls = [];
  const client = new booking.ZenbookerClient('qa-fixture-secret', async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json(catalog());
  });
  await client.catalog();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.zenbooker.com/v1/services?is_visible=true&cursor=0&limit=100');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer qa-fixture-secret');
  assert.equal(calls[0].url.includes('qa-fixture-secret'), false);
});

test('unconfigured clients and unapproved paths fail before any provider request', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return Response.json({}); };
  await assert.rejects(new booking.ZenbookerClient(undefined, fetcher).catalog(), e => e.code === 'unconfigured');
  const client = new booking.ZenbookerClient('fixture', fetcher);
  await assert.rejects(client.request('https://attacker.example/steal'), e => e.code === 'invalid_response');
  await assert.rejects(client.get('../attacker'));
  await assert.rejects(client.coverage('5910'), e => e.code === 'invalid_response');
  await assert.rejects(client.availability({ territory: 'territory-406', date: '2026-02-30', duration: 60 }), e => e.code === 'invalid_response');
  assert.equal(calls, 0);
});

test('redirect responses are rejected after one manual request and never followed', async () => {
  const calls = [];
  const client = new booking.ZenbookerClient('fixture-secret', async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response('redirect-body-secret', { status: 302, headers: { Location: 'https://attacker.example/collect' } });
  });
  await assert.rejects(client.catalog(), e => e.code === 'http_rejected' && e.status === 302 && e.message === 'http_rejected');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, 'manual');
  assert.match(calls[0].url, /^https:\/\/api\.zenbooker\.com\/v1\//);
});

test('ambiguous create and reschedule transport failures are never retried', async () => {
  for (const method of ['create', 'reschedule']) {
    let calls = 0;
    const client = new booking.ZenbookerClient('fixture-secret', async () => {
      calls++;
      throw new Error('sensitive transport detail');
    });
    await assert.rejects(
      method === 'create' ? client.create({ customer: { email: 'private@example.com' } }) : client.reschedule('job-1', '2027-01-15T17:00:00Z', 120),
      e => e.code === 'unknown' && e.message === 'unknown' && !e.message.includes('sensitive'),
    );
    assert.equal(calls, 1);
  }
});

test('reschedule uses documented fields and cancellation is a bodyless POST', async () => {
  const calls = [];
  const client = new booking.ZenbookerClient('fixture-secret', async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ accepted: true }, { status: 200 });
  });
  await client.reschedule('job-406', '2027-07-15T17:00:00Z', 120);
  await client.cancel('job-406');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.zenbooker.com/v1/jobs/job-406/reschedule');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    start_date: '2027-07-15T17:00:00Z',
    arrival_window_minutes: 120,
  });
  assert.equal(calls[1].url, 'https://api.zenbooker.com/v1/jobs/job-406/cancel');
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[1].init.body, undefined);
});

test('provider response validation requires a job id and exact successful create status', async () => {
  const good = {
    job_id: 'job-1', status: 'scheduled',
    timeslot: { type: 'arrival_window', start: '2027-01-15T17:00:00Z', end: '2027-01-15T19:00:00Z' },
    pricing: { subtotal: 89, tax_amount: 0, total: 89 },
  };
  const client = new booking.ZenbookerClient('fixture-secret', async (_url, init) => {
    assert.equal(init.method, 'POST');
    return Response.json(good, { status: 201 });
  });
  assert.equal((await client.create({ arbitrary: 'fixture' })).job_id, 'job-1');

  for (const [status, body] of [[200, good], [201, { ...good, job_id: undefined }]]) {
    const invalid = new booking.ZenbookerClient('fixture-secret', async () => Response.json(body, { status }));
    await assert.rejects(invalid.create({}), e => e.code === 'unknown');
  }
});

test('provider errors expose only controlled classifications, never provider response text', async () => {
  const secretText = 'do-not-leak-provider-body';
  const client = new booking.ZenbookerClient('fixture-secret', async () => new Response(secretText, { status: 502 }));
  await assert.rejects(client.catalog(), error => {
    assert.equal(error.code, 'http_rejected');
    assert.equal(error.status, 502);
    assert.equal(error.message, 'http_rejected');
    assert.equal(JSON.stringify(error).includes(secretText), false);
    return true;
  });
});

test('malformed provider data is reduced to a controlled invalid-response error', async () => {
  const privateMarker = 'PROVIDER_PRIVATE_MARKER';
  const client = new booking.ZenbookerClient('fixture-secret', async () => Response.json({
    results: [{ service_id: 'service-1', name: privateMarker, base_duration: 'not-a-number', base_price: 10, sections: [] }],
    remaining: 0,
  }));
  await assert.rejects(client.catalog(), error => {
    assert.equal(error.code, 'invalid_response');
    assert.equal(error.message, 'invalid_response');
    assert.equal(String(error).includes(privateMarker), false);
    assert.equal(JSON.stringify(error).includes(privateMarker), false);
    return true;
  });
});

test('Cloudflare OTP email accepts only the intended normalized recipient and distinguishes queued from delivered', async () => {
  const requests = [];
  const config = { accountId: 'a'.repeat(32), token: 'fixture-email-token', from: 'Bookings@Example.com' };
  const queued = await email.sendCustomerOtp(config, ' Customer@Example.com ', '042019', async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json({ success: true, result: { queued: ['customer@example.com'], delivered: [], permanent_bounces: [], suppressed_recipients: [] } });
  });
  assert.deepEqual(queued, { acceptance: 'queued', inboxDeliveryVerified: false });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/email/sending/send`);
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.redirect, 'manual');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer fixture-email-token');
  assert.equal(requests[0].url.includes(config.token), false);
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.to, 'customer@example.com');
  assert.equal(body.from, 'bookings@example.com');
  assert.match(body.text, /042019/);

  const delivered = await email.sendCustomerOtp(config, 'customer@example.com', '000007', async () => Response.json({
    success: true,
    result: { queued: [], delivered: ['customer@example.com'], permanent_bounces: [], suppressed_recipients: [] },
  }));
  assert.deepEqual(delivered, { acceptance: 'delivered', inboxDeliveryVerified: false });
});

test('Cloudflare accepted status alone cannot authenticate an OTP or enumerate suppressed addresses', async () => {
  const config = { accountId: 'b'.repeat(32), token: 'fixture-email-token', from: 'bookings@example.com' };
  const rejectedResponses = [
    { success: true, result: { queued: [], delivered: [], permanent_bounces: [], suppressed_recipients: [] } },
    { success: true, result: { queued: ['someone-else@example.com'], delivered: [], permanent_bounces: [], suppressed_recipients: [] } },
    { success: true, result: { queued: [], delivered: [], permanent_bounces: [], suppressed_recipients: ['customer@example.com'] } },
    { success: true, result: { queued: [], delivered: [], permanent_bounces: ['customer@example.com'], suppressed_recipients: [] } },
    { success: true, result: { queued: [], delivered: [], permanent_bounces: [], suppressed_recipients: [] } },
    { success: false, result: { queued: ['customer@example.com'], delivered: [], permanent_bounces: [], suppressed_recipients: [] } },
  ];
  for (const payload of rejectedResponses) {
    await assert.rejects(email.sendCustomerOtp(config, 'customer@example.com', '123456', async () => Response.json(payload)), error => {
      assert.equal(error.code, 'invalid_response');
      assert.equal(error.message, 'invalid_response');
      assert.equal(JSON.stringify(error).includes('customer@example.com'), false);
      return true;
    });
  }
  let calls = 0;
  await assert.rejects(email.sendCustomerOtp({ ...config, accountId: 'invalid' }, 'customer@example.com', '123456', async () => {
    calls++;
    return Response.json({ success: true });
  }), error => error.code === 'unconfigured');
  assert.equal(calls, 0);
});

test('Cloudflare Email REST rejects redirects and provider errors without forwarding credentials or leaking bodies', async () => {
  const config = { accountId: 'c'.repeat(32), token: 'email-token-fixture', from: 'bookings@example.com' };
  for (const status of [302, 500]) {
    let calls = 0;
    const privateBody = 'private-email-provider-body';
    await assert.rejects(email.sendCustomerOtp(config, 'customer@example.com', '999001', async (url, init) => {
      calls++;
      assert.equal(String(url), `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/email/sending/send`);
      assert.equal(init.redirect, 'manual');
      assert.equal(init.headers.Authorization, 'Bearer email-token-fixture');
      return new Response(privateBody, { status, headers: { Location: 'https://attacker.example/collect' } });
    }), error => {
      assert.equal(error.code, 'http_rejected');
      assert.equal(error.status, status);
      assert.equal(error.message, 'http_rejected');
      assert.equal(String(error).includes(privateBody), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('sender readiness performs only safe GETs and leaves provider verification explicitly unknown', async () => {
  const config = {
    accountId: 'd'.repeat(32), zoneId: 'e'.repeat(32), subdomainId: 'f'.repeat(32),
    from: 'Bookings@mail.example.com', token: 'fixture-zone-read-token',
  };
  const calls = [];
  const result = await email.checkEnabledSenderDomain(config, async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return Response.json({ success: true, result: { account: { id: config.accountId }, name: 'example.com' } });
    return Response.json({ success: true, result: { tag: config.subdomainId, name: 'mail.example.com', enabled: true } });
  });
  assert.deepEqual(result, { domainEnabled: true, accountMatched: true, providerVerification: 'unknown' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `https://api.cloudflare.com/client/v4/zones/${config.zoneId}`);
  assert.equal(calls[1].url, `https://api.cloudflare.com/client/v4/zones/${config.zoneId}/email/sending/subdomains/${config.subdomainId}`);
  for (const call of calls) {
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.redirect, 'manual');
    assert.equal(call.init.headers.Authorization, 'Bearer fixture-zone-read-token');
    assert.equal(call.url.includes(config.token), false);
  }
});

test('sender readiness rejects account, zone, subdomain and sender-domain mismatches without writes', async () => {
  const config = {
    accountId: '1'.repeat(32), zoneId: '2'.repeat(32), subdomainId: '3'.repeat(32),
    from: 'Bookings@mail.example.com', token: 'fixture-zone-read-token',
  };
  let calls = 0;
  const wrongZone = async () => {
    calls++;
    return Response.json({ success: true, result: { account: { id: '4'.repeat(32) }, name: 'example.com' } });
  };
  await assert.rejects(email.checkEnabledSenderDomain(config, wrongZone), error => error.code === 'invalid_response');
  assert.equal(calls, 1);
  calls = 0;
  const wrongSubdomain = async () => {
    calls++;
    if (calls === 1) return Response.json({ success: true, result: { account: { id: config.accountId }, name: 'example.com' } });
    return Response.json({ success: true, result: { tag: config.subdomainId, name: 'attacker.example.com', enabled: true } });
  };
  await assert.rejects(email.checkEnabledSenderDomain(config, wrongSubdomain), error => error.code === 'invalid_response');
  assert.equal(calls, 2);
  assert.equal(config.from, 'Bookings@mail.example.com');
});
