import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const source = await readFile(path.join(root, 'lib/support-composer.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', js)(specifier => {
  throw new Error(`Unexpected support-composer dependency: ${specifier}`);
}, loaded, loaded.exports);
const { createComposerState, composerReducer, canRecallComposerKey, canSubmitComposerKey, restoreComposerFocus } = loaded.exports;

test('confirmed send records only sent text and preserves newer edits made while pending', () => {
  let state = createComposerState('thread-1');
  state = composerReducer(state, { type: 'edit', text: '  first question  ' });
  state = composerReducer(state, { type: 'submit', requestKey: 'request-1', attachmentId: 'photo-1' });
  assert.equal(state.draft, '  first question  ');
  assert.deepEqual(state.submission, { requestKey: 'request-1', text: 'first question', attachmentId: 'photo-1' });

  state = composerReducer(state, { type: 'edit', text: 'newer unsent question' });
  state = composerReducer(state, { type: 'result', requestKey: 'request-1', status: 'success' });
  assert.equal(state.draft, 'newer unsent question');
  assert.deepEqual(state.history, ['first question']);
  assert.equal(state.submission, null);
  assert.equal(JSON.stringify(state.history).includes('photo-1'), false);
});

test('successful send clears an unchanged draft and adds the text to history once', () => {
  let state = createComposerState('thread-1');
  state = composerReducer(state, { type: 'edit', text: 'A confirmed question' });
  state = composerReducer(state, { type: 'submit', requestKey: 'request-2' });
  state = composerReducer(state, { type: 'result', requestKey: 'request-2', status: 'success' });
  state = composerReducer(state, { type: 'result', requestKey: 'request-2', status: 'success' });
  assert.equal(state.draft, '');
  assert.deepEqual(state.history, ['A confirmed question']);
  assert.equal(state.submission, null);
});

for (const status of ['pending', 'error', 'unknown']) {
  test(`${status} result keeps the original request key, text and photo for an explicit retry`, () => {
    let state = createComposerState('thread-1');
    state = composerReducer(state, { type: 'edit', text: 'Check this question' });
    state = composerReducer(state, { type: 'submit', requestKey: 'request-stable', attachmentId: 'photo-stable' });
    state = composerReducer(state, { type: 'result', requestKey: 'request-stable', status });
    const submission = state.submission;
    state = composerReducer(state, { type: 'submit', requestKey: 'must-not-replace' });
    assert.deepEqual(state.submission, submission);
    assert.equal(state.submission.requestKey, 'request-stable');
    assert.equal(state.submission.text, 'Check this question');
    assert.equal(state.submission.attachmentId, 'photo-stable');
    assert.deepEqual(state.history, []);
  });
}

test('recall uses only confirmed text in the current thread and restores the unsent draft', () => {
  let state = createComposerState('thread-1');
  for (const [requestKey, text] of [['r1', 'older question'], ['r2', 'newer question']]) {
    state = composerReducer(state, { type: 'edit', text });
    state = composerReducer(state, { type: 'submit', requestKey });
    state = composerReducer(state, { type: 'result', requestKey, status: 'success' });
  }
  state = composerReducer(state, { type: 'edit', text: 'scratch draft' });
  state = composerReducer(state, { type: 'recall', direction: 'up' });
  assert.equal(state.draft, 'newer question');
  state = composerReducer(state, { type: 'recall', direction: 'up' });
  assert.equal(state.draft, 'older question');
  state = composerReducer(state, { type: 'recall', direction: 'down' });
  assert.equal(state.draft, 'newer question');
  state = composerReducer(state, { type: 'recall', direction: 'down' });
  assert.equal(state.draft, 'scratch draft');
  assert.equal(state.recallIndex, null);

  state = composerReducer(state, { type: 'submit', requestKey: 'pending' });
  state = composerReducer(state, { type: 'result', requestKey: 'pending', status: 'pending' });
  assert.deepEqual(state.history, ['older question', 'newer question']);
  state = composerReducer(state, { type: 'reset', threadId: 'thread-2' });
  assert.equal(state.threadId, 'thread-2');
  assert.equal(state.draft, '');
  assert.deepEqual(state.history, []);
  assert.equal(state.submission, null);
});

test('plain arrow recall is restricted to a collapsed caret at the matching text boundary', () => {
  const base = { text: 'draft', selectionStart: 0, selectionEnd: 0, isComposing: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
  assert.equal(canRecallComposerKey({ ...base, key: 'ArrowUp' }), true);
  assert.equal(canRecallComposerKey({ ...base, key: 'ArrowDown', selectionStart: 5, selectionEnd: 5 }), true);
  for (const rejected of [
    { key: 'ArrowUp', selectionStart: 1, selectionEnd: 1 },
    { key: 'ArrowUp', selectionStart: 0, selectionEnd: 1 },
    { key: 'ArrowUp', text: 'first\nsecond' },
    { key: 'ArrowDown', selectionStart: 0, selectionEnd: 0 },
    { key: 'ArrowDown', selectionStart: 3, selectionEnd: 5 },
    { key: 'ArrowUp', isComposing: true },
    { key: 'ArrowUp', ctrlKey: true },
    { key: 'ArrowDown', metaKey: true },
    { key: 'ArrowUp', shiftKey: true },
    { key: 'ArrowDown', altKey: true },
    { key: 'Enter' },
  ]) assert.equal(canRecallComposerKey({ ...base, ...rejected }), false, JSON.stringify(rejected));
});

test('Enter submits only outside IME composition, including Safari keyCode 229', () => {
  const base = { key: 'Enter', isComposing: false, keyCode: 13, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };
  assert.equal(canSubmitComposerKey(base), true);
  assert.equal(canSubmitComposerKey({ ...base, shiftKey: true }), false, 'Shift+Enter remains a newline');
  assert.equal(canSubmitComposerKey({ ...base, isComposing: true }), false, 'active IME input is not sent');
  assert.equal(canSubmitComposerKey({ ...base, keyCode: 229 }), false, 'Safari composition keydown is not sent');
  assert.equal(canSubmitComposerKey({ ...base, key: 'Escape' }), false);
  for (const key of ['altKey', 'ctrlKey', 'metaKey']) {
    assert.equal(canSubmitComposerKey({ ...base, [key]: true }), false, `${key} modified Enter is not sent`);
  }
});

test('camera dismissal restores focus only to a control still connected after the UI closes', () => {
  const callbacks = [];
  let focusCalls = 0;
  const control = { isConnected: true, focus() { focusCalls += 1; } };
  restoreComposerFocus(control, callback => callbacks.push(callback));
  assert.equal(focusCalls, 0, 'focus waits until the camera UI is removed');
  control.isConnected = false;
  callbacks[0]();
  assert.equal(focusCalls, 0, 'a disconnected composer control is never focused');

  const connected = { isConnected: true, focus() { focusCalls += 1; } };
  restoreComposerFocus(connected, callback => callbacks.push(callback));
  callbacks[1]();
  assert.equal(focusCalls, 1);

  for (const unavailable of [
    { isConnected: true, disabled: true, focus() { focusCalls += 1; } },
    { isConnected: true, getClientRects: () => ({ length: 0 }), focus() { focusCalls += 1; } },
  ]) {
    restoreComposerFocus(unavailable, callback => callbacks.push(callback));
    callbacks.at(-1)();
    assert.equal(focusCalls, 1, 'disabled or hidden controls do not receive focus');
  }
});

test('editing recalled text exits recall and a thread reset clears submitted and recalled text', () => {
  let state = createComposerState('thread-a');
  state = composerReducer(state, { type: 'edit', text: 'sent' });
  state = composerReducer(state, { type: 'submit', requestKey: 'sent-1' });
  state = composerReducer(state, { type: 'result', requestKey: 'sent-1', status: 'success' });
  state = composerReducer(state, { type: 'edit', text: 'unsent' });
  state = composerReducer(state, { type: 'recall', direction: 'up' });
  assert.equal(state.draft, 'sent');
  state = composerReducer(state, { type: 'edit', text: 'edited recalled' });
  assert.equal(state.draft, 'edited recalled');
  assert.equal(state.recallIndex, null);
  state = composerReducer(state, { type: 'reset', threadId: null });
  assert.equal(state.threadId, null);
  assert.equal(state.draft, '');
  assert.equal(state.unsentDraft, '');
  assert.deepEqual(state.history, []);
});
