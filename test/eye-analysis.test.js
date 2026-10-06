import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzePredictionResult,
  EYE_ANALYSIS_SCHEMA_VERSION,
  EYE_ANALYSIS_VERSION,
} from '../src/eye-analysis.js';
import { mountEyeAnalysisStep } from '../src/eye-analysis-step.js';

const domains = {
  sph: { min: -20, max: 20, minInclusive: true, maxInclusive: true, unit: 'D' },
  cyl: { min: -20, max: 0, minInclusive: true, maxInclusive: true, unit: 'D' },
  axis: { min: 0, max: 180, minInclusive: true, maxInclusive: false, unit: 'deg' },
};

function makeEye(side, overrides = {}) {
  const right = side === 'right';
  return {
    eye: side,
    designation: right ? 'OD' : 'OS',
    sph: right ? -1.25 : -2.5,
    cyl: -.5,
    axis: right ? 90 : 45,
    units: { sph: 'D', cyl: 'D', axis: 'deg' },
    axisConvention: 'fixture-canonical-degrees',
    confidence: { value: null, status: 'UNAVAILABLE', reason: 'Not emitted by model.' },
    uncertainty: { value: null, status: 'UNAVAILABLE', reason: 'Not emitted by model.' },
    valid: true,
    ...overrides,
  };
}

function makePrediction(captures = [{ sourceCaptureId: 'capture-1', predictionId: 'batch-1:capture-1' }]) {
  return {
    predictionSchemaVersion: '1.0.0',
    predictionEngineVersion: '1.0.0',
    predictionBatchId: 'batch-1',
    model: {
      id: 'local-refraction-fixture',
      version: 'fixture-v2',
      runtime: 'fixture-local-runtime',
      artifactFormat: 'fixture-only',
      artifactSha256: 'a'.repeat(64),
      manifestVersion: '1.0.0',
      decoderId: 'documented-fixture-decoder',
      inputDataType: 'float32',
      inputTensorShape: [1, 2],
      axisConvention: 'fixture-canonical-degrees',
      outputDomains: structuredClone(domains),
      outputConfidenceDomain: null,
      outputUncertaintyFormat: null,
    },
    inferenceTimestamp: 1700000000000,
    inferenceTimeMs: 3.5,
    inputValidity: { valid: true, featureSchemaVersion: '1.0.0', sourcePreprocessingVersion: '1.0.0', captureCount: captures.length },
    outputValidity: { valid: true },
    clinicalValidity: 'NOT_ASSESSED',
    component11ReliabilityAssessmentRequired: true,
    valid: true,
    captures: captures.map((capture, index) => ({
      sourceCaptureId: capture.sourceCaptureId,
      ...(capture.predictionId ? { predictionId: capture.predictionId } : {}),
      rightEye: capture.rightEye || makeEye('right', index ? { sph: -1.5 - index } : {}),
      leftEye: capture.leftEye || makeEye('left', index ? { sph: -2.75 - index } : {}),
    })),
  };
}

test('normalizes a valid OD prediction without changing its decoded values', () => {
  const result = analyzePredictionResult(makePrediction());
  assert.equal(result.analysisStatus, 'ANALYZED');
  assert.equal(result.rightEye.eye, 'right');
  assert.equal(result.rightEye.designation, 'OD');
  assert.equal(result.rightEye.valid, true);
  assert.equal(result.rightEye.predictions[0].sph, -1.25);
  assert.equal(result.rightEye.predictions[0].axis, 90);
  assert.equal(result.rightEye.predictions[0].sourcePredictionId, 'batch-1:capture-1');
});

test('normalizes a valid OS prediction independently from OD', () => {
  const result = analyzePredictionResult(makePrediction());
  assert.equal(result.leftEye.eye, 'left');
  assert.equal(result.leftEye.designation, 'OS');
  assert.equal(result.leftEye.predictions[0].sph, -2.5);
  assert.notEqual(result.leftEye.predictions[0].sph, result.rightEye.predictions[0].sph);
});

