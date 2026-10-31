import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(root, 'lib/consent-client.ts'), 'utf8');
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

class SharedStorage {
  values = new Map();
  fail = false;
  getItem(key) { if (this.fail) throw new Error('storage unavailable'); return this.values.get(key) ?? null; }
  setItem(key, value) { if (this.fail) throw new Error('storage unavailable'); this.values.set(key, String(value)); }
}

class ExclusiveLocks {
  tails = new Map();
  request(name, _options, callback) {
    const previous = this.tails.get(name) ?? Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const tail = previous.then(() => gate);
    this.tails.set(name, tail);
    return previous.then(callback).finally(() => {
      release();
      if (this.tails.get(name) === tail) this.tails.delete(name);
    });
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function makeClient({ storage = new SharedStorage(), locks = new ExclusiveLocks(), fetch, crypto = globalThis.crypto } = {}) {
  const window = { addEventListener() {}, location: { reload() {} } };
  const navigator = locks === null ? {} : { locks };
  const document = { getElementById() { return null; } };
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', 'navigator', 'window', 'localStorage', 'fetch', 'document', 'crypto', 'AbortSignal', 'BroadcastChannel', javascript)(
    name => {
      if (name === './tag-identity-client') return { resetGoogleTagIdentityBinding() {} };
      throw new Error(`Unexpected consent-client import: ${name}`);
    }, loaded, loaded.exports,
    navigator, window, storage, fetch, document, crypto, AbortSignal, undefined,
  );
  return loaded.exports;
}

function response(state, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return { ...state }; } };
}

function server({ analytics = false, experiments = false, analyticsRevision = 0, experimentsRevision = 0 } = {}) {
  const state = { configured: true, analytics, analyticsSaved: analytics, analyticsSuppressed: false, experiments, analyticsRevision, experimentsRevision, measurementId: null };
  const posts = [];
  const requests = [];
  const fetch = async (_url, init = {}) => {
    const method = init.method ?? 'GET';
    requests.push({ method, body: init.body });
    if (method === 'GET') return response(state);
    const body = JSON.parse(init.body);
    posts.push(body);
    const revisionKey = body.purpose === 'analytics' ? 'analyticsRevision' : 'experimentsRevision';
    const valueKey = body.purpose;
    if (body.expectedPurposeRevision !== state[revisionKey]) return response(state, 409);
    state[valueKey] = body.grant;
    if (valueKey === 'analytics') state.analyticsSaved = body.grant;
    state[revisionKey]++;
    state.measurementId = state.analytics && state.experiments ? 'G-S4J27S9VMH' : null;
    return response(state);
  };
  return { state, posts, requests, fetch };
}

test('a later cross-tab decline supersedes a queued first Allow before it can post', async () => {
  const storage = new SharedStorage();
  const locks = new ExclusiveLocks();
  const api = server();
  const firstGet = deferred();
  const releaseFirstGet = deferred();
  let first = true;
  const fetch = async (url, init) => {
    if (first && (init?.method ?? 'GET') === 'GET') {
      first = false;
      firstGet.resolve();
      await releaseFirstGet.promise;
    }
    return api.fetch(url, init);
  };
  const tabA = makeClient({ storage, locks, fetch });
  const tabB = makeClient({ storage, locks, fetch });

  const allow = tabA.choosePurposeConsent('analytics', true);
  await firstGet.promise;
  const decline = tabB.choosePurposeConsent('analytics', false);
  await Promise.resolve();
  assert.equal(api.posts.length, 0, 'same-purpose exclusive lock keeps the queued decline from racing the first read');
  releaseFirstGet.resolve();
  await Promise.all([allow, decline]);

  assert.deepEqual(api.posts.map(({ purpose, grant }) => ({ purpose, grant })), [{ purpose: 'analytics', grant: false }]);
  assert.equal(api.state.analytics, false);
  assert.equal(api.state.analyticsRevision, 1);
  assert.equal(tabA.consentSnapshot().analytics, false, 'stale Allow completion cannot restore local analytics state');
  assert.equal(tabB.consentSnapshot().analytics, false);
  assert.equal(api.requests.some(request => String(request.body).includes('functional-consent-intent')), false);
});

