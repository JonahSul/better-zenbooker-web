import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => readFile(path.join(root, relative), 'utf8');
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

async function loadTsModule(relative, overrides) {
  const source = await read(relative);
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (Object.hasOwn(overrides, specifier)) return overrides[specifier];
    if (specifier === 'zod/v3' && Object.hasOwn(overrides, 'zod')) return overrides.zod;
    throw new Error(`Unexpected ${relative} import: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

async function harness(initialIds = ['home_book_header'], { deferEvents = false } = {}) {
  const now = Date.now();
  const descriptor = {
    purpose: 'element-document-v1', workspaceId: 'fixture-workspace', route: '/',
    snapshotHash: 'a'.repeat(64), assetManifestHash: 'b'.repeat(64),
    rendererVersion: 'fixture-renderer', registryVersion: 'element-v2',
    issuedAt: now - 1000, expiresAt: now + 30 * 60 * 1000,
  };
  const token = `${Buffer.from(JSON.stringify(descriptor)).toString('base64url')}.fixture-signature`;
  let clock = 0;
  let nextTimer = 1;
  const timers = new Map();
  const setTimer = (callback, delay = 0) => {
    const id = nextTimer++;
    timers.set(id, { callback, at: clock + Math.max(0, Number(delay) || 0) });
    return id;
  };
  const clearTimer = id => timers.delete(id);
  const advance = async duration => {
    const end = clock + duration;
    while (true) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      clock = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
      await tick();
    }
    clock = end;
    await tick();
  };
  const eventListeners = new Map();
  const pageListeners = new Map();
  const nodes = [];
  let intersectionObserver;
  let mutationObserver;
  class FakeElement {
    constructor(id) { this.id = id; this.dataset = { measurementElement: id }; this.isConnected = true; }
    getAttribute(name) { return name === 'data-measurement-element' ? this.dataset.measurementElement : null; }
    closest() { return this; }
    querySelector() { return null; }
  }
  nodes.push(...initialIds.map(id => new FakeElement(id)));
  class FakeIntersectionObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      intersectionObserver = { deliver: (node, ratio) => callback([{ target: node, isIntersecting: ratio > 0, intersectionRatio: ratio }]) };
    }
    observe(node) { this.targets.add(node); }
    unobserve(node) { this.targets.delete(node); }
    disconnect() { this.targets.clear(); }
  }
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; mutationObserver = { trigger: () => callback() }; }
    observe() {}
    disconnect() {}
  }
  const document = {
    visibilityState: 'visible', body: {}, referrer: 'https://sensitive.invalid/path?from=private',
    addEventListener(type, listener) { eventListeners.set(type, listener); },
    removeEventListener(type) { eventListeners.delete(type); },
    querySelectorAll() { return nodes.filter(node => node.isConnected); },
    getElementById(id) { return id === 'optional-gtm' ? {} : null; },
    fire(type, target) { eventListeners.get(type)?.({ type, target }); },
  };
  const window = {
    dataLayer: [], setTimeout: setTimer, clearTimeout: clearTimer,
    addEventListener(type, listener) { pageListeners.set(type, listener); },
    removeEventListener(type) { pageListeners.delete(type); },
    pagehide() { pageListeners.get('pagehide')?.({ type: 'pagehide' }); },
  };
  const saved = {};
  for (const key of ['document', 'window', 'location', 'performance', 'Element', 'IntersectionObserver', 'MutationObserver', 'setTimeout', 'clearTimeout', 'fetch']) {
    saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
  }
  globalThis.document = document;
  globalThis.window = window;
  globalThis.location = { pathname: '/', href: 'https://site.example/?secret=query-value#secret-fragment' };
  globalThis.performance = { now: () => clock, getEntriesByType: () => [{ serverTiming: [{ name: 'element_document', description: token }] }] };
  globalThis.Element = FakeElement;
  globalThis.IntersectionObserver = FakeIntersectionObserver;
  globalThis.MutationObserver = FakeMutationObserver;
  globalThis.setTimeout = setTimer;
  globalThis.clearTimeout = clearTimer;
  const requests = [];
  const pendingEventResponses = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith('/documents')) return { ok: true, json: async () => ({ documentId: '00000000-0000-4000-8000-000000000001', expiresAt: descriptor.expiresAt }) };
    if (deferEvents) return await new Promise(resolve => pendingEventResponses.push(() => resolve({ ok: true, json: async () => ({ accepted: 1, duplicates: 0 }) })));
    return { ok: true, json: async () => ({ accepted: 1, duplicates: 0 }) };
  };
  const purposeSubscribers = new Set();
  const consentState = { analytics: true };
  const ids = new Set(['home_book_header', 'home_service_1']);
  const coreStub = {
    ELEMENT_TIMING_METRIC: 'element_document', ELEMENT_DOCUMENT_HEADER: 'X-Measurement-Document',
    elementRegistry: [...ids].map(id => ({ id, placement: 'header' })),
    allowedElementEvent: (_route, event) => ids.has(event.elementId) && ['view', 'action'].includes(event.kind),
    elementDescriptorInput: { safeParse: value => ({ success: value?.purpose === 'element-document-v1', data: value }) },
    elementEventInput: { safeParse: value => ({ success: !!value && ids.has(value.elementId) && ['view', 'action'].includes(value.kind), data: value }) },
  };
  const client = await loadTsModule('lib/element-measurement-client.ts', { './element-measurement-core': coreStub });
  const overrides = {
    './element-measurement-core': coreStub,
    './element-measurement-client': client,
    './consent-client': {
      consentSnapshot: () => ({ analytics: consentState.analytics, analyticsSuppressed: false }),
      subscribePurposeConsent: callback => { purposeSubscribers.add(callback); return () => purposeSubscribers.delete(callback); },
      currentAnalyticsEpoch: () => 1,
      analyticsReferenceAllowed: () => consentState.analytics,
      refreshPurposeConsent: async () => {},
    },
    './feedback-client': { documentFeedbackReference: () => null },
    './analytics-contract': {
      publicAnalyticsPath: route => ['/', '/privacy', '/terms'].includes(route) ? route : null,
      analyticsContext: route => ({ page_location: `https://site.example${route}`, page_referrer: '' }),
    },
  };
  const adapter = await loadTsModule('lib/element-measurement-browser.ts', overrides);
  await adapter.startElementMeasurement();
  await tick();
  return {
    api: adapter, document, window, nodes, requests, timers, advance,
    completeEvents() { for (const complete of pendingEventResponses.splice(0)) complete(); },
    intersectionObserver: () => intersectionObserver,
    mutationObserver: () => mutationObserver,
    revoke() { consentState.analytics = false; for (const callback of purposeSubscribers) callback(); },
    restore() {
      for (const key of Object.keys(saved)) {
        if (saved[key]) Object.defineProperty(globalThis, key, saved[key]);
        else delete globalThis[key];
      }
    },
  };
}

