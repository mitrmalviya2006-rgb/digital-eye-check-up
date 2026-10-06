import { POSITIONING_CONFIG } from './positioning-config.js';

export const DEVICE_COMPATIBILITY_VERSION = '1.0.0';

const DEFAULT_POLICY = Object.freeze({
  camera: Object.freeze({ width: 1280, height: 720, frameRate: 24, maxFrameRate: 30 }),
  lowCoreCount: 2,
  lowMemoryGiB: 2,
  lowResourceIntervalMs: 300,
  supportedIntervalMs: POSITIONING_CONFIG.processIntervalMs,
});

/**
 * Component 17 capability boundary. Detection is API/evidence based. It never
 * requests camera permission, stores device identifiers, or infers hardware
 * from a phone model. Stream-only capabilities are reconciled after C2 starts.
 */
export function createDeviceCompatibilityLayer({
  navigatorObject = globalThis.navigator,
  windowObject = globalThis.window,
  documentObject = globalThis.document,
  localDataStore = null,
  modelSpec = null,
  policy = {},
} = {}) {
  const configuredPolicy = {
    ...DEFAULT_POLICY,
    ...policy,
    camera: { ...DEFAULT_POLICY.camera, ...(policy.camera || {}) },
  };
  let latest = null;

  async function assess({ cameraSnapshot = null } = {}) {
    const nav = navigatorObject || {};
    const win = windowObject || {};
    const doc = documentObject || {};
    const secureContext = win.isSecureContext ?? globalThis.isSecureContext ?? false;
    const supportedConstraints = safeCall(() => nav.mediaDevices?.getSupportedConstraints?.(), {}) || {};
    const permission = await readCameraPermission(nav.permissions);
    const canvas = inspectCanvas(doc);
    const compute = await inspectCompute(nav, doc, win, modelSpec);
    const storage = await readStorage(localDataStore);
    const constraints = cameraConstraints(supportedConstraints, configuredPolicy.camera);
    const camera = inspectCamera(nav, permission, supportedConstraints, cameraSnapshot, configuredPolicy.camera);
    const required = {
      secureContext: capability(Boolean(secureContext), true, secureContext ? 'Secure context available.' : 'Camera access requires HTTPS or localhost.'),
      cameraApi: capability(Boolean(nav.mediaDevices?.getUserMedia), true, nav.mediaDevices?.getUserMedia ? 'Browser camera API is present; physical camera is checked when permission is granted.' : 'This browser does not expose camera capture.'),
      moduleWorker: capability(typeof win.Worker === 'function', true, 'Positioning runs in a local module worker.'),
      transferableBitmap: capability(typeof win.createImageBitmap === 'function', true, 'The camera pipeline requires transferable image bitmaps.'),
      animationFrame: capability(typeof win.requestAnimationFrame === 'function', true, 'The camera pipeline uses animation-frame scheduling.'),
      webAssembly: capability(typeof win.WebAssembly === 'object', true, 'The current positioning runtime requires WebAssembly.'),
      canvas2d: capability(canvas.twoD, true, canvas.twoD ? '2D canvas processing is available.' : 'Local image-quality and preprocessing steps need a 2D canvas.'),
    };
    const optional = {
      rearCamera: capability(camera.rearCamera.available, false, camera.rearCamera.message),
      torch: capability(camera.torch.available, false, camera.torch.message),
      focus: capability(camera.controls.focus, false, 'Focus controls are available only when exposed by the active camera track.'),
      exposure: capability(camera.controls.exposure, false, 'Exposure controls are available only when exposed by the active camera track.'),
      zoom: capability(camera.controls.zoom, false, 'Zoom controls are available only when exposed by the active camera track.'),
      resolution: capability(camera.resolution.status === 'meets-requested', false, camera.resolution.message),
      orientation: capability(Boolean(win.screen?.orientation || 'ondeviceorientation' in win), false, 'Orientation APIs provide hints only; they do not establish camera suitability.'),
      webgl: capability(compute.webgl.available, false, compute.webgl.reason),
      webgpu: capability(compute.webgpu.available, false, compute.webgpu.reason),
      offscreenCanvas: capability(typeof win.OffscreenCanvas === 'function', false, 'OffscreenCanvas is an optional optimization.'),
      storage: capability(storage.available, false, storage.available ? 'Component 16 local IndexedDB is available.' : 'Local history/settings storage is unavailable or restricted.'),
    };

    const requiredFailures = Object.entries(required).filter(([, entry]) => entry.available === false).map(([key]) => key);
    const cameraUnavailable = camera.availability === 'UNAVAILABLE' && cameraSnapshot?.errorCode === 'NotFoundError';
    const permissionNeedsAction = camera.permission === 'denied' || camera.availability === 'UNAVAILABLE';
    const meaningfulOptionalLimit = ['rearCamera', 'torch', 'resolution', 'storage'].some(key => optional[key].available !== true);
    const status = requiredFailures.length || cameraUnavailable ? 'UNSUPPORTED'
      : (camera.availability !== 'AVAILABLE' || permissionNeedsAction || meaningfulOptionalLimit || !compute.modelRuntime.available ? 'LIMITED' : 'SUPPORTED');
    const limitations = [];
    const recommendations = [];
    if (!secureContext) recommendations.push('Open this site over HTTPS or use localhost.');
    if (!required.cameraApi.available) recommendations.push('Use a current browser with camera access support.');
    if (camera.permission === 'denied') recommendations.push('Allow camera permission in browser settings, then retry.');
    if (camera.availability === 'UNAVAILABLE' && camera.permission !== 'denied') recommendations.push('Connect or enable a camera, close apps that may be using it, or try another supported camera.');
    if (camera.availability === 'UNKNOWN') recommendations.push('Start Camera to check whether a usable camera is available; no permission is requested by this preflight.');
    if (camera.rearCamera.available === false) recommendations.push('Use the device camera selector to choose a rear-facing camera if one is available.');
    if (camera.torch.available === false) recommendations.push('Continue without torch; use even room lighting and avoid glare.');
    if (camera.resolution.status === 'below-requested') recommendations.push('Try a camera/browser combination that can provide the requested capture dimensions.');
    if (!storage.available) recommendations.push('History may not persist in this browser; check private-mode or site-storage settings.');
    if (!compute.modelRuntime.available) limitations.push(compute.modelRuntime.reason);
    if (modelSpec?.runtime === 'webgpu' && !compute.webgpu.available) limitations.push('The configured model requires WebGPU, which is unavailable on this browser/device.');
    if (camera.availability !== 'AVAILABLE') limitations.push(camera.availability === 'UNKNOWN' ? 'Physical camera access has not been verified yet.' : camera.message);
    if (camera.rearCamera.available !== true) limitations.push(camera.rearCamera.message);
    if (camera.torch.available !== true) limitations.push(camera.torch.message);
    if (!storage.available) limitations.push('Local history/settings storage is unavailable; screening can still be attempted without saving history.');
    if (cameraSnapshot?.facingModeFallback) limitations.push('The browser could not apply the rear-camera preference and selected a camera through its fallback.');

    const result = Object.freeze({
      schemaVersion: DEVICE_COMPATIBILITY_VERSION,
      timestamp: new Date().toISOString(),
      status,
      supported: status !== 'UNSUPPORTED',
      browser: {
        family: identifyBrowser(nav),
        secureContext: Boolean(secureContext),
        apis: { permissions: typeof nav.permissions?.query === 'function', mediaDevices: Boolean(nav.mediaDevices), userMedia: Boolean(nav.mediaDevices?.getUserMedia), enumerateDevices: Boolean(nav.mediaDevices?.enumerateDevices) },
      },
      required,
      optional,
      camera,
      torch: camera.torch,
      orientation: { available: optional.orientation.available, type: win.screen?.orientation?.type || null, angle: Number.isFinite(win.screen?.orientation?.angle) ? win.screen.orientation.angle : null },
      compute,
      storage,
      configuration: {
        cameraConstraints: constraints,
        cameraSelectionSupported: supportedConstraints.deviceId === true,
        processing: { backend: canvas.twoD ? '2d-canvas' : null, resolution: 'native-camera-frame-for-capture', intervalMs: selectProcessingInterval(nav, configuredPolicy) },
        qualitySampleResolution: 'existing-component-quality-preview-sample',
        qualitySampleIntervalMs: isLowResourceHint(nav, configuredPolicy) ? 1000 : 750,
        modelRuntime: compute.modelRuntime,
        fallback: { rearCamera: 'browser-selected camera when environment facing mode is unavailable', torch: 'continue without torch', compute: 'use the exact local model runtime declared by its manifest; do not substitute an incompatible backend' },
      },
      limitations: [...new Set(limitations)],
      recommendations: [...new Set(recommendations)],
    });
    latest = result;
    try { localDataStore?.setSessionValue?.('compatibilityResult', result); } catch { /* Compatibility remains usable if optional session telemetry rejects it. */ }
    return result;
  }

  return Object.freeze({
    version: DEVICE_COMPATIBILITY_VERSION,
    assess,
    getSnapshot: () => latest,
    cameraConfiguration: () => latest?.configuration?.cameraConstraints || cameraConstraints({}, configuredPolicy.camera),
  });
}

