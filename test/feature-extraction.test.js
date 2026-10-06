import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCaptureRecord } from '../src/capture-contract.js';
import { preprocessCapture } from '../src/preprocessing-step.js';
import {
  FEATURE_EXTRACTION_VERSION,
  FEATURE_ORDER,
  FEATURE_SCHEMA_VERSION,
  FeatureExtractionError,
  extractEyeFeatures,
  extractFeaturesBatch,
  toFeatureVector,
  validateFeatureBatch,
  validateFeatureVector,
} from '../src/feature-extraction.js';
import { mountFeatureExtractionStep } from '../src/feature-extraction-step.js';

function makeEye(side, designation, { confidence = null, irisBoundary = true, opennessRatio = 0.24 } = {}) {
  const centerX = side === 'right' ? .30 : .70;
  const centerY = .42;
  const eyeBox = { left: centerX - .15, top: .30, right: centerX + .15, bottom: .55 };
  const irisBox = { left: centerX - .02, top: centerY - .03, right: centerX + .02, bottom: centerY + .03 };
  const boundary = irisBoundary ? [
    { x: centerX, y: irisBox.top }, { x: irisBox.right, y: centerY },
    { x: centerX, y: irisBox.bottom }, { x: irisBox.left, y: centerY },
  ] : [];
  const cornerY = .42;
  return {
    eye: side, designation, detected: true,
    boundingBox: { ...eyeBox, width: eyeBox.right - eyeBox.left, height: eyeBox.bottom - eyeBox.top, coordinateSpace: 'normalized_camera_frame_top_left_unmirrored' },
    center: { x: centerX, y: centerY },
    landmarks: { eyeCorners: { nasal: { x: centerX - .12, y: cornerY }, temporal: { x: centerX + .12, y: cornerY } } },
    orientation: { angleDegrees: 0.5 },
    eyelid: { state: 'OPEN', opennessRatio },
    iris: { detected: true, center: { x: centerX, y: centerY }, boundingBox: { ...irisBox }, boundary },
    confidence, confidenceStatus: confidence === null ? 'UNAVAILABLE' : 'AVAILABLE',
  };
}

function makeCapture(id = 'capture-1', options = {}) {
  return buildCaptureRecord({
    image: new Blob(['png'], { type: 'image/png' }), width: 640, height: 360,
    timestamp: 100, frameTimestamp: 90, captureId: id,
    eyeResult: { rightEye: makeEye('right', 'OD', options), leftEye: makeEye('left', 'OS', options) },
    positioningState: { ready: true },
    qualityResult: { valid: true, overallStatus: 'GOOD' }, liveQualityResult: { valid: true, overallStatus: 'GOOD' },
    stability: { positionStable: true, eyeTrackingStable: true },
  });
}

function makePreprocessedEye(side, designation, { confidence = null, brightness = 80, normalization = { method: 'none', inputRange: [0, 255], outputRange: [0, 255] }, colorMode = 'RGB', layout = 'HWC', image, boundary = true, missingOpenness = false } = {}) {
  const width = 16, height = 12, channels = colorMode === 'RGBA' ? 4 : colorMode === 'RGB' ? 3 : 1;
  const values = image || new Uint8Array(width * height * channels);
  if (!image) {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      const pixelValues = colorMode === 'GRAYSCALE' ? [brightness + x * 2 + y] : colorMode === 'RGBA' ? [brightness + x * 2, brightness + x + y, brightness + y * 2, 255] : [brightness + x * 2, brightness + x + y, brightness + y * 2];
      for (let channel = 0; channel < channels; channel++) {
        const offset = layout === 'HWC' ? pixel * channels + channel : channel * width * height + pixel;
        values[offset] = pixelValues[channel];
      }
    }
  }
  const centerX = side === 'right' ? .30 : .70, centerY = .42;
  const eyeBox = { left: centerX - .15, top: .30, right: centerX + .15, bottom: .55 };
  const irisBox = { left: centerX - .02, top: centerY - .03, right: centerX + .02, bottom: centerY + .03 };
  return {
    eye: side, designation, width, height, channels, colorMode, layout,
    image: values, dataType: values instanceof Uint8Array ? 'uint8' : 'float32',
    normalization: structuredClone(normalization), transform: { rotationDegrees: 0 },
    irisOutputBoundary: boundary ? [{ x: 8, y: 2 }, { x: 12, y: 6 }, { x: 8, y: 10 }, { x: 4, y: 6 }] : [],
    sourceMetadata: {
      boundingBox: eyeBox,
      orientationDegrees: 0.5,
      opennessRatio: missingOpenness ? null : .24,
      confidence, confidenceStatus: confidence === null ? 'UNAVAILABLE' : 'AVAILABLE',
      eyeCorners: { nasal: { x: centerX - .12, y: centerY }, temporal: { x: centerX + .12, y: centerY } },
      iris: { detected: true, center: { x: centerX, y: centerY }, boundingBox: irisBox, boundary: [] },
    },
  };
}

