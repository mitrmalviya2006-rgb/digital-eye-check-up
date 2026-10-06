import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCaptureRecord, captureEyeMetadata } from '../src/capture-contract.js';
import {
  EYE_COORDINATE_SPACE,
  PREPROCESSING_CONFIG,
  PreprocessingError,
  computeEyeCrop,
  computeEyeRotation,
  computeOutputTransform,
  processRgbaPixels,
  resolvePreprocessingConfig,
  validateCaptureForPreprocessing,
} from '../src/image-preprocessing.js';
import { mountImagePreprocessingStep, preprocessCapture, preprocessCaptureBatch } from '../src/preprocessing-step.js';

function eyeSource(eye, designation, box, { centerX = (box.left + box.right) / 2, cornerTilt = 0 } = {}) {
  const centerY = (box.top + box.bottom) / 2;
  const cornerY = centerY - cornerTilt / 2;
  const irisBox = { left: centerX - .025, top: centerY - .04, right: centerX + .025, bottom: centerY + .04, coordinateSpace: EYE_COORDINATE_SPACE };
  return {
    eye, designation, detected: true,
    boundingBox: { ...box, width: box.right - box.left, height: box.bottom - box.top, coordinateSpace: EYE_COORDINATE_SPACE },
    center: { x: centerX, y: centerY },
    landmarks: { eyeCorners: { nasal: { x: centerX - .08, y: cornerY }, temporal: { x: centerX + .08, y: cornerY + cornerTilt } } },
    orientation: { angleDegrees: Math.atan2(cornerTilt * 360, .16 * 640) * 180 / Math.PI },
    iris: { detected: true, center: { x: centerX, y: centerY }, boundingBox: irisBox },
    eyelid: { state: 'OPEN' }, confidence: null, confidenceStatus: 'UNAVAILABLE',
  };
}

function capture({ id = 'capture-a', leftBox = { left: .72, top: .3, right: .91, bottom: .55 }, rightBox = { left: .08, top: .3, right: .27, bottom: .55 }, overrides = {} } = {}) {
  const image = new Blob(['validated-captured-eye-frame'], { type: 'image/png' });
  const leftEye = eyeSource('left', 'OS', leftBox);
  const rightEye = eyeSource('right', 'OD', rightBox);
  return buildCaptureRecord({
    captureId: id, image, width: 640, height: 360, timestamp: 1_700_000_000_000, frameTimestamp: 1234,
    eyeResult: { leftEye, rightEye },
    positioningState: { status: 'READY', faceDetected: true, ready: true, stable: true },
    qualityResult: { valid: true, overallStatus: 'GOOD', captureReady: true },
    liveQualityResult: { valid: true, overallStatus: 'GOOD', captureReady: true },
    stability: { positionStable: true, eyeTrackingStable: true, stableForMs: 900, qualitySamples: 2 },
    captureIndex: 1, requiredCaptureCount: 1,
    ...overrides,
  });
}

function expectCode(fn, code) {
  assert.throws(fn, error => error instanceof PreprocessingError && error.code === code);
}

test('accepts only validated Component 6 PNG captures with dimensions and binocular OD/OS metadata', () => {
  const value = capture();
  assert.equal(value.valid, true); assert.equal(value.validationStatus, 'VALIDATED');
  assert.equal(value.leftEyeDetection.eye, 'left'); assert.equal(value.leftEyeDetection.designation, 'OS');
  assert.equal(value.rightEyeDetection.eye, 'right'); assert.equal(value.rightEyeDetection.designation, 'OD');
  assert.equal(value.leftEyeDetection.coordinateSpace, EYE_COORDINATE_SPACE);
  assert.ok(value.leftEyeDetection.iris.boundingBox);
  assert.equal(validateCaptureForPreprocessing(value).inputWidth, null);
  assert.equal(PREPROCESSING_CONFIG.normalization, 'none');
});

