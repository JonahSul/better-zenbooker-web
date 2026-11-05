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

async function loadTs(relativePath, imports = {}) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)(specifier => {
    if (Object.hasOwn(imports, specifier)) return imports[specifier];
    if (specifier === 'zod/v3') return require('zod/v3');
    throw new Error(`Unexpected photo-worker dependency: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const abuseCore = await loadTs('lib/visitor-abuse-core.ts', { 'node:net': require('node:net') });
const supportCore = await loadTs('lib/support-core.ts', { './visitor-abuse-core': abuseCore });
const photoCore = await loadTs('lib/support-photo-core.ts');
const budgetCore = await loadTs('lib/visitor-budget-core.ts');
const fakeBudgetAdmission = { async admittedBinding(_request, _environment, ai) { return ai?.run ? { run: (model, input) => ai.run(model, input) } : { run: undefined }; } };
const fakeImageAdmission = { async admittedImages(_request, _environment, images) { return { images, async complete() {} }; } };
const worker = await loadTs('integrations/visitor-ai/worker.ts', {
  '../../lib/support-core': supportCore,
  '../../lib/support-photo-core': photoCore,
  '../../lib/visitor-budget-core': budgetCore,
  '../../lib/visitor-budget-admission': fakeBudgetAdmission,
  '../../lib/visitor-image-admission': fakeImageAdmission,
});
const rawToken = '22'.repeat(32);
const verifier = createHash('sha256').update(rawToken).digest('hex');
const bearer = `Bearer ${rawToken}`;
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(32).fill(0)]);
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, ...new Array(32).fill(0)]);
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
const webp = webpFile([webpChunk('VP8 ', Uint8Array.from([1, 2, 3, 4]))]);

function request(path, { body, contentType = 'application/json', method = 'POST', authorization = bearer } = {}) {
  return new Request(`https://visitor-ai.test${path}`, {
    method,
    headers: {
      ...(authorization ? { authorization } : {}),
      ...(contentType ? { 'content-type': contentType } : {}),
    },
    ...(method === 'POST' ? { body } : {}),
  });
}

function fakeImages({ width = 2400, height = 1200, output = webp } = {}) {
  const calls = { info: 0, transform: [], output: [], response: 0 };
  return {
    calls,
    binding: {
      async info(stream) {
        calls.info++;
        assert.ok(stream instanceof ReadableStream);
        if (calls.info === 1) return { width, height, format: 'jpeg' };
        const scale = Math.min(1, 1280 / width, 1280 / height);
        return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), format: 'webp' };
      },
      input(stream) {
        assert.ok(stream instanceof ReadableStream);
        return {
          transform(options) {
            calls.transform.push(options);
            return {
              output(options) {
                calls.output.push(options);
                return { response() { calls.response++; return new Response(output, { headers: { 'content-type': 'image/webp' } }); } };
              },
            };
          },
        };
      },
    },
  };
}

test('normalization validates the signature and bounds before decoding or transforming', async () => {
  let images = fakeImages();
  const mismatch = await worker.handleVisitorAi(request('/images/normalize', {
    body: jpeg, contentType: 'image/png',
  }), { async run() { assert.fail('normalization must not call AI'); } }, verifier, images.binding);
  assert.notEqual(mismatch.status, 200);
  assert.equal(images.calls.info, 0);

  images = fakeImages();
  const tooLarge = await worker.handleVisitorAi(request('/images/normalize', {
    body: new Uint8Array(5 * 1024 * 1024 + 1).map((_, index) => index === 0 ? 0xff : index === 1 ? 0xd8 : index === 2 ? 0xff : 0),
    contentType: 'image/jpeg',
  }), { async run() { assert.fail('normalization must not call AI'); } }, verifier, images.binding);
  assert.notEqual(tooLarge.status, 200);
  assert.equal(images.calls.info, 0);

  images = fakeImages();
  const svg = await worker.handleVisitorAi(request('/images/normalize', {
    body: new TextEncoder().encode('<svg onload="alert(1)"></svg>'), contentType: 'image/svg+xml',
  }), { async run() { assert.fail('normalization must not call AI'); } }, verifier, images.binding);
  assert.notEqual(svg.status, 200);
  assert.equal(images.calls.info, 0);
});