test('accepts bilateral results with explicit anatomical identities and model metadata', () => {
  const result = analyzePredictionResult(makePrediction());
  assert.equal(result.analysisSchemaVersion, EYE_ANALYSIS_SCHEMA_VERSION);
  assert.equal(result.analysisVersion, EYE_ANALYSIS_VERSION);
  assert.equal(result.overallValid, true);
  assert.equal(result.sourcePrediction.model.version, 'fixture-v2');
  assert.equal(result.sourcePrediction.model.id, 'local-refraction-fixture');
  assert.equal(result.component11ReliabilityAssessmentRequired, true);
  assert.equal(result.clinicalValidity, 'NOT_ASSESSED');
});

test('represents one missing eye explicitly while retaining the other eye independently', () => {
  for (const [missing, present] of [['rightEye', 'leftEye'], ['leftEye', 'rightEye']]) {
    const prediction = makePrediction();
    delete prediction.captures[0][missing];
    const result = analyzePredictionResult(prediction);
    assert.equal(result.analysisStatus, 'PARTIAL');
    assert.equal(result.overallValid, false);
    assert.equal(result[present].predictions[0].valid, true);
    assert.equal(result[missing].predictions[0].status, 'MISSING');
    assert.equal(result[missing].predictions[0].sph, undefined);
    assert.equal(result.structurallyValid, true);
  }
});

test('preserves explicit per-eye invalid states without passing their values', () => {
  const prediction = makePrediction();
  prediction.captures[0].leftEye = { eye: 'left', designation: 'OS', status: 'INVALID', valid: false, errorCode: 'INVALID_MODEL_OUTPUT' };
  const result = analyzePredictionResult(prediction);
  assert.equal(result.analysisStatus, 'PARTIAL');
  assert.equal(result.rightEye.predictions[0].valid, true);
  assert.equal(result.leftEye.predictions[0].status, 'INVALID');
  assert.equal(result.leftEye.predictions[0].sph, undefined);

  prediction.captures[0].leftEye.sph = 0;
  assert.equal(analyzePredictionResult(prediction).analysisStatus, 'REJECTED');
});

test('rejects swapped and duplicate anatomical eye identities', () => {
  const swapped = makePrediction();
  [swapped.captures[0].rightEye, swapped.captures[0].leftEye] = [swapped.captures[0].leftEye, swapped.captures[0].rightEye];
  assert.equal(analyzePredictionResult(swapped).structuralValidationErrors[0].code, 'EYE_IDENTITY_MISMATCH');

  const duplicate = makePrediction();
  duplicate.captures[0].leftEye = makeEye('right');
  assert.equal(analyzePredictionResult(duplicate).structuralValidationErrors[0].code, 'EYE_IDENTITY_MISMATCH');
});

test('rejects invalid SPH, CYL, and Axis values without clamping or zero substitution', () => {
  const cases = [
    ['rightEye', { sph: Number.NaN }, 'PREDICTION_VALUE_INVALID'],
    ['leftEye', { cyl: 0.01 }, 'PREDICTION_VALUE_INVALID'],
    ['rightEye', { axis: 180 }, 'PREDICTION_AXIS_INVALID'],
    ['leftEye', { axis: Infinity }, 'PREDICTION_AXIS_INVALID'],
  ];
  for (const [key, changes, code] of cases) {
    const prediction = makePrediction();
    prediction.captures[0][key] = { ...prediction.captures[0][key], ...changes };
    const result = analyzePredictionResult(prediction);
    assert.equal(result.analysisStatus, 'REJECTED');
    assert.equal(result.structuralValidationErrors[0].code, code);
    assert.deepEqual(result.rightEye.predictions, []);
    assert.deepEqual(result.leftEye.predictions, []);
  }
});

