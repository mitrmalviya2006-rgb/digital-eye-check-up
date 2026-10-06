import test from 'node:test';
import assert from 'node:assert/strict';
import { AutomaticCaptureStateMachine, assessCaptureReadiness } from '../src/capture-state.js';
import { extractCaptureImage } from '../src/capture-image.js';
import { buildCaptureRecord, captureEyeMetadata } from '../src/capture-contract.js';
import { mountAutomaticCaptureStep } from '../src/automatic-capture-step.js';
import { analyzeImageQuality } from '../src/image-quality.js';

function validSnapshot(now = 10_000, overrides = {}) {
  const leftEye = { eye: 'left', designation: 'OS', detected: true, boundingBox: { left: .2, top: .3, right: .4, bottom: .5 }, center: { x: .3, y: .4 }, validity: { geometryState: 'VALID' }, iris: { detected: true }, eyelid: { state: 'OPEN' }, confidence: .9, confidenceStatus: 'AVAILABLE' };
  const rightEye = { eye: 'right', designation: 'OD', detected: true, boundingBox: { left: .6, top: .3, right: .8, bottom: .5 }, center: { x: .7, y: .4 }, validity: { geometryState: 'VALID' }, iris: { detected: true }, eyelid: { state: 'OPEN' }, confidence: .9, confidenceStatus: 'AVAILABLE' };
  const positioning = { status: 'READY', faceDetected: true, ready: true, stable: true, distanceStatus: 'ACCEPTABLE', alignmentStatus: { horizontal: 'CENTERED', vertical: 'LEVEL' }, faceBoundingBox: { left: .2, top: .1, right: .8, bottom: .9 } };
  const qualityResult = {
    valid: true, overallStatus: 'GOOD', captureReady: true, timestamp: now - 10,
    blur: { state: 'SHARP' }, exposure: { state: 'ACCEPTABLE' }, lighting: { state: 'ACCEPTABLE' },
    glare: { state: 'NO_EXCESSIVE_GLARE_DETECTED' }, motion: { state: 'STABLE' }, positioning: { state: 'ACCEPTABLE' },
    leftEye: { confidence: { state: 'SUFFICIENT' }, occlusion: { state: 'CLEAR' } },
    rightEye: { confidence: { state: 'SUFFICIENT' }, occlusion: { state: 'CLEAR' } },
  };
  const eyeResult = { coordinateSpace: 'normalized_camera_frame_top_left_unmirrored', timestamp: now - 10, analysisStatus: 'GEOMETRY_STABLE', bothEyesGeometryValid: true, trackingStable: true, leftEye, rightEye };
  return { cameraReady: true, positioning, positioningFresh: true, eyeResult, qualityResult, ...overrides };
}

function updateAt(machine, time, qualityTimestamp = time - 10, snapshot = validSnapshot(time)) {
  const current = { ...snapshot, eyeResult: { ...snapshot.eyeResult, timestamp: time - 10 }, qualityResult: { ...snapshot.qualityResult, timestamp: qualityTimestamp } };
  return machine.update(current, time);
}

test('capture gate accepts fully fresh Component 3–5 signals and rejects a bad position', () => {
  const good = validSnapshot();
  assert.deepEqual(assessCaptureReadiness(good, 10_000), { eligible: true, reasons: [] });
  assert.ok(assessCaptureReadiness({ ...good, positioning: { ...good.positioning, distanceStatus: 'TOO_FAR' } }, 10_000).reasons.includes('DISTANCE_NOT_ACCEPTABLE'));
  assert.ok(assessCaptureReadiness({ ...good, positioningFresh: false }, 10_000).reasons.includes('POSITIONING_REQUIRED'));
});

