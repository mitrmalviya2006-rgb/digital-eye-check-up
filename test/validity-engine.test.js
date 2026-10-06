import test from 'node:test';
import assert from 'node:assert/strict';
import { assessEyeValidity, VALIDITY_ENGINE_VERSION } from '../src/validity-engine.js';

const domains = {
  sph: { min: -20, max: 20, minInclusive: true, maxInclusive: true, unit: 'D' },
  cyl: { min: -20, max: 0, minInclusive: true, maxInclusive: true, unit: 'D' },
  axis: { min: 0, max: 180, minInclusive: true, maxInclusive: false, unit: 'deg' },
};
const policy = {
  confidenceMinimumByKind: { probability: .7 },
  uncertaintyMaximumByFormat: {},
  consistencyTolerances: { sph: .5, cyl: .5, axis: 15 },
};

function qualityEye(eye, designation) {
  return {
    eye, designation, state: 'GOOD', detected: true, geometryComplete: true, openness: 'OPEN',
    confidence: { state: 'SUFFICIENT', value: .9, threshold: .65 },
    visibility: { state: 'VISIBLE', geometryPresent: true }, occlusionState: 'CLEAR',
    sharpness: { state: 'SHARP', value: 50, threshold: 32 },
    exposureState: 'ACCEPTABLE', glareState: 'CHECKED', reasons: [],
  };
}

function quality() {
  return {
    schemaVersion: '1.0.0', valid: true, overallStatus: 'GOOD', captureReady: true,
    blurState: 'SHARP', exposureState: 'ACCEPTABLE', lightingState: 'ACCEPTABLE',
    glareState: 'NO_EXCESSIVE_GLARE_DETECTED',
    motion: { state: 'STABLE', stable: true, eyeMovementPixels: 0 },
    positioning: { state: 'ACCEPTABLE', positioningReady: true, distanceStatus: 'ACCEPTABLE' },
    eyes: { OD: qualityEye('right', 'OD'), OS: qualityEye('left', 'OS') }, reasons: [],
  };
}

function captureEvidence(sourceCaptureId, captureIndex = 1) {
  return {
    schemaVersion: '1.0.0', sourceCaptureId, captureIndex, requiredCaptureCount: 1,
    stability: { positionStable: true, eyeTrackingStable: true, stableForMs: 900, qualitySamples: 2 },
    positioning: { status: 'READY', ready: true, stable: true, distanceStatus: 'ACCEPTABLE' },
    capturedQuality: quality(), liveQuality: quality(),
  };
}

function prediction(eye, designation, sourceCaptureId, values = {}) {
  return {
    eye, designation, sourceCaptureId, sourcePredictionId: `prediction-${sourceCaptureId}`,
    valid: true, status: 'VALID', sph: eye === 'right' ? -1.25 : -2.5, cyl: -.5,
    axis: eye === 'right' ? 90 : 45, axisStatus: 'AVAILABLE', axisConvention: 'canonical-180',
    units: { sph: 'D', cyl: 'D', axis: 'deg' },
    confidence: { status: 'AVAILABLE', value: .9, kind: 'probability' },
    uncertainty: { status: 'UNAVAILABLE', value: null },
    modelId: 'local-refraction-model', modelVersion: 'model-v1',
    captureEvidence: captureEvidence(sourceCaptureId),
    ...values,
  };
}

function analysis({ right = [prediction('right', 'OD', 'capture-1')], left = [prediction('left', 'OS', 'capture-1')], captureCount = 1, overrides = {} } = {}) {
  const model = {
    id: 'local-refraction-model', version: 'model-v1', axisConvention: 'canonical-180',
    outputDomains: structuredClone(domains),
    outputConfidenceDomain: { kind: 'probability', min: 0, max: 1, minInclusive: true, maxInclusive: true },
    outputUncertaintyFormat: null,
  };
  return {
    analysisSchemaVersion: '1.0.0', analysisVersion: '1.0.0', analysisStatus: 'ANALYZED',
    structurallyValid: true, clinicalValidity: 'NOT_ASSESSED',
    sourcePrediction: {
      model, inputValidity: { valid: true, captureCount, featureSchemaVersion: '1.0.0', sourcePreprocessingVersion: '1.0.0' },
      outputValidity: { valid: true },
    },
    rightEye: { eye: 'right', designation: 'OD', status: 'VALID', predictions: right },
    leftEye: { eye: 'left', designation: 'OS', status: 'VALID', predictions: left },
    ...overrides,
  };
}

