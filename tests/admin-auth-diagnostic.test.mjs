import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(root, 'lib/admin-auth-diagnostic.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', js)(() => { throw new Error('No imports expected'); }, loaded, loaded.exports);
const diagnostic = loaded.exports;

test('auth diagnostic contract contains only bounded stages, results, and OAuth identifiers', () => {
  assert.deepEqual(diagnostic.diagnosticStages, ['site_identity', 'credential_resolution', 'oauth_response', 'token_exchange']);
  assert.deepEqual(diagnostic.exchangeResults, ['network', 'timeout', 'http_rejected', 'empty_body', 'oversized_body', 'invalid_json', 'missing_id_token']);
  assert.deepEqual(diagnostic.oauthErrors, ['invalid_client', 'invalid_grant', 'unauthorized_client', 'invalid_request', 'unsupported_grant_type', 'access_denied', 'temporarily_unavailable', 'server_error', 'other']);
  assert.equal(diagnostic.oauthError('invalid_client'), 'invalid_client');
  assert.equal(diagnostic.oauthError('unknown-provider-error'), 'other');
  assert.equal(diagnostic.oauthError({ error: 'invalid_client' }), 'other');
});

test('diagnostic parser accepts stage-compatible DTOs and rejects unsafe or malformed persisted values', () => {
  const valid = [
    { stage: 'site_identity', result: 'unavailable', httpStatus: null, oauthError: null },
    { stage: 'credential_resolution', result: 'unavailable', httpStatus: null, oauthError: null },
    { stage: 'oauth_response', result: 'oauth_error', httpStatus: null, oauthError: 'server_error' },
    { stage: 'token_exchange', result: 'network', httpStatus: null, oauthError: null },
    { stage: 'token_exchange', result: 'timeout', httpStatus: null, oauthError: null },
    { stage: 'token_exchange', result: 'http_rejected', httpStatus: 400, oauthError: 'invalid_client' },
    { stage: 'token_exchange', result: 'empty_body', httpStatus: 200, oauthError: null },
    { stage: 'token_exchange', result: 'oversized_body', httpStatus: 200, oauthError: null },
    { stage: 'token_exchange', result: 'invalid_json', httpStatus: 200, oauthError: null },
    { stage: 'token_exchange', result: 'missing_id_token', httpStatus: 200, oauthError: null },
    { stage: 'token_exchange', result: 'unavailable', httpStatus: null, oauthError: null },
  ];
  for (const value of valid) {
    assert.deepEqual(diagnostic.parseAdminAuthDiagnostic(JSON.stringify(value)), value);
    assert.equal(diagnostic.parseAdminAuthDiagnostic(diagnostic.encodeAdminAuthDiagnostic(value)).stage, value.stage);
  }

  for (const value of [
    null,
    '{',
    JSON.stringify({ ...valid[0], error_description: 'secret provider text' }),
    JSON.stringify({ ...valid[0], secret: 'credential' }),
    JSON.stringify({ ...valid[0], stage: 'unknown_stage' }),
    JSON.stringify({ ...valid[0], result: 'provider said client_secret=sentinel' }),
    JSON.stringify({ ...valid[0], httpStatus: 99 }),
    JSON.stringify({ ...valid[0], httpStatus: 600 }),
    JSON.stringify({ ...valid[0], oauthError: 'secret_error_description' }),
    JSON.stringify({ ...valid[0], oauthError: 'invalid_client' }),
    JSON.stringify({ ...valid[2], oauthError: 'unlisted-secret-error' }),
    JSON.stringify({ ...valid[3], httpStatus: 302 }),
    JSON.stringify({ ...valid[4], oauthError: 'other' }),
    'x'.repeat(513),
  ]) assert.equal(diagnostic.parseAdminAuthDiagnostic(value), null, String(value).slice(0, 40));
  assert.throws(() => diagnostic.encodeAdminAuthDiagnostic({ ...valid[0], debug: 'raw exception' }));
});

test('typed exchange errors expose only their generic message and safe diagnostic', () => {
  const dto = { stage: 'token_exchange', result: 'http_rejected', httpStatus: 401, oauthError: 'invalid_client' };
  const error = new diagnostic.AdminTokenExchangeError(dto);
  assert.equal(error.message, 'Google sign-in unavailable');
  assert.deepEqual(error.diagnostic, dto);
  assert.doesNotMatch(error.stack ?? '', /secret|provider body|error_description/i);
  assert.doesNotMatch(JSON.stringify(error), /client_secret|provider body|error_description/i);
});
