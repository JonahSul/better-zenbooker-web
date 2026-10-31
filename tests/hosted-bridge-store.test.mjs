import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { webcrypto } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const zod = require('zod/v3');
const priorCrypto = globalThis.crypto;
if (!priorCrypto) globalThis.crypto = webcrypto;
const ciphertextAad = new Map();

async function loadTs(relativePath, imports = {}) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (Object.hasOwn(imports, specifier)) return imports[specifier];
    if (specifier === 'zod/v3') return zod;
    throw new Error(`Unexpected import from ${relativePath}: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const bridgeCore = await loadTs('integrations/zenbooker-bridge/core.ts', { zod, 'zod/v3': zod });
const encryptionCalls = [];
const encryptedValue = {
  validEncryptionKey: key => key === Buffer.alloc(32, 0x23).toString('base64'),
  encryptValue: async (value, aad, key) => {
    encryptionCalls.push({ aad, key });
    const ciphertext = `fixture-cipher:${Buffer.from(value).toString('base64')}`;
    ciphertextAad.set(ciphertext, aad);
    return ciphertext;
  },
  decryptValue: async (value, aad, key) => {
    if (key !== Buffer.alloc(32, 0x23).toString('base64')) throw new Error('bad key');
    if (typeof value !== 'string' || !value.startsWith('fixture-cipher:')) throw new Error('bad ciphertext');
    if (ciphertextAad.get(value) !== aad) throw new Error('bad purpose binding');
    return Buffer.from(value.slice('fixture-cipher:'.length), 'base64').toString();
  },
};
const storeModule = await loadTs('lib/hosted-bridge-store.ts', {
  zod,
  './encrypted-value': encryptedValue,
  '../integrations/zenbooker-bridge/core': bridgeCore,
});

const key = Buffer.alloc(32, 0x23).toString('base64');

class MemoryD1 {
  row = null;
  audit = [];

  prepare(sql) {
    let args = [];
    return {
      bind: (...values) => {
        args = values;
        return {
          first: async () => sql.startsWith('SELECT * FROM hosted_bridge_state')
            ? (this.row?.workspace_id === args[0] ? structuredClone(this.row) : null)
            : null,
          run: async () => {
            if (sql.startsWith('INSERT OR IGNORE INTO hosted_bridge_state')) {
              if (this.row) return { meta: { changes: 0 } };
              const [workspace, credentialRevision, credentialJson, bridgeVerifier, callbackVerifier, configJson, createdAt, updatedAt] = args;
              this.row = {
                workspace_id: workspace,
                revision: 1,
                credential_revision: credentialRevision,
                credential_json: credentialJson,
                bridge_verifier: bridgeVerifier,
                callback_verifier: callbackVerifier,
                pending_json: null,
                config_json: configJson,
                cursor: 0,
                created_at: createdAt,
                updated_at: updatedAt,
              };
              return { meta: { changes: 1 } };
            }
            if (sql.startsWith('INSERT INTO admin_audit')) this.audit.push(args);
            return { meta: { changes: 1 } };
          },
        };
      },
    };
  }
}

test('fixed-owner initialization stores encrypted capabilities and returns verifiers only', async () => {
  const db = new MemoryD1();
  const store = new storeModule.HostedBridgeStore(db, 'fixture-workspace', key, () => 1_798_000_000_000);
  const result = await store.initialize('request-key-fixture-0001', 'native-owner:fixture');

  assert.equal(result.initialized, true);
  assert.equal(result.revision, 1);
  assert.match(result.bridgeVerifier, /^[0-9a-f]{64}$/);
  assert.match(result.callbackVerifier, /^[0-9a-f]{64}$/);
  assert.notEqual(result.bridgeVerifier, result.callbackVerifier);
  assert.equal(Object.hasOwn(result, 'bearer'), false);
  assert.equal(Object.hasOwn(result, 'callback'), false);
  assert.equal(Object.hasOwn(result, 'url'), false);
  assert.equal(db.row.credential_json.includes(result.bridgeVerifier), false);
  assert.equal(db.row.credential_json.includes(result.callbackVerifier), false);
  assert.equal(db.row.credential_json.includes(Buffer.alloc(32, 0x37).toString('hex')), false);
  assert.deepEqual(encryptionCalls.map(call => call.aad), [
    'hosted-bridge:v1:fixture-workspace:bearer:1',
    'hosted-bridge:v1:fixture-workspace:callback:1',
  ]);
  assert.equal(db.audit.length, 1);
  assert.deepEqual(await store.tokens(db.row).then(tokens => Object.keys(tokens).sort()), ['bearer', 'callback']);
});

test('concurrent setup returns the single persisted winner and does not regenerate on retry', async () => {
  const db = new MemoryD1();
  const first = new storeModule.HostedBridgeStore(db, 'fixture-workspace', key, () => 1_798_000_000_000);
  const second = new storeModule.HostedBridgeStore(db, 'fixture-workspace', key, () => 1_798_000_000_001);
  const [a, b] = await Promise.all([
    first.initialize('request-key-fixture-first', 'native-owner:fixture'),
    second.initialize('request-key-fixture-second', 'native-owner:fixture'),
  ]);
  assert.equal(a.bridgeVerifier, b.bridgeVerifier);
  assert.equal(a.callbackVerifier, b.callbackVerifier);
  assert.equal(db.audit.length, 1);

  const retry = await first.initialize('request-key-fixture-retry', 'native-owner:fixture');
  assert.equal(retry.revision, 1);
  assert.equal(retry.bridgeVerifier, a.bridgeVerifier);
  assert.equal(retry.callbackVerifier, a.callbackVerifier);
  assert.equal(db.audit.length, 1);
  assert.equal(db.row.credential_revision, 1);
});

test('invalid setup key and corrupt or wrong-purpose ciphertext fail closed without replacement', async () => {
  const emptyDb = new MemoryD1();
  const noKey = new storeModule.HostedBridgeStore(emptyDb, 'fixture-workspace', undefined);
  await assert.rejects(noKey.initialize('request-key-fixture-no-key', 'native-owner:fixture'));
  assert.equal(emptyDb.row, null);

  const db = new MemoryD1();
  const good = new storeModule.HostedBridgeStore(db, 'fixture-workspace', key, () => 1_798_000_000_000);
  const initialized = await good.initialize('request-key-fixture-corrupt', 'native-owner:fixture');
  const stored = structuredClone(db.row);
  db.row.credential_json = '{bad json';
  const broken = new storeModule.HostedBridgeStore(db, 'fixture-workspace', key);
  await assert.rejects(broken.initialize('request-key-fixture-repair', 'native-owner:fixture'));
  assert.equal(db.audit.length, 1);
  assert.equal(db.row.credential_json, '{bad json');

  db.row = stored;
  const encrypted = JSON.parse(stored.credential_json);
  const callbackCiphertext = encrypted.callback;
  encrypted.callback = encrypted.bearer;
  db.row.credential_json = JSON.stringify(encrypted);
  const wrongPurpose = new storeModule.HostedBridgeStore(db, 'fixture-workspace', key);
  await assert.rejects(wrongPurpose.tokens(db.row));
  encrypted.callback = callbackCiphertext;
  db.row.credential_json = JSON.stringify(encrypted);
  const wrongWorkspace = new storeModule.HostedBridgeStore(db, 'other-workspace', key);
  assert.equal((await wrongWorkspace.readiness()).initialized, false);
  assert.equal(initialized.revision, 1);
});

test('readiness remains setup-only until the approved receiver origin is configured', async () => {
  const db = new MemoryD1();
  const store = new storeModule.HostedBridgeStore(db, 'fixture-workspace', key, () => 1_798_000_000_000);
  await store.initialize('request-key-fixture-readiness', 'native-owner:fixture');
  const status = await store.readiness(storeModule.APPROVED_BRIDGE_ORIGIN);
  assert.equal(status.initialized, true);
  assert.equal(status.configured, false);
  assert.equal(status.locallyReadable, true);
  assert.equal(status.schema, 'unverified');
  assert.equal(status.correlation, 'unverified');
  assert.equal(status.schedule, 'not_recorded');
  assert.equal(Object.hasOwn(status, 'bearer'), false);
  assert.equal(Object.hasOwn(status, 'callback'), false);
  assert.equal(JSON.stringify(status).includes('fixture-cipher'), false);
});