test('missing eyes, closed eyes, unstable tracking, stale quality, and poor quality each block capture', () => {
  const good = validSnapshot();
  assert.ok(assessCaptureReadiness({ ...good, eyeResult: null }, 10_000).reasons.includes('EYES_NOT_DETECTED'));
  assert.ok(assessCaptureReadiness({ ...good, eyeResult: { ...good.eyeResult, leftEye: { ...good.eyeResult.leftEye, eyelid: { state: 'CLOSED' } } } }, 10_000).reasons.includes('LEFT_EYE_NOT_OPEN'));
  assert.ok(assessCaptureReadiness({ ...good, eyeResult: { ...good.eyeResult, trackingStable: false } }, 10_000).reasons.includes('EYE_TRACKING_UNSTABLE'));
  assert.ok(assessCaptureReadiness({ ...good, qualityResult: { ...good.qualityResult, timestamp: 1 } }, 10_000).reasons.includes('QUALITY_RESULT_STALE'));
  assert.ok(assessCaptureReadiness({ ...good, qualityResult: { ...good.qualityResult, blur: { state: 'BLURRED' } } }, 10_000).reasons.includes('BLUR_CHECK_NOT_PASSED'));
});

test('unverified confidence, visibility, and mirrored/unknown coordinates fail closed', () => {
  const good = validSnapshot();
  const noConfidence = { ...good, qualityResult: { ...good.qualityResult, leftEye: { confidence: { state: 'UNAVAILABLE' }, occlusion: { state: 'UNKNOWN' } } } };
  assert.ok(assessCaptureReadiness(noConfidence, 10_000).reasons.includes('EYE_CONFIDENCE_NOT_VERIFIED'));
  assert.ok(assessCaptureReadiness(noConfidence, 10_000).reasons.includes('EYE_VISIBILITY_NOT_VERIFIED'));
  assert.ok(assessCaptureReadiness({ ...good, eyeResult: { ...good.eyeResult, coordinateSpace: 'preview_mirrored' } }, 10_000).reasons.includes('EYE_COORDINATE_SPACE_UNVERIFIED'));
});

test('current Component 4/5 model output remains ineligible instead of inventing confidence or occlusion', () => {
  const now = 10_000;
  const eyes = validSnapshot(now).eyeResult;
  for (const eye of [eyes.leftEye, eyes.rightEye]) {
    eye.confidence = null; eye.confidenceStatus = 'UNAVAILABLE'; eye.visibility = { state: 'UNAVAILABLE' };
  }
  const width = 640, height = 360, pixels = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 130, pixels[offset + 3] = 255;
  for (const box of [eyes.leftEye.boundingBox, eyes.rightEye.boundingBox]) {
    for (let y = Math.floor(box.top * height); y < Math.ceil(box.bottom * height); y++) for (let x = Math.floor(box.left * width); x < Math.ceil(box.right * width); x++) {
      const offset = (y * width + x) * 4, value = (x + y) % 2 ? 180 : 80;
      pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = value;
    }
  }
  const upstream = validSnapshot(now);
  const quality = analyzeImageQuality({ pixels, width, height, sourceWidth: width, sourceHeight: height, timestamp: now - 10 }, { eyeResult: eyes, positioning: upstream.positioning, positioningFresh: true });
  const result = assessCaptureReadiness({ ...upstream, eyeResult: eyes, qualityResult: quality }, now);
  assert.equal(quality.leftEye.confidence.state, 'UNAVAILABLE');
  assert.equal(quality.occlusion.state, 'UNKNOWN');
  assert.equal(quality.valid, false);
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('QUALITY_NOT_READY'));
});

test('continuous readiness and distinct quality samples are required before automatic trigger', () => {
  const machine = new AutomaticCaptureStateMachine();
  assert.equal(updateAt(machine, 1_000, 990).state, 'WAITING_FOR_STABILITY');
  assert.equal(updateAt(machine, 1_400, 990).state, 'WAITING_FOR_STABILITY');
  assert.equal(machine.snapshot(1_400).qualitySampleCount, 1);
  assert.equal(updateAt(machine, 1_700, 1_690).state, 'WAITING_FOR_STABILITY');
  assert.equal(updateAt(machine, 1_900, 1_890).state, 'READY_TO_CAPTURE');
  assert.equal(machine.beginCapture(1_900), true);
  assert.equal(machine.beginCapture(1_901), false);
});