test('rejects missing, unvalidated, unsupported, corrupt-dimension, and incomplete-eye inputs', () => {
  expectCode(() => validateCaptureForPreprocessing(null), 'CAPTURE_MISSING');
  expectCode(() => validateCaptureForPreprocessing({ ...capture(), valid: false }), 'CAPTURE_NOT_VALIDATED');
  expectCode(() => validateCaptureForPreprocessing({ ...capture(), image: new Blob(['jpg'], { type: 'image/jpeg' }) }), 'CAPTURE_FORMAT_UNSUPPORTED');
  expectCode(() => validateCaptureForPreprocessing({ ...capture(), width: 0 }), 'CAPTURE_DIMENSIONS_INVALID');
  expectCode(() => validateCaptureForPreprocessing({ ...capture(), leftEyeDetection: null }), 'EYE_METADATA_INVALID');
  expectCode(() => validateCaptureForPreprocessing({ ...capture(), rightEyeDetection: { ...capture().rightEyeDetection, designation: 'OS' } }), 'EYE_METADATA_INVALID');
  expectCode(() => validateCaptureForPreprocessing({ ...capture(), qualityResult: { valid: false, overallStatus: 'UNKNOWN' } }), 'CAPTURE_QUALITY_INVALID');
});

test('computes independent normalized-margin crops and retains anatomical mapping even when screen positions appear mirrored', () => {
  const value = capture();
  const right = computeEyeCrop(value.rightEyeDetection, value.width, value.height);
  const left = computeEyeCrop(value.leftEyeDetection, value.width, value.height);
  assert.ok(right.x < left.x, 'the right/OD eye is on the left of this unmirrored synthetic frame');
  assert.equal(right.normalized.left, right.x / value.width);
  assert.ok(right.width > right.eyeBounds.width); assert.ok(right.height > right.eyeBounds.height);
  assert.equal(value.rightEyeDetection.designation, 'OD'); assert.equal(value.leftEyeDetection.designation, 'OS');
});

test('clips only safety margin near image boundaries and never clips the eye or iris region', () => {
  const edgeEye = captureEyeMetadata(eyeSource('left', 'OS', { left: .01, top: .3, right: .2, bottom: .55 }, { centerX: .105 }));
  const crop = computeEyeCrop(edgeEye, 640, 360);
  assert.equal(crop.x, 0); assert.equal(crop.marginClipped, true);
  assert.ok(crop.eyeBounds.x >= crop.x);
  expectCode(() => computeEyeCrop({ ...edgeEye, boundingBox: { ...edgeEye.boundingBox, left: -.01 } }, 640, 360), 'EYE_METADATA_INVALID');
  expectCode(() => computeEyeCrop({ ...edgeEye, boundingBox: { left: .1, top: .3, right: .12, bottom: .34 } }, 640, 360), 'EYE_REGION_TOO_SMALL');
});

test('eye-corner alignment levels the line deterministically and rejects absent or excessive rotations', () => {
  const tilted = captureEyeMetadata(eyeSource('left', 'OS', { left: .3, top: .3, right: .5, bottom: .55 }, { centerX: .4, cornerTilt: .06 }));
  const rotation = computeEyeRotation(tilted, 640, 360, 'eye-corners-level', 25);
  assert.ok(rotation < 0); assert.ok(Math.abs(rotation) < 25);
  const transform = computeOutputTransform({ x: 160, y: 100, width: 140, height: 100 }, rotation);
  assert.ok(transform.width > 140); assert.ok(transform.height > 100);
  expectCode(() => computeEyeRotation({ eye: 'left' }, 640, 360, 'eye-corners-level'), 'EYE_ALIGNMENT_UNAVAILABLE');
  const steep = { ...tilted, eyeCorners: { nasal: { x: .3, y: .2 }, temporal: { x: .4, y: .5 } } };
  expectCode(() => computeEyeRotation(steep, 640, 360, 'eye-corners-level', 15), 'EYE_ALIGNMENT_OUT_OF_RANGE');
});

