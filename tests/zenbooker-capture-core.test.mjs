import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,webcrypto} from 'node:crypto';
import ts from 'typescript';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
globalThis.crypto??=webcrypto;
const zod=require('zod/v3');
async function loadTs(relativePath,imports={}){
  const source=await readFile(path.join(root,relativePath),'utf8');
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const loaded={exports:{}};
  new Function('require','module','exports',js)(specifier=>{
    if(Object.hasOwn(imports,specifier))return imports[specifier];
    throw new Error(`Unexpected import from ${relativePath}: ${specifier}`);
  },loaded,loaded.exports);
  return loaded.exports;
}
const bridge=await loadTs('integrations/zenbooker-bridge/core.ts',{zod,'zod/v3':zod});
const capture=await loadTs('integrations/zenbooker-bridge/capture.ts',{zod,'zod/v3':zod,'./core':bridge});
const {CaptureStore,encryptCapture,decryptCapture,captureMetadataSchema,encryptedCaptureSchema,CAPTURE_NAMESPACE,CAPTURE_TTL_MS}=capture;

const key=Buffer.alloc(32,0x53).toString('base64');
const rotatedKey=Buffer.alloc(32,0x54).toString('base64');
const raw=Buffer.from('synthetic local webhook body: CONTACT_SENTINEL@example.invalid');
const capturedAt=1_800_000_000_000;
const metadata={
  id:'cd1ec29f-a12b-41bd-9030-d3f9451c1011',
  eventKey:'a'.repeat(64),
  bodySha256:createHash('sha256').update(raw).digest('hex'),
  keyVersion:'v1',
  namespace:CAPTURE_NAMESPACE,
  parserPolicyVersion:'webhook-inspection-v1',
  mode:'setup',
  configRevision:0,
  byteLength:raw.byteLength,
  capturedAt,
  expiresAt:capturedAt+CAPTURE_TTL_MS,
};

test('capture metadata and ciphertext records enforce the strict versioned, bounded storage contract',()=>{
  assert.deepEqual(captureMetadataSchema.parse(metadata),metadata);
  assert.deepEqual(captureMetadataSchema.parse({ ...metadata, parserPolicyVersion: 'webhook-inspection-v2' }), {
    ...metadata,
    parserPolicyVersion: 'webhook-inspection-v2',
  });
  assert.equal(captureMetadataSchema.safeParse({...metadata,rawBody:'CONTACT_SENTINEL'}).success,false);
  assert.equal(captureMetadataSchema.safeParse({...metadata,namespace:'other-purpose'}).success,false);
  assert.equal(captureMetadataSchema.safeParse({...metadata,keyVersion:'x'.repeat(33)}).success,false);
  assert.equal(captureMetadataSchema.safeParse({...metadata,byteLength:262145}).success,false);
  assert.equal(captureMetadataSchema.safeParse({...metadata,expiresAt:capturedAt+CAPTURE_TTL_MS+1}).success,false);
  assert.equal(encryptedCaptureSchema.safeParse({metadata,nonce:'A'.repeat(16),ciphertext:'A'.repeat(24),rawBody:'CONTACT_SENTINEL'}).success,false);
});

test('new parser v2 metadata round-trips without changing legacy v1 metadata or AAD behavior', async()=>{
  assert.equal(bridge.CURRENT_WEBHOOK_PARSER_VERSION, 'webhook-inspection-v2');
  const v1 = await encryptCapture(raw, metadata, key);
  assert.equal(v1.metadata.parserPolicyVersion, 'webhook-inspection-v1');
  assert.deepEqual(Buffer.from(await decryptCapture(v1,[{version:'v1',keyBase64:key}],capturedAt+1)),raw);

  const nextMetadata = {
    ...metadata,
    id: '0a79f60d-1ea4-4d4e-aa9c-fbc3e16b34b5',
    parserPolicyVersion: bridge.CURRENT_WEBHOOK_PARSER_VERSION,
  };
  const v2 = await encryptCapture(raw, nextMetadata, key);
  assert.equal(v2.metadata.parserPolicyVersion, 'webhook-inspection-v2');
  assert.deepEqual(Buffer.from(await decryptCapture(v2,[{version:'v1',keyBase64:key}],capturedAt+1)),raw);
  assert.equal(v1.metadata.parserPolicyVersion, 'webhook-inspection-v1', 'reading v1 does not rewrite recorded metadata');
});