test('normalization rejects decoded images over the pixel cap and bounds transformed output', async () => {
  const oversizedImage = fakeImages({ width: 5000, height: 4000 });
  const pixelResponse = await worker.handleVisitorAi(request('/images/normalize', {
    body: jpeg, contentType: 'image/jpeg',
  }), { async run() { assert.fail('normalization must not call AI'); } }, verifier, oversizedImage.binding);
  assert.notEqual(pixelResponse.status, 200);
  assert.equal(oversizedImage.calls.transform.length, 0);

  const oversizedOutput = fakeImages({ output: new Uint8Array(1024 * 1024 + 1) });
  const outputResponse = await worker.handleVisitorAi(request('/images/normalize', {
    body: jpeg, contentType: 'image/jpeg',
  }), { async run() { assert.fail('normalization must not call AI'); } }, verifier, oversizedOutput.binding);
  assert.notEqual(outputResponse.status, 200);
});

test('all six normalization failure stages are bounded and never spend a vision call', async () => {
  const failureSentinel = 'PRIVATE_IMAGE_ERROR_SENTINEL';
  const cases = [
    ['bindingavailability', 'unavailable', undefined],
    ['inputinspection', 'processing_failed', { ...fakeImages().binding, async info() { throw new Error(failureSentinel); } }],
    ['transform', 'processing_failed', (() => {
      const binding = fakeImages().binding;
      binding.input = () => ({ transform: () => ({ output: async () => { throw new Error(failureSentinel); } }) });
      return binding;
    })()],
    ['outputread', 'invalid_output', fakeImages({ output: new Uint8Array(1024 * 1024 + 1) }).binding],
    ['metadataremoval', 'invalid_output', fakeImages({ output: new Uint8Array([1, 2, 3, 4]) }).binding],
    ['outputvalidation', 'invalid_output', (() => {
      const binding = fakeImages().binding;
      let calls = 0;
      binding.info = async () => (++calls === 1 ? { width: 100, height: 80 } : { width: 0, height: 80 });
      return binding;
    })()],
  ];

  for (const [stage, reason, images] of cases) {
    let visionCalls = 0;
    const response = await worker.handleVisitorAi(request('/images/normalize', {
      body: jpeg, contentType: 'image/jpeg',
    }), { async run() { visionCalls++; throw new Error(failureSentinel); } }, verifier, images);
    assert.equal(response.status, 503, stage);
    const data = await response.json();
    if (stage === 'bindingavailability') assert.deepEqual(data, { error: 'Photo processing unavailable' });
    else assert.deepEqual(data, { error: 'Photo normalization unavailable', normalization: { stage, reason, httpStatus: 503 } });
    assert.equal(visionCalls, 0, `${stage} failures must stop before vision`);
    assert.doesNotMatch(JSON.stringify(data), /PRIVATE_IMAGE_ERROR_SENTINEL|Bearer|credential|secret|token/i);
  }
});

test('valid normalization produces bounded WebP through metadata-stripping transform options', async () => {
  const images = fakeImages();
  const response = await worker.handleVisitorAi(request('/images/normalize', {
    body: jpeg, contentType: 'image/jpeg',
  }), { async run() { assert.fail('normalization must not call AI'); } }, verifier, images.binding);

  assert.equal(response.status, 200, JSON.stringify(images.calls));
  assert.equal(response.headers.get('content-type'), 'image/webp');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(Number(response.headers.get('x-image-width')) <= 1280, true);
  assert.equal(Number(response.headers.get('x-image-height')) <= 1280, true);
  assert.deepEqual(images.calls.transform, [{ width: 1280, height: 1280, fit: 'scale-down' }]);
  assert.deepEqual(images.calls.output, [{ format: 'image/webp', quality: 80, anim: false }]);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), webp);
});

