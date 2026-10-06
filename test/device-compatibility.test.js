import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceCompatibilityLayer } from '../src/device-compatibility.js';
import { createLocalDataStore } from '../src/local-data-store.js';
import { CameraController } from '../src/camera-controller.js';

function environment({ mediaDevices = true, secure = true, permission = 'granted', constraints = allConstraints(), cores = 8, memory = 8, webgl = true, webgpu = false, wasm = true } = {}) {
  let getUserMediaRequests = 0;
  const trackSupport = mediaDevices ? {
    getUserMedia: async () => { getUserMediaRequests++; },
    getSupportedConstraints: () => constraints,
    enumerateDevices: async () => [{ kind: 'videoinput', deviceId: 'camera-private-id', label: 'Rear camera' }],
  } : null;
  const nav = {
    mediaDevices: trackSupport,
    permissions: { query: async () => ({ state: permission }) },
    hardwareConcurrency: cores,
    deviceMemory: memory,
    userAgent: 'TestBrowser/1.0',
    ...(webgpu ? { gpu: { requestAdapter: async () => ({}) } } : {}),
  };
  const windowObject = {
    isSecureContext: secure,
    Worker: class Worker {}, createImageBitmap() {}, requestAnimationFrame() {}, cancelAnimationFrame() {},
    ...(wasm ? { WebAssembly: {} } : {}),
    screen: { orientation: { type: 'portrait-primary', angle: 0 } },
  };
  const documentObject = { createElement: () => ({ getContext: kind => kind === '2d' || (webgl && (kind === 'webgl2' || kind === 'webgl')) ? { getExtension: () => ({ loseContext() {} }) } : null }) };
  return { navigatorObject: nav, windowObject, documentObject, getUserMediaRequests: () => getUserMediaRequests };
}
function allConstraints() { return { facingMode: true, width: true, height: true, frameRate: true }; }
function storeStub(available = true) { return { setSessionValue() {}, async getStorageAvailability() { return { available, backend: available ? 'IndexedDB' : null, localOnly: true }; } }; }
function readyCamera({ width = 1280, height = 720, facingMode = 'environment', torch = true, focus = true, errorCode = null } = {}) {
  return {
    status: 'ready', previewReady: true, errorCode,
    actualResolution: { width, height }, activeFacingMode: facingMode, facingModeFallback: false,
    cameras: [{ deviceId: 'private', label: 'camera' }], torchSupported: torch,
    capabilities: { ...(torch ? { torch: true } : {}), ...(focus ? { focusMode: ['continuous'], focusDistance: { min: 0, max: 1 }, exposureCompensation: { min: -1, max: 1 }, zoom: { min: 1, max: 3 } } : {}), frameRate: { min: 15, max: 30 } },
    settings: { width, height },
  };
}
const wasmModel = { runtime: 'wasm' };

test('reports supported when required browser APIs, an active rear camera, storage, and declared runtime are available', async () => {
  const env = environment({ webgl: false, webgpu: false });
  const layer = createDeviceCompatibilityLayer({ ...env, localDataStore: storeStub(), modelSpec: wasmModel });
  const result = await layer.assess({ cameraSnapshot: readyCamera() });
  assert.equal(env.getUserMediaRequests(), 0, 'preflight must not prompt for or request camera access');
  assert.equal(result.status, 'SUPPORTED');
  assert.equal(result.camera.rearCamera.available, true);
  assert.equal(result.optional.torch.available, true);
  assert.deepEqual(result.camera.frameRate.range, { min: 15, max: 30 });
  assert.deepEqual(result.camera.resolution.capabilityRange, { width: null, height: null });
  assert.equal(result.compute.modelRuntime.runtime, 'wasm');
  assert.equal(result.compute.webgl.available, false);
  assert.equal(result.compute.webgpu.available, false);
  assert.equal(result.configuration.processing.resolution, 'native-camera-frame-for-capture');
});

test('camera unavailable after permission is unsupported and gives a browser-actionable recommendation', async () => {
  const env = environment();
  const result = await createDeviceCompatibilityLayer({ ...env, localDataStore: storeStub(), modelSpec: wasmModel }).assess({ cameraSnapshot: { status: 'error', errorCode: 'NotFoundError', error: 'No camera found.' } });
  assert.equal(result.status, 'UNSUPPORTED');
  assert.equal(result.camera.availability, 'UNAVAILABLE');
  assert.ok(result.recommendations.some(item => /camera/i.test(item)));
});