test('resizing preserves aspect ratio by default and stretches only when explicitly configured', () => {
  const crop = { x: 10, y: 20, width: 200, height: 100 };
  const contained = computeOutputTransform(crop, 0, { inputWidth: 64, inputHeight: 64 });
  assert.equal(contained.width, 64); assert.equal(contained.height, 64);
  assert.equal(contained.resizeMode, 'contain'); assert.equal(contained.contentRegion.width, 64); assert.equal(contained.contentRegion.height, 32);
  const stretched = computeOutputTransform(crop, 0, { inputWidth: 64, inputHeight: 64, resizeMode: 'stretch' });
  assert.equal(stretched.contentRegion.width, 64); assert.equal(stretched.contentRegion.height, 64);
  expectCode(() => resolvePreprocessingConfig({ inputWidth: 64 }), 'PREPROCESSING_CONFIG_INVALID');
});

test('raw RGB identity, grayscale conversion, RGBA preservation, and all supported normalizations are explicit', () => {
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 128, 255, 64]);
  const raw = processRgbaPixels(rgba, 2, 1);
  assert.deepEqual([...raw.image], [255, 0, 0, 0, 128, 255]);
  assert.equal(raw.dataType, 'uint8'); assert.deepEqual(raw.normalization.outputRange, [0, 255]);
  const gray = processRgbaPixels(rgba, 2, 1, { colorMode: 'GRAYSCALE' });
  assert.deepEqual([...gray.image], [54, 110]);
  const rgbaOutput = processRgbaPixels(rgba, 2, 1, { colorMode: 'RGBA' });
  assert.deepEqual([...rgbaOutput.image], [...rgba]);
  const zeroOne = processRgbaPixels(new Uint8Array([0, 127, 255, 255]), 1, 1, { normalization: 'zero-to-one' });
  assert.equal(zeroOne.image[0], 0); assert.ok(Math.abs(zeroOne.image[1] - 127 / 255) < 1e-7); assert.equal(zeroOne.image[2], 1); assert.equal(zeroOne.dataType, 'float32');
  const minusOne = processRgbaPixels(new Uint8Array([0, 128, 255, 255]), 1, 1, { normalization: 'minus-one-to-one' });
  assert.equal(minusOne.image[0], -1); assert.ok(Math.abs(minusOne.image[1] - (128 / 127.5 - 1)) < 1e-6); assert.equal(minusOne.image[2], 1);
  const meanStd = processRgbaPixels(new Uint8Array([160, 100, 80, 255]), 1, 1, { normalization: 'mean-std', mean: [128, 100, 80], std: [16, 10, 8] });
  assert.deepEqual([...meanStd.image], [2, 0, 0]); assert.deepEqual(meanStd.normalization.mean, [128, 100, 80]);
});

test('photometric correction is identity by default, deterministic when configured, and no denoising is applied', () => {
  const rgba = new Uint8Array([100, 120, 140, 255]);
  assert.deepEqual([...processRgbaPixels(rgba, 1, 1).image], [100, 120, 140]);
  const adjusted = processRgbaPixels(rgba, 1, 1, { brightness: 10, contrast: 1.5 });
  assert.deepEqual([...adjusted.image], [96, 126, 156]);
  assert.equal(adjusted.noiseReduction, 'none');
  expectCode(() => resolvePreprocessingConfig({ noiseReduction: 'median3' }), 'PREPROCESSING_CONFIG_UNSUPPORTED');
});

test('invalid tensor lengths and non-finite pixel values are rejected instead of passed downstream', () => {
  expectCode(() => processRgbaPixels(new Uint8Array([1, 2, 3]), 1, 1), 'PREPROCESSING_PIXELS_INVALID');
  expectCode(() => processRgbaPixels(new Float32Array([1, Number.NaN, 3, 255]), 1, 1), 'PREPROCESSING_PIXELS_INVALID');
  expectCode(() => processRgbaPixels(new Uint8Array([1, 2, 3, 255]), 1, 1, { normalization: 'mean-std', mean: [0, 0, 0], std: [1, 0, 1] }), 'PREPROCESSING_CONFIG_INVALID');
});