test('CaptureStore prepares new records with current v2 while retaining coverage for an active v1 key', async()=>{
  const calls = [];
  const db = {
    prepare(sql) {
      return {
        bind(...bindings) {
          calls.push({ sql, bindings });
          return {
            all: async() => ({ results: [{ key_version: 'v1' }] }),
          };
        },
      };
    },
  };
  const store = new CaptureStore(db, { keyBase64: key, keyVersion: 'v1' }, () => capturedAt);
  const prepared = await store.prepare(raw, {
    eventKey: 'd'.repeat(64),
    mode: 'setup',
    configRevision: 1,
  });

  assert.equal(prepared.record.metadata.parserPolicyVersion, 'webhook-inspection-v2');
  assert.equal(prepared.record.metadata.keyVersion, 'v1');
  assert.equal(prepared.record.metadata.mode, 'setup');
  assert.equal(prepared.record.metadata.configRevision, 1);
  assert.equal(calls.length, 2, 'prepare checks active key versions and returns an insert statement without writing');
  assert.match(calls[0].sql, /^SELECT DISTINCT key_version/);
  assert.match(calls[1].sql, /^INSERT OR IGNORE INTO bridge_captures/);
});

test('capture encrypts raw bytes and decrypts only with the matching key, AAD metadata, and unexpired record',async()=>{
  const record=await encryptCapture(raw,metadata,key);
  assert.equal(record.metadata.bodySha256,metadata.bodySha256);
  assert.equal(record.metadata.namespace,metadata.namespace);
  assert.equal(record.metadata.keyVersion,metadata.keyVersion);
  assert.equal(typeof record.nonce,'string');
  assert.equal(typeof record.ciphertext,'string');
  assert.notEqual(record.ciphertext,raw.toString('base64'));
  assert.equal(JSON.stringify(record).includes('CONTACT_SENTINEL'),false);
  assert.deepEqual(Buffer.from(await decryptCapture(record,[{version:'v1',keyBase64:key}],capturedAt+1)),raw);
  await assert.rejects(decryptCapture(record,[{version:'v1',keyBase64:rotatedKey}],capturedAt+1));
  await assert.rejects(decryptCapture({...record,metadata:{...record.metadata,namespace:'other-purpose'}},[{version:'v1',keyBase64:key}],capturedAt+1));
  await assert.rejects(decryptCapture({...record,metadata:{...record.metadata,keyVersion:'v2'}},[{version:'v1',keyBase64:key}],capturedAt+1));
  await assert.rejects(decryptCapture({...record,metadata:{...record.metadata,eventKey:'b'.repeat(64)}},[{version:'v1',keyBase64:key}],capturedAt+1));
  await assert.rejects(decryptCapture({...record,metadata:{...record.metadata,bodySha256:'c'.repeat(64)}},[{version:'v1',keyBase64:key}],capturedAt+1));
  await assert.rejects(decryptCapture({...record,ciphertext:record.ciphertext.slice(0,-4)+'AAAA'},[{version:'v1',keyBase64:key}],capturedAt+1));
  await assert.rejects(decryptCapture(record,[{version:'v1',keyBase64:key}],metadata.expiresAt));
});

test('capture key rotation reads the recorded version but does not accept an unknown version',async()=>{
  const next={...metadata,id:'7f74265a-7097-44cb-b782-4e7fbfd471cb',keyVersion:'v2'};
  const record=await encryptCapture(raw,next,rotatedKey);
  assert.equal(record.metadata.keyVersion,'v2');
  const keyring=[{version:'v1',keyBase64:key},{version:'v2',keyBase64:rotatedKey}];
  assert.deepEqual(Buffer.from(await decryptCapture(record,keyring,capturedAt+1)),raw);
  await assert.rejects(decryptCapture(record,[{version:'v1',keyBase64:key}],capturedAt+1));
});