function inspectCamera(nav, permission, supportedConstraints, snapshot, requested) {
  const active = snapshot?.previewReady === true;
  const actual = snapshot?.actualResolution;
  const actualWidth = Number.isFinite(actual?.width) ? actual.width : snapshot?.settings?.width;
  const actualHeight = Number.isFinite(actual?.height) ? actual.height : snapshot?.settings?.height;
  let availability = active ? 'AVAILABLE' : 'UNKNOWN';
  let message = 'Camera availability is unconfirmed until the user starts the preview.';
  if (snapshot?.status === 'unsupported' || snapshot?.status === 'permission_denied' || snapshot?.errorCode === 'NotFoundError') {
    availability = 'UNAVAILABLE';
    message = snapshot.error || (snapshot?.errorCode === 'NotFoundError' ? 'No camera is available to this browser.' : 'Camera access is unavailable in this browser or current permission state.');
  }
  const facing = snapshot?.activeFacingMode;
  const rear = facing === 'environment' ? true : facing === 'user' ? false : null;
  const rearCamera = { available: rear, message: rear === true ? 'An environment-facing camera is active.' : rear === false ? 'The active camera reports user-facing mode; rear camera access is not confirmed.' : 'Rear-camera access is unknown until a camera track reports its facing mode.' };
  const range = snapshot?.capabilities || {};
  const torch = { available: active ? snapshot?.torchSupported === true : null, message: snapshot?.torchSupported === true ? 'The active camera track reports torch support.' : active ? 'The active camera track does not report torch support.' : 'Torch support is unknown until the active camera track is inspected.' };
  const controls = {
    focus: hasAny(range, ['focusMode', 'focusDistance']),
    exposure: hasAny(range, ['exposureMode', 'exposureTime', 'exposureCompensation', 'whiteBalanceMode']),
    zoom: range.zoom !== undefined,
    frameRate: range.frameRate || null,
  };
  let resolution;
  if (Number.isFinite(actualWidth) && Number.isFinite(actualHeight)) {
    const adequate = actualWidth >= requested.width && actualHeight >= requested.height;
    resolution = { status: adequate ? 'meets-requested' : 'below-requested', width: actualWidth, height: actualHeight, capabilityRange: { width: range.width || null, height: range.height || null }, requested: { width: requested.width, height: requested.height }, message: adequate ? `Camera preview is ${actualWidth} × ${actualHeight}; it meets or exceeds the requested capture dimensions.` : `Camera preview is ${actualWidth} × ${actualHeight}, below the requested ${requested.width} × ${requested.height}; model-specific minimum resolution is not configured.` };
  } else {
    resolution = { status: 'unknown', width: null, height: null, capabilityRange: { width: range.width || null, height: range.height || null }, requested: { width: requested.width, height: requested.height }, message: 'Actual resolution will be reported by the active camera track; no clinical threshold is assumed.' };
  }
  return {
    availability,
    permission,
    message,
    rearCamera,
    torch,
    controls,
    resolution,
    frameRate: { supported: supportedConstraints.frameRate === true, range: controls.frameRate },
    cameraCount: snapshot?.cameras?.length ?? null,
    facingModeFallback: snapshot?.facingModeFallback === true,
  };
}