test('passes valid independent predictions with explicit confidence, image, and capture evidence', () => {
  const result = assessEyeValidity(analysis(), { policy, now: () => 1_700_000_000_000 });
  assert.equal(result.engineVersion, VALIDITY_ENGINE_VERSION);
  assert.equal(result.valid, true);
  assert.equal(result.status, 'VALID');
  assert.equal(result.component12.status, 'READY_FOR_SCREENING_ESTIMATE');
  assert.equal(result.component12.canPresentScreeningEstimate, true);
  assert.equal(result.component13.status, 'NOT_REQUIRED');
  assert.equal(result.clinicalValidity, 'NOT_ASSESSED');
  assert.equal(result.rightEye.predictions[0].sph, -1.25);
  assert.equal(result.leftEye.predictions[0].sph, -2.5);
  assert.equal(result.timestamp, '2023-11-14T22:13:20.000Z');
});

test('rejects non-finite and out-of-domain refractive values without changing them', () => {
  const invalidRight = prediction('right', 'OD', 'capture-1', { sph: Number.NaN });
  const result = assessEyeValidity(analysis({ right: [invalidRight] }), { policy });
  assert.equal(result.rightEye.status, 'INVALID');
  assert.equal(result.rightEye.predictionCount, 0);
  assert.ok(result.reasons.some(item => item.code === 'REFRACTION_VALUE_NONFINITE'));
  assert.equal(result.leftEye.predictions[0].sph, -2.5);
  assert.equal(result.status, 'RETEST_REQUIRED');

  const bothInvalid = analysis({
    right: [{ eye: 'right', designation: 'OD', sourceCaptureId: 'capture-1', valid: false, status: 'INVALID' }],
    left: [{ eye: 'left', designation: 'OS', sourceCaptureId: 'capture-1', valid: false, status: 'INVALID' }],
  });
  assert.equal(assessEyeValidity(bothInvalid, { policy }).status, 'INVALID');
});

test('marks model confidence below the configured threshold as LOW_CONFIDENCE', () => {
  const low = prediction('right', 'OD', 'capture-1', { confidence: { status: 'AVAILABLE', value: .6, kind: 'probability' } });
  const result = assessEyeValidity(analysis({ right: [low] }), { policy });
  assert.equal(result.status, 'LOW_CONFIDENCE');
  assert.equal(result.rightEye.status, 'LOW_CONFIDENCE');
  assert.ok(result.reasons.some(item => item.code === 'MODEL_CONFIDENCE_LOW'));
  assert.equal(result.component12.canPresentScreeningEstimate, false);
});

test('keeps a missing eye separate and never swaps OD/right with OS/left', () => {
  const missingRight = { eye: 'right', designation: 'OD', sourceCaptureId: 'capture-1', valid: false, status: 'MISSING' };
  const result = assessEyeValidity(analysis({ right: [missingRight] }), { policy });
  assert.equal(result.rightEye.designation, 'OD');
  assert.equal(result.rightEye.status, 'RETEST_REQUIRED');
  assert.equal(result.leftEye.designation, 'OS');
  assert.equal(result.leftEye.status, 'VALID');
  assert.equal(result.leftEye.predictions[0].eye, 'left');
  assert.equal(result.status, 'RETEST_REQUIRED');
  assert.equal(result.component13.affectedEyes.includes('OD'), true);
});

test('detects repeated-prediction disagreement and retains captures without averaging', () => {
  const firstRight = prediction('right', 'OD', 'capture-1');
  const secondRight = prediction('right', 'OD', 'capture-2', {
    sourcePredictionId: 'prediction-capture-2', sph: 1.5, axis: 2,
    captureEvidence: captureEvidence('capture-2', 2),
  });
  const firstLeft = prediction('left', 'OS', 'capture-1');
  const secondLeft = prediction('left', 'OS', 'capture-2', {
    sourcePredictionId: 'prediction-capture-2', captureEvidence: captureEvidence('capture-2', 2),
  });
  const result = assessEyeValidity(analysis({ right: [firstRight, secondRight], left: [firstLeft, secondLeft], captureCount: 2 }), { policy });
  assert.equal(result.status, 'INCONSISTENT');
  assert.equal(result.rightEye.status, 'INCONSISTENT');
  assert.equal(result.rightEye.consistency.status, 'INCONSISTENT');
  assert.equal(result.rightEye.predictions.length, 2);
  assert.deepEqual(result.rightEye.predictions.map(item => item.sph), [-1.25, 1.5]);
  assert.equal(result.component13.status, 'RETEST_REQUIRED');
  assert.equal(result.component12.canPresentScreeningEstimate, false);
});

