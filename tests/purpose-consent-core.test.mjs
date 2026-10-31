import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function loadCore() {
  const source = await readFile(path.join(root, 'lib/purpose-consent-core.ts'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)(() => { throw new Error('Unexpected import'); }, loaded, loaded.exports);
  return loaded.exports;
}

const core = await loadCore();
const signingKey = Buffer.alloc(32, 0x5a).toString('base64');
const now = Date.now();
const expiresAt = now + 24 * 60 * 60 * 1000;
const subject = 'c9b6c78a-c829-4d61-bc4c-4dd985a1ed5e';

test('consent signing key accepts only base64 for exactly 32 bytes', () => {
  assert.equal(core.consentKey(signingKey), true);
  assert.equal(core.consentKey(Buffer.alloc(31, 1).toString('base64')), false);
  assert.equal(core.consentKey('not-base64'), false);
  assert.equal(core.consentKey(undefined), false);
});

test('purpose cookie separates analytics and experiment grants and keeps subject only for experiment consent', async () => {
  const analyticsOnly = { subject: null, analytics: true, experiments: false, expiresAt };
  const analyticsCookie = await core.signConsent(analyticsOnly, signingKey);
  assert.deepEqual(await core.verifyConsent(analyticsCookie, signingKey, now), analyticsOnly);

  const experimentsOnly = { subject, analytics: false, experiments: true, expiresAt };
  const experimentCookie = await core.signConsent(experimentsOnly, signingKey);
  assert.deepEqual(await core.verifyConsent(experimentCookie, signingKey, now), experimentsOnly);
});

test('invalid signature, wrong key, expired cookie and overlong expiry fail closed', async () => {
  const validCookie = await core.signConsent({ analytics: false, experiments: true, subject, expiresAt }, signingKey);
  const [body, signature] = validCookie.split('.');
  const modified = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
  assert.equal(await core.verifyConsent(`${body}.${modified}`, signingKey, now), null);
  assert.equal(await core.verifyConsent(validCookie, Buffer.alloc(32, 0x2a).toString('base64'), now), null);
  assert.equal(await core.verifyConsent(validCookie, signingKey, expiresAt + 1), null);

  await assert.rejects(core.signConsent({
    analytics: true,
    experiments: false,
    expiresAt: now + 31 * 24 * 60 * 60 * 1000,
  }, signingKey));
});

test('consent record rejects unknown fields and invalid experiment subjects', async () => {
  await assert.rejects(core.signConsent({ analytics: true, experiments: false, expiresAt, subject, userId: 'site-user' }, signingKey));
  await assert.rejects(core.signConsent({ analytics: false, experiments: true, expiresAt, subject: 'site-user-id' }, signingKey));
});

test('public purpose consent status and same-origin changes do not reveal the subject', async () => {
  const source = await readFile(path.join(root, 'lib/purpose-consent-server.ts'), 'utf8');
  assert.match(source, /if\(request\.method==='GET'\)return safeJson\(await status\(request\)\)/);
  assert.doesNotMatch(source, /getChatGPTUser/);
  assert.match(source, /if\(request\.headers\.get\('origin'\)!==new URL\(request\.url\)\.origin\)/);
  assert.match(source, /analytics:!!analytics&&!analyticsSuppressed,analyticsSaved:!!analytics,analyticsSuppressed/);
  assert.match(source, /const row=await ledger\.save\(hash,args\.purpose,args\.grant,args\.expectedPurposeRevision,expiresAt\)/);
  assert.match(source, /const id=old\?\('grantId'in old\?old\.grantId:old\.subject\):crypto\.randomUUID\(\)/);
  assert.match(source, /'Set-Cookie':cookie/);
  assert.match(source, /; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000/);
  assert.match(source, /if\(args\.purpose==='experiments'&&!args\.grant\)response\.headers\.append\('Set-Cookie',clearExposureCookie\(\)\)/);
  assert.doesNotMatch(source, /safeJson\(\{[^}]*subject:/);
});