function cameraConstraints(supported, requested) {
  const video = {};
  if (supported.facingMode === true) video.facingMode = { ideal: 'environment' };
  if (supported.width === true) video.width = { ideal: requested.width };
  if (supported.height === true) video.height = { ideal: requested.height };
  if (supported.frameRate === true) video.frameRate = { ideal: requested.frameRate, max: requested.maxFrameRate };
  return video;
}

async function inspectCompute(nav, doc, win, modelSpec) {
  const webgl = inspectWebgl(doc);
  let webgpu = { available: false, adapterAvailable: false, reason: 'WebGPU API is unavailable; this is optional unless a future local model manifest requires it.' };
  try {
    if (nav.gpu?.requestAdapter) {
      const adapter = await Promise.race([nav.gpu.requestAdapter(), timeout(1500)]);
      const available = Boolean(adapter);
      webgpu = { available, adapterAvailable: available, reason: available ? 'WebGPU adapter is available, but it is not selected unless the local model explicitly requires it.' : 'WebGPU is exposed but no adapter is available.' };
    }
  } catch { webgpu = { available: false, adapterAvailable: false, reason: 'WebGPU adapter detection failed; other supported processing paths may still work.' }; }
  const wasmAvailable = typeof win.WebAssembly === 'object';
  const modelRuntime = resolveModelRuntime(modelSpec, webgl.available, webgpu.available, wasmAvailable);
  return {
    webgl: { ...webgl }, webgpu,
    wasm: wasmAvailable,
    worker: typeof win.Worker === 'function',
    performance: {
      hardwareConcurrency: positiveInteger(nav.hardwareConcurrency),
      deviceMemoryGiB: positiveNumber(nav.deviceMemory),
      tier: 'unclassified',
      hintsAreAdvisory: true,
    },
    modelRuntime,
  };
}

