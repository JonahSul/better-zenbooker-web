import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadController() {
  const source = await readFile(path.join(root, 'lib/account-controller.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((specifier) => {
    throw new Error(`Unexpected import from account-controller: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const controllerModule = await loadController();
const { AccountController, GENERIC_ACCOUNT_SNAPSHOT, projectAccountControls } = controllerModule;

const customer = (overrides = {}) => ({
  configured: true,
  authenticated: true,
  profile: { name: 'Fixture Customer', email: 'fixture@example.test' },
  expiresAt: 20_000,
  prefillPending: false,
  prefillReturnTo: null,
  adminEligible: false,
  ...overrides,
});
const admin = (overrides = {}) => ({
  configured: true,
  authenticated: true,
  email: 'owner@example.test',
  expiresAt: 20_000,
  ...overrides,
});

test('the default global fetch keeps its Window-like receiver', async t => {
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const calls = [];
  globalThis.fetch = function (url, init) {
    calls.push({ receiver: this, url, cache: init.cache });
    return Promise.resolve(Response.json(url.includes('/customer/') ? customer() : admin()));
  };
  const controller = new AccountController(undefined, () => 10_000);
  const unsubscribe = controller.subscribe(() => {});
  t.after(() => {
    unsubscribe();
    if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
    else delete globalThis.fetch;
  });

  const snapshot = await controller.refresh();

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ url, cache }) => ({ url, cache })), [
    { url: '/api/customer/google/status', cache: 'no-store' },
    { url: '/api/admin/auth/status', cache: 'no-store' },
  ]);
  assert.ok(calls.every(call => call.receiver === globalThis), 'Fetch must receive the global platform object, not the controller instance');
  assert.equal(snapshot.customer.authenticated, true);
  assert.equal(snapshot.customer.profile.email, 'fixture@example.test');
  assert.equal(snapshot.admin.authenticated, true);
  assert.equal(snapshot.admin.email, 'owner@example.test');
});

test('account status uses uncached independent customer and admin reads', async t => {
  let now = 10_000;
  const calls = [];
  const controller = new AccountController(async (url, init) => {
    calls.push({ url, cache: init.cache });
    return Response.json(url.includes('/customer/')
      ? customer({ configured: false })
      : admin());
  }, () => now);
  const unsubscribe = controller.subscribe(() => {});
  t.after(unsubscribe);

  const snapshot = await controller.refresh();

  assert.deepEqual(calls, [
    { url: '/api/customer/google/status', cache: 'no-store' },
    { url: '/api/admin/auth/status', cache: 'no-store' },
  ]);
  assert.equal(snapshot.customer.configured, false);
  assert.equal(snapshot.customer.authenticated, true);
  assert.equal(snapshot.admin.authenticated, true);
  assert.equal(snapshot.customer.profile.email, 'fixture@example.test');
  assert.equal(snapshot.admin.email, 'owner@example.test');
});

test('expired or malformed role snapshots fail closed without changing the other role', async t => {
  let now = 10_000;
  const controller = new AccountController(async url => Response.json(url.includes('/customer/')
    ? customer({ expiresAt: now, prefillPending: true, prefillReturnTo: 'book' })
    : { configured: true, authenticated: true, email: 'owner@example.test', expiresAt: '20000' }), () => now);
  const unsubscribe = controller.subscribe(() => {});
  t.after(unsubscribe);

  const snapshot = await controller.refresh();

  assert.equal(snapshot.customer.authenticated, false);
  assert.equal(snapshot.customer.profile, null);
  assert.equal(snapshot.customer.prefillPending, false);
  assert.equal(snapshot.customer.prefillReturnTo, null);
  assert.equal(snapshot.admin.authenticated, false);
  assert.equal(snapshot.admin.email, null);
  assert.equal(snapshot.customer.configured, false);
  assert.equal(snapshot.customerRead.availability, 'unavailable');
  assert.equal(snapshot.customerRead.reason, 'invalid_response');
  assert.equal(snapshot.admin.configured, false);
  assert.equal(snapshot.adminRead.availability, 'unavailable');
  assert.equal(snapshot.adminRead.reason, 'invalid_response');
  now += 1;
  controller.invalidateCustomer();
  assert.equal(controller.snapshot().admin.authenticated, false);
});

test('late status reads cannot overwrite a newer account snapshot', async t => {
  const pending = [];
  const controller = new AccountController((url) => new Promise(resolve => pending.push({ url, resolve })), () => 10_000);
  const unsubscribe = controller.subscribe(() => {});
  t.after(unsubscribe);

  const older = controller.refresh();
  const newer = controller.refresh();
  assert.equal(pending.length, 4);

  for (const request of pending.slice(2)) {
    request.resolve(Response.json(request.url.includes('/customer/')
      ? customer({ profile: { name: 'Newer', email: 'newer@example.test' } })
      : admin({ email: 'newer-owner@example.test' })));
  }
  await newer;
  for (const request of pending.slice(0, 2)) {
    request.resolve(Response.json(request.url.includes('/customer/')
      ? customer({ profile: { name: 'Older', email: 'older@example.test' } })
      : admin({ email: 'older-owner@example.test' })));
  }
  await older;

  assert.equal(controller.snapshot().customer.profile.email, 'newer@example.test');
  assert.equal(controller.snapshot().admin.email, 'newer-owner@example.test');
});

test('customer and Admin invalidation are independent and erase only their own identity fields', async t => {
  const controller = new AccountController(async url => Response.json(url.includes('/customer/') ? customer() : admin()), () => 10_000);
  const unsubscribe = controller.subscribe(() => {});
  t.after(unsubscribe);
  await controller.refresh();

  controller.invalidateCustomer();
  assert.equal(controller.snapshot().customer.authenticated, false);
  assert.equal(controller.snapshot().customer.profile, null);
  assert.equal(controller.snapshot().admin.authenticated, true);
  assert.equal(controller.snapshot().admin.email, 'owner@example.test');

  await controller.refresh();
  controller.invalidateAdmin();
  assert.equal(controller.snapshot().admin.authenticated, false);
  assert.equal(controller.snapshot().admin.email, null);
  assert.equal(controller.snapshot().customer.authenticated, true);
  assert.equal(controller.snapshot().customer.profile.email, 'fixture@example.test');
});

test('a valid signed-out customer response is ready, while the native Admin 401 is a recoverable ready state', async t => {
  const controller = new AccountController(async url => url.includes('/customer/')
    ? Response.json(customer())
    : Response.json({ code: 'native_session_required' }, { status: 401 }), () => 10_000);
  const unsubscribe = controller.subscribe(() => {});
  t.after(unsubscribe);

  const snapshot = await controller.refresh();

  assert.deepEqual(snapshot.customerRead, { availability: 'ready', httpStatus: 200, reason: null });
  assert.equal(snapshot.customer.authenticated, true);
  assert.equal(snapshot.customer.profile.email, 'fixture@example.test');
  assert.equal(snapshot.customer.adminEligible, false);
  assert.deepEqual(snapshot.adminRead, {
    availability: 'ready', httpStatus: 401, reason: 'native_session_required',
    nativeSignInPath: '/signin-with-chatgpt?return_to=%2Fadmin',
  });
  assert.equal(snapshot.admin.authenticated, false);
});

test('ordinary 401 is an unauthenticated ready response, not a network failure or invented identity', async t => {
  const controller = new AccountController(async url => url.includes('/customer/')
    ? Response.json({ error: 'sign-in required' }, { status: 401 })
    : Response.json(admin()), () => 10_000);
  const unsubscribe = controller.subscribe(() => {});
  t.after(unsubscribe);

  const snapshot = await controller.refresh();

  assert.deepEqual(snapshot.customerRead, { availability: 'ready', httpStatus: 401, reason: 'authentication_required' });
  assert.equal(snapshot.customer.authenticated, false);
  assert.equal(snapshot.customer.profile, null);
  assert.equal(snapshot.customer.configured, false);
  assert.equal(snapshot.adminRead.availability, 'ready');
  assert.equal(snapshot.admin.authenticated, true);
});

test('status transport, timeout, malformed JSON and invalid DTO failures are unavailable per role', async t => {
  const cases = [
    ['network', async () => { throw new TypeError('offline'); }],
    ['timeout', async () => { throw new DOMException('expired', 'TimeoutError'); }],
    ['invalid_response', async () => new Response('{', { status: 200 })],
    ['invalid_response', async () => Response.json({ configured: true, authenticated: true, profile: { email: 'not-an-email' }, expiresAt: 20_000 })],
    ['http', async () => Response.json({ error: 'unavailable' }, { status: 503 })],
  ];

  for (const [reason, customerResponse] of cases) {
    const controller = new AccountController(async url => url.includes('/customer/') ? customerResponse() : Response.json(admin()), () => 10_000);
    const unsubscribe = controller.subscribe(() => {});
    const snapshot = await controller.refresh();
    unsubscribe();
    assert.deepEqual(snapshot.customerRead, {
      availability: 'unavailable', httpStatus: reason === 'network' || reason === 'timeout' ? null : reason === 'http' ? 503 : 200,
      reason,
    });
    assert.equal(snapshot.customer.authenticated, false);
    assert.equal(snapshot.customer.profile, null);
    assert.equal(snapshot.customer.configured, false);
    assert.equal(snapshot.adminRead.availability, 'ready');
    assert.equal(snapshot.admin.authenticated, true);
  }
});

test('Admin eligibility is accepted only as a server field on a current verified customer session', async t => {
  const controller = new AccountController(async url => Response.json(url.includes('/customer/')
    ? customer({ adminEligible: true })
    : { configured: false, authenticated: false, email: null, expiresAt: null }), () => 10_000);
  const unsubscribe = controller.subscribe(() => {});
  t.after(unsubscribe);

  const snapshot = await controller.refresh();

  assert.equal(snapshot.customer.adminEligible, true);
  assert.equal(snapshot.customerRead.availability, 'ready');
  assert.equal(snapshot.admin.authenticated, false);
  assert.equal(snapshot.admin.email, null);
});

test('a fast customer identity is published before a slow independent Admin status read completes', async t => {
  const pending = [];
  const controller = new AccountController(url => new Promise(resolve => pending.push({ url, resolve })), () => 10_000);
  const unsubscribe = controller.subscribe(() => {});
  t.after(unsubscribe);

  const refresh = controller.refresh();
  assert.equal(pending.length, 2);
  pending.find(request => request.url.includes('/customer/')).resolve(Response.json(customer()));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(controller.snapshot().customerRead.availability, 'ready');
  assert.equal(controller.snapshot().customer.authenticated, true);
  assert.equal(controller.snapshot().customer.profile.email, 'fixture@example.test');
  assert.equal(controller.snapshot().adminRead.availability, 'loading');

  pending.find(request => request.url.includes('/admin/')).resolve(Response.json({ code: 'native_session_required' }, { status: 401 }));
  await refresh;
  assert.equal(controller.snapshot().customer.profile.email, 'fixture@example.test');
  assert.equal(controller.snapshot().adminRead.reason, 'native_session_required');
});

test('logout settles a pending role read and a late identity response cannot restore that role', async t => {
  let resolveCustomer, customerCalls = 0;
  const pendingController = new AccountController(url => url.includes('/customer/')
    ? ++customerCalls === 1
      ? Promise.resolve(Response.json(customer()))
      : new Promise(resolve => { resolveCustomer = resolve; })
    : Promise.resolve(Response.json(admin())), () => 10_000);
  const pendingUnsubscribe = pendingController.subscribe(() => {});
  t.after(pendingUnsubscribe);
  await pendingController.refresh();
  const refresh = pendingController.refreshCustomer();
  assert.equal(pendingController.snapshot().customerRead.availability, 'loading');

  pendingController.beginLogout('customer');
  assert.notEqual(pendingController.snapshot().customerRead.availability, 'loading');
  assert.equal(pendingController.snapshot().loading, false);
  assert.equal(pendingController.snapshot().customer.authenticated, false);

  resolveCustomer(Response.json(customer({ profile: { name: 'Late', email: 'late@example.test' } })));
  await refresh;
  pendingController.endLogout('customer');
  assert.equal(pendingController.snapshot().customer.authenticated, false);
  assert.equal(pendingController.snapshot().customer.profile, null);
  assert.equal(pendingController.snapshot().admin.authenticated, true);
});

test('configured guest action and Admin visibility depend on server state, not browser coordination capability', () => {
  const guest = {
    ...GENERIC_ACCOUNT_SNAPSHOT,
    customer: { ...GENERIC_ACCOUNT_SNAPSHOT.customer, configured: true },
    customerRead: { availability: 'ready', httpStatus: 200, reason: null },
  };
  const guestControls = projectAccountControls(guest);
  assert.equal(guestControls.showGoogleSignIn, true);
  assert.equal(guestControls.showAdmin, false);

  const eligible = {
    ...guest,
    customer: { ...guest.customer, authenticated: true, adminEligible: true, profile: { name: 'Fixture', email: 'owner@example.test' }, expiresAt: 20_000 },
    adminRead: { availability: 'ready', httpStatus: 401, reason: 'native_session_required', nativeSignInPath: '/signin-with-chatgpt?return_to=%2Fadmin' },
  };
  const eligibleControls = projectAccountControls(eligible);
  assert.equal(eligibleControls.showAdmin, true);
  assert.equal(eligibleControls.nativeSignInPath, '/signin-with-chatgpt?return_to=%2Fadmin');

  const forged = { ...eligible, customer: { ...eligible.customer, adminEligible: false } };
  assert.equal(projectAccountControls(forged).showAdmin, false);
});