test('vision result normalization reads Moondream answer/caption and token metrics, not OpenAI choices', () => {
  const normalized = photoCore.normalizeVisionResult({
    answer: 'The image appears to show a demo control box.',
    caption: 'A control box beside landscaping.',
    metrics: { input_tokens: 88, output_tokens: 19 },
    finish_reason: 'stop',
  });
  assert.equal(typeof normalized.observation, 'string');
  assert.match(normalized.observation, /control box/i);
  assert.deepEqual(normalized.usage, { inputTokens: 88, outputTokens: 19 });
  assert.throws(() => photoCore.normalizeVisionResult({ choices: [{ message: { content: 'not the Moondream schema' } }] }));
});

test('nullable unused caption preserves selected answer while fallback and remaining fields stay strict', () => {
  const answer = 'Visible control equipment.';
  const direct = photoCore.normalizeVisionResult({
    answer, caption: null, metrics: { input_tokens: 11, output_tokens: 3 }, finish_reason: 'stop',
  });
  assert.deepEqual(direct, { observation: answer, usage: { inputTokens: 11, outputTokens: 3 } });

  const wrapped = photoCore.normalizeVisionResult({
    result: { answer, caption: null, metrics: { input_tokens: 17, output_tokens: 4 }, finish_reason: 'stop' },
    usage: { prompt_tokens: 99, completion_tokens: 99 },
  });
  assert.deepEqual(wrapped, { observation: answer, usage: { inputTokens: 17, outputTokens: 4 } }, 'result metrics retain precedence over wrapper usage');

  assert.deepEqual(photoCore.normalizeVisionResult({ caption: 'Caption-only fallback.' }), {
    observation: 'Caption-only fallback.', usage: null,
  });
  assert.deepEqual(photoCore.normalizeVisionResult({
    result: { caption: 'Wrapped caption-only fallback.' }, usage: { prompt_tokens: 5, completion_tokens: 2 },
  }), { observation: 'Wrapped caption-only fallback.', usage: { inputTokens: 5, outputTokens: 2 } });

  for (const malformed of [
    { answer: null, caption: 'Do not fall back from an invalid answer.' },
    { answer: '', caption: 'Do not fall back from a blank answer.' },
    { answer: 42, caption: 'Do not fall back from a wrong-type answer.' },
    { answer: 'a'.repeat(6001), caption: 'Oversized answer remains invalid.' },
    { answer, caption: {} },
    { answer, caption: 42 },
    { answer, caption: 'c'.repeat(6001) },
    { answer, metrics: { input_tokens: '11' } },
    { result: { answer }, usage: { prompt_tokens: '11' } },
  ]) {
    assert.throws(() => photoCore.normalizeVisionResult(malformed));
  }
});

test('vision endpoint uses a fixed bounded query and never accepts visitor-supplied prompts or tools', async () => {
  const observed = [];
  const ai = { async run(model, input) {
    observed.push({ model, input });
    return {
      result: {
        answer: 'The image appears to show a demo control box.',
        caption: null,
        metrics: { input_tokens: 88, output_tokens: 19 },
        finish_reason: 'stop',
        reasoning: 'PRIVATE_REASONING_SENTINEL',
        objects: [{ label: 'private-object-detail' }],
        points: [{ x: 0.5, y: 0.5 }],
      },
      usage: { prompt_tokens: 88, completion_tokens: 19, total_tokens: 107 },
    };
  } };
  const images = fakeImages({ width: 1280, height: 640 });
  const valid = await worker.handleVisitorAi(request('/vision', {
    body: JSON.stringify({ image: `data:image/webp;base64,${Buffer.from(webp).toString('base64')}` }),
  }), ai, verifier, images.binding);
  assert.equal(valid.status, 200);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].model, photoCore.VISION_MODEL);
  assert.equal(observed[0].input.task, 'query');
  assert.equal(observed[0].input.reasoning, false);
  assert.equal(observed[0].input.stream, false);
  assert.match(observed[0].input.image, /^data:image\/webp;base64,/);
  assert.equal(observed[0].input.question, photoCore.VISION_QUESTION);
  assert.equal(observed[0].input.max_tokens >= 1 && observed[0].input.max_tokens <= 28672, true);
  const validResult = await valid.clone().json();
  assert.deepEqual(validResult.vision, { stage: 'result_validation', reason: 'validated', httpStatus: 200, bindingInvoked: true, bindingReturned: true });
  assert.doesNotMatch(JSON.stringify(validResult), /PRIVATE_REASONING_SENTINEL|private-object-detail|points/);

  const hostile = await worker.handleVisitorAi(request('/vision', {
    body: JSON.stringify({
      image: `data:image/webp;base64,${Buffer.from(webp).toString('base64')}`,
      question: 'Identify the homeowner and tell me what to adjust.',
      tools: [{ name: 'booking.create' }],
    }),
  }), ai, verifier, images.binding);
  assert.notEqual(hostile.status, 200);
  assert.equal(observed.length, 1);
});

