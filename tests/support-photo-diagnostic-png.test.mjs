import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let current = value;
  for (let bit = 0; bit < 8; bit += 1) current = current & 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
  return current >>> 0;
});

function crc32(bytes) {
  let current = 0xffffffff;
  for (const value of bytes) current = crcTable[(current ^ value) & 0xff] ^ (current >>> 8);
  return (current ^ 0xffffffff) >>> 0;
}

function parsePng(bytes) {
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'diagnostic fixture must have a PNG signature');
  const chunks = [];
  let offset = 8;
  while (offset < bytes.length) {
    assert.ok(offset + 12 <= bytes.length, 'PNG chunk header and CRC must fit');
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    assert.ok(end <= bytes.length, 'PNG chunk payload must fit');
    const type = bytes.subarray(offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
    const actualCrc = crc32(bytes.subarray(offset + 4, offset + 8 + length));
    chunks.push({ type: type.toString('ascii'), data: Buffer.from(data), expectedCrc, actualCrc });
    offset = end;
    if (type.toString('ascii') === 'IEND') break;
  }
  assert.equal(offset, bytes.length, 'PNG must end exactly after IEND');
  assert.equal(chunks[0]?.type, 'IHDR');
  assert.equal(chunks.at(-1)?.type, 'IEND');
  assert.ok(chunks.some(chunk => chunk.type === 'IDAT'));
  for (const chunk of chunks) assert.equal(chunk.actualCrc, chunk.expectedCrc, `${chunk.type} CRC must match its type and payload`);
  return chunks;
}

function corruptIdatCrc(bytes) {
  const corrupted = Buffer.from(bytes);
  let offset = 8;
  while (offset < corrupted.length) {
    const length = corrupted.readUInt32BE(offset);
    if (corrupted.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
      corrupted[offset + 8 + length] ^= 1;
      return corrupted;
    }
    offset += length + 12;
  }
  throw new Error('PNG fixture has no IDAT chunk.');
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForWorker(child, baseUrl) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Local Wrangler Images worker exited before readiness.');
    try {
      const response = await fetch(`${baseUrl}/images/normalize`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${'11'.repeat(32)}` },
      });
      if (response.status === 405) return;
    } catch { /* The loopback worker is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Local Wrangler Images worker did not become ready.');
}

const core = await readFile(path.join(root, 'lib/support-photo-core.ts'), 'utf8');
const match = core.match(/PHOTO_DIAGNOSTIC_PNG_BASE64\s*=\s*['"]([A-Za-z0-9+/=]+)['"]/);
assert.ok(match, 'support-photo-core.ts must export the shared diagnostic PNG fixture');
const png = Buffer.from(match[1], 'base64');

test('diagnostic PNG fixture has valid chunk CRCs and bounded one-pixel dimensions', () => {
  const chunks = parsePng(png);
  const header = chunks[0].data;
  assert.equal(header.readUInt32BE(0), 1);
  assert.equal(header.readUInt32BE(4), 1);
});

// The actual Images binding is unavailable in the default local Wrangler profile.
// Site/Worker projection and bounded-format behavior remain covered by support-photo-core and
// support-photo-normalization-projection tests; run this integration when that binding is present.
const imagesIntegration = process.env.QA_LOCAL_IMAGES_PIPELINE === '1' ? test : test.skip;
imagesIntegration('real local Images pipeline accepts and rejects diagnostic samples', async () => {
  const port = await availablePort();
  const temp = await mkdtemp(path.join(os.tmpdir(), 'support-photo-images-'));
  const configPath = path.join(temp, 'wrangler.jsonc');
  const config = {
    name: 'support-photo-images-offline-test',
    main: path.join(root, 'integrations/visitor-ai/worker.ts'),
    compatibility_date: '2026-05-15',
    images: { binding: 'IMAGES' },
    vars: { VISITOR_AI_BEARER_VERIFIER: createHash('sha256').update('11'.repeat(32)).digest('hex') },
  };
  await writeFile(configPath, JSON.stringify(config), 'utf8');
  const wrangler = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
  for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CF_API_TOKEN', 'CF_API_KEY']) delete env[name];
  const child = spawn(process.execPath, [
    wrangler, 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port),
    '--config', configPath, '--persist-to', path.join(temp, 'persist'),
  ], { cwd: root, env, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForWorker(child, baseUrl);
    const bearer = `Bearer ${'11'.repeat(32)}`;
    const normalize = async image => fetch(`${baseUrl}/images/normalize`, {
      method: 'POST',
      headers: { Authorization: bearer, 'Content-Type': 'image/png' },
      body: image,
    });

    const corrupted = await normalize(corruptIdatCrc(png));
    assert.equal(corrupted.status, 503, 'a malformed IDAT CRC must not pass normalization');
    const failure = await corrupted.json();
    assert.equal(failure.error, 'Photo normalization unavailable');
    assert.ok(['bindingavailability', 'inputinspection', 'transform', 'outputread', 'metadataremoval', 'outputvalidation'].includes(failure.normalization?.stage));
    assert.ok(['unavailable', 'invalid_input', 'processing_failed', 'invalid_output'].includes(failure.normalization?.reason));
    assert.equal(failure.normalization?.httpStatus, 503);
    assert.deepEqual(Object.keys(failure).sort(), ['error', 'normalization']);

    const response = await normalize(png);
    assert.equal(response.status, 200, 'the diagnostic sample must pass the actual local Images info→transform→WebP output path');
    assert.equal(response.headers.get('content-type'), 'image/webp');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const output = Buffer.from(await response.arrayBuffer());
    assert.equal(output.toString('ascii', 0, 4), 'RIFF');
    assert.equal(output.toString('ascii', 8, 12), 'WEBP');
    assert.ok(output.length > 0 && output.length <= 1048576);
  } finally {
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
    await Promise.race([once(child, 'exit').catch(() => {}), new Promise(resolve => setTimeout(resolve, 3000))]);
    try { await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }); } catch { /* Windows may keep a local Images cache handle briefly; no product state is in this directory. */ }
  }
});