test('rear camera and torch remain unknown before permission and unsupported controls never become fake capabilities', async () => {
  const env = environment({ constraints: { facingMode: true } });
  const layer = createDeviceCompatibilityLayer({ ...env, localDataStore: storeStub(), modelSpec: wasmModel });
  const before = await layer.assess();
  assert.equal(before.camera.rearCamera.available, null);
  assert.equal(before.torch.available, null);
  assert.deepEqual(before.camera.controls, { focus: false, exposure: false, zoom: false, frameRate: null });
  const after = await layer.assess({ cameraSnapshot: readyCamera({ facingMode: 'user', torch: false, focus: false }) });
  assert.equal(after.camera.rearCamera.available, false);
  assert.equal(after.torch.available, false);
  assert.equal(after.optional.zoom.available, false);
});

test('selects only browser-supported camera constraints and preserves the full frame', async () => {
  const env = environment({ constraints: { width: true, frameRate: true } });
  const layer = createDeviceCompatibilityLayer({ ...env, localDataStore: storeStub(), modelSpec: wasmModel });
  const result = await layer.assess();
  assert.deepEqual(result.configuration.cameraConstraints, { width: { ideal: 1280 }, frameRate: { ideal: 24, max: 30 } });
  assert.equal('facingMode' in result.configuration.cameraConstraints, false);
  assert.equal('height' in result.configuration.cameraConstraints, false);
  assert.equal(result.configuration.cameraSelectionSupported, false);
});

test('low-resolution preview is limited, not declared clinically inadequate; no configured minimum is invented', async () => {
  const env = environment();
  const result = await createDeviceCompatibilityLayer({ ...env, localDataStore: storeStub(), modelSpec: wasmModel }).assess({ cameraSnapshot: readyCamera({ width: 640, height: 480 }) });
  assert.equal(result.status, 'LIMITED');
  assert.equal(result.camera.resolution.status, 'below-requested');
  assert.match(result.camera.resolution.message, /model-specific minimum resolution is not configured/);
});

test('optional GPU, torch and advanced-control absence leaves supported APIs usable when WASM is declared', async () => {
  const env = environment({ webgl: false, webgpu: false, constraints: { width: true, height: true, frameRate: true, facingMode: true } });
  const result = await createDeviceCompatibilityLayer({ ...env, localDataStore: storeStub(), modelSpec: wasmModel }).assess({ cameraSnapshot: readyCamera({ torch: false, focus: false }) });
  assert.equal(result.compute.webgl.available, false);
  assert.equal(result.compute.webgpu.available, false);
  assert.equal(result.configuration.modelRuntime.runtime, 'wasm');
  assert.equal(result.required.canvas2d.available, true);
  assert.equal(result.status, 'LIMITED');
});

test('unavailable required browser APIs and insecure origins fail closed', async t => {
  await t.test('camera API missing', async () => {
    const env = environment({ mediaDevices: false });
    const result = await createDeviceCompatibilityLayer({ ...env, localDataStore: storeStub(), modelSpec: wasmModel }).assess();
    assert.equal(result.status, 'UNSUPPORTED');
    assert.equal(result.required.cameraApi.available, false);
  });
  await t.test('insecure context', async () => {
    const env = environment({ secure: false });
    const result = await createDeviceCompatibilityLayer({ ...env, localDataStore: storeStub(), modelSpec: wasmModel }).assess();
    assert.equal(result.status, 'UNSUPPORTED');
    assert.ok(result.recommendations.some(item => /https|localhost/i.test(item)));
  });
  await t.test('permission denied', async () => {
    const env = environment({ permission: 'denied' });
    const result = await createDeviceCompatibilityLayer({ ...env, localDataStore: storeStub(), modelSpec: wasmModel }).assess();
    assert.equal(result.status, 'LIMITED');
    assert.ok(result.recommendations.some(item => /permission/i.test(item)));
  });
  for (const missing of ['Worker', 'createImageBitmap', 'requestAnimationFrame', 'WebAssembly']) await t.test(`${missing} missing`, async () => {
    const env = environment(); delete env.windowObject[missing];
    const result = await createDeviceCompatibilityLayer({ ...env, localDataStore: storeStub(), modelSpec: wasmModel }).assess();
    assert.equal(result.status, 'UNSUPPORTED');
  });
  await t.test('2D canvas missing', async () => {
    const env = environment(); env.documentObject.createElement = () => ({ getContext: () => null });
    const result = await createDeviceCompatibilityLayer({ ...env, localDataStore: storeStub(), modelSpec: wasmModel }).assess();
    assert.equal(result.required.canvas2d.available, false);
    assert.equal(result.status, 'UNSUPPORTED');
  });
});

