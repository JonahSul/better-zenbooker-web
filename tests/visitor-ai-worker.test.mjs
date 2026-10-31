import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, webcrypto } from 'node:crypto';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const sourceRequire = (specifier) => {
  if (specifier === 'zod/v3') return require(specifier);
  throw new Error(`Unexpected visitor AI worker import: ${specifier}`);
};

async function loadTs(relativePath, imports = {}) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (Object.hasOwn(imports, specifier)) return imports[specifier];
    return sourceRequire(specifier);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const supportCore = await loadTs('lib/support-core.ts');
const supportPhotoCore = await loadTs('lib/support-photo-core.ts');
const worker = await loadTs('integrations/visitor-ai/worker.ts', {
  '../../lib/support-core': supportCore,
  '../../lib/support-photo-core': supportPhotoCore,
});
const rawToken = '22'.repeat(32);
const verifier = createHash('sha256').update(rawToken).digest('hex');
const bearer = `Bearer ${rawToken}`;
const json = (value) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

function request(path, { method = 'POST', body = {}, authorization = bearer, scheme = 'https:' } = {}) {
  return new Request(`${scheme}//visitor-ai.test${path}`, {
    method,
    headers: {
      ...(authorization ? { authorization } : {}),
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}

const validInference = {
  messages: [{ role: 'system', content: 'Use approved public help.' }, { role: 'user', content: 'Where do I check availability?' }],
  tools: [],
  max_tokens: 200,
};

test('visitor AI proxy rejects missing, wrong, and verifier-as-token credentials before inference', async () => {
  let calls = 0;
  const ai = { async run() { calls++; return json({ choices: [{ message: { content: 'unexpected' } }] }); } };
  const missing = await worker.handleVisitorAi(request('/infer', { authorization: null, body: validInference }), ai, verifier);
  const wrong = await worker.handleVisitorAi(request('/infer', { authorization: `Bearer ${'33'.repeat(32)}`, body: validInference }), ai, verifier);
  const hashIsNotToken = await worker.handleVisitorAi(request('/infer', { authorization: `Bearer ${verifier}`, body: validInference }), ai, verifier);
  assert.equal(missing.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(hashIsNotToken.status, 401);
  assert.equal(calls, 0);
});

test('visitor AI proxy accepts the fixed model request and normalizes Cloudflare choices and tool calls', async () => {
  const observed = [];
  const ai = { async run(model, input) {
    observed.push({ model, input });
    return { choices: [{ message: { content: 'Check the hosted booking page.', tool_calls: [{ function: { name: 'public_kb_search', arguments: '{"query":"availability"}' } }] } }], usage: { prompt_tokens: 17, completion_tokens: 8, total_tokens: 25 } };
  } };
  const response = await worker.handleVisitorAi(request('/infer', { body: validInference }), ai, verifier);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].model, supportCore.SUPPORT_MODEL);
  assert.equal(observed[0].input.stream, false);
  assert.equal(payload.choices[0].message.content, 'Check the hosted booking page.');
  assert.equal(payload.choices[0].message.tool_calls[0].function.name, 'public_kb_search');
  assert.deepEqual(JSON.parse(payload.choices[0].message.tool_calls[0].function.arguments), { query: 'availability' });
  assert.deepEqual(payload.usage, { prompt_tokens: 17, completion_tokens: 8, total_tokens: 25 });
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.match(response.headers.get('x-robots-tag') ?? '', /noindex/i);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
});

test('visitor AI proxy denies private/admin tool names, oversized bodies, and invalid call limits before AI', async () => {
  let calls = 0;
  const ai = { async run() { calls++; return { choices: [{ message: { content: 'unexpected' } }] }; } };
  const privateTool = { ...validInference, tools: [{ type: 'function', function: { name: 'inquiries_list', description: 'Private admin records', parameters: {} } }] };
  const tooManyTokens = { ...validInference, max_tokens: 1025 };
  const tooLarge = { ...validInference, messages: [{ role: 'user', content: 'x'.repeat(16001) }] };
  for (const body of [privateTool, tooManyTokens, tooLarge]) {
    const response = await worker.handleVisitorAi(request('/infer', { body }), ai, verifier);
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /inquiries_list|Private admin records|x{100}/);
  }
  assert.equal(calls, 0);
});

test('visitor AI proxy uses fixed paths and does not reflect upstream model errors', async () => {
  let calls = 0;
  const ai = { async run() { calls++; throw new Error('sensitive provider response marker'); } };
  const unknown = await worker.handleVisitorAi(request('/admin/records', { body: validInference }), ai, verifier);
  const query = await worker.handleVisitorAi(request('/infer?model=@cf/other', { body: validInference }), ai, verifier);
  const http = await worker.handleVisitorAi(request('/infer', { body: validInference, scheme: 'http:' }), ai, verifier);
  const failure = await worker.handleVisitorAi(request('/infer', { body: validInference }), ai, verifier);
  assert.equal(unknown.status, 404);
  assert.equal(query.status, 404);
  assert.equal(http.status, 403);
  assert.equal(failure.status, 503);
  assert.doesNotMatch(await failure.text(), /sensitive provider response marker/);
  assert.equal(calls, 1);
});

test('visitor AI health is a readiness hint only and an unknown provider tool call fails closed', async () => {
  let calls = 0;
  const ai = { async run(_model, input) {
    calls++;
    if (input.messages?.[1]?.content.includes('Where do I check')) {
      return { choices: [{ message: { content: null, tool_calls: [{ function: { name: 'inquiries_list', arguments: '{}' } }] } }] };
    }
    return { choices: [{ message: { content: 'Ready.', tool_calls: [] } }] };
  } };
  const health = await worker.handleVisitorAi(request('/health', { method: 'GET' }), ai, verifier);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { available: true, model: supportCore.SUPPORT_MODEL, inferenceVerified: false, imagesAvailable: false, visionModel: supportPhotoCore.VISION_MODEL });
  const response = await worker.handleVisitorAi(request('/infer', { body: validInference }), ai, verifier);
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /inquiries_list/);
  assert.equal(calls, 1);
});
