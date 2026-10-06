import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeImageQuality, imageQualityFailure } from '../src/image-quality.js';
import { QualitySampler } from '../src/quality-sampler.js';
import { EyeTracker } from '../src/eye-tracker.js';

const LEFT_BOX = { left: 0.28, top: 0.34, right: 0.42, bottom: 0.50 };
const RIGHT_BOX = { left: 0.58, top: 0.34, right: 0.72, bottom: 0.50 };

function frame({ width = 640, height = 360, left = 130, right = 130, contrast = 30, sharp = true, glare = false, boxes = [LEFT_BOX, RIGHT_BOX] } = {}) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) { pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 130; pixels[offset + 3] = 255; }
  for (const [index, [box, base]] of [[boxes[0], left], [boxes[1], right]].entries()) {
    const x0 = Math.floor(box.left * width), x1 = Math.ceil(box.right * width), y0 = Math.floor(box.top * height), y1 = Math.ceil(box.bottom * height);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      let value = sharp ? base + ((x + y) % 2 ? contrast : -contrast) : base;
      if (glare && index === 0 && x < x0 + (x1 - x0) * 0.55) value = 255;
      const offset = (y * width + x) * 4;
      pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = Math.max(0, Math.min(255, value));
    }
  }
  return { pixels, width, height, sourceWidth: width, sourceHeight: height, timestamp: 1234 };
}

function eye(boundingBox, options = {}) {
  return {
    detected: options.detected ?? true, designation: options.designation ?? 'OS', boundingBox,
    validity: { geometryState: options.geometryState ?? 'VALID' }, iris: { detected: options.irisDetected ?? true },
    eyelid: { state: options.openness ?? 'OPEN' }, confidence: Object.hasOwn(options, 'confidence') ? options.confidence : 0.9,
    visibility: { state: options.visibility ?? 'VISIBLE' },
  };
}
function eyeResult(options = {}) {
  return {
    frameWidth: 640, frameHeight: 360,
    leftEye: eye(options.leftBox ?? LEFT_BOX, { ...(options.left || {}), designation: 'OS' }),
    rightEye: eye(options.rightBox ?? RIGHT_BOX, { ...(options.right || {}), designation: 'OD' }),
    bothEyesGeometryValid: options.bothEyesGeometryValid ?? true,
    trackingStable: options.trackingStable ?? true,
  };
}
function positioning(options = {}) {
  return { ready: options.ready ?? true, stable: options.stable ?? true, distanceStatus: options.distanceStatus ?? 'ACCEPTABLE', faceBoundingBox: options.faceBoundingBox ?? { left: 0.2, top: 0.12, right: 0.8, bottom: 0.86 } };
}
function check(image = frame(), eyes = eyeResult(), pos = positioning(), options = {}) {
  return analyzeImageQuality(image, { eyeResult: eyes, positioning: pos, positioningFresh: options.fresh ?? true, previousEyeCenters: options.previousEyeCenters, config: options.config });
}
function has(result, code) { return result.reasons.some(reason => reason.code === code); }

test('good sharp two-eye frame is capture-ready only with explicit confidence and visibility evidence', () => {
  const result = check();
  assert.equal(result.schemaVersion, '1.0.0'); assert.equal(result.valid, true); assert.equal(result.overallStatus, 'GOOD'); assert.equal(result.captureReady, true);
  assert.equal(result.leftEye.sharpness.state, 'SHARP'); assert.equal(result.rightEye.sharpness.state, 'SHARP');
  assert.equal(result.leftEye.eye, 'left'); assert.equal(result.rightEye.eye, 'right');
  assert.equal(result.blur.state, 'SHARP'); assert.equal(result.lighting.state, 'ACCEPTABLE'); assert.equal(result.glare.state, 'NO_EXCESSIVE_GLARE_DETECTED');
});

test('missing, malformed, corrupt, and low-resolution frame data are rejected with structured reasons', () => {
  const missing = analyzeImageQuality(null);
  assert.equal(missing.reasons[0].code, 'FRAME_MISSING'); assert.equal(missing.overallStatus, 'RETAKE');
  for (const key of ['image', 'leftEye', 'rightEye', 'blur', 'exposure', 'lighting', 'glare', 'motion', 'positioning', 'eyeVisibility', 'occlusion', 'detectionConfidence']) assert.ok(key in missing, key);
  assert.equal(analyzeImageQuality({ pixels: new Uint8Array(0), width: 0, height: 360 }).reasons[0].code, 'INVALID_DIMENSIONS');
  assert.equal(analyzeImageQuality({ pixels: [], width: 10, height: 10 }).reasons[0].code, 'PIXEL_DATA_INVALID');
  const low = check(frame({ width: 320, height: 240 }));
  assert.equal(low.valid, false); assert.ok(has(low, 'INSUFFICIENT_RESOLUTION'));
});