test('any invalid state resets the stability timer and invalid positions cannot become ready', () => {
  const machine = new AutomaticCaptureStateMachine();
  updateAt(machine, 1_000, 990);
  updateAt(machine, 1_500, 1_490);
  const invalid = validSnapshot(1_600, { positioningFresh: false });
  assert.equal(machine.update(invalid, 1_600).state, 'POSITIONING');
  assert.equal(updateAt(machine, 1_700, 1_690).state, 'WAITING_FOR_STABILITY');
  assert.equal(updateAt(machine, 2_600, 2_590).state, 'READY_TO_CAPTURE');
});

test('capture failure backs off, retries, and transitions to ERROR at the configured maximum', () => {
  const machine = new AutomaticCaptureStateMachine({ stableDurationMs: 0, minimumDistinctQualitySamples: 1, maxAttemptsPerCapture: 2 });
  updateAt(machine, 1_000, 990); assert.equal(machine.state, 'READY_TO_CAPTURE'); machine.beginCapture(1_000); machine.setValidating();
  assert.equal(machine.captureFailed('POST_CAPTURE_QUALITY_FAILED', 1_010), true);
  assert.equal(machine.snapshot().state, 'RETRY_REQUIRED');
  assert.equal(updateAt(machine, 1_200, 1_190).state, 'RETRY_REQUIRED');
  assert.equal(updateAt(machine, 1_600, 1_590).state, 'READY_TO_CAPTURE'); machine.beginCapture(1_600);
  machine.captureFailed('FRAME_EXTRACTION_FAILED', 1_610);
  assert.equal(machine.snapshot().state, 'ERROR');
  assert.equal(machine.restart(), true); assert.equal(machine.snapshot().state, 'INITIALIZING');
});

test('a retry can succeed and completes without retaining the failed attempt as an image', () => {
  const machine = new AutomaticCaptureStateMachine({ stableDurationMs: 0, minimumDistinctQualitySamples: 1, maxAttemptsPerCapture: 2 });
  updateAt(machine, 1_000, 990); machine.beginCapture(1_000);
  machine.captureFailed('FRAME_EXTRACTION_FAILED', 1_010);
  assert.equal(updateAt(machine, 1_600, 1_590).state, 'READY_TO_CAPTURE');
  machine.beginCapture(1_600); machine.setValidating(); machine.captureValidated(); machine.captureSucceeded(1_610);
  assert.equal(machine.snapshot().state, 'COMPLETE');
  assert.equal(machine.snapshot().captureCount, 1);
  assert.equal(machine.snapshot().attempts, 0);
});

test('consent withdrawal resets an active capture without counting a failure', () => {
  const machine = new AutomaticCaptureStateMachine({ stableDurationMs: 0, minimumDistinctQualitySamples: 1 });
  updateAt(machine, 1_000, 990); machine.beginCapture(1_000);
  assert.equal(machine.withdrawConsent(), true);
  assert.equal(machine.snapshot().state, 'INITIALIZING');
  assert.equal(machine.snapshot().attempts, 0);
});

function fakeCanvas({ nullBlob = false, nullContext = false, malformedPixels = false } = {}) {
  const draws = [];
  const context = {
    drawImage: (...args) => draws.push(args), clearRect() {},
    getImageData: (_x, _y, width, height) => ({ data: new Uint8ClampedArray(malformedPixels ? 0 : width * height * 4) }),
  };
  return {
    width: 0, height: 0, draws,
    getContext: () => nullContext ? null : context,
    toBlob(callback, type) { assert.equal(type, 'image/png'); callback(nullBlob ? null : new Blob(['encoded camera pixels'], { type })); },
  };
}

test('full-resolution frame extraction uses the real video source, returns PNG pixels, and clears temporary canvases', async () => {
  const video = { readyState: 2, videoWidth: 1280, videoHeight: 720 };
  const captureCanvas = fakeCanvas(), validationCanvas = fakeCanvas();
  const decoded = { width: 1280, height: 720, close() { this.closed = true; } };
  const result = await extractCaptureImage(video, { captureCanvas, validationCanvas, decodeImage: async blob => { assert.equal(blob.type, 'image/png'); return decoded; } });
  assert.equal(result.blob.type, 'image/png'); assert.equal(result.width, 1280); assert.equal(result.height, 720);
  assert.equal(result.sampleWidth, 480); assert.equal(result.sampleHeight, 270);
  assert.equal(captureCanvas.draws[0][0], video);
  assert.equal(validationCanvas.draws[0][0], decoded);
  assert.equal(decoded.closed, true);
  assert.equal(captureCanvas.width, 0); assert.equal(validationCanvas.height, 0);
});