test('a marked action immediately before pagehide is sent once with keepalive and without blocking teardown', async () => {
  const h = await harness();
  try {
    h.document.fire('click', h.nodes[0]);
    const startedAt = Date.now();
    h.window.pagehide();
    assert.ok(Date.now() - startedAt < 100, 'pagehide handler returns synchronously');
    await tick();
    const eventCalls = h.requests.filter(request => request.url.endsWith('/events'));
    assert.equal(eventCalls.length, 1, 'the queued action is handed to one event request before teardown');
    assert.equal(eventCalls[0].init.keepalive, true);
    assert.equal(eventCalls[0].init.signal.aborted, false, 'pagehide does not abort the action request');
    assert.deepEqual(JSON.parse(eventCalls[0].init.body).events, [{ elementId: 'home_book_header', kind: 'action' }]);
    await h.advance(500);
    assert.equal(h.requests.filter(request => request.url.endsWith('/events')).length, 1, 'the action is not retried');
  } finally { h.restore(); }
});

test('an action arriving during an unresolved event request is sent independently and pagehide does not abort either request', async () => {
  const h = await harness(['home_book_header', 'home_service_1'], { deferEvents: true });
  try {
    h.document.fire('click', h.nodes[0]);
    await tick();
    let eventCalls = h.requests.filter(request => request.url.endsWith('/events'));
    assert.equal(eventCalls.length, 1, 'first action dispatches immediately');
    assert.equal(eventCalls[0].init.keepalive, true);
    assert.equal(eventCalls[0].init.signal.aborted, false);
    h.document.fire('click', h.nodes[1]);
    await tick();
    eventCalls = h.requests.filter(request => request.url.endsWith('/events'));
    assert.equal(eventCalls.length, 2, 'second action is not held behind the unresolved response');
    assert.deepEqual(eventCalls.map(request => JSON.parse(request.init.body).events), [
      [{ elementId: 'home_book_header', kind: 'action' }],
      [{ elementId: 'home_service_1', kind: 'action' }],
    ]);
    h.window.pagehide();
    assert.ok(eventCalls.every(request => request.init.signal.aborted === false));
    h.completeEvents();
    await tick();
    assert.equal(h.requests.filter(request => request.url.endsWith('/events')).length, 2, 'completed requests are not retried after pagehide');
  } finally { h.restore(); }
});