test('a committed but delayed Allow response cannot re-enable analytics after a later Decline intent', async () => {
  const storage = new SharedStorage();
  const locks = new ExclusiveLocks();
  const api = server();
  const allowPostStarted = deferred();
  const releaseAllowPost = deferred();
  const fetch = async (url, init = {}) => {
    if (init.method === 'POST') {
      const body = JSON.parse(init.body);
      const revisionKey = body.purpose === 'analytics' ? 'analyticsRevision' : 'experimentsRevision';
      const valueKey = body.purpose;
      api.posts.push(body);
      if (body.expectedPurposeRevision !== api.state[revisionKey]) return response(api.state, 409);
      api.state[valueKey] = body.grant;
      if (valueKey === 'analytics') api.state.analyticsSaved = body.grant;
      api.state[revisionKey]++;
      api.state.measurementId = api.state.analytics && api.state.experiments ? 'G-S4J27S9VMH' : null;
      if (body.grant) {
        allowPostStarted.resolve();
        await releaseAllowPost.promise;
      }
      return response(api.state);
    }
    return response(api.state);
  };
  const tabA = makeClient({ storage, locks, fetch });
  const tabB = makeClient({ storage, locks, fetch });

  const allow = tabA.choosePurposeConsent('analytics', true);
  await allowPostStarted.promise;
  const decline = tabB.choosePurposeConsent('analytics', false);
  assert.equal(tabA.analyticsReferenceAllowed(), false, 'the local decline intent disables optional navigation immediately');
  releaseAllowPost.resolve();
  await allow;
  assert.equal(tabA.consentSnapshot().analytics, false, 'old Allow readback is ignored while the newer decline is pending');
  assert.equal(tabA.analyticsReferenceAllowed(), false);
  await decline;

  assert.deepEqual(api.posts.map(({ grant, expectedPurposeRevision }) => ({ grant, expectedPurposeRevision })), [
    { grant: true, expectedPurposeRevision: 0 },
    { grant: false, expectedPurposeRevision: 1 },
  ]);
  assert.equal(api.state.analytics, false);
  assert.equal(api.state.analyticsRevision, 2);
  assert.equal(tabA.consentSnapshot().analytics, false);
  assert.equal(tabB.consentSnapshot().analytics, false);
});

test('a fresh explicit Allow after a completed Decline uses the new purpose revision', async () => {
  const storage = new SharedStorage();
  const locks = new ExclusiveLocks();
  const api = server();
  const tabA = makeClient({ storage, locks, fetch: api.fetch });
  const tabB = makeClient({ storage, locks, fetch: api.fetch });

  await tabA.choosePurposeConsent('analytics', false);
  await tabB.choosePurposeConsent('analytics', true);

  assert.deepEqual(api.posts.map(({ purpose, grant, expectedPurposeRevision }) => ({ purpose, grant, expectedPurposeRevision })), [
    { purpose: 'analytics', grant: false, expectedPurposeRevision: 0 },
    { purpose: 'analytics', grant: true, expectedPurposeRevision: 1 },
  ]);
  assert.equal(api.state.analytics, true);
  assert.equal(api.state.analyticsRevision, 2);
});

test('independent purpose choices use separate locks, cookies and revisions', async () => {
  const storage = new SharedStorage();
  const locks = new ExclusiveLocks();
  const api = server();
  const client = makeClient({ storage, locks, fetch: api.fetch });
  await Promise.all([
    client.choosePurposeConsent('analytics', true),
    client.choosePurposeConsent('experiments', true),
  ]);

  assert.deepEqual(api.posts.map(({ purpose, grant, expectedPurposeRevision }) => ({ purpose, grant, expectedPurposeRevision })).sort((a, b) => a.purpose.localeCompare(b.purpose)), [
    { purpose: 'analytics', grant: true, expectedPurposeRevision: 0 },
    { purpose: 'experiments', grant: true, expectedPurposeRevision: 0 },
  ]);
  assert.equal(api.state.analytics, true);
  assert.equal(api.state.experiments, true);
  assert.equal(api.state.analyticsRevision, 1);
  assert.equal(api.state.experimentsRevision, 1);
  assert.equal(client.consentSnapshot().measurementId, 'G-S4J27S9VMH');
});

test('a pending denial is recovered under its purpose lock using fresh revision and readback', async () => {
  const storage = new SharedStorage();
  storage.setItem('functional-consent-intent:analytics', JSON.stringify({ id: 'pending-deny', grant: false, pending: true }));
  const api = server({ analytics: true, analyticsRevision: 4, experiments: true, experimentsRevision: 2 });
  const client = makeClient({ storage, fetch: api.fetch });
  await client.refreshPurposeConsent();

  assert.equal(client.consentSnapshot().analytics, false);
  assert.equal(client.consentSnapshot().experiments, true);
  assert.equal(client.analyticsReferenceAllowed(), false);
  assert.deepEqual(api.posts, [{ purpose: 'analytics', grant: false, expectedPurposeRevision: 4 }]);
  assert.deepEqual(JSON.parse(storage.getItem('functional-consent-intent:analytics')), { id: 'pending-deny', grant: false, pending: false });
  assert.equal(api.state.analytics, false);
  assert.equal(api.state.analyticsRevision, 5);
  assert.equal(api.state.experimentsRevision, 2);
});

