import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadTs(relative, overrides = {}) {
  const source = await readFile(path.join(root, relative), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (Object.hasOwn(overrides, specifier)) return overrides[specifier];
    if (specifier === 'zod/v3' && Object.hasOwn(overrides, 'zod')) return overrides.zod;
    throw new Error(`Unexpected ${relative} import: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const consent = await loadTs('lib/purpose-consent-core.ts');
const tag = await loadTs('lib/tag-identity-core.ts', { './purpose-consent-core': consent });
const key = Buffer.alloc(32, 0x61).toString('base64');
const otherKey = Buffer.alloc(32, 0x62).toString('base64');
const subjectHash = 'a'.repeat(64);

function identity(overrides = {}) {
  return {
    clientId: '123456789.987654321',
    measurementId: 'G-S4J27S9VMH',
    subjectHash,
    grantRevision: 4,
    analyticsGrantHash: 'c'.repeat(64),
    analyticsRevision: 3,
    expiresAt: Date.now() + 60 * 60 * 1000,
    ...overrides,
  };
}

test('tag identity is a short-lived HMAC bound to both current purpose grants, consent subject, and Measurement ID', async () => {
  const value = identity();
  const signed = await tag.signTagIdentity(value, key);
  assert.equal(tag.TAG_IDENTITY_COOKIE, '__Host-ga_tag_identity');
  assert.equal(tag.TAG_IDENTITY_MAX_AGE_MS, 86_400_000);
  assert.deepEqual(await tag.verifyTagIdentity(signed, key, subjectHash, value.measurementId), value);
  assert.equal(await tag.verifyTagIdentity(signed, key, 'b'.repeat(64), value.measurementId), null);
  assert.equal(await tag.verifyTagIdentity(signed, key, subjectHash, 'G-OTHER123'), null);
  assert.equal(await tag.verifyTagIdentity(signed, otherKey, subjectHash, value.measurementId), null);
  assert.match(tag.clearTagIdentityCookie(), /^__Host-ga_tag_identity=;.*HttpOnly;.*Max-Age=0$/);
  const partialGrant = { ...value };
  delete partialGrant.analyticsRevision;
  await assert.rejects(tag.signTagIdentity(partialGrant, key));
});

test('tag identity rejects tampering, expiry, unsupported fields, invalid client IDs, and overlong lifetime', async () => {
  const value = identity();
  const signed = await tag.signTagIdentity(value, key);
  const [body, signature] = signed.split('.');
  const badSignature = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
  assert.equal(await tag.verifyTagIdentity(`${body}.${badSignature}`, key, subjectHash, value.measurementId), null);
  assert.equal(await tag.verifyTagIdentity(signed, key, subjectHash, value.measurementId, value.expiresAt), null);
  assert.equal(await tag.verifyTagIdentity(`${signed}.extra`, key, subjectHash, value.measurementId), null);
  assert.equal(await tag.verifyTagIdentity('x'.repeat(2049), key, subjectHash, value.measurementId), null);
  assert.equal(tag.validTagClientId('123456789.987654321'), true);
  for (const invalid of ['123.456.789', 'a.2', '1.', '1.2 ', '1.2.3', null]) assert.equal(tag.validTagClientId(invalid), false);
  assert.equal(tag.validMeasurementId('G-S4J27S9VMH'), true);
  assert.equal(tag.validMeasurementId('GTM-THR2KRPF'), false);
  await assert.rejects(tag.signTagIdentity(identity({ extra: 'not-allowed' }), key));
  await assert.rejects(tag.signTagIdentity(identity({ expiresAt: Date.now() + tag.TAG_IDENTITY_MAX_AGE_MS + 10_000 }), key));
  await assert.rejects(tag.signTagIdentity(identity({ clientId: 'site-user-id' }), key));
  await assert.rejects(tag.signTagIdentity(value, Buffer.alloc(12, 1).toString('base64')));
});

test('tag identity server and Measurement Protocol recheck both purpose revisions before sending', async () => {
  const identityServer = await readFile(path.join(root, 'lib/tag-identity-server.ts'), 'utf8');
  assert.match(identityServer, /signTagIdentity\(\{clientId,measurementId:runtime\.GA4_MEASUREMENT_ID,subjectHash,grantRevision:experiment\.revision,analyticsGrantHash:analytics\.hash,analyticsRevision:analytics\.revision,expiresAt\}/);
  assert.match(identityServer, /if\(!analytics\|\|!experiment\)return safeJson\(\{error:'Both current optional grants are required\.'/);

  const server = await readFile(path.join(root, 'lib/measurement-server.ts'), 'utf8');
  assert.match(server, /identity\.analyticsGrantHash!==initialAnalytics\.hash/);
  assert.match(server, /identity\.analyticsRevision!==initialAnalytics\.revision/);
  assert.match(server, /identity\.grantRevision!==initialExperiment\.revision/);
  assert.match(server, /async function freshGrant\(\)[\s\S]*analytics\.revision===identity!\.analyticsRevision[\s\S]*experiment\.revision===identity!\.grantRevision/);
  assert.match(server, /if\(!await freshGrant\(\)\)return \{status:'suppressed',reason:'revoked_or_unregistered_grant'\}/);
});

test('browser bridge asks the loaded Google tag for its own ID and posts only that value first-party', async () => {
  const source = await readFile(path.join(root, 'lib/tag-identity-client.ts'), 'utf8');
  assert.match(source, /command\('get',measurementId,'client_id',receive\)/);
  assert.match(source, /fetch\('\/api\/analytics\/tag-identity'/);
  assert.match(source, /JSON\.stringify\(\{clientId:value\}\)/);
  assert.match(source, /if\(!allowed\(\)\|\|!validTagClientId\(value\)\)return/);
  assert.doesNotMatch(source, /gtag\.js|googletagmanager\.com\/gtag|google-analytics\.com/);
});