test('preserves unavailable and model-declared confidence/uncertainty states', () => {
  const unavailable = analyzePredictionResult(makePrediction()).rightEye.predictions[0];
  assert.deepEqual(unavailable.confidence, { status: 'UNAVAILABLE', value: null, reason: 'Not emitted by model.' });
  assert.equal(unavailable.uncertainty.status, 'UNAVAILABLE');

  const prediction = makePrediction();
  prediction.model.outputConfidenceDomain = { kind: 'probability', min: 0, max: 1, minInclusive: true, maxInclusive: true };
  prediction.model.outputUncertaintyFormat = 'variance-vector-v1';
  for (const eye of [prediction.captures[0].rightEye, prediction.captures[0].leftEye]) {
    eye.confidence = { value: .82, status: 'AVAILABLE', kind: 'probability' };
    eye.uncertainty = { value: { sph: .1, cyl: .2, axis: .3 }, status: 'AVAILABLE', format: 'variance-vector-v1' };
  }
  const result = analyzePredictionResult(prediction);
  assert.deepEqual(result.leftEye.predictions[0].confidence, { status: 'AVAILABLE', value: .82, kind: 'probability' });
  assert.deepEqual(result.rightEye.predictions[0].uncertainty.value, { sph: .1, cyl: .2, axis: .3 });
});

test('preserves explicitly unavailable Axis without deriving or converting it', () => {
  const prediction = makePrediction();
  prediction.captures[0].rightEye.axis = null;
  prediction.captures[0].rightEye.axisStatus = 'NOT_APPLICABLE';
  const result = analyzePredictionResult(prediction);
  assert.equal(result.rightEye.predictions[0].axis, null);
  assert.equal(result.rightEye.predictions[0].axisStatus, 'NOT_APPLICABLE');
  assert.equal(result.leftEye.predictions[0].axis, 45);
});

test('groups multiple predictions per eye and capture without averaging', () => {
  const result = analyzePredictionResult(makePrediction([
    { sourceCaptureId: 'capture-1', predictionId: 'batch-1:capture-1' },
    { sourceCaptureId: 'capture-2', predictionId: 'batch-1:capture-2' },
    { sourceCaptureId: 'capture-3', predictionId: 'batch-1:capture-3' },
  ]));
  assert.equal(result.rightEye.predictions.length, 3);
  assert.equal(result.leftEye.predictions.length, 3);
  assert.deepEqual(result.rightEye.predictions.map(item => item.sourceCaptureId), ['capture-1', 'capture-2', 'capture-3']);
  assert.deepEqual(result.leftEye.predictions.map(item => item.sourcePredictionId), ['batch-1:capture-1', 'batch-1:capture-2', 'batch-1:capture-3']);
  assert.equal(result.rightEye.predictions[0].sph, -1.25);
  assert.equal(result.rightEye.predictions[1].sph, -2.5);
});

test('rejects duplicate capture identities and missing model domains', () => {
  const duplicate = makePrediction([
    { sourceCaptureId: 'capture-1', predictionId: 'a' },
    { sourceCaptureId: 'capture-1', predictionId: 'b' },
  ]);
  assert.equal(analyzePredictionResult(duplicate).structuralValidationErrors[0].code, 'SOURCE_CAPTURE_ID_INVALID');

  const duplicatePredictionId = makePrediction([
    { sourceCaptureId: 'capture-1', predictionId: 'duplicate-id' },
    { sourceCaptureId: 'capture-2', predictionId: 'duplicate-id' },
  ]);
  assert.equal(analyzePredictionResult(duplicatePredictionId).structuralValidationErrors[0].code, 'PREDICTION_ID_INVALID');

  const noDomain = makePrediction();
  delete noDomain.model.outputDomains.axis;
  assert.equal(analyzePredictionResult(noDomain).structuralValidationErrors[0].code, 'MODEL_DOMAIN_INVALID');
});