test('eye-region Laplacian variance distinguishes a crisp eye ROI from a uniform blurred ROI', () => {
  const crisp = check(frame()); const blurred = check(frame({ sharp: false }));
  assert.ok(crisp.leftEye.sharpness.laplacianVariance > blurred.leftEye.sharpness.laplacianVariance);
  assert.equal(crisp.leftEye.sharpness.state, 'SHARP'); assert.equal(blurred.leftEye.sharpness.state, 'BLURRED');
  assert.ok(has(blurred, 'LOW_SHARPNESS'));
});

test('eye-region luminance percentiles detect underexposure, overexposure, and uneven lighting', () => {
  const dark = check(frame({ left: 28, right: 28 }));
  const bright = check(frame({ left: 245, right: 245, contrast: 10 }));
  const uneven = check(frame({ left: 90, right: 180 }));
  assert.equal(dark.leftEye.exposure.state, 'UNDEREXPOSED'); assert.ok(has(dark, 'TOO_DARK'));
  assert.equal(bright.exposure.state, 'OVEREXPOSED'); assert.ok(has(bright, 'OVEREXPOSED'));
  assert.equal(uneven.lighting.state, 'UNEVEN'); assert.ok(has(uneven, 'UNEVEN_LIGHTING'));
});

test('severe shadows are a separate check and isolated small highlights are tolerated', () => {
  const shadow = check(frame({ left: 75, right: 75, contrast: 65 }));
  const smallHighlight = frame();
  const x = Math.floor(LEFT_BOX.left * smallHighlight.width) + 3, y = Math.floor(LEFT_BOX.top * smallHighlight.height) + 3;
  const offset = (y * smallHighlight.width + x) * 4;
  smallHighlight.pixels[offset] = smallHighlight.pixels[offset + 1] = smallHighlight.pixels[offset + 2] = 255;
  const highlightResult = check(smallHighlight);
  assert.equal(shadow.leftEye.exposure.shadowState, 'SEVERE_SHADOW'); assert.ok(has(shadow, 'SEVERE_SHADOW'));
  assert.equal(highlightResult.leftEye.glare.state, 'CHECKED'); assert.equal(has(highlightResult, 'EXCESSIVE_GLARE'), false);
});

test('a small-in-eye but large-in-iris saturated region is detected as glare', () => {
  const image = frame();
  const eyes = eyeResult();
  eyes.leftEye.iris.boundary = [{ x: 0.34, y: 0.39 }, { x: 0.37, y: 0.39 }, { x: 0.37, y: 0.44 }, { x: 0.34, y: 0.44 }];
  for (let y = 141; y < 151; y++) for (let x = 219; x < 229; x++) {
    const offset = (y * image.width + x) * 4;
    image.pixels[offset] = image.pixels[offset + 1] = image.pixels[offset + 2] = 255;
  }
  const result = check(image, eyes);
  assert.equal(result.leftEye.glare.state, 'EXCESSIVE'); assert.ok(has(result, 'EXCESSIVE_GLARE'));
  assert.ok(result.leftEye.glare.brightPixelRatio < 0.055); assert.ok(result.leftEye.glare.irisBrightPixelRatio > 0.25);
});

test('closed left, right, and both eyes independently block the frame', () => {
  const left = check(frame(), eyeResult({ left: { openness: 'CLOSED' } }));
  const right = check(frame(), eyeResult({ right: { openness: 'PARTIALLY_CLOSED' } }));
  const both = check(frame(), eyeResult({ left: { openness: 'CLOSED' }, right: { openness: 'CLOSED' } }));
  assert.equal(left.leftEye.openness, 'CLOSED'); assert.ok(left.leftEye.reasons.some(reason => reason.code === 'EYE_CLOSED')); assert.equal(left.valid, false);
  assert.ok(right.rightEye.reasons.some(reason => reason.code === 'EYE_CLOSED'));
  assert.equal(both.reasons.filter(reason => reason.code === 'EYE_CLOSED').length, 2);
});