test('missing WebGL and WebGPU is not a failure unless a selected local model requires one', async () => {
  const env = environment({ webgl: false, webgpu: false });
  const result = await createDeviceCompatibilityLayer({ ...env, localDataStore: storeStub(), modelSpec: { runtime: 'webgpu' } }).assess({ cameraSnapshot: readyCamera() });
  assert.equal(result.status, 'LIMITED');
  assert.equal(result.configuration.modelRuntime.available, false);
  assert.equal(result.configuration.modelRuntime.runtime, null);
  assert.ok(result.limitations.some(item => /requires WebGPU/i.test(item)));
});

test('missing local storage is reported but does not make camera/cv APIs unsupported', async () => {
  const env = environment();
  const result = await createDeviceCompatibilityLayer({ ...env, localDataStore: storeStub(false), modelSpec: wasmModel }).assess({ cameraSnapshot: readyCamera() });
  assert.equal(result.storage.available, false);
  assert.equal(result.status, 'LIMITED');
  assert.equal(result.supported, true);
});

test('low-resource hints adapt processing frequency only and do not lower camera dimensions', async () => {
  const env = environment({ cores: 2, memory: 2 });
  const result = await createDeviceCompatibilityLayer({ ...env, localDataStore: storeStub(), modelSpec: wasmModel }).assess();
  assert.equal(result.configuration.processing.intervalMs, 300);
  assert.equal(result.configuration.qualitySampleIntervalMs, 1000);
  assert.equal(result.configuration.processing.resolution, 'native-camera-frame-for-capture');
});

test('Component 2 consumes capability-selected constraints and Component 16 stores only the in-memory compatibility summary', async () => {
  const env = environment({ constraints: { facingMode: true, width: true, height: true } });
  const idb = {
    open() { throw new Error('storage not needed to save compatibility'); },
  };
  const localDataStore = createLocalDataStore({ indexedDB: idb });
  const layer = createDeviceCompatibilityLayer({ ...env, localDataStore, modelSpec: wasmModel });
  const result = await layer.assess();
  assert.equal(localDataStore.getSessionValue('compatibilityResult').schemaVersion, result.schemaVersion);
  const calls = [];
  const track = { getSettings: () => ({ deviceId: 'ephemeral', facingMode: 'environment', width: 1280, height: 720 }), getCapabilities: () => ({}), addEventListener() {}, stop() {} };
  const video = { videoWidth: 1280, videoHeight: 720, addEventListener() {}, removeEventListener() {}, async play() {}, pause() {}, srcObject: null };
  const controller = new CameraController({ video, secureContext: true, mediaDevices: { getUserMedia: async constraints => { calls.push(constraints); return { getVideoTracks: () => [track], getTracks: () => [track] }; }, enumerateDevices: async () => [] }, config: { videoConstraints: layer.cameraConfiguration(), metadataTimeoutMs: 10 } });
  await controller.startCamera();
  assert.deepEqual(calls[0].video, result.configuration.cameraConstraints);
});

test('Component 9 receives no runtime fallback without a declared model and uses only a matching runtime', async () => {
  const env = environment({ webgpu: true });
  const noModel = await createDeviceCompatibilityLayer({ ...env, localDataStore: storeStub() }).assess();
  const model = await createDeviceCompatibilityLayer({ ...env, localDataStore: storeStub(), modelSpec: { runtime: 'webgpu' } }).assess();
  assert.deepEqual(noModel.compute.modelRuntime, { available: false, runtime: null, reason: 'No trained Component 9 prediction model is configured in this project.' });
  assert.equal(model.compute.modelRuntime.available, true);
  assert.equal(model.compute.modelRuntime.runtime, 'webgpu');
  assert.equal(model.configuration.fallback.compute.includes('incompatible backend'), true);
});
