import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function transpile(source) {
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (specifier !== './purpose-consent-core') throw new Error(`Unexpected import: ${specifier}`);
    return consentCore;
  }, loaded, loaded.exports);
  return loaded.exports;
}
const consentSource = await readFile(path.join(root, 'lib/purpose-consent-core.ts'), 'utf8');
const consentCore = (() => {
  const js = ts.transpileModule(consentSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)(() => { throw new Error('Unexpected consent import'); }, loaded, loaded.exports);
  return loaded.exports;
})();
const attributionCore = transpile(await readFile(path.join(root, 'lib/attribution-core.ts'), 'utf8'));
const {
  ATTRIBUTION_COOKIE,
  ATTRIBUTION_WINDOW_MS,
  clearExposureCookie,
  signExposureReference,
  verifyExposureReference,
} = attributionCore;

const signingKey = Buffer.alloc(32, 0x5a).toString('base64');
const otherKey = Buffer.alloc(32, 0x2a).toString('base64');
const versionId = 'b5b92dc2-0278-4ead-9132-4776a9666421';
const compositionId = '15997d63-1f99-4378-a479-1533f610dfe7';
const subjectHash = 'a'.repeat(64);

test('exposure reference uses a fixed seven-day first-exposure deadline and binds the experiment subject', async () => {
  const now = Date.now();
  const reference = {
    versionId,
    compositionId,
    subjectHash,
    firstExposedAt: now - 1_000,
    expiresAt: now - 1_000 + ATTRIBUTION_WINDOW_MS,
  };
  const cookie = await signExposureReference(reference, signingKey);

  assert.equal(ATTRIBUTION_COOKIE, '__Host-exposure_reference');
  assert.deepEqual(await verifyExposureReference(cookie, signingKey, subjectHash, now), reference);
  assert.equal(await verifyExposureReference(cookie, signingKey, 'b'.repeat(64), now), null);
  assert.equal(await verifyExposureReference(cookie, otherKey, subjectHash, now), null);
  assert.equal(await verifyExposureReference(cookie, signingKey, subjectHash, reference.expiresAt), null);
  assert.match(clearExposureCookie(), /^__Host-exposure_reference=;.*HttpOnly;.*Max-Age=0$/);
});

test('exposure reference rejects tampering, a sliding expiry, invalid identity, and future exposure times', async () => {
  const now = Date.now();
  const reference = {
    versionId,
    compositionId,
    subjectHash,
    firstExposedAt: now - 1_000,
    expiresAt: now - 1_000 + ATTRIBUTION_WINDOW_MS,
  };
  const cookie = await signExposureReference(reference, signingKey);
  const [body, signature] = cookie.split('.');
  const changedSignature = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
  assert.equal(await verifyExposureReference(`${body}.${changedSignature}`, signingKey, subjectHash, now), null);
  assert.equal(await verifyExposureReference(`${body}.${signature}.${signature}`, signingKey, subjectHash, now), null);
  assert.equal(await verifyExposureReference(cookie, signingKey, subjectHash, now + ATTRIBUTION_WINDOW_MS), null);

  await assert.rejects(signExposureReference({
    ...reference,
    expiresAt: reference.expiresAt + 1,
  }, signingKey));
  await assert.rejects(signExposureReference({
    ...reference,
    subjectHash: 'site-user-id',
  }, signingKey));
  await assert.rejects(signExposureReference({
    ...reference,
    firstExposedAt: now + 10_000,
    expiresAt: now + 10_000 + ATTRIBUTION_WINDOW_MS,
  }, signingKey));
});