test('a newer explicit Allow supersedes a queued pending-denial recovery without posting the old denial', async () => {
  const storage = new SharedStorage();
  const locks = new ExclusiveLocks();
  const api = server({ analytics: true, analyticsRevision: 4 });
  storage.setItem('functional-consent-intent:analytics', JSON.stringify({ id: 'pending-deny', grant: false, pending: true }));
  const client = makeClient({ storage, locks, fetch: api.fetch });
  const entered = deferred();
  const release = deferred();
  const blocker = locks.request('optional-purpose-choice:analytics', { mode: 'exclusive' }, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;

  const recovering = client.refreshPurposeConsent();
  await Promise.resolve();
  const newerAllow = client.choosePurposeConsent('analytics', true);
  const latest = JSON.parse(storage.getItem('functional-consent-intent:analytics'));
  assert.equal(latest.grant, true);
  assert.notEqual(latest.id, 'pending-deny');
  release.resolve();
  await blocker;
  await Promise.all([recovering, newerAllow]);

  assert.deepEqual(api.posts.map(({ purpose, grant }) => ({ purpose, grant })), [{ purpose: 'analytics', grant: true }]);
  assert.equal(api.state.analytics, true);
  assert.equal(client.consentSnapshot().analytics, true);
});

test('failed denial recovery stays pending and locally off, then a later refresh retries the same denial', async () => {
  const storage = new SharedStorage();
  storage.setItem('functional-consent-intent:analytics', JSON.stringify({ id: 'pending-deny-retry', grant: false, pending: true }));
  const api = server({ analytics: true, analyticsRevision: 7 });
  const fetch = async (url, init = {}) => {
    if (init.method === 'POST' && api.posts.length === 0) {
      api.posts.push(JSON.parse(init.body));
      return response(api.state, 503);
    }
    return api.fetch(url, init);
  };
  const client = makeClient({ storage, fetch });

  await client.refreshPurposeConsent();
  assert.equal(client.consentSnapshot().analytics, false);
  assert.equal(client.analyticsReferenceAllowed(), false);
  assert.deepEqual(JSON.parse(storage.getItem('functional-consent-intent:analytics')), { id: 'pending-deny-retry', grant: false, pending: true });
  assert.equal(api.state.analytics, true, 'the failed request did not falsely claim a saved denial');

  await client.refreshPurposeConsent();
  assert.deepEqual(api.posts.map(({ purpose, grant, expectedPurposeRevision }) => ({ purpose, grant, expectedPurposeRevision })), [
    { purpose: 'analytics', grant: false, expectedPurposeRevision: 7 },
    { purpose: 'analytics', grant: false, expectedPurposeRevision: 7 },
  ]);
  assert.deepEqual(JSON.parse(storage.getItem('functional-consent-intent:analytics')), { id: 'pending-deny-retry', grant: false, pending: false });
  assert.equal(api.state.analytics, false);
  assert.equal(api.state.analyticsRevision, 8);
});

test('recovering one purpose leaves the other purpose cookie, grant and revision unchanged', async () => {
  const storage = new SharedStorage();
  storage.setItem('functional-consent-intent:analytics', JSON.stringify({ id: 'pending-analytics-deny', grant: false, pending: true }));
  storage.setItem('functional-consent-intent:experiments', JSON.stringify({ id: 'saved-experiments', grant: true, pending: false }));
  const api = server({ analytics: true, experiments: true, analyticsRevision: 3, experimentsRevision: 6 });
  const client = makeClient({ storage, fetch: api.fetch });

  await client.refreshPurposeConsent();

  assert.deepEqual(api.posts, [{ purpose: 'analytics', grant: false, expectedPurposeRevision: 3 }]);
  assert.equal(api.state.analyticsRevision, 4);
  assert.equal(api.state.experimentsRevision, 6);
  assert.equal(api.state.experiments, true);
  assert.deepEqual(JSON.parse(storage.getItem('functional-consent-intent:analytics')), { id: 'pending-analytics-deny', grant: false, pending: false });
  assert.deepEqual(JSON.parse(storage.getItem('functional-consent-intent:experiments')), { id: 'saved-experiments', grant: true, pending: false });
});

test('Allow fails closed without Web Locks or functional storage while Decline remains available', async () => {
  const noLocksApi = server();
  const noLocks = makeClient({ locks: null, fetch: noLocksApi.fetch });
  await assert.rejects(noLocks.choosePurposeConsent('analytics', true), /cannot coordinate privacy choices/);
  assert.equal(noLocksApi.posts.length, 0);
  await noLocks.choosePurposeConsent('analytics', false);
  assert.equal(noLocksApi.posts.length, 1);
  assert.equal(noLocksApi.state.analytics, false);

  const brokenStorage = new SharedStorage();
  brokenStorage.fail = true;
  const storageApi = server();
  const noStorage = makeClient({ storage: brokenStorage, fetch: storageApi.fetch });
  await assert.rejects(noStorage.choosePurposeConsent('experiments', true), /cannot coordinate privacy choices/);
  assert.equal(storageApi.posts.length, 0);
});