test('missing eye detection and incomplete landmarks never substitute the other eye', () => {
  const missing = check(frame(), eyeResult({ left: { detected: false }, bothEyesGeometryValid: false }));
  const incomplete = check(frame(), eyeResult({ right: { geometryState: 'INVALID', irisDetected: false }, bothEyesGeometryValid: false }));
  assert.ok(has(missing, 'EYE_NOT_DETECTED')); assert.equal(missing.leftEye.boundingBox, null);
  assert.ok(incomplete.rightEye.reasons.some(reason => reason.code === 'EYE_LANDMARKS_INCOMPLETE'));
  assert.equal(missing.valid, false);
});

test('low confidence rejects while unavailable confidence or occlusion stays UNKNOWN', () => {
  const low = check(frame(), eyeResult({ left: { confidence: 0.2 } }));
  const currentModel = check(frame(), eyeResult({ left: { confidence: null, visibility: 'UNAVAILABLE' }, right: { confidence: null, visibility: 'UNAVAILABLE' } }));
  assert.ok(has(low, 'LOW_EYE_CONFIDENCE')); assert.equal(low.overallStatus, 'RETAKE');
  assert.ok(has(currentModel, 'EYE_CONFIDENCE_UNAVAILABLE')); assert.ok(has(currentModel, 'EYE_OCCLUSION_UNVERIFIED'));
  assert.equal(currentModel.leftEye.visibility.state, 'UNKNOWN');
  assert.equal(currentModel.valid, false); assert.equal(currentModel.overallStatus, 'UNKNOWN'); assert.equal(currentModel.captureReady, false);
});

test('eye edge margin, excessive highlights, movement, and poor positioning each produce actionable failure codes', () => {
  const edge = check(frame(), eyeResult({ leftBox: { ...LEFT_BOX, left: 0.005, right: 0.145 } }));
  const glare = check(frame({ glare: true }));
  const motion = check(frame(), eyeResult(), positioning(), { previousEyeCenters: { leftEye: { x: 0.25, y: 0.42 }, rightEye: { x: 0.65, y: 0.42 } } });
  const badPosition = check(frame(), eyeResult(), positioning({ ready: false }));
  assert.ok(has(edge, 'EYE_TOO_CLOSE_TO_EDGE'));
  assert.equal(glare.leftEye.glare.state, 'EXCESSIVE'); assert.ok(has(glare, 'EXCESSIVE_GLARE'));
  assert.ok(has(motion, 'MOTION_DETECTED')); assert.equal(motion.motion.state, 'UNSTABLE');
  assert.ok(has(badPosition, 'BAD_POSITION')); assert.equal(badPosition.valid, false);
});

test('tiny or off-frame eye regions are rejected rather than clipped into usable boxes', () => {
  const tooSmall = check(frame(), eyeResult({ leftBox: { left: 0.32, top: 0.4, right: 0.34, bottom: 0.43 } }));
  const outside = check(frame(), eyeResult({ leftBox: { left: 0.92, top: 0.4, right: 1.08, bottom: 0.56 } }));
  assert.ok(has(tooSmall, 'EYE_TOO_SMALL'));
  assert.ok(has(outside, 'EYE_OUTSIDE_FRAME')); assert.equal(outside.leftEye.boundingBox.right, 1.08);
});

test('face cropping and too-far/too-close position states reuse Component 3 positioning data', () => {
  const cropped = check(frame(), eyeResult(), positioning({ faceBoundingBox: { left: 0, top: 0.12, right: 0.8, bottom: 0.86 } }));
  const far = check(frame(), eyeResult(), positioning({ distanceStatus: 'TOO_FAR' }));
  const close = check(frame(), eyeResult(), positioning({ distanceStatus: 'TOO_CLOSE' }));
  assert.ok(has(cropped, 'FACE_CROPPED')); assert.ok(has(far, 'DISTANCE_TOO_FAR')); assert.ok(has(close, 'DISTANCE_TOO_CLOSE'));
});

test('simultaneous independent failures are all preserved and no category score masks them', () => {
  const result = check(frame({ left: 20, right: 20, sharp: false }), eyeResult({ left: { openness: 'CLOSED', confidence: 0.1 } }), positioning({ ready: false }));
  for (const code of ['LOW_SHARPNESS', 'TOO_DARK', 'EYE_CLOSED', 'LOW_EYE_CONFIDENCE', 'BAD_POSITION']) assert.ok(has(result, code), code);
  assert.equal(result.valid, false); assert.equal(result.overallStatus, 'RETAKE');
});