function resolveModelRuntime(modelSpec, webgl, webgpu, wasm) {
  if (!modelSpec) return { available: false, runtime: null, reason: 'No trained Component 9 prediction model is configured in this project.' };
  const runtime = modelSpec.runtime;
  const available = runtime === 'webgpu' ? webgpu : runtime === 'webgl' ? webgl : runtime === 'wasm' ? wasm : false;
  return { available, runtime: available ? runtime : null, requiredRuntime: runtime, reason: available ? `The declared local model runtime (${runtime}) is available.` : `The model declares ${runtime || 'an unknown runtime'}, which is not available; no incompatible fallback will be selected.` };
}

function inspectCanvas(doc) {
  try {
    const canvas = doc?.createElement?.('canvas');
    return { twoD: Boolean(canvas?.getContext?.('2d')) };
  } catch { return { twoD: false }; }
}

function inspectWebgl(doc) {
  try {
    const canvas = doc?.createElement?.('canvas');
    const context = canvas?.getContext?.('webgl2') || canvas?.getContext?.('webgl');
    const lose = context?.getExtension?.('WEBGL_lose_context');
    lose?.loseContext?.();
    return { available: Boolean(context), reason: context ? 'A WebGL context can be created; it remains optional.' : 'WebGL is unavailable; the current pipeline has no WebGL-only inference dependency.' };
  } catch { return { available: false, reason: 'WebGL detection failed; the current pipeline has no WebGL-only inference dependency.' }; }
}

async function readCameraPermission(permissions) {
  if (typeof permissions?.query !== 'function') return 'unknown';
  try { return (await permissions.query({ name: 'camera' }))?.state || 'unknown'; }
  catch { return 'unknown'; }
}

async function readStorage(store) {
  if (!store?.getStorageAvailability) return { available: false, backend: null, localOnly: true, reason: 'Component 16 storage availability API is unavailable.' };
  try { return await store.getStorageAvailability(); }
  catch { return { available: false, backend: null, localOnly: true, reason: 'STORAGE_CHECK_FAILED' }; }
}

function selectProcessingInterval(nav, policy) {
  return isLowResourceHint(nav, policy)
    ? policy.lowResourceIntervalMs : policy.supportedIntervalMs;
}
function isLowResourceHint(nav, policy) {
  const cores = positiveInteger(nav.hardwareConcurrency);
  const memory = positiveNumber(nav.deviceMemory);
  return cores !== null && cores <= policy.lowCoreCount || memory !== null && memory <= policy.lowMemoryGiB;
}
function capability(available, required, message) { return { available, required, message }; }
function hasAny(object, keys) { return keys.some(key => object?.[key] !== undefined); }
function positiveInteger(value) { return Number.isSafeInteger(value) && value > 0 ? value : null; }
function positiveNumber(value) { return Number.isFinite(value) && value > 0 ? value : null; }
function identifyBrowser(nav) {
  const brands = nav.userAgentData?.brands;
  if (Array.isArray(brands) && brands.length) return brands.map(item => item.brand).filter(Boolean).join(' / ');
  const agent = typeof nav.userAgent === 'string' ? nav.userAgent : '';
  // Label only; API checks above determine compatibility.
  return /Firefox\//.test(agent) ? 'Firefox' : /Edg\//.test(agent) ? 'Edge' : /Chrome\//.test(agent) ? 'Chromium-based' : /Safari\//.test(agent) ? 'Safari/WebKit' : 'Unknown browser';
}
function safeCall(callback, fallback) { try { return callback() ?? fallback; } catch { return fallback; } }
function timeout(ms) { return new Promise(resolve => setTimeout(() => resolve(null), ms)); }
