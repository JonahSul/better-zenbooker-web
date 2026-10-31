import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

async function loadTs(relativePath) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (specifier === 'zod/v3') return require('zod/v3');
    throw new Error(`Unexpected import in ${relativePath}: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const submission = await loadTs('lib/contact-submission.ts');
const firstKey = 'd7000000-0000-4000-8000-000000000001';
const retryKey = 'd7000000-0000-4000-8000-000000000002';

test('contact form starts blank and locks an immutable request snapshot while submitting', () => {
  let state = submission.createContactSubmission();
  assert.deepEqual(state, {
    draft: { name: '', email: '', message: '' },
    pending: null,
    state: 'idle',
  });
  state = submission.reduceContactSubmission(state, { type: 'edit', field: 'name', value: 'Casey' });
  state = submission.reduceContactSubmission(state, { type: 'edit', field: 'email', value: 'casey@example.invalid' });
  state = submission.reduceContactSubmission(state, { type: 'edit', field: 'message', value: 'Please call.' });
  state = submission.reduceContactSubmission(state, { type: 'submit', requestKey: firstKey });
  assert.deepEqual(state.pending, {
    requestKey: firstKey,
    name: 'Casey',
    email: 'casey@example.invalid',
    message: 'Please call.',
  });
  assert.equal(state.state, 'submitting');
  const duplicate = submission.reduceContactSubmission(state, { type: 'submit', requestKey: retryKey });
  assert.deepEqual(duplicate, state, 'a pending submit cannot replace its request key or body');
});

test('uncertain result retains the request key and fields; matching receipt clears only submitted values', () => {
  let state = submission.createContactSubmission();
  for (const [field, value] of [['name', 'Casey'], ['email', 'casey@example.invalid'], ['message', 'First note']]) {
    state = submission.reduceContactSubmission(state, { type: 'edit', field, value });
  }
  state = submission.reduceContactSubmission(state, { type: 'submit', requestKey: firstKey });
  state = submission.reduceContactSubmission(state, { type: 'result', requestKey: firstKey, received: false });
  assert.equal(state.state, 'unconfirmed');
  assert.equal(state.pending.requestKey, firstKey);
  assert.equal(state.draft.message, 'First note');
  state = submission.reduceContactSubmission(state, { type: 'submit', requestKey: retryKey });
  assert.equal(state.pending.requestKey, firstKey, 'retry must preserve the idempotency key for the original payload');
  state = submission.reduceContactSubmission(state, { type: 'edit', field: 'message', value: 'Newer edit' });
  state = submission.reduceContactSubmission(state, { type: 'result', requestKey: firstKey, received: true });
  assert.equal(state.state, 'received');
  assert.equal(state.pending, null);
  assert.deepEqual(state.draft, { name: '', email: '', message: 'Newer edit' });
});

test('stale receipt cannot clear a newer pending submission and reset clears local contact data', () => {
  let state = submission.createContactSubmission();
  state = submission.reduceContactSubmission(state, { type: 'edit', field: 'message', value: 'Private message sentinel' });
  state = submission.reduceContactSubmission(state, { type: 'submit', requestKey: firstKey });
  const stale = submission.reduceContactSubmission(state, { type: 'result', requestKey: retryKey, received: true });
  assert.deepEqual(stale, state);
  state = submission.reduceContactSubmission(state, { type: 'reset' });
  assert.deepEqual(state, {
    draft: { name: '', email: '', message: '' },
    pending: null,
    state: 'idle',
  });
});