test('routes consistent repeat captures to Component 13 review before a single estimate can display', () => {
  const right = [
    prediction('right', 'OD', 'capture-1'),
    prediction('right', 'OD', 'capture-2', { sourcePredictionId: 'prediction-capture-2', sph: -1.2, axis: 92, captureEvidence: captureEvidence('capture-2', 2) }),
  ];
  const left = [
    prediction('left', 'OS', 'capture-1'),
    prediction('left', 'OS', 'capture-2', { sourcePredictionId: 'prediction-capture-2', sph: -2.45, axis: 46, captureEvidence: captureEvidence('capture-2', 2) }),
  ];
  const result = assessEyeValidity(analysis({ right, left, captureCount: 2 }), { policy });
  assert.equal(result.status, 'VALID');
  assert.equal(result.component12.status, 'CONSISTENCY_REVIEW_REQUIRED');
  assert.equal(result.component12.canPresentScreeningEstimate, false);
  assert.equal(result.component13.status, 'CONSISTENCY_REVIEW_REQUIRED');
  assert.deepEqual(result.component13.affectedEyes, ['OD', 'OS']);
});

test('requests retest for unavailable axis, reliability metadata, or capture evidence', () => {
  const withoutReliability = prediction('right', 'OD', 'capture-1', {
    confidence: { status: 'UNAVAILABLE', value: null },
    uncertainty: { status: 'UNAVAILABLE', value: null },
    axis: null, axisStatus: 'UNAVAILABLE',
  });
  const withoutEvidence = prediction('left', 'OS', 'capture-1', { captureEvidence: null });
  const result = assessEyeValidity(analysis({ right: [withoutReliability], left: [withoutEvidence] }), { policy });
  assert.equal(result.status, 'RETEST_REQUIRED');
  assert.ok(result.reasons.some(item => item.code === 'AXIS_UNAVAILABLE'));
  assert.ok(result.reasons.some(item => item.code === 'RELIABILITY_EVIDENCE_UNAVAILABLE'));
  assert.ok(result.reasons.some(item => item.code === 'CAPTURE_QUALITY_UNAVAILABLE'));
  assert.equal(result.component13.retestRequired, true);
});

test('retests conflicting or insufficiently configured repeated measurements and bad capture quality', () => {
  const first = prediction('right', 'OD', 'capture-1');
  const second = prediction('right', 'OD', 'capture-2', { captureEvidence: captureEvidence('capture-2', 2) });
  second.sph = first.sph;
  second.sourcePredictionId = 'prediction-capture-2';
  const missingThresholds = assessEyeValidity(analysis({ right: [first, second], left: [
    prediction('left', 'OS', 'capture-1'), prediction('left', 'OS', 'capture-2', { sourcePredictionId: 'prediction-capture-2', captureEvidence: captureEvidence('capture-2', 2) }),
  ], captureCount: 2 }), { policy: { confidenceMinimumByKind: { probability: .7 } } });
  assert.equal(missingThresholds.status, 'RETEST_REQUIRED');
  assert.ok(missingThresholds.reasons.some(item => item.code === 'CONSISTENCY_POLICY_UNCONFIGURED'));

  const poor = quality();
  poor.rightEye = undefined;
  const badEvidencePrediction = prediction('right', 'OD', 'capture-1', { captureEvidence: { ...captureEvidence('capture-1'), capturedQuality: { ...quality(), eyes: { OD: null, OS: null } } } });
  const badEvidence = assessEyeValidity(analysis({ right: [badEvidencePrediction] }), { policy });
  assert.equal(badEvidence.status, 'RETEST_REQUIRED');

  const blurredQuality = quality();
  blurredQuality.blurState = 'BLUR_DETECTED';
  blurredQuality.motion = { state: 'UNSTABLE', stable: false, eyeMovementPixels: 12 };
  blurredQuality.eyes.OD.sharpness.state = 'BLURRED';
  const blurredCapture = captureEvidence('capture-1');
  blurredCapture.capturedQuality = blurredQuality;
  const blurredResult = assessEyeValidity(analysis({ right: [prediction('right', 'OD', 'capture-1', { captureEvidence: blurredCapture })] }), { policy });
  assert.equal(blurredResult.rightEye.status, 'RETEST_REQUIRED');
  assert.ok(blurredResult.reasons.some(item => item.code === 'IMAGE_QUALITY_FAILED'));
  assert.ok(blurredResult.reasons.some(item => item.code === 'IMAGE_BLUR'));
  assert.ok(blurredResult.reasons.some(item => item.code === 'CAPTURE_MOTION_UNSTABLE'));
});

test('reports Component 12 and Component 13 machine-readable decisions for each final status', () => {
  const valid = assessEyeValidity(analysis(), { policy });
  assert.deepEqual(valid.component12, {
    status: 'READY_FOR_SCREENING_ESTIMATE', canPresentScreeningEstimate: true,
    clinicalValidity: 'NOT_ASSESSED', predictionCounts: { OD: 1, OS: 1 },
  });
  const rejected = assessEyeValidity({ ...analysis(), structurallyValid: false, analysisStatus: 'REJECTED', structuralValidationErrors: [{ code: 'BAD' }] }, { policy });
  assert.equal(rejected.status, 'INVALID');
  assert.equal(rejected.component12.status, 'BLOCKED');
  assert.equal(rejected.component13.status, 'RETEST_REQUIRED');
});
