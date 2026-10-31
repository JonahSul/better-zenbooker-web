import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storeSource = await readFile(path.join(root, 'lib/credential-store.ts'), 'utf8');
const storeJs = ts.transpileModule(storeSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const loaded = { exports: {} };
const mocks = (specifier) => {
  if (specifier === './encrypted-value') return { encryptValue: async (value) => value, decryptValue: async (value) => value };
  throw new Error(`Unexpected import: ${specifier}`);
};
new Function('require', 'module', 'exports', storeJs)(mocks, loaded, loaded.exports);
const { CredentialStore } = loaded.exports;

test('native credential values take precedence without reading the D1 fallback', async () => {
  let queries = 0;
  const db = {
    prepare() {
      queries += 1;
      throw new Error('D1 should not be read when a native value is present');
    },
  };
  const store = new CredentialStore(db, 'fixture-project', undefined);
  const resolved = await store.resolve('ADMIN_GOOGLE_CLIENT_SECRET', 'fixture-native-secret-not-real');

  assert.deepEqual(resolved, { value: 'fixture-native-secret-not-real', source: 'native' });
  assert.equal(queries, 0);
});

test('native Zenbooker and Cloudflare Email secrets take precedence without reading encrypted D1 values', async () => {
  for (const [key, value] of [
    ['ZENBOOKER_API_KEY', 'fixture-native-zenbooker-key-not-real'],
    ['CLOUDFLARE_EMAIL_API_TOKEN', 'fixture-native-email-token-not-real'],
  ]) {
    let queries = 0;
    const db = {
      prepare() {
        queries += 1;
        throw new Error('D1 fallback must not be read when a native secret is configured');
      },
    };
    const store = new CredentialStore(db, 'fixture-project', undefined);
    assert.deepEqual(await store.resolve(key, value), { value, source: 'native' });
    assert.equal(queries, 0, `${key} should resolve natively without touching D1`);
  }
});

test('credential keys are an explicit allowlist', async () => {
  const db = { prepare() { throw new Error('invalid names must fail before any D1 access'); } };
  const store = new CredentialStore(db, 'fixture-project', undefined);
  await assert.rejects(store.resolve('UNSUPPORTED_SECRET', 'fixture-value'), /Credential key rejected/);
});