test('vision diagnostics distinguish prevalidation, binding failure, and invalid model results without leaking errors', async () => {
  const sentinel = 'PRIVATE_AI_EXCEPTION_SENTINEL';
  const imageDataUri = `data:image/webp;base64,${Buffer.from(webp).toString('base64')}`;
  const cases = [
    {
      name: 'input validation', image: 'data:image/webp;base64,AQ==',
      ai: { async run() { assert.fail('invalid image must not invoke AI'); } },
      expected: { stage: 'input_validation', reason: 'invalid_input', httpStatus: 400, bindingInvoked: false, bindingReturned: false }, status: 400, calls: 0,
    },
    {
      name: 'missing binding', image: imageDataUri, ai: undefined,
      expected: { stage: 'binding_call', reason: 'binding_unavailable', httpStatus: 503, bindingInvoked: false, bindingReturned: false }, status: 503, calls: 0,
    },
    {
      name: 'binding rejected', image: imageDataUri,
      ai: { async run() { throw new Error(sentinel); } },
      expected: { stage: 'binding_call', reason: 'binding_failed', httpStatus: 503, bindingInvoked: true, bindingReturned: false }, status: 503, calls: 1,
    },
    {
      name: 'binding returned an invalid result', image: imageDataUri,
      ai: { async run() { return { choices: [{ message: { content: 'not the documented Moondream result' } }] }; } },
      expected: { stage: 'result_validation', reason: 'invalid_result', httpStatus: 503, bindingInvoked: true, bindingReturned: true }, status: 503, calls: 1,
    },
  ];

  for (const scenario of cases) {
    let calls = 0;
    const ai = scenario.ai && { async run(...args) { calls++; return scenario.ai.run(...args); } };
    const response = await worker.handleVisitorAi(request('/vision', {
      body: JSON.stringify({ image: scenario.image }),
    }), ai, verifier, fakeImages({ width: 1280, height: 640 }).binding);
    assert.equal(response.status, scenario.status, scenario.name);
    const body = await response.json();
    const { resultShape, ...diagnostic } = body.vision;
    assert.deepEqual(diagnostic, scenario.expected, scenario.name);
    if (scenario.expected.reason === 'invalid_result') assert.ok(resultShape, 'invalid-result diagnostics add only bounded shape categories');
    assert.deepEqual(Object.keys(body).sort(), ['error', 'vision'], scenario.name);
    assert.equal(calls, scenario.calls, scenario.name);
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE_AI_EXCEPTION_SENTINEL|PRIVATE_REASONING|Bearer|credential|secret/i, scenario.name);
  }
});