test('frame extraction rejects unavailable, low-resolution, oversized, corrupt, and unrenderable frames', async () => {
  const decodeImage = async () => ({ width: 1280, height: 720, close() {} });
  const canvases = () => ({ captureCanvas: fakeCanvas(), validationCanvas: fakeCanvas(), decodeImage });
  await assert.rejects(extractCaptureImage({ readyState: 1, videoWidth: 1280, videoHeight: 720 }, canvases()), /FRAME_EXTRACTION_FAILED/);
  await assert.rejects(extractCaptureImage({ readyState: 2, videoWidth: 320, videoHeight: 240 }, canvases()), /INSUFFICIENT_CAPTURE_RESOLUTION/);
  await assert.rejects(extractCaptureImage({ readyState: 2, videoWidth: 5000, videoHeight: 4000 }, canvases()), /CAPTURE_RESOLUTION_TOO_LARGE/);
  const nullBlob = canvases(); nullBlob.captureCanvas = fakeCanvas({ nullBlob: true });
  await assert.rejects(extractCaptureImage({ readyState: 2, videoWidth: 1280, videoHeight: 720 }, nullBlob), /CAPTURE_IMAGE_INVALID/);
  const noPixels = canvases(); noPixels.validationCanvas = fakeCanvas({ malformedPixels: true });
  await assert.rejects(extractCaptureImage({ readyState: 2, videoWidth: 1280, videoHeight: 720 }, noPixels), /CAPTURE_IMAGE_INVALID/);
  const noContext = canvases(); noContext.captureCanvas = fakeCanvas({ nullContext: true });
  await assert.rejects(extractCaptureImage({ readyState: 2, videoWidth: 1280, videoHeight: 720 }, noContext), /FRAME_EXTRACTION_FAILED/);
  await assert.rejects(extractCaptureImage({ readyState: 2, videoWidth: 1280, videoHeight: 720 }, { ...canvases(), decodeImage: async () => ({ width: 640, height: 360, close() {} }) }), /CAPTURE_IMAGE_INVALID/);
});

test('eye metadata and Component 7 contract preserve anatomical OD/OS in unmirrored camera coordinates', () => {
  const snapshot = validSnapshot();
  // Model anatomical left may appear on the screen-right side of an unmirrored image.
  const left = captureEyeMetadata({ ...snapshot.eyeResult.leftEye, center: { x: .72, y: .4 } });
  const right = captureEyeMetadata({ ...snapshot.eyeResult.rightEye, center: { x: .28, y: .4 } });
  assert.equal(left.designation, 'OS'); assert.equal(left.center.x, .72); assert.equal(right.designation, 'OD'); assert.equal(right.center.x, .28);
  assert.equal(left.confidence, .9);
  const image = new Blob(['png'], { type: 'image/png' });
  const record = buildCaptureRecord({ image, width: 1280, height: 720, timestamp: 1, frameTimestamp: 2, eyeResult: { ...snapshot.eyeResult, leftEye: { ...snapshot.eyeResult.leftEye, center: { x: .72, y: .4 } }, rightEye: { ...snapshot.eyeResult.rightEye, center: { x: .28, y: .4 } } }, positioningState: snapshot.positioning, qualityResult: snapshot.qualityResult, liveQualityResult: snapshot.qualityResult, stability: { positionStable: true, eyeTrackingStable: true, stableForMs: 900, qualitySamples: 2 }, captureIndex: 1, requiredCaptureCount: 1, captureId: 'test-capture' });
  assert.equal(record.schemaVersion, '1.0.0'); assert.equal(record.captureId, 'test-capture'); assert.equal(record.image, image); assert.equal(record.mimeType, 'image/png');
  assert.equal(record.valid, true); assert.equal(record.validationStatus, 'VALIDATED'); assert.deepEqual(record.validation, { component: '6', valid: true });
  assert.equal(record.leftEyeDetection.designation, 'OS'); assert.equal(record.leftEyeDetection.center.x, .72); assert.equal(record.rightEyeDetection.designation, 'OD'); assert.equal(record.rightEyeDetection.center.x, .28);
  assert.equal(record.width, 1280); assert.equal(record.height, 720); assert.equal(record.captureIndex, 1);
});