function makeBatch({ id = 'capture-1', options = {}, eyeOverrides = {} } = {}) {
  return {
    preprocessingVersion: '1.0.0', valid: true, timestamp: 200,
    captures: [{
      sourceCaptureId: id, valid: true, sourceDimensions: { width: 640, height: 360 },
      rightEye: makePreprocessedEye('right', 'OD', { ...options, ...eyeOverrides.rightEye }),
      leftEye: makePreprocessedEye('left', 'OS', { ...options, ...eyeOverrides.leftEye }),
    }],
  };
}

test('extracts deterministic independent right/OD and left/OS geometry and iris-region measurements', async () => {
  const result = await extractFeaturesBatch(makeBatch(), { now: () => 333, yieldToMainThread: async () => {} });
  assert.equal(result.featureSchemaVersion, FEATURE_SCHEMA_VERSION);
  assert.equal(result.featureExtractionVersion, FEATURE_EXTRACTION_VERSION);
  assert.deepEqual(result.featureOrder, FEATURE_ORDER);
  const capture = result.captures[0];
  assert.equal(capture.rightEye.designation, 'OD'); assert.equal(capture.leftEye.designation, 'OS');
  assert.ok(Math.abs(capture.rightEye.features.eyeWidthFraction.value - .3) < 1e-12);
  assert.ok(capture.rightEye.features.irisRegionMeanEncodedLuma.value > 0);
  assert.ok(capture.rightEye.features.irisRegionStdDevEncodedLuma.value > 0);
  assert.equal(capture.rightEye.completeness, 'COMPLETE');
  assert.ok(capture.rightEye.candidateVector.values instanceof Float32Array);
  assert.ok([...capture.rightEye.candidateVector.values].every((value, index) => Math.abs(value - capture.rightEye.features[FEATURE_ORDER[index]].value) < 1e-4));
  assert.equal(capture.rightEye.candidateVector.modelReady, false);
  assert.equal(validateFeatureBatch(result), result);
});

test('pupil and detector confidence remain explicitly unavailable rather than inferred', async () => {
  const result = await extractFeaturesBatch(makeBatch(), { yieldToMainThread: async () => {} });
  const eye = result.captures[0].rightEye;
  assert.equal(eye.pupil.status, 'UNAVAILABLE');
  assert.equal(eye.pupil.diameterPx.value, null); assert.equal(eye.pupil.pupilToIrisRatio.value, null);
  assert.equal(eye.confidence.value, null); assert.equal(eye.confidence.status, 'UNAVAILABLE');
  assert.equal(eye.features.irisRegionMeanEncodedLuma.confidence.status, 'UNAVAILABLE');
});

test('preserves a supplied detector confidence without applying an undocumented cutoff', async () => {
  const result = await extractFeaturesBatch(makeBatch({ options: { confidence: .21 } }), { yieldToMainThread: async () => {} });
  assert.equal(result.captures[0].leftEye.confidence.value, .21);
  assert.equal(result.captures[0].leftEye.features.irisAspectRatio.confidence.value, .21);
});

test('missing openness and iris-boundary image samples are represented as unavailable, never zero-filled', async () => {
  const batch = makeBatch({ eyeOverrides: { leftEye: { missingOpenness: true, boundary: false } } });
  const result = await extractFeaturesBatch(batch, { yieldToMainThread: async () => {} });
  const left = result.captures[0].leftEye;
  assert.equal(left.completeness, 'PARTIAL');
  assert.equal(left.features.eyeOpennessRatio.value, null); assert.equal(left.features.eyeOpennessRatio.valid, false);
  assert.equal(left.features.irisRegionMeanEncodedLuma.value, null); assert.equal(left.features.irisRegionMeanEncodedLuma.status, 'UNAVAILABLE');
  assert.equal(left.candidateVector, null);
  assert.throws(() => toFeatureVector(left), error => error.code === 'FEATURE_VECTOR_INCOMPLETE');
  const withoutCorners = makeBatch();
  withoutCorners.captures[0].rightEye.sourceMetadata.eyeCorners = { nasal: null, temporal: null };
  const cornerResult = await extractFeaturesBatch(withoutCorners, { yieldToMainThread: async () => {} });
  assert.equal(cornerResult.captures[0].rightEye.features.eyeCornerDistanceFractionOfFrameDiagonal.value, null);
});

