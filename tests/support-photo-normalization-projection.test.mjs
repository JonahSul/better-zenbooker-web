import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
async function loadTs(relativePath, imports) {
  const source = await readFile(path.join(root, relativePath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)(specifier => {
    if (Object.hasOwn(imports, specifier)) return imports[specifier];
    if (specifier === 'zod/v3') return require(specifier);
    throw new Error(`Unexpected support-proxy dependency: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports;
}

const photoCore = await loadTs('lib/support-photo-core.ts', {});
const supportCore = await loadTs('lib/support-core.ts', {});
const worker = await loadTs('integrations/visitor-ai/worker.ts', {
  '../../lib/support-core': supportCore,
  '../../lib/support-photo-core': photoCore,
});
const photoTestModules = new Set(['ai', 'photos', 'visitor_support']);
async function assertTestModule(runtime, module) {
  if (!runtime?.qaEnabledModules?.has(module)) throw new Error(`Module ${module} disabled in photo projection fixture`);
}
const moduleGuard = {
  assertModule: assertTestModule,
  async assertAi(runtime, module) {
    await assertTestModule(runtime, 'ai');
    if (module !== 'ai') await assertTestModule(runtime, module);
  },
};
const proxyModule = await loadTs('lib/support-proxy.ts', {
  './support-photo-core': photoCore,
  'cloudflare:workers': { env: {} },
  './module-config': moduleGuard,
  '../integrations/visitor-ai/worker': worker,
  './support-schedule': { SupportScheduleStore: class {} },
  './encrypted-value': { validEncryptionKey: () => true, decryptValue: async () => '22'.repeat(32) },
  '../integrations/zenbooker-bridge/core': { capabilityVerifier: async () => 'a'.repeat(64) },
  './support-core': {
    SUPPORT_MODEL: 'fixture-model', SUPPORT_PROXY_ORIGIN: 'https://visitor-ai.test',
    normalizeSupportModelResult: value => value, supportConfigInput: require('zod/v3').z.object({}), requestKeySchema: require('zod/v3').z.string(),
  },
});
const png = Uint8Array.from(Buffer.from(photoCore.PHOTO_DIAGNOSTIC_PNG_BASE64, 'base64'));
function diagnosticWebp() {
  const payload = Uint8Array.from([1, 2, 3, 4]);
  const bytes = new Uint8Array(12 + 8 + payload.length);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  bytes.set(new TextEncoder().encode('WEBP'), 8);
  bytes.set(new TextEncoder().encode('VP8 '), 12);
  new DataView(bytes.buffer).setUint32(16, payload.length, true);
  bytes.set(payload, 20);
  return bytes;
}

function proxyFor(response) {
  const calls = [];
  const row = { workspace_id: 'fixture-workspace', revision: 1, credential_json: 'sealed-fixture', verifier: 'a'.repeat(64), config_json: '{}' };
  const store = {
    workspaceId: 'fixture-workspace', key: 'fixture-key', now: () => 1_800_000_000_000,
    statement(sql) {
      return {
        async first() {
          if (sql.startsWith('SELECT * FROM support_proxy_state')) return row;
          if (sql.startsWith('INSERT INTO app_credential_attempts')) return { attempts: 1 };
          assert.fail(`Unexpected query in normalization projection test: ${sql}`);
        },
      };
    },
  };
  const instance = new proxyModule.SupportProxy(store, 'https://visitor-ai.test', fetch, () => true, {
    qaEnabledModules: photoTestModules,
    AI: { run: async () => { throw new Error('unexpected provider binding call'); } },
  });
  instance.transport = async (url, init) => {
    await assertTestModule(instance.runtime, new URL(String(url)).pathname === '/images/normalize' ? 'photos' : 'visitor_support');
    calls.push({ url: String(url), init });
    return typeof response === 'function' ? response(url, init) : response;
  };
  return { instance, calls, store };
}

test('Site-side photo normalization projects only fixed diagnostic fields and never calls vision', async () => {
  const body = {
    error: 'Photo normalization unavailable',
    normalization: { stage: 'inputinspection', reason: 'processing_failed', httpStatus: 400 },
    provider_error: 'PRIVATE_PROVIDER_SENTINEL',
    message: 'PRIVATE_IMAGE_BODY_SENTINEL',
  };
  const { instance, calls } = proxyFor(Response.json(body, { status: 503 }));
  await assert.rejects(instance.normalizePhoto(png, 'image/png'), error => {
    assert.equal(error.name, 'PhotoNormalizationError');
    assert.deepEqual(error.diagnostic, { stage: 'inputinspection', reason: 'processing_failed', httpStatus: 503 });
    assert.doesNotMatch(error.message + JSON.stringify(error.diagnostic), /PRIVATE_PROVIDER_SENTINEL|PRIVATE_IMAGE_BODY_SENTINEL/);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://visitor-ai.test/images/normalize');

  const { instance: malformed, calls: malformedCalls } = proxyFor(Response.json({
    normalization: { stage: 'inputinspection', reason: 'processing_failed', httpStatus: 503, detail: 'PRIVATE_DETAIL_SENTINEL' },
  }, { status: 503 }));
  await assert.rejects(malformed.normalizePhoto(png, 'image/png'), error => {
    assert.notEqual(error.name, 'PhotoNormalizationError');
    assert.doesNotMatch(error.message, /PRIVATE_DETAIL_SENTINEL|PRIVATE_PROVIDER_SENTINEL/);
    return true;
  });
  assert.equal(malformedCalls.length, 1);
  assert.ok(malformedCalls.every(call => !call.url.endsWith('/vision')));
});

test('Site vision projection preserves only typed Worker diagnostics and distinguishes transport failure', async () => {
  const typed = {
    error: 'Vision outcome unavailable',
    vision: { stage: 'result_validation', reason: 'invalid_result', httpStatus: 400, bindingInvoked: true, bindingReturned: true },
    provider_error: 'PRIVATE_PROVIDER_SENTINEL',
    raw_body: 'PRIVATE_IMAGE_BODY_SENTINEL',
  };
  const { instance, calls } = proxyFor(Response.json(typed, { status: 503 }));
  let requestStarted = false;
  await assert.rejects(instance.vision(Uint8Array.from([1, 2, 3]), () => { requestStarted = true; }, true), error => {
    assert.equal(error.name, 'VisionPathError');
    assert.equal(error.diagnostic.sitePhase, 'response_validation');
    assert.deepEqual(error.diagnostic.vision, {
      stage: 'result_validation', reason: 'invalid_result', httpStatus: 503, bindingInvoked: true, bindingReturned: true,
    });
    assert.equal(error.diagnostic.modelResponseValidated, false);
    assert.equal(error.diagnostic.usagePersisted, null);
    assert.doesNotMatch(error.message + JSON.stringify(error.diagnostic), /PRIVATE_PROVIDER_SENTINEL|PRIVATE_IMAGE_BODY_SENTINEL/);
    return true;
  });
  assert.equal(requestStarted, true, 'this marker means the Site started a proxy fetch, not that AI billing occurred');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://visitor-ai.test/vision');

  const { instance: malformed, calls: malformedCalls } = proxyFor(Response.json({
    vision: { stage: 'binding_call', reason: 'binding_failed', httpStatus: 503, bindingInvoked: true, bindingReturned: false, details: 'PRIVATE_DETAIL_SENTINEL' },
  }, { status: 503 }));
  await assert.rejects(malformed.vision(Uint8Array.from([1, 2, 3]), undefined, true), error => {
    assert.equal(error.name, 'VisionPathError');
    assert.equal(error.diagnostic.sitePhase, 'response_validation');
    assert.equal(error.diagnostic.vision, undefined, 'malformed strict evidence remains unknown');
    assert.equal(error.diagnostic.modelResponseValidated, null);
    assert.equal(error.diagnostic.usagePersisted, null);
    assert.doesNotMatch(error.message + JSON.stringify(error.diagnostic), /PRIVATE_DETAIL_SENTINEL/);
    return true;
  });
  assert.equal(malformedCalls.length, 1);

  const { instance: transport, calls: transportCalls } = proxyFor(async () => { throw new Error('PRIVATE_TRANSPORT_SENTINEL'); });
  await assert.rejects(transport.vision(Uint8Array.from([1, 2, 3]), undefined, true), error => {
    assert.equal(error.name, 'VisionPathError');
    assert.equal(error.diagnostic.sitePhase, 'transport');
    assert.equal(error.diagnostic.vision, undefined);
    assert.equal(error.diagnostic.modelResponseValidated, null);
    assert.equal(error.diagnostic.usagePersisted, null);
    assert.doesNotMatch(error.message + JSON.stringify(error.diagnostic), /PRIVATE_TRANSPORT_SENTINEL/);
    return true;
  });
  assert.equal(transportCalls.length, 1);

  const originalTimeout = AbortSignal.timeout;
  try {
    AbortSignal.timeout = () => ({ aborted: true });
    const { instance: timedOut, calls: timeoutCalls } = proxyFor(async () => { throw new Error('PRIVATE_ABORT_SENTINEL'); });
    await assert.rejects(timedOut.vision(Uint8Array.from([1, 2, 3]), undefined, true), error => {
      assert.equal(error.name, 'VisionPathError');
      assert.equal(error.diagnostic.sitePhase, 'timeout', 'timeout is based on the actual abort signal state');
      assert.equal(error.diagnostic.modelResponseValidated, null);
      assert.equal(error.diagnostic.usagePersisted, null);
      assert.doesNotMatch(error.message + JSON.stringify(error.diagnostic), /PRIVATE_ABORT_SENTINEL/);
      return true;
    });
    assert.equal(timeoutCalls.length, 1);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test('validated vision response remains distinct from failed budget-usage persistence', async () => {
  const { instance, store } = proxyFor(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
  const row = { workspace_id: 'fixture-workspace', revision: 2, config_json: '{}' };
  instance.row = async () => row;
  instance.normalizePhoto = async () => ({ bytes: Uint8Array.from([1, 2, 3]), width: 1, height: 1 });
  instance.reserveSystemCall = async () => 'fixture-call';
  let outcomes = 0;
  store.callOutcome = async (_id, status) => { outcomes++; assert.equal(status, 'complete'); throw new Error('PRIVATE_D1_WRITE_SENTINEL'); };
  instance.vision = async (_bytes, onAttempt) => {
    onAttempt?.();
    return {
      observation: 'A visible valve box.', usage: { inputTokens: 2, outputTokens: 3 },
      vision: { stage: 'result_validation', reason: 'validated', httpStatus: 200, bindingInvoked: true, bindingReturned: true },
    };
  };

  await assert.rejects(instance.checkPhotos('fixture-owner'), error => {
    assert.equal(error.name, 'VisionPathError');
    assert.equal(error.diagnostic.sitePhase, 'usage_persistence');
    assert.deepEqual(error.diagnostic.vision, {
      stage: 'result_validation', reason: 'validated', httpStatus: 200, bindingInvoked: true, bindingReturned: true,
    });
    assert.equal(error.diagnostic.modelResponseValidated, true);
    assert.equal(error.diagnostic.usagePersisted, null);
    assert.doesNotMatch(error.message + JSON.stringify(error.diagnostic), /PRIVATE_D1_WRITE_SENTINEL/);
    return true;
  });
  assert.equal(outcomes, 1, 'a failed completion write must not be overwritten with an unknown usage update');
});

test('wrapped null-caption answer survives Worker response projection and Site normalization', async () => {
  const token = '22'.repeat(32);
  const verifier = createHash('sha256').update(token).digest('hex');
  let aiCalls = 0;
  const ai = { async run() {
    aiCalls++;
    return {
      result: { answer: 'Visible demo equipment.', caption: null, metrics: { input_tokens: 7, output_tokens: 3 }, finish_reason: 'stop' },
      usage: { prompt_tokens: 99, completion_tokens: 99 },
    };
  } };
  const images = { async info() { return { width: 1, height: 1, format: 'webp' }; } };
  const { instance, calls } = proxyFor(async (url, init) => worker.handleVisitorAi(new Request(String(url), init), ai, verifier, images));
  const response = await instance.vision(diagnosticWebp(), undefined, true);
  assert.equal(response.observation, 'Visible demo equipment.');
  assert.deepEqual(response.usage, { inputTokens: 7, outputTokens: 3 }, 'normalized response metrics are preserved through both boundaries');
  assert.deepEqual(response.vision, { stage: 'result_validation', reason: 'validated', httpStatus: 200, bindingInvoked: true, bindingReturned: true });
  assert.equal(aiCalls, 1);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(JSON.stringify(response), /caption|99/);
});
