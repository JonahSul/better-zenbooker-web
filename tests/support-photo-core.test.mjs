import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const source = await readFile(path.join(root, 'lib/support-photo-core.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', js)(specifier => {
  if (specifier === 'zod/v3') return require(specifier);
  throw new Error(`Unexpected support-photo-core dependency: ${specifier}`);
}, loaded, loaded.exports);
const photo = loaded.exports;
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 1, 2, 3]);
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);

function webpChunk(type, payload) {
  const bytes = new Uint8Array(8 + payload.length + payload.length % 2);
  bytes.set(new TextEncoder().encode(type), 0);
  new DataView(bytes.buffer).setUint32(4, payload.length, true);
  bytes.set(payload, 8);
  return bytes;
}

function webpFile(chunks) {
  const bodyLength = 4 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(8 + bodyLength);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  new DataView(bytes.buffer).setUint32(4, bodyLength, true);
  bytes.set(new TextEncoder().encode('WEBP'), 8);
  let offset = 12;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

test('upload validator trusts file signatures and bounds, not declared MIME alone', () => {
  assert.deepEqual(photo.validateUpload(jpeg, 'image/jpeg'), { mime: 'image/jpeg' });
  assert.deepEqual(photo.validateUpload(png, 'image/png'), { mime: 'image/png' });
  assert.throws(() => photo.validateUpload(jpeg, 'image/png'));
  assert.throws(() => photo.validateUpload(new TextEncoder().encode('<svg/>'), 'image/svg+xml'));
  assert.throws(() => photo.validateUpload(new Uint8Array(5 * 1024 * 1024 + 1), 'image/jpeg'));
});

test('normalized image metadata permits only bounded WebP dimensions and bytes', () => {
  assert.equal(photo.normalizedPhotoSchema.safeParse({ mime: 'image/webp', width: 1280, height: 640, byteLength: 1024 * 1024 }).success, true);
  assert.equal(photo.normalizedPhotoSchema.safeParse({ mime: 'image/jpeg', width: 100, height: 100, byteLength: 100 }).success, false);
  assert.equal(photo.normalizedPhotoSchema.safeParse({ mime: 'image/webp', width: 1281, height: 100, byteLength: 100 }).success, false);
  assert.equal(photo.normalizedPhotoSchema.safeParse({ mime: 'image/webp', width: 100, height: 100, byteLength: 1024 * 1024 + 1 }).success, false);
  assert.equal(photo.supportPhotoInput.safeParse({ revision: 0 }).success, true, 'new photo-first threads need no model call or prior text turn');
  assert.equal(photo.supportPhotoInput.safeParse({ threadId: 'e1469ad0-4986-46f3-beb4-a0cdb6ed2d63', revision: 0 }).success, true);
  assert.equal(photo.supportPhotoInput.safeParse({ threadId: 'e1469ad0-4986-46f3-beb4-a0cdb6ed2d63', revision: 0, visitorHash: 'other' }).success, false);
});

test('WebP normalization removes EXIF, XMP and ICC chunks and validates the container', () => {
  const source = webpFile([
    webpChunk('VP8 ', Uint8Array.from([1, 2, 3, 4])),
    webpChunk('EXIF', new TextEncoder().encode('synthetic-location-metadata')),
    webpChunk('XMP ', new TextEncoder().encode('synthetic-camera-metadata')),
    webpChunk('ICCP', new TextEncoder().encode('synthetic-profile')),
  ]);
  const normalized = photo.stripWebpMetadata(source);
  const decoded = new TextDecoder().decode(normalized);
  assert.match(decoded, /VP8 /);
  assert.doesNotMatch(decoded, /EXIF|XMP |ICCP|synthetic-location|synthetic-camera|synthetic-profile/);
  assert.throws(() => photo.stripWebpMetadata(new Uint8Array([1, 2, 3])));
  assert.throws(() => photo.stripWebpMetadata(webpFile([webpChunk('EXIF', new Uint8Array([1, 2]))])));
});

test('vision normalizer accepts the documented model result and ignores OpenAI-shaped results', () => {
  const normalized = photo.normalizeVisionResult({
    answer: 'The image appears to show a demo control box.',
    caption: 'A control box beside landscaping.',
    metrics: { input_tokens: 88, output_tokens: 19 },
    finish_reason: 'stop',
  });
  assert.equal(normalized.observation, 'The image appears to show a demo control box.');
  assert.deepEqual(normalized.usage, { inputTokens: 88, outputTokens: 19 });
  const wrapped = photo.normalizeVisionResult({
    result: {
      answer: 'The image appears to show a valve box.',
      caption: 'A valve box near landscaping.',
      metrics: { input_tokens: 92, output_tokens: 13 },
      finish_reason: 'stop',
      reasoning: 'PRIVATE_REASONING_SENTINEL',
      objects: [{ label: 'private-object-detail' }],
      points: [{ x: 0.5, y: 0.5 }],
    },
    usage: { prompt_tokens: 92, completion_tokens: 13, total_tokens: 105 },
  });
  assert.equal(wrapped.observation, 'The image appears to show a valve box.');
  assert.deepEqual(wrapped.usage, { inputTokens: 92, outputTokens: 13 });
  assert.doesNotMatch(JSON.stringify(wrapped), /PRIVATE_REASONING_SENTINEL|private-object-detail|points/);
  assert.throws(() => photo.normalizeVisionResult({ choices: [{ message: { content: 'wrong wire format' } }] }));
  assert.equal(photo.visionInputSchema.safeParse({ image: 'data:image/webp;base64,AA==' }).success, true);
  assert.equal(photo.visionInputSchema.safeParse({ image: 'https://example.invalid/photo.webp' }).success, false);
  assert.equal(photo.visionInputSchema.safeParse({ image: 'data:image/webp;base64,AA==', question: 'read the label' }).success, false);
});
