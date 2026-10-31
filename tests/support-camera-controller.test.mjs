import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const source = await readFile(path.join(root, 'lib/support-camera-controller.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', js)(specifier => {
  throw new Error(`Unexpected support-camera-controller dependency: ${specifier}`);
}, loaded, loaded.exports);
const { SupportCameraController } = loaded.exports;

function makeStream(trackCount = 1) {
  const tracks = Array.from({ length: trackCount }, () => ({ stopCalls: 0, stop() { this.stopCalls += 1; } }));
  return { stream: { getTracks: () => tracks }, tracks };
}

function makeVideo({ width = 0, height = 0, readyState = 0 } = {}) {
  return {
    videoWidth: width,
    videoHeight: height,
    readyState,
    srcObject: null,
    playCalls: 0,
    async play() { this.playCalls += 1; },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('camera access is opt-in and the default getUserMedia call preserves its receiver and video-only constraints', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const { stream } = makeStream();
  let calls = 0;
  const mediaDevices = {
    getUserMedia(constraints) {
      assert.equal(this, mediaDevices);
      calls += 1;
      assert.deepEqual(constraints, { audio: false, video: { facingMode: { ideal: 'environment' } } });
      return Promise.resolve(stream);
    },
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { mediaDevices } });
  try {
    const controller = new SupportCameraController();
    assert.equal(controller.snapshot().state, 'closed');
    assert.equal(calls, 0, 'construction does not request a camera');
    await controller.open(makeVideo());
    assert.equal(calls, 1);
    assert.equal(controller.snapshot().state, 'preview');
    controller.cancel();
    assert.equal(controller.snapshot().state, 'closed');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete globalThis.navigator;
  }
});

test('unsupported mediaDevices fails closed without a permission request', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: {} });
  try {
    const controller = new SupportCameraController();
    await controller.open(makeVideo());
    assert.deepEqual(controller.snapshot(), {
      state: 'unavailable', error: 'unavailable', ready: false, blob: null,
    });
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete globalThis.navigator;
  }
});

test('explicit preview is not capture-ready until video metadata has usable dimensions', async () => {
  const { stream } = makeStream();
  const video = makeVideo();
  const controller = new SupportCameraController({
    getUserMedia: async constraints => {
      assert.deepEqual(constraints, { audio: false, video: { facingMode: { ideal: 'environment' } } });
      return stream;
    },
    capture: async () => new Blob(['jpeg'], { type: 'image/jpeg' }),
  });
  controller.setReady();
  assert.equal(controller.snapshot().state, 'closed');
  await controller.open(video);
  assert.equal(video.srcObject, stream);
  assert.equal(video.playCalls, 1);
  assert.equal(controller.snapshot().state, 'preview');
  assert.equal(controller.snapshot().ready, false);
  video.videoWidth = 1280;
  video.videoHeight = 720;
  video.readyState = 2;
  controller.setReady();
  assert.equal(controller.snapshot().ready, true);
  controller.cancel();
});

test('permission denial and missing camera map to fixed safe errors without raw details', async () => {
  const denied = new SupportCameraController({
    getUserMedia: async () => { const error = new Error('sensitive device diagnostic'); error.name = 'NotAllowedError'; throw error; },
    capture: async () => new Blob(),
  });
  await denied.open(makeVideo());
  assert.deepEqual(denied.snapshot(), { state: 'unavailable', error: 'permission_denied', ready: false, blob: null });
  assert.doesNotMatch(JSON.stringify(denied.snapshot()), /sensitive device diagnostic/);

  const missing = new SupportCameraController({
    getUserMedia: async () => { const error = new Error('camera serial SHOULD NEVER ESCAPE'); error.name = 'NotFoundError'; throw error; },
    capture: async () => new Blob(),
  });
  await missing.open(makeVideo());
  assert.deepEqual(missing.snapshot(), { state: 'unavailable', error: 'unavailable', ready: false, blob: null });
  assert.doesNotMatch(JSON.stringify(missing.snapshot()), /camera serial/);
});

test('capture is explicit, yields a JPEG blob, and releases every stream track', async () => {
  const { stream, tracks } = makeStream(2);
  const video = makeVideo({ width: 2560, height: 1440, readyState: 4 });
  let captureCalls = 0;
  const controller = new SupportCameraController({
    getUserMedia: async () => stream,
    capture: async actualVideo => {
      captureCalls += 1;
      assert.equal(actualVideo, video);
      return new Blob([new Uint8Array(1024)], { type: 'image/jpeg' });
    },
  });
  await controller.open(video);
  assert.equal(captureCalls, 0, 'opening the preview does not capture');
  controller.setReady();
  await controller.capture();
  assert.equal(captureCalls, 1);
  assert.equal(controller.snapshot().state, 'captured');
  assert.equal(controller.snapshot().blob.type, 'image/jpeg');
  assert.ok(controller.snapshot().blob.size <= 5 * 1024 * 1024);
  assert.deepEqual(tracks.map(track => track.stopCalls), [1, 1]);
  assert.equal(video.srcObject, null);
});

