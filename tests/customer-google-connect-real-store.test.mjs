import test from 'node:test';
import assert from 'node:assert/strict';

const base = process.env.TEST_CUSTOMER_GOOGLE_CONNECT_BASE_URL ?? '';
const token = process.env.TEST_CUSTOMER_GOOGLE_CONNECT_FIXTURE_TOKEN ?? '';
const config = process.env.TEST_CUSTOMER_GOOGLE_CONNECT_D1_CONFIG ?? '';
const persist = process.env.TEST_CUSTOMER_GOOGLE_CONNECT_D1_PERSIST ?? '';
const dbName = process.env.TEST_CUSTOMER_GOOGLE_CONNECT_D1_NAME ?? '';
const parsed = base ? new URL(base) : null;
const enabled = !!parsed && parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1'
  && parsed.port === '8796' && !!token
  && /\.sites-runtime\/customer-google-store-fixture\/wrangler\.json$/i.test(config.replaceAll('\\', '/'))
  && /\.wrangler\/customer-google-connect-local-0[1-4]$/i.test(persist.replaceAll('\\', '/'))
  && dbName === 'site-creator-d1';

if (base && !enabled) throw new Error('Customer Google route tests require the dedicated local Google D1 fixture and exact isolated paths.');

async function call(action, body = {}) {
  const response = await fetch(`${base}/__qa/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-QA-Customer-Google-Store': token, Connection: 'close' },
    body: JSON.stringify(body),
  });
  let result;
  try { result = await response.json(); }
  catch { throw new Error(`Local route fixture returned non-JSON for ${action} (${response.status}).`); }
  return { response, result };
}

const validCases = [
  {
    name: 'generic account connect',
    input: { purpose: 'account', returnContext: 'home' },
    purpose: 'account', context: 'home', returnTo: 'book',
  },
  {
    name: 'booking-prefill connect',
    input: { purpose: 'booking_prefill', returnContext: 'book' },
    purpose: 'booking_prefill', context: 'book', returnTo: 'book',
  },
  {
    name: 'legacy booking connect',
    input: { returnTo: 'support-booking' },
    purpose: 'booking_prefill', context: 'support-booking', returnTo: 'support-booking',
  },
];

test('actual customer route creates allowlisted OAuth state through the D1-backed CustomerGoogleStore', {
  skip: !enabled && 'Set TEST_CUSTOMER_GOOGLE_CONNECT_* from the fresh isolated local customer Google fixture only.',
}, async t => {
  const initialized = await call('init');
  assert.equal(initialized.response.status, 200);
  assert.deepEqual(initialized.result, { ready: true, counts: { states: 0, sessions: 0 } });

  for (const entry of validCases) await t.test(entry.name, async () => {
    const { response, result } = await call('google/connect', { input: entry.input });
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(typeof result.authorizationUrl, 'string');

    const authorization = new URL(result.authorizationUrl);
    assert.equal(authorization.origin, 'https://accounts.google.com');
    assert.equal(authorization.pathname, '/o/oauth2/v2/auth');
    assert.equal(authorization.searchParams.get('client_id'), 'customer-connect-fixture.apps.googleusercontent.com');
    assert.equal(authorization.searchParams.get('redirect_uri'), 'https://demo.example.test/api/customer/google/callback');
    assert.equal(authorization.searchParams.get('scope'), 'openid email profile');
    assert.equal(authorization.searchParams.get('response_type'), 'code');
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.match(authorization.searchParams.get('state') ?? '', /^[0-9a-f]{64}$/);
    assert.match(authorization.searchParams.get('nonce') ?? '', /^[0-9a-f]{64}$/);
    assert.match(authorization.searchParams.get('code_challenge') ?? '', /^[A-Za-z0-9_-]{43}$/);
    assert.match(response.headers.get('set-cookie') ?? '', /__Host-customer_google_oauth=/);
  });

  const persisted = await call('state/contracts');
  assert.equal(persisted.response.status, 200);
  const order = value => `${value.purpose}:${value.returnContext}:${value.returnTo}`;
  assert.deepEqual(persisted.result.states.map(order).sort(), validCases.map(({ purpose, context, returnTo }) => order({ purpose, returnContext: context, returnTo })).sort());
});

test('actual route rejects malformed or mixed connect inputs before D1 state writes', {
  skip: !enabled && 'Set TEST_CUSTOMER_GOOGLE_CONNECT_* from the fresh isolated local customer Google fixture only.',
}, async t => {
  const initialized = await call('init');
  assert.equal(initialized.response.status, 200);
  const before = await call('state/contracts');
  const beforeStates = before.result.states;

  const invalidInputs = [
    { purpose: 'account', returnContext: 'home', email: 'caller@example.invalid' },
    { purpose: 'account', returnContext: 'https://example.invalid/' },
    { purpose: 'booking_prefill', returnContext: 'home' },
    { returnTo: 'book', callback: 'https://example.invalid/' },
    { purpose: 'account', returnContext: 'home', returnTo: 'book' },
  ];
  for (const input of invalidInputs) await t.test(JSON.stringify(input), async () => {
    const { response, result } = await call('google/connect', { input });
    assert.equal(response.status, 400, JSON.stringify(result));
    assert.equal(result.error, 'Use the supported booking controls.');
  });

  const persisted = await call('state/contracts');
  assert.deepEqual(persisted.result.states, beforeStates);
});