test('represents Component 9 unavailable/error outcomes explicitly for both eyes', () => {
  const prediction = {
    predictionSchemaVersion: '1.0.0',
    predictionEngineVersion: '1.0.0',
    model: null,
    predictionStatus: 'UNAVAILABLE',
    inputValidity: { valid: true, featureSchemaVersion: '1.0.0', sourcePreprocessingVersion: '1.0.0', captureCount: 2, status: 'NOT_EVALUATED_BY_MODEL' },
    outputValidity: { valid: false },
    clinicalValidity: 'NOT_ASSESSED',
    component11ReliabilityAssessmentRequired: true,
    sourceCaptureIds: ['capture-1', 'capture-2'],
    valid: false,
    error: { code: 'MODEL_NOT_CONFIGURED', message: 'No local model.' },
  };
  const result = analyzePredictionResult(prediction);
  assert.equal(result.analysisStatus, 'UNAVAILABLE');
  assert.equal(result.rightEye.status, 'UNAVAILABLE');
  assert.equal(result.leftEye.status, 'UNAVAILABLE');
  assert.equal(result.rightEye.valid, false);
  assert.equal(result.rightEye.predictions[0].designation, 'OD');
  assert.equal(result.leftEye.predictions[0].designation, 'OS');
  assert.deepEqual(result.leftEye.predictions.map(item => item.sourceCaptureId), ['capture-1', 'capture-2']);
});

test('keeps Component 11 and 12 data UI-independent and compatible', () => {
  const result = analyzePredictionResult(makePrediction());
  assert.equal(result.component11InputCompatible, true);
  assert.equal(result.rightEye.predictions[0].valid, true);
  assert.equal(result.leftEye.predictions[0].confidence.value, null);
  assert.equal(result.component12DataAvailable, undefined, 'C10 does not claim Component 11 approval or final display readiness');
  assert.equal(result.rightEye.designation, 'OD');
  assert.equal(result.leftEye.designation, 'OS');
  assert.ok(Array.isArray(result.rightEye.predictions));
  assert.ok(Array.isArray(result.leftEye.predictions));
});

test('C10 screen emits the normalized handoff but never displays prescription values', async t => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousCustomEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete globalThis.document;
    if (previousCustomEvent) Object.defineProperty(globalThis, 'CustomEvent', previousCustomEvent);
    else delete globalThis.CustomEvent;
  });
  globalThis.document = { createElement: () => ({ textContent: '' }) };
  globalThis.CustomEvent = class { constructor(type, options) { this.type = type; Object.assign(this, options); } };
  const nodes = new Map();
  for (const id of ['#eye-analysis-heading', '#eye-analysis-detail', '#eye-analysis-summary', '#eye-analysis-error', '#eye-analysis-status', '#eye-analysis-stop']) {
    nodes.set(id, {
      textContent: '',
      children: [],
      listeners: new Map(),
      classList: { add() {} },
      replaceChildren(...children) { this.children = children; },
      addEventListener(type, handler) { this.listeners.set(type, handler); },
      removeEventListener(type, handler) { if (this.listeners.get(type) === handler) this.listeners.delete(type); },
    });
  }
  const events = [];
  const root = {
    innerHTML: '',
    querySelector(selector) { return nodes.get(selector); },
    dispatchEvent(event) { events.push(event); return true; },
  };
  const cleanup = mountEyeAnalysisStep(root, { predictionResult: makePrediction() });
  assert.equal(events[0].type, 'eye-analysis-complete');
  assert.equal(events[0].detail.analysisStatus, 'ANALYZED');
  assert.match(nodes.get('#eye-analysis-summary').children[0].textContent, /Right eye \(OD\)/);
  assert.match(nodes.get('#eye-analysis-summary').children[1].textContent, /Left eye \(OS\)/);
  assert.doesNotMatch(root.innerHTML, /-1\.25|-2\.5/);
  await cleanup();
  assert.equal(nodes.get('#eye-analysis-stop').listeners.size, 0);
});
