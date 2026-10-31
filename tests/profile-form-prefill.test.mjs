import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

async function loadTs(relativePath, imports = {}) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((specifier) => {
    if (Object.hasOwn(imports, specifier)) return imports[specifier];
    throw new Error(`Unexpected import from ${relativePath}: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const prefill = await loadTs('lib/profile-form-prefill.ts');
const emailValue = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const customer = (name, email, expiresAt = 100_000) => ({
  configured: true, authenticated: true, adminEligible: false,
  profile: { name, email }, expiresAt, prefillPending: false, prefillReturnTo: null,
});

function reconcile(state, value, options = {}) {
  return prefill.reconcileProfileField(state, {
    value, autofilled: false, kind: options.kind ?? 'name', maxLength: options.maxLength ?? 80,
    accept: options.accept, customer: options.customer ?? customer('Ari Example', 'ari@example.invalid'),
    availability: options.availability ?? 'ready', epoch: options.epoch ?? 4, now: options.now ?? 1,
  });
}

test('prefill fills only an untouched blank field from a current verified customer profile', () => {
  const initial = prefill.createProfileFieldState();
  const name = reconcile(initial, '');
  const email = reconcile(prefill.createProfileFieldState(), '', { kind: 'email', maxLength: 254, accept: emailValue });

  assert.equal(name.value, 'Ari Example');
  assert.equal(name.state.auto.name, 'Ari Example');
  assert.equal(name.state.auto.email, 'ari@example.invalid');
  assert.equal(email.value, 'ari@example.invalid');
});

test('loading does not add a profile value and manual typing or clearing is preserved', () => {
  const initial = prefill.createProfileFieldState();
  assert.equal(reconcile(initial, '', { availability: 'loading' }).value, '');

  const typed = prefill.editProfileField(initial);
  assert.equal(reconcile(typed, 'Typed by customer').value, 'Typed by customer');
  assert.equal(reconcile(typed, '').value, '', 'an explicit clear is still an edit');
});

test('browser-autofilled values are preserved instead of being replaced', () => {
  const state = prefill.createProfileFieldState();
  const result = prefill.reconcileProfileField(state, {
    value: 'browser@example.invalid', autofilled: true, kind: 'email', maxLength: 254,
    accept: emailValue, customer: customer('Ari Example', 'ari@example.invalid'),
    availability: 'ready', epoch: 4, now: 1,
  });
  assert.equal(result.value, 'browser@example.invalid');
  assert.equal(result.state.auto, null);
});

test('switching profiles at the same epoch replaces only an unchanged autofill', () => {
  const first = reconcile(prefill.createProfileFieldState(), '');
  const switched = reconcile(first.state, first.value, {
    epoch: 4, customer: customer('Bea Example', 'bea@example.invalid'),
  });
  assert.equal(switched.value, 'Bea Example');
  assert.equal(switched.state.auto.email, 'bea@example.invalid');

  const edited = prefill.editProfileField(first.state);
  const retained = reconcile(edited, 'Customer edited this', {
    epoch: 4, customer: customer('Bea Example', 'bea@example.invalid'),
  });
  assert.equal(retained.value, 'Customer edited this');
});

test('logout, expiry, or unavailable profile clears only an unchanged owned value', () => {
  const owned = reconcile(prefill.createProfileFieldState(), '');
  const guest = { ...customer(null, ''), authenticated: false, profile: null, expiresAt: null };
  assert.equal(reconcile(owned.state, owned.value, { customer: guest }).value, '');
  assert.equal(reconcile(owned.state, owned.value, { customer: customer('Ari Example', 'ari@example.invalid', 1), now: 2 }).value, '');
  assert.equal(reconcile(owned.state, owned.value, { availability: 'unavailable' }).value, '');

  const edited = prefill.editProfileField(owned.state);
  assert.equal(reconcile(edited, 'Human value', { customer: guest, availability: 'unavailable' }).value, 'Human value');
});

test('oversized, invalid and missing profile fields are skipped without truncation', () => {
  const overlong = reconcile(prefill.createProfileFieldState(), '', {
    customer: customer('Name longer than limit', 'ari@example.invalid'), maxLength: 8,
  });
  assert.equal(overlong.value, '');

  const invalidEmail = reconcile(prefill.createProfileFieldState(), '', {
    kind: 'email', maxLength: 254, accept: emailValue,
    customer: customer('Ari Example', 'not an email'),
  });
  assert.equal(invalidEmail.value, '');

  const noName = reconcile(prefill.createProfileFieldState(), '', {
    customer: customer(null, 'ari@example.invalid'),
  });
  assert.equal(noName.value, '');
});

function customerSnapshot(value, availability = 'ready') {
  return { customer: value, customerRead: { availability, httpStatus: availability === 'ready' ? 200 : null, reason: null } };
}

async function mountHook(fields, firstSnapshot, firstEpoch = 4) {
  let snapshot = firstSnapshot;
  let epoch = firstEpoch;
  let effect;
  let disposed = false;
  let refreshes = 0;
  const listeners = new Set();
  const accountController = {
    snapshot: () => snapshot,
    customerEpoch: () => epoch,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    refreshCustomer() { refreshes++; return Promise.resolve(); },
  };
  const react = {
    useRef: initial => ({ current: initial }),
    useEffect: callback => { effect = callback; },
    useCallback: callback => callback,
    useMemo: callback => callback(),
  };
  const module = await loadTs('hooks/use-profile-form-prefill.ts', {
    react,
    '../lib/account-controller': { accountController },
    '../lib/profile-form-prefill': prefill,
  });
  const api = module.useProfileFormPrefill(fields);
  const cleanup = effect?.();
  return {
    api,
    listeners,
    get refreshes() { return refreshes; },
    setSnapshot(value, nextEpoch = epoch) { snapshot = value; epoch = nextEpoch; for (const listener of listeners) listener(); },
    unmount() { cleanup?.(); disposed = true; },
    get disposed() { return disposed; },
  };
}

function input(value, maxLength) {
  const listeners = new Map();
  return {
    value, maxLength, isConnected: true, disabled: false,
    matches: () => false,
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
    listeners,
  };
}

test('shared hook refreshes the existing customer role and honors manual clear and same-epoch profile replacement', async () => {
  const name = { current: input('', 80) };
  const email = { current: input('', 254) };
  const delayedName = { current: input('', 80) };
  const changes = [];
  const mounted = await mountHook({
    name: { ref: name, kind: 'name', maxLength: 80, onValueChange: value => changes.push(['name', value]) },
    email: { ref: email, kind: 'email', maxLength: 254, accept: emailValue, onValueChange: value => changes.push(['email', value]) },
    delayedName: { ref: delayedName, kind: 'name', maxLength: 80 },
  }, customerSnapshot({ ...customer(null, ''), authenticated: false, profile: null, expiresAt: null }, 'loading'));

  assert.equal(mounted.refreshes, 1);
  mounted.api.sync();
  assert.equal(name.current.value, '');
  delayedName.current.value = 'Typed while waiting';
  mounted.api.edited('delayedName');
  mounted.setSnapshot(customerSnapshot(customer('Ari Example', 'ari@example.invalid', Date.now() + 60_000)));
  assert.equal(name.current.value, 'Ari Example');
  assert.equal(email.current.value, 'ari@example.invalid');
  assert.equal(delayedName.current.value, 'Typed while waiting', 'a delayed profile cannot replace typing entered before it arrived');

  name.current.value = '';
  mounted.api.edited('name');
  mounted.api.sync();
  assert.equal(name.current.value, '', 'manual clear is never refilled');

  mounted.setSnapshot(customerSnapshot(customer('Bea Example', 'bea@example.invalid', Date.now() + 60_000)));
  assert.equal(name.current.value, '');
  assert.equal(email.current.value, 'bea@example.invalid', 'same epoch does not hide a profile change');
  assert.deepEqual(changes, [['name', 'Ari Example'], ['email', 'ari@example.invalid'], ['email', 'bea@example.invalid']]);
  mounted.unmount();
  assert.equal(mounted.listeners.size, 0);
  assert.equal(name.current.listeners.size, 0);
  assert.equal(email.current.listeners.size, 0);
  assert.equal(delayedName.current.listeners.size, 0);
});

test('shared hook leaves phone, edited values, autofill and pending Contact payload alone', async () => {
  const contact = { current: input('406-555-0100', 160) };
  const name = { current: input('', 80) };
  const submission = await loadTs('lib/contact-submission.ts');
  let state = submission.createContactSubmission();
  state = submission.reduceContactSubmission(state, { type: 'edit', field: 'message', value: 'Submitted text' });
  state = submission.reduceContactSubmission(state, { type: 'submit', requestKey: 'e7000000-0000-4000-8000-000000000001' });
  const pendingBefore = structuredClone(state.pending);
  const mounted = await mountHook({
    name: { ref: name, kind: 'name', maxLength: 80 },
    contact: { ref: contact, kind: 'email', maxLength: 160, accept: emailValue },
  }, customerSnapshot(customer('Ari Example', 'ari@example.invalid', Date.now() + 60_000)));
  mounted.api.sync();

  assert.equal(contact.current.value, '406-555-0100', 'verified email must not replace an existing phone number');
  assert.equal(name.current.value, 'Ari Example');
  assert.deepEqual(state.pending, pendingBefore, 'prefill does not edit, resubmit, or replace the immutable request snapshot/key');
  mounted.unmount();
  assert.equal(contact.current.listeners.size, 0);
  assert.equal(name.current.listeners.size, 0);
});

test('both forms use the shared client hook without exposing profile data in cached HTML or analytics', async () => {
  const [contact, inquiry, template, islands, page] = await Promise.all([
    readFile(path.join(root, 'components/contact-form.tsx'), 'utf8'),
    readFile(path.join(root, 'components/inquiry-form.tsx'), 'utf8'),
    readFile(path.join(root, 'lib/public-template.tsx'), 'utf8'),
    readFile(path.join(root, 'client/public-islands.tsx'), 'utf8'),
    readFile(path.join(root, 'app/contact/page.tsx'), 'utf8'),
  ]);
  assert.match(contact, /useProfileFormPrefill/);
  assert.match(contact, /name[^\n]*kind:'name'/);
  assert.match(contact, /email[^\n]*kind:'email'/);
  assert.match(contact, /ContactForm/);
  assert.match(inquiry, /useProfileFormPrefill/);
  assert.match(inquiry, /name[^\n]*kind:'name'/);
  assert.match(inquiry, /contact[^\n]*kind:'email'/);
  assert.match(inquiry, /accept:[^,}]*email/i);
  assert.match(inquiry, /form\.reset\(\)/, 'successful Inquiry submission keeps its existing reset behavior');
  assert.match(page, /<ContactForm\s*\/>/);
  assert.match(template, /data-public-island="inquiry"/);
  assert.match(islands, /inquiry:InquiryForm/);
  assert.doesNotMatch(template, /customer\.profile|profile\.email|google_subject|customer_email/);
  const [hook, helper] = await Promise.all([
    readFile(path.join(root, 'hooks/use-profile-form-prefill.ts'), 'utf8'),
    readFile(path.join(root, 'lib/profile-form-prefill.ts'), 'utf8'),
  ]);
  assert.doesNotMatch(`${hook}\n${helper}`, /localStorage|sessionStorage|dataLayer|analytics|google_subject|adminEligible/);
});
