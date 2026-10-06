import test from 'node:test';
import assert from 'node:assert/strict';
import { assessSafety, createMedicalSafetyLayer, safetyStatusCopy } from '../src/safety.js';
import { preparePrescriptionResult } from '../src/prescription-result-step.js';
import { validateQuestionnaire } from '../src/validation.js';
import { createLocalDataStore } from '../src/local-data-store.js';

const questionnaire = () => ({ suddenVisionChange: 'no', painfulSymptoms: 'no', seriousEyeInjury: 'no', pendingEyeSurgeryFollowup: 'no', blurredVision: 'no', eyeConditionHistory: 'no', steadyGaze: 'no', lastExam: 'within-year' });
const validPrediction = (eye, designation) => ({ valid: true, eye, designation, sph: -1.25, cyl: -0.5, axis: 90, axisStatus: 'AVAILABLE', units: { sph: 'D', cyl: 'D', axis: 'deg' }, sourceCaptureId: `capture-${designation}`, sourcePredictionId: `prediction-${designation}` });
const validGroup = (eye, designation) => ({ eye, designation, status: 'VALID', valid: true, predictionCount: 1, predictions: [validPrediction(eye, designation)] });
const validity = () => ({ schemaVersion: '1.0.0', engineVersion: '1.0.0', technicalValidityOnly: true, clinicalValidity: 'NOT_ASSESSED', status: 'VALID', valid: true, overallValid: true, timestamp: '2026-10-06T00:00:00.000Z', component12: { status: 'READY_FOR_SCREENING_ESTIMATE', canPresentScreeningEstimate: true }, rightEye: validGroup('right', 'OD'), leftEye: validGroup('left', 'OS'), reasons: [] });

test('normal screening has a versioned technical-only safe status', () => {
  const result = assessSafety({ questionnaire: questionnaire() }, { now: () => Date.UTC(2026, 9, 6) });
  assert.equal(result.status, 'SAFE_TO_SCREEN');
  assert.equal(result.canPresentEstimate, true);
  assert.equal(result.clinicalDiagnosis, 'NOT_PROVIDED');
  assert.equal(result.timestamp, '2026-10-06T00:00:00.000Z');
});

test('urgent self-reported symptoms stop routine screening without diagnosing', () => {
  for (const field of ['suddenVisionChange', 'painfulSymptoms', 'seriousEyeInjury', 'pendingEyeSurgeryFollowup']) {
    const result = assessSafety({ questionnaire: { ...questionnaire(), [field]: 'yes' } });
    assert.equal(result.status, 'STOP_AND_SEEK_CARE', field);
    assert.equal(result.canContinue, false);
    assert.ok(result.recommendations.some(message => /professional|urgent/i.test(message)));
  }
});

test('C1 validation blocks the routine route for reported injury or pending surgery follow-up', () => {
  const base = { age: '25', previousPrescription: 'no', right: {}, left: {}, wearsCorrection: 'no', lastExam: 'within-year', blurredVision: 'no', suddenVisionChange: 'no', painfulSymptoms: 'no', seriousEyeInjury: 'yes', pendingEyeSurgeryFollowup: 'no', eyeConditionHistory: 'no', steadyGaze: 'no', historyDescription: '', requiredConsent: true };
  assert.equal(validateQuestionnaire(base).safety.status, 'STOP_AND_SEEK_CARE');
});

test('technical failures require retest while unsupported requirements limit screening', () => {
  assert.equal(assessSafety({ imageQuality: { valid: false, overallStatus: 'RETAKE' } }).status, 'REQUIRES_RETEST');
  assert.equal(assessSafety({ predictionResult: { valid: false } }).status, 'REQUIRES_RETEST');
  assert.equal(assessSafety({ predictionResult: { predictionStatus: 'UNAVAILABLE', error: { code: 'MODEL_NOT_CONFIGURED' } } }).status, 'SCREENING_LIMITED');
  assert.equal(assessSafety({ capture: { complete: false, status: 'INCOMPLETE' } }).status, 'REQUIRES_RETEST');
  assert.equal(assessSafety({ validityResult: { status: 'LOW_CONFIDENCE', valid: false } }).status, 'REQUIRES_RETEST');
  assert.equal(assessSafety({ validityResult: { status: 'INCONSISTENT', valid: false } }).status, 'REQUIRES_RETEST');
  assert.equal(assessSafety({ compatibility: { status: 'UNSUPPORTED', required: { camera: { available: false } } } }).status, 'SCREENING_LIMITED');
  assert.equal(assessSafety({ compatibility: { compute: { modelRuntime: { available: false } } } }).status, 'SCREENING_LIMITED');
});

test('Component 13 requires a retest for instability and allows an explicitly passed result', () => {
  assert.equal(assessSafety({ retestResult: { status: 'RETEST_AGAIN' } }).status, 'REQUIRES_RETEST');
  assert.equal(assessSafety({ validityResult: { status: 'LOW_CONFIDENCE', valid: false }, retestResult: { status: 'PASSED', presentation: { canPresent: true } } }).status, 'SAFE_TO_SCREEN');
  assert.equal(assessSafety({ retestResult: { status: 'FAILED' } }).status, 'SCREENING_LIMITED');
});

test('safety layer stores the same bounded decision in Component 16 session memory', () => {
  let stored = null;
  const layer = createMedicalSafetyLayer({ localDataStore: { setSessionValue: (key, value) => { assert.equal(key, 'medicalSafetyResult'); stored = value; } }, now: () => 0 });
  const result = layer.assess({ questionnaire: questionnaire() });
  assert.equal(stored.status, 'SAFE_TO_SCREEN');
  assert.deepEqual(layer.getSnapshot(), result);
});

test('Component 16 validates safety records and keeps them in the resettable session only', async () => {
  const store = createLocalDataStore({ indexedDB: null });
  const result = assessSafety({ questionnaire: questionnaire() });
  store.setSessionValue('medicalSafetyResult', result);
  assert.equal(store.getSessionValue('medicalSafetyResult').status, 'SAFE_TO_SCREEN');
  assert.throws(() => store.setSessionValue('medicalSafetyResult', { schemaVersion: '1.0.0', status: 'SAFE_TO_SCREEN' }), /Medical safety result/);
  store.resetSession();
  assert.equal(store.getSessionValue('medicalSafetyResult'), null);
  await store.close();
});

test('Component 12 withholds valid-looking values unless central safety explicitly permits display', () => {
  const valid = validity();
  const stop = assessSafety({ questionnaire: { ...questionnaire(), painfulSymptoms: 'yes' } });
  const result = preparePrescriptionResult(valid, { safetyResult: stop });
  assert.equal(result.canPresent, false);
  assert.equal(result.eyes.every(eye => !eye.estimate), true);
  assert.equal(result.reasons[0].code, 'EYE_PAIN_OR_REDNESS');
});

test('Component 12 preserves OD/OS separately for allowed technical results', () => {
  const result = preparePrescriptionResult(validity(), { safetyResult: assessSafety({ questionnaire: questionnaire() }) });
  assert.equal(result.canPresent, true);
  assert.deepEqual(result.eyes.map(eye => eye.designation), ['OD', 'OS']);
  assert.equal(result.eyes[0].estimate.sph, -1.25);
  assert.equal(result.eyes[1].estimate.cyl, -0.5);
});

test('user-facing messages stay non-diagnostic and status-specific', () => {
  const copy = safetyStatusCopy({ status: 'STOP_AND_SEEK_CARE' });
  assert.match(copy.message, /Contact an eye-care professional/);
  assert.doesNotMatch(copy.message, /you have|diagnosed with/i);
});
