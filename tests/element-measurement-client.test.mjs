import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

async function loadTs(relative, overrides = {}) {
  const source = await readFile(path.join(root, relative), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (Object.hasOwn(overrides, specifier)) return overrides[specifier];
    if (specifier === 'zod/v3' && Object.hasOwn(overrides, 'zod')) return overrides.zod;
    if (specifier === 'zod/v3') return require(specifier);
    throw new Error(`Unexpected ${relative} import: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const purpose = await loadTs('lib/purpose-consent-core.ts');
const proof = await loadTs('lib/consent-proof.ts', { './purpose-consent-core': purpose });
const core = await loadTs('lib/element-measurement-core.ts', { './consent-proof': proof });
const client = await loadTs('lib/element-measurement-client.ts', { './element-measurement-core': core });

function harness() {
  let time = 0;
  let nextId = 1;
  const timers = new Map();
  const emitted = [];
  const controller = client.createElementObservationController({
    now: () => time,
    setTimer(callback, delay) {
      const id = nextId++;
      timers.set(id, { at: time + delay, callback });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    emit(events) { emitted.push(...(Array.isArray(events) ? events : [events])); },
  });
  function advance(milliseconds) {
    const target = time + milliseconds;
    while (true) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      timers.delete(id);
      time = timer.at;
      timer.callback();
    }
    time = target;
  }
  return { controller, emitted, timers, advance, now: () => time };
}

test('no view or action is emitted before the current Analytics grant; pre-grant visibility is not replayed', () => {
  const h = harness();
  h.controller.observe('home_book_header', 1);
  h.controller.action('home_book_header');
  h.advance(1500);
  assert.deepEqual(h.emitted, []);
  h.controller.setGranted(true);
  h.advance(1500);
  assert.deepEqual(h.emitted, [], 'the pre-grant observation is not backfilled');
  h.controller.observe('home_book_header', 1);
  h.advance(999);
  assert.deepEqual(h.emitted, []);
  h.advance(1);
  assert.deepEqual(h.emitted, [{ elementId: 'home_book_header', kind: 'view' }]);
});

test('view needs one continuous second at or above 50 percent; falling below resets the interval', () => {
  const h = harness();
  h.controller.setGranted(true);
  h.controller.observe('contact_form', 0.5);
  h.advance(999);
  h.controller.observe('contact_form', 0.49);
  h.advance(10);
  assert.deepEqual(h.emitted, []);
  h.controller.observe('contact_form', 0.51);
  h.advance(999);
  assert.deepEqual(h.emitted, []);
  h.advance(1);
  assert.deepEqual(h.emitted, [{ elementId: 'contact_form', kind: 'view' }]);
  h.controller.observe('contact_form', 1);
  h.advance(1500);
  assert.equal(h.emitted.length, 1, 'a registered view is emitted only once per element per document');
});

test('hidden document time never counts toward the one-second view threshold', () => {
  const h = harness();
  h.controller.setGranted(true);
  h.controller.observe('home_service_1', 0.9);
  h.advance(500);
  h.controller.setVisible(false);
  h.advance(5000);
  assert.deepEqual(h.emitted, []);
  h.controller.setVisible(true);
  h.advance(999);
  assert.deepEqual(h.emitted, []);
  h.advance(1);
  assert.deepEqual(h.emitted, [{ elementId: 'home_service_1', kind: 'view' }]);
});

test('an action is a single action record and does not manufacture a view', () => {
  const h = harness();
  h.controller.setGranted(true);
  h.controller.action('home_request_form');
  h.controller.action('home_request_form');
  assert.deepEqual(h.emitted, [{ elementId: 'home_request_form', kind: 'action' }]);
  h.controller.observe('home_request_form', 1);
  h.advance(1000);
  assert.deepEqual(h.emitted, [
    { elementId: 'home_request_form', kind: 'action' },
    { elementId: 'home_request_form', kind: 'view' },
  ]);
});

test('withdrawal permanently closes that document controller and dispose cancels a fresh pending timer', () => {
  const h = harness();
  h.controller.setGranted(true);
  h.controller.action('contact_book');
  h.controller.observe('contact_form', 0.8);
  h.advance(500);
  h.controller.setGranted(false);
  h.advance(2000);
  h.controller.setGranted(true);
  h.controller.observe('contact_form', 0.8);
  h.advance(1000);
  h.controller.action('contact_book');
  h.controller.observe('contact_faq_1', 1);
  assert.equal(h.timers.size, 0, 'a withdrawn document schedules no further target timers after regrant');
  assert.deepEqual(h.emitted, [{ elementId: 'contact_book', kind: 'action' }], 'withdrawal neither emits queued events nor clears dedupe state');
  h.controller.dispose();
  assert.equal(h.timers.size, 0);
  h.advance(2000);
  assert.deepEqual(h.emitted, [{ elementId: 'contact_book', kind: 'action' }]);

  const fresh = harness();
  fresh.controller.setGranted(true);
  fresh.controller.observe('contact_faq_1', 1);
  assert.ok(fresh.timers.size > 0, 'a new consented document can measure its own targets');
  fresh.controller.dispose();
  assert.equal(fresh.timers.size, 0);
  fresh.advance(2000);
  assert.deepEqual(fresh.emitted, []);
});