class MockCanvas {
  constructor({ pixels } = {}) { this.width = 0; this.height = 0; this.draws = []; this.transforms = []; this.pixels = pixels; this.context = null; }
  getContext() {
    this.context ||= {
      clearRect() {}, setTransform: (...values) => this.transforms.push(values),
      drawImage: (...values) => this.draws.push(values),
      getImageData: (_x, _y, width, height) => ({ data: this.pixels?.(width, height) || new Uint8ClampedArray(width * height * 4).fill(127) }),
    };
    return this.context;
  }
}

test('preprocesses a Component 6 capture once into binocular typed-array outputs and releases image resources', async () => {
  const value = capture();
  const bitmap = { width: value.width, height: value.height, close() { this.closed = true; } };
  const canvas = new MockCanvas(); let decodes = 0;
  const result = await preprocessCapture(value, { decodeImage: async image => { assert.equal(image, value.image); decodes++; return bitmap; }, createCanvas: () => canvas, now: () => 55 });
  assert.equal(decodes, 1); assert.equal(bitmap.closed, true); assert.equal(canvas.width, 0); assert.equal(canvas.height, 0);
  assert.equal(result.valid, true); assert.equal(result.preprocessingVersion, '1.0.0'); assert.equal(result.sourceCaptureId, value.captureId); assert.equal(result.timestamp, 55);
  assert.equal(result.rightEye.designation, 'OD'); assert.equal(result.leftEye.designation, 'OS');
  assert.ok(result.rightEye.cropRegion.x < result.leftEye.cropRegion.x);
  assert.ok(result.rightEye.irisOutputBounds.left >= 0 && result.rightEye.irisOutputBounds.right <= result.rightEye.width);
  assert.ok(result.leftEye.irisOutputBounds.top >= 0 && result.leftEye.irisOutputBounds.bottom <= result.leftEye.height);
  assert.ok(result.rightEye.image instanceof Uint8Array); assert.equal(result.rightEye.channels, 3); assert.equal(result.rightEye.layout, 'HWC');
  assert.ok(result.rightEye.transform.sourceToOutput.every(Number.isFinite));
});

test('cancellation during asynchronous image decoding closes the bitmap and prevents canvas processing', async () => {
  const value = capture();
  const bitmap = { width: value.width, height: value.height, close() { this.closed = true; } };
  let createCanvasCalls = 0;
  let continuationChecks = 0;
  await assert.rejects(preprocessCapture(value, {
    decodeImage: async () => bitmap,
    createCanvas: () => { createCanvasCalls++; return new MockCanvas(); },
    shouldContinue: () => ++continuationChecks === 1,
  }), error => error.code === 'PREPROCESSING_CANCELLED');
  assert.equal(bitmap.closed, true);
  assert.equal(createCanvasCalls, 0);
});

test('supports model-configured output size, color, layout, and normalization without assuming defaults', async () => {
  const value = capture(); const canvas = new MockCanvas();
  const bitmap = { width: value.width, height: value.height, close() {} };
  const result = await preprocessCapture(value, {
    config: { inputWidth: 32, inputHeight: 24, colorMode: 'GRAYSCALE', layout: 'CHW', normalization: 'zero-to-one' },
    decodeImage: async () => bitmap, createCanvas: () => canvas,
  });
  assert.equal(result.rightEye.width, 32); assert.equal(result.rightEye.height, 24);
  assert.equal(result.rightEye.colorMode, 'GRAYSCALE'); assert.equal(result.rightEye.layout, 'CHW');
  assert.equal(result.rightEye.dataType, 'float32'); assert.equal(result.rightEye.image.length, 32 * 24);
  assert.deepEqual(result.config.normalization, 'zero-to-one');
});