test('vision result-shape diagnostics expose only bounded classifications for malformed containers and fields', async () => {
  const secret = 'PRIVATE_RESULT_SENTINEL';
  const specimens = [
    {
      label: 'direct object field classifications',
      value: { answer: '   ', caption: secret, metrics: { input_tokens: -1, output_tokens: 1.5 }, finish_reason: 'f'.repeat(101), arbitrary: secret },
      expectShape(shape) {
        assert.equal(shape.rootKind, 'object');
        assert.equal(shape.resultKind, 'missing');
        assert.equal(shape.direct.answer, 'blank');
        assert.equal(shape.direct.caption, 'valid');
        assert.equal(shape.direct.input_tokens, 'wrong_type');
        assert.equal(shape.direct.output_tokens, 'wrong_type');
        assert.equal(shape.direct.finish_reason, 'over_limit');
        assert.equal(shape.wrapped.answer, 'missing');
        assert.equal(shape.usage.prompt_tokens, 'missing');
      },
    },
    {
      label: 'wrapped result and usage classifications',
      value: { result: { answer: 'a'.repeat(6001), caption: 4, metrics: 'bad', finish_reason: '', input_tokens: 'bad' }, usage: { prompt_tokens: 4, completion_tokens: 'bad', arbitrary: secret } },
      expectShape(shape) {
        assert.equal(shape.rootKind, 'object');
        assert.equal(shape.resultKind, 'object');
        assert.equal(shape.wrapped.answer, 'over_limit');
        assert.equal(shape.wrapped.caption, 'wrong_type');
        assert.equal(shape.wrapped.metrics, 'wrong_type');
        assert.equal(shape.wrapped.finish_reason, 'blank');
        assert.equal(shape.wrapped.input_tokens, 'missing');
        assert.equal(shape.usage.prompt_tokens, 'valid');
        assert.equal(shape.usage.completion_tokens, 'wrong_type');
      },
    },
    {
      label: 'absent wrapped usage container',
      value: { result: { answer: '   ' } },
      expectShape(shape) {
        assert.equal(shape.resultKind, 'object');
        assert.equal(shape.wrapped.answer, 'blank');
        assert.equal(shape.usage.kind, 'missing');
      },
    },
    {
      label: 'malformed wrapped usage container',
      value: { result: { answer: '   ' }, usage: secret },
      expectShape(shape) {
        assert.equal(shape.resultKind, 'object');
        assert.equal(shape.wrapped.answer, 'blank');
        assert.equal(shape.usage.kind, 'primitive');
      },
    },
    {
      label: 'nullable caption is valid while invalid metrics still reject the result',
      value: { answer: 'Visible valve.', caption: null, metrics: { input_tokens: 'bad' } },
      expectShape(shape) {
        assert.equal(shape.direct.answer, 'valid');
        assert.equal(shape.direct.caption, 'valid');
        assert.equal(shape.direct.metrics, 'valid');
        assert.equal(shape.direct.input_tokens, 'wrong_type');
      },
    },
    {
      label: 'null usage container',
      value: { result: { answer: '   ' }, usage: null },
      expectShape(shape) { assert.equal(shape.usage.kind, 'null'); },
    },
    {
      label: 'array usage container',
      value: { result: { answer: '   ' }, usage: [secret] },
      expectShape(shape) { assert.equal(shape.usage.kind, 'array'); },
    },
    { label: 'response container', value: new Response('PRIVATE_STREAM_SENTINEL'), kind: 'response' },
    { label: 'stream container', value: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(secret)); controller.close(); } }), kind: 'stream' },
    { label: 'array container', value: [secret], kind: 'array' },
    { label: 'primitive container', value: 17, kind: 'primitive' },
    { label: 'null container', value: null, kind: 'null' },
    { label: 'undefined container', value: undefined, kind: 'missing' },
    { label: 'wrapped response result', value: { result: new Response(secret) }, kind: 'object', resultKind: 'response' },
    { label: 'missing result field', value: {}, kind: 'object', resultKind: 'missing' },
    { label: 'hostile proxy container', value: new Proxy({}, { getPrototypeOf() { throw new Error(secret); }, getOwnPropertyDescriptor() { throw new Error(secret); } }), kind: 'unknown' },
  ];

  for (const specimen of specimens) {
    let aiCalls = 0;
    const response = await worker.handleVisitorAi(request('/vision', {
      body: JSON.stringify({ image: `data:image/webp;base64,${Buffer.from(webp).toString('base64')}` }),
    }), { async run() { aiCalls++; return specimen.value; } }, verifier, fakeImages({ width: 1280, height: 640 }).binding);
    assert.equal(response.status, 503, specimen.label);
    const body = await response.json();
    assert.equal(aiCalls, 1, specimen.label);
    assert.equal(body.vision.stage, 'result_validation', specimen.label);
    assert.equal(body.vision.reason, 'invalid_result', specimen.label);
    assert.ok(body.vision.resultShape, specimen.label);
    specimen.expectShape?.(body.vision.resultShape);
    if (specimen.kind) assert.equal(body.vision.resultShape.rootKind, specimen.kind, specimen.label);
    if (specimen.resultKind) assert.equal(body.vision.resultShape.resultKind, specimen.resultKind, specimen.label);
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE_RESULT_SENTINEL|PRIVATE_STREAM_SENTINEL|arbitrary|answerText/i, specimen.label);
    assert.deepEqual(Object.keys(body).sort(), ['error', 'vision'], specimen.label);
    assert.deepEqual(Object.keys(body.vision.resultShape).sort(), ['direct', 'resultKind', 'rootKind', 'usage', 'wrapped'], specimen.label);
    assert.deepEqual(Object.keys(body.vision.resultShape.usage).sort(), ['completion_tokens', 'kind', 'prompt_tokens'], specimen.label);
  }

  let getterReads = 0;
  const guarded = {};
  Object.defineProperty(guarded, 'answer', { enumerable: true, get() { getterReads++; throw new Error(secret); } });
  const shape = photoCore.inspectVisionResultShape(guarded);
  assert.equal(getterReads, 0, 'shape inspection must not invoke accessors');
  assert.equal(shape.rootKind, 'object');
  assert.equal(shape.direct.answer, 'unknown');
  assert.doesNotMatch(JSON.stringify(shape), /PRIVATE_RESULT_SENTINEL/);

  const hostileProxy = new Proxy({}, {
    getPrototypeOf() { throw new Error(secret); },
    getOwnPropertyDescriptor() { throw new Error(secret); },
  });
  const proxyShape = photoCore.inspectVisionResultShape(hostileProxy);
  assert.equal(proxyShape.rootKind, 'unknown');
  assert.equal(proxyShape.resultKind, 'unknown');
  assert.doesNotMatch(JSON.stringify(proxyShape), /PRIVATE_RESULT_SENTINEL/);
});