test('state transitions and Component 6 interface are deterministic and machine-readable', () => {
  const sequence = [check(), check(frame({ sharp: false })), check()];
  assert.deepEqual(sequence.map(item => item.overallStatus), ['GOOD', 'RETAKE', 'GOOD']);
  for (const result of sequence) { assert.equal(typeof result.valid, 'boolean'); assert.equal(result.captureReady, result.valid); assert.ok(Array.isArray(result.reasons)); }
  assert.equal(imageQualityFailure('PIXEL_DATA_UNAVAILABLE').overallStatus, 'UNKNOWN');
  assert.equal(imageQualityFailure('FRAME_STALE', 1, 'RETAKE').overallStatus, 'RETAKE');
});

test('Component 4 schema with no confidence or occlusion score is never presented as fully valid', () => {
  const c4Like = eyeResult({ left: { confidence: null, visibility: 'UNAVAILABLE' }, right: { confidence: null, visibility: 'UNAVAILABLE' } });
  const result = check(frame(), c4Like);
  assert.equal(result.leftEye.confidence.state, 'UNAVAILABLE'); assert.equal(result.occlusion.state, 'UNKNOWN');
  assert.equal(result.valid, false); assert.equal(result.technicalUsable, true);
});

test('real Component 4 EyeTracker output is consumed without inventing confidence or visibility', () => {
  const ring = ids => [[ids[0], ids[1]], [ids[1], ids[2]], [ids[2], ids[3]], [ids[3], ids[4]], [ids[0], ids[5]], [ids[5], ids[6]], [ids[6], ids[7]], [ids[7], ids[4]]].map(([start, end]) => ({ start, end }));
  const points = Array.from({ length: 24 }, () => ({ x: 0.5, y: 0.4, z: 0 }));
  function setEye(offset, centerX) {
    const centerY = 0.41, half = 0.05, gap = 0.025;
    [[centerX-half,centerY],[centerX-half/2,centerY-gap],[centerX,centerY-gap*1.3],[centerX+half/2,centerY-gap],[centerX+half,centerY],[centerX-half/2,centerY+gap],[centerX,centerY+gap*1.3],[centerX+half/2,centerY+gap]].forEach(([x,y],i) => { points[offset+i] = { x,y,z:0 }; });
  }
  function setIris(offset, centerX) { [[centerX-.008,.41],[centerX,.398],[centerX+.008,.41],[centerX,.422]].forEach(([x,y],i)=>{points[offset+i]={x,y,z:0};}); }
  setEye(0,.27); setEye(8,.73); setIris(16,.27); setIris(20,.73);
  const detection = { landmarks: points, videoDimensions: { width: 1280, height: 720 }, timestamp: 0, eyeTopology: { rightEye: ring([0,1,2,3,4,5,6,7]), leftEye: ring([8,9,10,11,12,13,14,15]), rightIris: [16,17,18,19].map((id,i,ids)=>({start:id,end:ids[(i+1)%4]})), leftIris: [20,21,22,23].map((id,i,ids)=>({start:id,end:ids[(i+1)%4]})) } };
  const tracker = new EyeTracker({ trackingWindow: 2, stableDurationMs: 100, stableCenterRange: 0.04, stableScaleRange: 0.05 });
  tracker.update(detection, { positioningReady: true, timestamp: 0 });
  const c4 = tracker.update(detection, { positioningReady: true, timestamp: 100 });
  const result = check(frame({ width: 1280, height: 720, boxes: [c4.leftEye.boundingBox, c4.rightEye.boundingBox] }), c4, positioning());
  assert.equal(c4.analysisStatus, 'GEOMETRY_STABLE'); assert.equal(c4.leftEye.confidence, null); assert.equal(c4.rightEye.visibility.state, 'UNAVAILABLE');
  assert.equal(result.technicalUsable, true); assert.equal(result.overallStatus, 'UNKNOWN'); assert.equal(result.valid, false);
  assert.ok(has(result, 'EYE_CONFIDENCE_UNAVAILABLE')); assert.ok(has(result, 'EYE_OCCLUSION_UNVERIFIED'));
});

test('quality sampler throttles overlapping work and cleanup prevents later timer samples', async () => {
  let callback, cleared = false, calls = 0, unblock;
  const sampler = new QualitySampler({ intervalMs: 10, setTimer: fn => { callback = fn; return 7; }, clearTimer: id => { cleared = id === 7; }, sample: () => { calls++; return new Promise(resolve => { unblock = resolve; }); } });
  sampler.start(); await Promise.resolve(); callback(); assert.equal(calls, 1);
  sampler.stop(); assert.equal(cleared, true); unblock(); await Promise.resolve(); callback(); await Promise.resolve();
  assert.equal(calls, 1); assert.equal(sampler.running, false);
});