test('detects corrupt decode dimensions and ensures one invalid capture invalidates a complete batch', async () => {
  const value = capture();
  await assert.rejects(preprocessCapture(value, { decodeImage: async () => ({ width: 320, height: 240, close() {} }), createCanvas: () => new MockCanvas() }), error => error.code === 'CAPTURE_DECODE_INVALID');
  let count = 0;
  await assert.rejects(preprocessCaptureBatch([value, { ...value, valid: false }], { decodeImage: async input => { count++; return { width: input === value.image ? value.width : 320, height: input === value.image ? value.height : 240, close() {} }; }, createCanvas: () => new MockCanvas() }), error => error.code === 'CAPTURE_NOT_VALIDATED');
  assert.equal(count, 1);
});

test('processes multiple frames sequentially and is deterministic for the same input and configuration', async () => {
  const first = capture({ id: 'frame-1' }), second = capture({ id: 'frame-2' });
  let decodes = 0;
  const decodeImage = async image => { decodes++; return { width: 640, height: 360, close() {} }; };
  const options = { decodeImage, createCanvas: () => new MockCanvas(), now: () => 123 };
  const batch = await preprocessCaptureBatch([first, second], options);
  const repeated = await preprocessCapture(first, options);
  assert.equal(decodes, 3); assert.equal(batch.captures.length, 2); assert.equal(batch.valid, true);
  assert.deepEqual([...batch.captures[0].leftEye.image], [...repeated.leftEye.image]);
  assert.equal(batch.captures[0].sourceCaptureId, 'frame-1'); assert.equal(batch.captures[1].sourceCaptureId, 'frame-2');
});

class FakeNode {
  constructor() { this.listeners = new Map(); this.textContent = ''; this.innerHTML = ''; this.children = []; this.classList = { add() {}, remove() {}, toggle() {} }; }
  addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(value => value !== fn)); }
  dispatchEvent(event) { for (const listener of this.listeners.get(event.type) || []) listener(event); return true; }
  replaceChildren(...nodes) { this.children = nodes; }
}

test('Component 6 completion batch integrates with Component 7 and emits Component 8-ready output', async () => {
  const previousDocument = globalThis.document, previousWindow = globalThis.window, previousCustomEvent = globalThis.CustomEvent;
  const nodes = new Map(['#preprocessing-heading', '#preprocessing-detail', '#preprocessing-summary', '#preprocessing-error', '#preprocessing-stop'].map(selector => [selector, new FakeNode()]));
  const root = new FakeNode(); root.querySelector = selector => nodes.get(selector); root.events = [];
  root.dispatchEvent = event => { root.events.push(event); return true; };
  const bitmap = { width: 640, height: 360, close() {} };
  globalThis.document = { createElement: name => name === 'canvas' ? new MockCanvas() : new FakeNode() };
  globalThis.window = new FakeNode();
  globalThis.CustomEvent = class extends Event { constructor(type, init = {}) { super(type, init); this.detail = init.detail; } };
  try {
    const resultCapture = capture({ id: 'from-component-6' });
    const cleanup = mountImagePreprocessingStep(root, { captures: [resultCapture] }, { decodeImage: async () => bitmap, now: () => 99 });
    for (let i = 0; i < 12 && !root.events.some(event => event.type === 'eye-preprocessing-complete'); i++) await new Promise(resolve => setTimeout(resolve, 0));
    const ready = root.events.find(event => event.type === 'eye-preprocessing-ready');
    const complete = root.events.find(event => event.type === 'eye-preprocessing-complete');
    assert.ok(ready); assert.ok(complete); assert.equal(complete.detail.valid, true);
    assert.equal(complete.detail.captures[0].rightEye.designation, 'OD');
    assert.equal(complete.detail.captures[0].leftEye.designation, 'OS');
    assert.equal(nodes.get('#preprocessing-heading').textContent, 'Eye images are ready.');
    await cleanup();
  } finally {
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousCustomEvent === undefined) delete globalThis.CustomEvent; else globalThis.CustomEvent = previousCustomEvent;
  }
});