test('rejects missing eyes or iris geometry and impossible normalized bounds', async () => {
  const noEye = makeBatch(); noEye.captures[0].rightEye.sourceMetadata.boundingBox = null;
  await assert.rejects(extractFeaturesBatch(noEye, { yieldToMainThread: async () => {} }), error => error.code === 'FEATURE_GEOMETRY_MISSING');
  const noIris = makeBatch(); noIris.captures[0].leftEye.sourceMetadata.iris.detected = false;
  await assert.rejects(extractFeaturesBatch(noIris, { yieldToMainThread: async () => {} }), error => error.code === 'FEATURE_GEOMETRY_MISSING');
  const impossible = makeBatch(); impossible.captures[0].rightEye.sourceMetadata.iris.boundingBox.right = .99;
  await assert.rejects(extractFeaturesBatch(impossible, { yieldToMainThread: async () => {} }), error => error.code === 'FEATURE_GEOMETRY_MISSING');
});

test('rejects NaN, infinity, corrupt tensor length, invalid channel layout, and out-of-range normalized pixels', async () => {
  const nonFinite = makeBatch({ options: { normalization: { method: 'zero-to-one', inputRange: [0, 255], outputRange: [0, 1] }, image: new Float32Array(16 * 12 * 3).fill(.5) } });
  nonFinite.captures[0].rightEye.image[3] = Number.NaN;
  await assert.rejects(extractFeaturesBatch(nonFinite, { yieldToMainThread: async () => {} }), error => error.code === 'PREPROCESSED_PIXELS_INVALID');
  const infinite = makeBatch({ options: { normalization: { method: 'zero-to-one', inputRange: [0, 255], outputRange: [0, 1] }, image: new Float32Array(16 * 12 * 3).fill(.5) } });
  infinite.captures[0].leftEye.image[2] = Number.POSITIVE_INFINITY;
  await assert.rejects(extractFeaturesBatch(infinite, { yieldToMainThread: async () => {} }), error => error.code === 'PREPROCESSED_PIXELS_INVALID');
  const tooBright = makeBatch({ options: { normalization: { method: 'zero-to-one', inputRange: [0, 255], outputRange: [0, 1] }, image: new Float32Array(16 * 12 * 3).fill(.5) } });
  tooBright.captures[0].leftEye.image[0] = 2;
  await assert.rejects(extractFeaturesBatch(tooBright, { yieldToMainThread: async () => {} }), error => error.code === 'PREPROCESSED_PIXELS_INVALID');
  const wrongLength = makeBatch(); wrongLength.captures[0].leftEye.image = new Uint8Array(3); 
  await assert.rejects(extractFeaturesBatch(wrongLength, { yieldToMainThread: async () => {} }), error => error.code === 'PREPROCESSED_EYE_INVALID');
  const wrongChannels = makeBatch(); wrongChannels.captures[0].leftEye.channels = 1;
  await assert.rejects(extractFeaturesBatch(wrongChannels, { yieldToMainThread: async () => {} }), error => error.code === 'PREPROCESSED_EYE_INVALID');
});

test('reads grayscale and CHW normalized RGB consistently back into the source 0–255 intensity domain', async () => {
  const gray = makeBatch({ options: { colorMode: 'GRAYSCALE', layout: 'HWC', brightness: 96 } });
  const grayEye = gray.captures[0].rightEye;
  grayEye.normalization = { method: 'none', inputRange: [0, 255], outputRange: [0, 255] };
  const grayResult = await extractFeaturesBatch(gray, { yieldToMainThread: async () => {} });
  assert.ok(grayResult.captures[0].rightEye.features.irisRegionMeanEncodedLuma.value > 0);
  const chw = makeBatch({ options: { colorMode: 'RGB', layout: 'CHW', normalization: { method: 'zero-to-one', inputRange: [0, 255], outputRange: [0, 1] }, image: new Float32Array(16 * 12 * 3).fill(.5) } });
  const chwResult = await extractFeaturesBatch(chw, { yieldToMainThread: async () => {} });
  assert.ok(Math.abs(chwResult.captures[0].rightEye.features.irisRegionMeanEncodedLuma.value - 127.5) < .01);
  assert.equal(chwResult.captures[0].rightEye.features.irisRegionStdDevEncodedLuma.value, 0);
});