test('default canvas capture limits the longest edge to 1280px and emits JPEG', async () => {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const { stream, tracks } = makeStream();
  let canvas;
  let drawArguments;
  let blobArguments;
  const mediaDevices = { getUserMedia: async () => stream };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { mediaDevices } });
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: {
    createElement(name) {
      assert.equal(name, 'canvas');
      canvas = {
        width: 0, height: 0,
        getContext(kind) {
          assert.equal(kind, '2d');
          return { drawImage(...args) { drawArguments = args; } };
        },
        toBlob(callback, type, quality) {
          blobArguments = { type, quality, width: this.width, height: this.height };
          callback(new Blob([new Uint8Array(100)], { type }));
        },
      };
      return canvas;
    },
  } });
  try {
    const video = makeVideo({ width: 2560, height: 1440, readyState: 2 });
    const controller = new SupportCameraController();
    await controller.open(video);
    controller.setReady();
    await controller.capture();
    assert.equal(controller.snapshot().state, 'captured');
    assert.equal(controller.snapshot().blob.type, 'image/jpeg');
    assert.deepEqual(blobArguments, { type: 'image/jpeg', quality: 0.86, width: 1280, height: 720 });
    assert.deepEqual(drawArguments.slice(1), [0, 0, 1280, 720]);
    assert.deepEqual([canvas.width, canvas.height], [0, 0], 'the canvas is cleared after encoding');
    assert.equal(tracks[0].stopCalls, 1);
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete globalThis.navigator;
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete globalThis.document;
  }
});

test('an oversized camera JPEG is discarded with a fixed error and no blob escapes', async () => {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const { stream, tracks } = makeStream();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: {
    mediaDevices: { getUserMedia: async () => stream },
  } });
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: {
    createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({ drawImage() {} }),
      toBlob(callback, type) { callback(new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type })); },
    }),
  } });
  try {
    const controller = new SupportCameraController();
    await controller.open(makeVideo({ width: 1280, height: 720, readyState: 2 }));
    controller.setReady();
    await controller.capture();
    assert.deepEqual(controller.snapshot(), {
      state: 'unavailable', error: 'capture_failed', ready: false, blob: null,
    });
    assert.equal(tracks[0].stopCalls, 1);
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete globalThis.navigator;
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete globalThis.document;
  }
});

test('cancel during a pending permission request stops a late stream and never reopens preview', async () => {
  const pending = deferred();
  const { stream, tracks } = makeStream(2);
  const video = makeVideo();
  const controller = new SupportCameraController({ getUserMedia: () => pending.promise, capture: async () => new Blob() });
  const opening = controller.open(video);
  assert.equal(controller.snapshot().state, 'requesting');
  controller.cancel();
  pending.resolve(stream);
  await opening;
  assert.equal(controller.snapshot().state, 'closed');
  assert.deepEqual(tracks.map(track => track.stopCalls), [1, 1]);
  assert.equal(video.srcObject, null);
});

test('cancel during asynchronous canvas capture discards the late blob', async () => {
  const capturePending = deferred();
  const { stream, tracks } = makeStream();
  const video = makeVideo({ width: 640, height: 480, readyState: 2 });
  const controller = new SupportCameraController({ getUserMedia: async () => stream, capture: () => capturePending.promise });
  await controller.open(video);
  controller.setReady();
  const capturing = controller.capture();
  controller.cancel();
  capturePending.resolve(new Blob(['late image'], { type: 'image/jpeg' }));
  await capturing;
  assert.deepEqual(controller.snapshot(), { state: 'closed', error: null, ready: false, blob: null });
  assert.deepEqual(tracks.map(track => track.stopCalls), [1]);
  assert.equal(video.srcObject, null);
});

test('the video frame is drawn and every stream track stops before JPEG encoding completes', async () => {
  const capturePending = deferred();
  const { stream, tracks } = makeStream(2);
  const video = makeVideo({ width: 1280, height: 720, readyState: 2 });
  let frameDrawn = false;
  const controller = new SupportCameraController({
    getUserMedia: async () => stream,
    capture: (_video, onFrameDrawn) => {
      frameDrawn = true;
      onFrameDrawn();
      return capturePending.promise;
    },
  });
  await controller.open(video);
  controller.setReady();
  const capturing = controller.capture();
  assert.equal(frameDrawn, true);
  assert.deepEqual(tracks.map(track => track.stopCalls), [1, 1], 'camera tracks stop before encoding returns');
  assert.equal(video.srcObject, null);
  capturePending.resolve(new Blob(['jpeg'], { type: 'image/jpeg' }));
  await capturing;
  assert.equal(controller.snapshot().state, 'captured');
  assert.equal(controller.snapshot().blob.type, 'image/jpeg');
});

test('cancel and dispose are idempotent, release the preview, and do not restart capture', async () => {
  const { stream, tracks } = makeStream();
  const video = makeVideo({ width: 1280, height: 720, readyState: 2 });
  let mediaRequests = 0;
  const controller = new SupportCameraController({
    getUserMedia: async () => { mediaRequests += 1; return stream; },
    capture: async () => new Blob(['jpeg'], { type: 'image/jpeg' }),
  });
  await controller.open(video);
  controller.setReady();
  controller.cancel();
  controller.cancel();
  assert.equal(video.srcObject, null);
  assert.equal(controller.snapshot().state, 'closed');
  assert.equal(tracks[0].stopCalls, 1);
  controller.dispose();
  await Promise.resolve();
  assert.equal(mediaRequests, 1);
  assert.equal(controller.snapshot().state, 'closed');
});
