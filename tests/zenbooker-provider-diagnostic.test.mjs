import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const zod = require('zod/v3');
const source = await readFile(path.join(root, 'lib/zenbooker-provider-diagnostic.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', js)((specifier) => {
  if (specifier === 'zod/v3') return zod;
  throw new Error(`Unexpected diagnostic helper import: ${specifier}`);
}, loaded, loaded.exports);
const { inspectRejectedResponse, projectProviderDiagnostic } = loaded.exports;

const fieldTypes = (overrides = {}) => ({
  code: 'missing', message: 'missing', error: 'object', 'error.code': 'string',
  'error.message': 'string', 'error.status': 'missing', 'response.code': 'missing', 'response.message': 'missing',
  ...overrides,
});

test('provider diagnostic recognizes only fixed cross-endpoint code literals and fixed paths', () => {
  for (const [path, value] of [
    ['top-level', { code: 'MISSING_PARAMETER' }],
    ['error', { error: { code: 'MISSING_DATA' } }],
    ['response', { response: { code: 'OPERATION_ERROR' } }],
  ]) {
    const projected = projectProviderDiagnostic(value, 'json', 'json');
    assert.equal(projected.observedCode, path === 'top-level' ? 'MISSING_PARAMETER' : path === 'error' ? 'MISSING_DATA' : 'OPERATION_ERROR');
    assert.equal(projected.provenance, 'recognized_cross_endpoint_literal');
    assert.equal(projected.category, 'unclassified');
    assert.equal(JSON.stringify(projected).includes('private'), false);
  }

  const conflicting = projectProviderDiagnostic({
    code: 'MISSING_PARAMETER', error: { code: 'OPERATION_ERROR' },
    response: { code: 'MISSING_DATA' },
  }, 'json', 'json');
  assert.equal(conflicting.observedCode, null);
  assert.equal(conflicting.provenance, null);
  assert.equal(conflicting.category, 'unclassified');
  assert.equal(conflicting.recognizedParameter, null);

  const unrecognized = projectProviderDiagnostic({ error: { code: 'INVALID_API_KEY' } }, 'json', 'json');
  assert.equal(unrecognized.observedCode, null);
  assert.equal(unrecognized.provenance, null);
  assert.deepEqual(unrecognized.fieldTypes, fieldTypes({ 'error.code': 'string', 'error.message': 'missing' }));
});

test('bounded message patterns map to fixed category and parameter enums without retaining text', () => {
  const examples = [
    [{ error: { message: 'Expired API key.' } }, 'authentication', 'authorization'],
    [{ response: { message: 'Insufficient permissions' } }, 'authorization', 'authorization'],
    [{ message: 'limit must be an integer' }, 'parameter_validation', 'limit'],
    [{ error: { message: 'Missing required parameter: cursor.' } }, 'parameter_validation', 'cursor'],
    [{ error: { message: 'Unsupported media type' } }, 'media_type', 'content_type'],
    [{ message: 'Too many requests' }, 'rate_limit', null],
    [{ message: 'private-provider-reason https://private.invalid/token=DO_NOT_ECHO' }, 'unclassified', null],
    [{ message: 'secret_field is invalid' }, 'parameter_validation', 'other'],
  ];
  for (const [body, category, recognizedParameter] of examples) {
    const projected = projectProviderDiagnostic(body, 'json', 'json');
    assert.equal(projected.category, category);
    assert.equal(projected.recognizedParameter, recognizedParameter);
    const serialized = JSON.stringify(projected);
    for (const secret of ['private-provider-reason', 'private.invalid', 'DO_NOT_ECHO', 'secret_field']) {
      assert.equal(serialized.includes(secret), false);
    }
    assert.deepEqual(Object.keys(projected).sort(), [
      'bodyFormat', 'category', 'contentTypeFamily', 'fieldTypes', 'observedCode', 'reportedStatus',
      'provenance', 'recognizedParameter', 'rootType',
    ].sort());
    assert.deepEqual(Object.keys(projected.fieldTypes).sort(), [
      'code', 'error', 'error.code', 'error.message', 'error.status', 'message', 'response.code', 'response.message',
    ].sort());
  }

  const conflictingMessages = projectProviderDiagnostic({
    message: 'Too many requests', error: { message: 'Insufficient permissions' },
  }, 'json', 'json');
  assert.equal(conflictingMessages.category, 'unclassified');
  assert.equal(conflictingMessages.recognizedParameter, null);
});

test('reportedStatus accepts only integer error.status values without coercion', async () => {
  const valid = await inspectRejectedResponse(new Response(JSON.stringify({
    error: { status: 401, message: 'Bearer STATUS_PRIVATE_SENTINEL' }, status: 418,
  }), { status: 400, headers: { 'content-type': 'application/json' } }));
  assert.equal(valid.reportedStatus, 401);
  assert.equal(valid.fieldTypes['error.status'], 'number');
  assert.equal(JSON.stringify(valid).includes('STATUS_PRIVATE_SENTINEL'), false);

  for (const [body, fieldType] of [
    [{}, 'missing'], [{ error: { status: '401' } }, 'string'],
    [{ error: { status: 401.5 } }, 'number'], [{ error: { status: 99 } }, 'number'],
    [{ error: { status: 600 } }, 'number'],
  ]) {
    const result = projectProviderDiagnostic(body, 'json', 'json');
    assert.equal(result.reportedStatus, null);
    assert.equal(result.fieldTypes['error.status'], fieldType);
  }
  const nonJson = await inspectRejectedResponse(new Response('{"error":{"status":401}}', {
    status: 400, headers: { 'content-type': 'text/plain' },
  }));
  assert.equal(nonJson.reportedStatus, null);
  assert.equal(nonJson.fieldTypes['error.status'], 'missing');
});

test('non-JSON media families are classified by header only and never inspected for provider text', async () => {
  const sentinel = 'RAW_BODY_PRIVATE_SENTINEL';
  for (const [contentType, family] of [
    ['text/plain', 'text'], ['text/html; charset=utf-8', 'html'],
    ['application/octet-stream', 'other'], [null, 'missing'],
  ]) {
    const headers = new Headers(contentType ? { 'content-type': contentType } : {});
    const body = new Response(JSON.stringify({ error: { code: 'MISSING_PARAMETER', message: sentinel } })).body;
    const response = contentType
      ? new Response(body, { status: 400, headers })
      : { headers, body };
    const result = await inspectRejectedResponse(response);
    assert.equal(result.contentTypeFamily, family);
    assert.equal(result.bodyFormat, 'text');
    assert.equal(result.rootType, 'not_parsed');
    assert.equal(result.observedCode, null);
    assert.equal(result.category, 'unclassified');
    assert.equal(JSON.stringify(result).includes(sentinel), false);
    assert.ok(Object.values(result.fieldTypes).every((value) => value === 'missing'));
  }

  const problemJson = await inspectRejectedResponse(new Response(
    JSON.stringify({ response: { code: 'OPERATION_ERROR' } }),
    { status: 400, headers: { 'content-type': 'application/problem+json' } },
  ));
  assert.equal(problemJson.contentTypeFamily, 'json');
  assert.equal(problemJson.observedCode, 'OPERATION_ERROR');
});

test('JSON response diagnostics distinguish body forms and never expose arbitrary fields or values', async () => {
  const sentinel = 'SENSITIVE_MESSAGE_SENTINEL';
  const json = await inspectRejectedResponse(Response.json({
    error: { code: 'MISSING_PARAMETER', message: 'cursor is missing' },
    arbitrary_provider_key: sentinel,
  }, { status: 400 }));
  assert.equal(json.contentTypeFamily, 'json');
  assert.equal(json.bodyFormat, 'json');
  assert.equal(json.rootType, 'object');
  assert.equal(json.observedCode, 'MISSING_PARAMETER');
  assert.equal(json.category, 'parameter_validation');
  assert.equal(json.recognizedParameter, 'cursor');
  assert.deepEqual(json.fieldTypes, fieldTypes({
    error: 'object', 'error.code': 'string', 'error.message': 'string',
  }));
  assert.equal(JSON.stringify(json).includes(sentinel), false);
  assert.equal(JSON.stringify(json).includes('arbitrary_provider_key'), false);

  const empty = await inspectRejectedResponse(new Response(null, {
    status: 400, headers: { 'content-type': 'application/json' },
  }));
  assert.equal(empty.bodyFormat, 'empty');
  assert.equal(empty.rootType, 'not_parsed');

  const malformed = await inspectRejectedResponse(new Response('{"error":', {
    status: 400, headers: { 'content-type': 'application/json' },
  }));
  assert.equal(malformed.bodyFormat, 'invalid_json');
  assert.equal(malformed.rootType, 'not_parsed');
  assert.equal(malformed.category, 'unclassified');

  const prefix = '{"message":"';
  const suffix = '"}';
  const exactly8192 = prefix + 'x'.repeat(8192 - prefix.length - suffix.length) + suffix;
  assert.equal(new TextEncoder().encode(exactly8192).byteLength, 8192);
  const boundary = await inspectRejectedResponse(new Response(exactly8192, {
    status: 400, headers: { 'content-type': 'application/json' },
  }));
  assert.equal(boundary.bodyFormat, 'json', 'exactly 8 KiB remains eligible for bounded parsing');
  assert.equal(boundary.rootType, 'object');
  assert.equal(boundary.category, 'unclassified', 'overlong message text is not pattern-matched');

  const oversizedText = JSON.stringify({ message: 'x'.repeat(8200) });
  const oversized = await inspectRejectedResponse(new Response(oversizedText, {
    status: 400, headers: { 'content-type': 'application/json' },
  }));
  assert.equal(oversized.bodyFormat, 'oversized');
  assert.equal(oversized.rootType, 'not_parsed');
  assert.equal(JSON.stringify(oversized).includes('x'.repeat(100)), false);
});

test('8 KiB stream cap cancels immediately and read failures or stalled cancellation expose no content', async () => {
  let cancelled = false;
  const oversizedResponse = {
    headers: new Headers({ 'content-type': 'application/json' }),
    body: { getReader: () => ({
      read: async () => ({ done: false, value: new Uint8Array(8193) }),
      cancel: () => { cancelled = true; return new Promise(() => {}); },
      releaseLock() {},
    }) },
  };
  const oversized = await inspectRejectedResponse(oversizedResponse);
  assert.equal(oversized.bodyFormat, 'oversized');
  assert.equal(cancelled, true);

  let failedReadCancelled = false;
  const unreadableResponse = {
    headers: new Headers({ 'content-type': 'application/json' }),
    body: { getReader: () => ({
      read: async () => { throw new Error('STREAM_PRIVATE_SENTINEL'); },
      cancel: () => { failedReadCancelled = true; return new Promise(() => {}); },
      releaseLock() {},
    }) },
  };
  const started = Date.now();
  const unavailable = await inspectRejectedResponse(unreadableResponse);
  assert.equal(Date.now() - started < 250, true, 'cancellation must not be awaited');
  assert.equal(failedReadCancelled, true);
  assert.equal(unavailable.bodyFormat, 'unavailable');
  assert.equal(unavailable.rootType, 'not_parsed');
  assert.equal(JSON.stringify(unavailable).includes('STREAM_PRIVATE_SENTINEL'), false);

  let timedOutCancelled = false;
  const stalledResponse = {
    headers: new Headers({ 'content-type': 'application/json' }),
    body: { getReader: () => ({
      read: () => new Promise(() => {}),
      cancel: () => { timedOutCancelled = true; return new Promise(() => {}); },
      releaseLock() {},
    }) },
  };
  const timeoutStarted = Date.now();
  const timedOut = await inspectRejectedResponse(stalledResponse);
  assert.ok(Date.now() - timeoutStarted < 3000, 'diagnostic body read has a bounded deadline');
  assert.equal(timedOutCancelled, true);
  assert.equal(timedOut.bodyFormat, 'unavailable');
});