test('feature vector order is fixed, validates names/shape, and only applies explicit model-supplied normalization', async () => {
  const eye = (await extractFeaturesBatch(makeBatch(), { yieldToMainThread: async () => {} })).captures[0].rightEye;
  const subsetOrder = ['irisRegionMeanEncodedLuma', 'eyeWidthFraction'];
  const vector = toFeatureVector(eye, { featureOrder: subsetOrder, normalization: { method: 'mean-std', mean: [100, .2], std: [10, .1] } });
  assert.deepEqual(vector.featureOrder, subsetOrder);
  assert.ok(Math.abs(vector.values[0] - (eye.features.irisRegionMeanEncodedLuma.value - 100) / 10) < 1e-5);
  assert.equal(vector.normalization.method, 'mean-std');
  assert.equal(validateFeatureVector(vector, { expectedFeatureOrder: subsetOrder }), vector);
  assert.throws(() => validateFeatureVector({ ...vector, featureOrder: [...subsetOrder].reverse() }, { expectedFeatureOrder: subsetOrder }), error => error.code === 'FEATURE_VECTOR_INVALID');
  assert.throws(() => toFeatureVector(eye, { featureOrder: ['pupilDiameterPx'] }), error => error.code === 'FEATURE_ORDER_INVALID');
  assert.throws(() => toFeatureVector(eye, { featureOrder: subsetOrder, normalization: { method: 'mean-std', mean: [0], std: [1] } }), error => error.code === 'FEATURE_NORMALIZATION_INVALID');
});

test('mirrored screen positions do not change anatomical feature slots', async () => {
  const batch = makeBatch();
  batch.captures[0].rightEye.sourceMetadata.boundingBox.left = .55;
  batch.captures[0].rightEye.sourceMetadata.boundingBox.right = .85;
  batch.captures[0].leftEye.sourceMetadata.boundingBox.left = .15;
  batch.captures[0].leftEye.sourceMetadata.boundingBox.right = .45;
  batch.captures[0].rightEye.sourceMetadata.iris.center.x = .70;
  batch.captures[0].rightEye.sourceMetadata.iris.boundingBox.left = .68;
  batch.captures[0].rightEye.sourceMetadata.iris.boundingBox.right = .72;
  batch.captures[0].leftEye.sourceMetadata.iris.center.x = .30;
  batch.captures[0].leftEye.sourceMetadata.iris.boundingBox.left = .28;
  batch.captures[0].leftEye.sourceMetadata.iris.boundingBox.right = .32;
  const result = await extractFeaturesBatch(batch, { yieldToMainThread: async () => {} });
  assert.equal(result.captures[0].rightEye.eye, 'right'); assert.equal(result.captures[0].rightEye.designation, 'OD');
  assert.equal(result.captures[0].leftEye.eye, 'left'); assert.equal(result.captures[0].leftEye.designation, 'OS');
});

test('processes multiple captures sequentially with deterministic results and cooperative yielding', async () => {
  const batch = makeBatch();
  batch.captures.push({ ...makeBatch({ id: 'capture-2' }).captures[0], sourceCaptureId: 'capture-2' });
  let yields = 0;
  const result = await extractFeaturesBatch(batch, { now: () => 55, yieldToMainThread: async () => { yields++; } });
  assert.equal(result.captures.length, 2); assert.equal(yields, 1); assert.equal(result.timestamp, 55);
  assert.deepEqual([...result.captures[0].leftEye.candidateVector.values], [...result.captures[1].leftEye.candidateVector.values]);
});

