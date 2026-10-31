import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(root, 'lib/customer-auth-coordinator.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', compiled)((specifier) => {
  throw new Error(`Unexpected import from customer-auth-coordinator: ${specifier}`);
}, loaded, loaded.exports);
const { CustomerAuthCoordinator } = loaded.exports;

test('missing Web Locks leaves guest booking and logout available but never dispatches connect or prefill', async () => {
  const coordinator = new CustomerAuthCoordinator(undefined, 20);
  let dispatches = 0;

  await assert.rejects(coordinator.run('connect', async () => { dispatches += 1; }), /lock_unavailable/);
  await assert.rejects(coordinator.run('prefill', async () => { dispatches += 1; }), /lock_unavailable/);
  const signedOut = await coordinator.run('logout', async (_signal, isCurrent) => {
    dispatches += 1;
    assert.equal(isCurrent(), true);
    return 'logout-requested';
  });

  assert.equal(signedOut, 'logout-requested');
  assert.equal(dispatches, 1, 'only the existing logout fallback may dispatch without a lock');
});

test('coordinated work holds the named lock through response completion and receives an abort fence', async () => {
  const calls = [];
  const locks = { request: async (name, options, callback) => {
    calls.push({ name, options });
    return callback();
  } };
  const coordinator = new CustomerAuthCoordinator(locks, 100);
  let responseProcessed = false;
  const value = await coordinator.run('connect', async (signal, isCurrent) => {
    assert.equal(signal.aborted, false);
    assert.equal(isCurrent(), true);
    await Promise.resolve();
    responseProcessed = true;
    return 'complete';
  });

  assert.equal(value, 'complete');
  assert.equal(responseProcessed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'app:customer-google-auth:v1');
});

test('queued lock acquisition times out without running the request callback', async () => {
  const locks = { request: () => new Promise(() => {}) };
  const coordinator = new CustomerAuthCoordinator(locks, 5);
  let dispatches = 0;

  await assert.rejects(coordinator.run('connect', async () => { dispatches += 1; }), /lock_timeout/);
  assert.equal(dispatches, 0);
});

test('logout cancellation fences a response that arrives after invalidation', async () => {
  let release;
  const locks = { request: async (_name, _options, callback) => callback() };
  const coordinator = new CustomerAuthCoordinator(locks, 100);
  const pending = coordinator.run('logout', async (_signal, isCurrent) => {
    await new Promise(resolve => { release = resolve; });
    if (!isCurrent()) throw new Error('cancelled');
    return 'late';
  });
  await new Promise(resolve => setImmediate(resolve));
  coordinator.cancel();
  release();
  await assert.rejects(pending, /cancelled/);
});