test('multiple valid-frame count is configurable and every completed capture is counted once', () => {
  const machine = new AutomaticCaptureStateMachine({ stableDurationMs: 0, minimumDistinctQualitySamples: 1, requiredCaptureCount: 2 });
  updateAt(machine, 1_000, 990); machine.beginCapture(1_000); machine.setValidating(); machine.captureValidated(); machine.captureSucceeded(1_001);
  assert.equal(machine.snapshot().captureCount, 1); assert.equal(machine.snapshot().state, 'WAITING_FOR_STABILITY');
  updateAt(machine, 1_600, 1_590); assert.equal(machine.state, 'READY_TO_CAPTURE');
  machine.beginCapture(1_600); machine.setValidating(); machine.captureValidated(); machine.captureSucceeded(1_601);
  assert.equal(machine.snapshot().captureCount, 2); assert.equal(machine.snapshot().state, 'COMPLETE');
});

class FakeNode {
  constructor() {
    this.listeners = new Map(); this.textContent = ''; this.disabled = false; this.checked = false; this.style = {};
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(listener => listener !== fn)); }
  dispatchEvent(event) { for (const fn of this.listeners.get(event.type) || []) fn(event); return true; }
  insertBefore() {}
}

test('unmount clears the C6 interval hooks, video listeners, temporary canvases, and upstream resources', async () => {
  const previousDocument = globalThis.document, previousWindow = globalThis.window, previousCustomEvent = globalThis.CustomEvent;
  const nodes = new Map(['#capture-consent', '#capture-status', '#capture-heading', '#capture-detail', '#capture-progress', '#capture-feedback', '#capture-position-check', '#capture-eyes-check', '#capture-quality-check', '#capture-restart', '#capture-stop', '#capture-frame'].map(selector => [selector, new FakeNode()]));
  const root = new FakeNode(); root.querySelector = selector => nodes.get(selector); root.dispatchEvent = event => { root.lastEvent = event; return true; };
  const canvases = [];
  globalThis.document = { createElement: () => { const canvas = { width: 0, height: 0, getContext: () => ({ clearRect() {} }) }; canvases.push(canvas); return canvas; } };
  globalThis.window = new FakeNode();
  globalThis.CustomEvent = class extends Event { constructor(type, init = {}) { super(type, init); this.detail = init.detail; } };
  const video = new FakeNode(); Object.assign(video, { videoWidth: 1280, videoHeight: 720, readyState: 2 });
  let qualityCleanupCalls = 0;
  const camera = { getSnapshot: () => ({ previewReady: true }), withVideoFrame: async callback => callback(video) };
  const detector = { getSnapshot: () => ({ latest: null, fresh: false }) };
  try {
    const cleanup = await mountAutomaticCaptureStep(root, { camera, positioningDetector: detector, getLatestEyeResult: () => null, getLatestQuality: () => null, cleanupQualityStep: async () => { qualityCleanupCalls++; } });
    assert.equal((root.listeners.get('image-quality-update') || []).length, 1);
    await cleanup();
    assert.equal((root.listeners.get('image-quality-update') || []).length, 0);
    assert.equal((video.listeners.get('resize') || []).length, 0);
    assert.equal((video.listeners.get('loadedmetadata') || []).length, 0);
    assert.equal((globalThis.window.listeners.get('pagehide') || []).length, 0);
    assert.equal(canvases.length, 2); assert.ok(canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
    assert.equal(qualityCleanupCalls, 1);
  } finally {
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousCustomEvent === undefined) delete globalThis.CustomEvent; else globalThis.CustomEvent = previousCustomEvent;
  }
});