test('Component 7 output integrates through its PNG and landmark contract without a second image decode in Component 8', async () => {
  const canvas = {
    width: 0, height: 0,
    getContext() { return { clearRect() {}, setTransform() {}, drawImage() {}, getImageData(_x, _y, width, height) { return { data: new Uint8ClampedArray(width * height * 4).fill(150) }; } }; },
  };
  const capture = makeCapture();
  const bitmap = { width: capture.width, height: capture.height, close() { this.closed = true; } };
  const preprocessed = await preprocessCapture(capture, { decodeImage: async () => bitmap, createCanvas: () => canvas });
  const features = await extractFeaturesBatch({ preprocessingVersion: '1.0.0', valid: true, captures: [preprocessed] }, { yieldToMainThread: async () => {} });
  assert.equal(bitmap.closed, true);
  assert.equal(features.captures[0].rightEye.designation, 'OD');
  assert.equal(features.captures[0].leftEye.designation, 'OS');
  assert.equal(features.captures[0].captureEvidence.sourceCaptureId, 'capture-1');
  assert.equal(features.captures[0].captureEvidence.capturedQuality.eyes.OD, null);
  assert.equal(JSON.stringify(features.captures[0].captureEvidence).includes('image'), false);
  assert.equal(features.captures[0].rightEye.sourceMetadata.preprocessingVersion, '1.0.0');
  assert.ok(features.captures[0].rightEye.features.eyeOpennessRatio.valid);
  assert.ok(features.captures[0].rightEye.features.eyeCornerDistanceFractionOfFrameDiagonal.valid);
  assert.ok(features.captures[0].rightEye.features.irisRegionMeanEncodedLuma.valid);
});

class FakeNode {
  constructor() { this.listeners = new Map(); this.textContent = ''; this.innerHTML = ''; this.children = []; }
  addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(value => value !== fn)); }
  dispatchEvent(event) { for (const listener of this.listeners.get(event.type) || []) listener(event); return true; }
  replaceChildren(...nodes) { this.children = nodes; }
}

test('Component 8 step emits ready and complete contracts, reports no model prediction, and cleans up', async () => {
  const previousDocument = globalThis.document, previousWindow = globalThis.window, previousCustomEvent = globalThis.CustomEvent;
  const nodes = new Map(['#feature-heading', '#feature-detail', '#feature-summary', '#feature-error', '#feature-stop'].map(selector => [selector, new FakeNode()]));
  const root = new FakeNode(); root.querySelector = selector => nodes.get(selector); root.events = [];
  root.dispatchEvent = event => { root.events.push(event); return true; };
  globalThis.document = { createElement: () => new FakeNode() };
  globalThis.window = new FakeNode();
  globalThis.CustomEvent = class extends Event { constructor(type, init = {}) { super(type, init); this.detail = init.detail; } };
  try {
    const cleanup = mountFeatureExtractionStep(root, { preprocessingBatch: makeBatch() }, { yieldToMainThread: async () => {} });
    for (let i = 0; i < 12 && !root.events.some(event => event.type === 'eye-features-complete'); i++) await new Promise(resolve => setTimeout(resolve, 0));
    const ready = root.events.find(event => event.type === 'eye-features-ready');
    const complete = root.events.find(event => event.type === 'eye-features-complete');
    assert.ok(ready); assert.ok(complete); assert.equal(complete.detail.modelReady, false);
    assert.equal(nodes.get('#feature-heading').textContent, 'Feature extraction complete.');
    assert.match(nodes.get('#feature-detail').textContent, /No refractive-error prediction/);
    assert.equal(nodes.get('#feature-summary').children.length, 2);
    await cleanup();

    const pendingNodes = new Map(['#feature-heading', '#feature-detail', '#feature-summary', '#feature-error', '#feature-stop'].map(selector => [selector, new FakeNode()]));
    const pendingRoot = new FakeNode(); pendingRoot.querySelector = selector => pendingNodes.get(selector); pendingRoot.events = [];
    pendingRoot.dispatchEvent = event => { pendingRoot.events.push(event); return true; };
    const multiBatch = makeBatch(); multiBatch.captures.push({ ...makeBatch({ id: 'capture-2' }).captures[0] });
    const cleanupPending = mountFeatureExtractionStep(pendingRoot, { preprocessingBatch: multiBatch }, { yieldToMainThread: () => new Promise(resolve => setTimeout(resolve, 5)) });
    await cleanupPending();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(pendingRoot.events.length, 0, 'cleanup suppresses results from the in-flight second capture');
  } finally {
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousCustomEvent === undefined) delete globalThis.CustomEvent; else globalThis.CustomEvent = previousCustomEvent;
  }
});