test('consent withdrawal discards queued view events without draining them', async () => {
  const h = await harness(['home_service_1']);
  try {
    h.intersectionObserver().deliver(h.nodes[0], 0.8);
    await h.advance(1000);
    h.revoke();
    await h.advance(100);
    assert.equal(h.requests.filter(request => request.url.endsWith('/events')).length, 0);
  } finally { h.restore(); }
});

test('removing the sole visible target resets dwell; a replacement begins a fresh interval', async () => {
  const h = await harness(['home_service_1']);
  try {
    const io = h.intersectionObserver();
    const original = h.nodes[0];
    io.deliver(original, 0.8);
    await h.advance(500);
    original.isConnected = false;
    h.mutationObserver().trigger();
    await h.advance(500);
    assert.equal(h.window.dataLayer.filter(event => event.event === 'element_view').length, 0, 'a removed target cannot complete its old dwell');
    const replacement = new original.constructor('home_service_1');
    h.nodes.push(replacement);
    h.mutationObserver().trigger();
    io.deliver(replacement, 0.8);
    await h.advance(500);
    assert.equal(h.window.dataLayer.filter(event => event.event === 'element_view').length, 0, 'replacement needs its own full one-second dwell');
    await h.advance(500);
    assert.equal(h.window.dataLayer.filter(event => event.event === 'element_view').length, 1);
  } finally { h.restore(); }
});

test('a remaining visible duplicate keeps its shared target dwell when the stronger duplicate is removed', async () => {
  const h = await harness(['home_service_1', 'home_service_1']);
  try {
    const io = h.intersectionObserver();
    const [strong, remaining] = h.nodes;
    io.deliver(strong, 0.8);
    io.deliver(remaining, 0.6);
    await h.advance(500);
    strong.isConnected = false;
    h.mutationObserver().trigger();
    await h.advance(500);
    assert.equal(h.window.dataLayer.filter(event => event.event === 'element_view').length, 1);
  } finally { h.restore(); }
});

test('forwarded view and action events use canonical page context and exclude the document query, fragment, and referrer', async () => {
  const h = await harness(['home_service_1']);
  try {
    h.document.fire('click', h.nodes[0]);
    h.intersectionObserver().deliver(h.nodes[0], 0.8);
    await h.advance(1000);
    const events = h.window.dataLayer.filter(event => event.event === 'element_action' || event.event === 'element_view');
    assert.deepEqual(events.map(event => event.event).sort(), ['element_action', 'element_view']);
    for (const event of events) {
      assert.equal(event.page_location, 'https://site.example/');
      assert.equal(event.page_referrer, '');
      assert.equal(JSON.stringify(event).includes('query-value'), false);
      assert.equal(JSON.stringify(event).includes('secret-fragment'), false);
      assert.equal(JSON.stringify(event).includes('sensitive.invalid'), false);
    }
  } finally { h.restore(); }
});