test('only a documented structured numeric Workers AI error code is projected', async () => {
  const cases = [
    { name: 'documented structured code', error: { code: 3007, message: 'PRIVATE_CODE_MESSAGE_SENTINEL' }, expected: 3007 },
    { name: 'unknown structured code', error: { code: 999999, message: 'code 3007 PRIVATE_CODE_MESSAGE_SENTINEL' }, expected: undefined },
    { name: 'string code', error: { code: '3007', message: '3007 PRIVATE_CODE_MESSAGE_SENTINEL' }, expected: undefined },
    { name: 'message-only code', error: new Error('Workers AI error 3007 PRIVATE_CODE_MESSAGE_SENTINEL'), expected: undefined },
  ];
  for (const scenario of cases) {
    const response = await worker.handleVisitorAi(request('/vision', {
      body: JSON.stringify({ image: `data:image/webp;base64,${Buffer.from(webp).toString('base64')}` }),
    }), { async run() { throw scenario.error; } }, verifier, fakeImages({ width: 1280, height: 640 }).binding);
    assert.equal(response.status, 503, scenario.name);
    const body = await response.json();
    assert.equal(body.vision.stage, 'binding_call', scenario.name);
    if (scenario.expected === undefined) assert.equal(Object.hasOwn(body.vision, 'providerErrorCode'), false, scenario.name);
    else assert.equal(body.vision.providerErrorCode, scenario.expected, scenario.name);
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE_CODE_MESSAGE_SENTINEL|999999|Workers AI error/i, scenario.name);
  }

  let getterReads = 0;
  const guarded = {};
  Object.defineProperty(guarded, 'code', { enumerable: true, get() { getterReads++; throw new Error('PRIVATE_CODE_GETTER_SENTINEL'); } });
  assert.equal(photoCore.structuredWorkersAiErrorCode(guarded), undefined);
  assert.equal(getterReads, 0, 'structured code extraction must not invoke getters');
});
