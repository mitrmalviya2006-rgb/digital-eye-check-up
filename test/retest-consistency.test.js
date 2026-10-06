import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetestSession, recordRetestAssessment, recordCaptureFailure, startRetest, transitionRetestState } from '../src/retest-consistency.js';

function prediction(eye, designation, sph, source = 'cap') {
  return { valid: true, eye, designation, sourceCaptureId: source, sourcePredictionId: `${source}-${designation}`, sph, cyl: -.5, axis: eye === 'right' ? 90 : 45, axisStatus: 'AVAILABLE', units: { sph: 'D', cyl: 'D', axis: 'deg' }, confidence: { status: 'UNAVAILABLE' }, uncertainty: { status: 'UNAVAILABLE' } };
}
function validity({ status = 'VALID', rightStatus = 'VALID', leftStatus = 'VALID', right = [prediction('right', 'OD', -1)], left = [prediction('left', 'OS', -2)], now = '2026-10-06T10:00:00.000Z' } = {}) {
  const eye = (eye, designation, eyeStatus, predictions) => ({ eye, designation, status: eyeStatus, valid: eyeStatus === 'VALID', predictions, reasons: [] });
  return { schemaVersion: '1.0.0', engineVersion: '1.0.0', timestamp: now, status, valid: status === 'VALID', overallValid: status === 'VALID', component12: { canPresentScreeningEstimate: status === 'VALID' && right.length === 1 && left.length === 1 }, sourceAnalysis: { captureCount: Math.max(right.length, left.length), predictionModelId: 'local-model' }, reasons: status === 'VALID' ? [] : [{ code: status === 'LOW_CONFIDENCE' ? 'MODEL_CONFIDENCE_LOW' : 'CAPTURE_QUALITY_FAILED', message: 'The technical check did not pass.' }], rightEye: eye('right', 'OD', rightStatus, right), leftEye: eye('left', 'OS', leftStatus, left) };
}
const configured = { maxRetests: 2, consistencyTolerances: { sph: .5, cyl: .5, axis: 10 } };
const fixedClock = () => Date.parse('2026-10-06T10:01:00.000Z');

test('a valid first Component 11 result passes without modifying either eye', () => {
  const { result } = recordRetestAssessment(createRetestSession(configured), validity(), { now: fixedClock });
  assert.equal(result.status, 'PASSED');
  assert.equal(result.presentation.canPresent, true);
  assert.equal(result.rightEye.measurements[0].prediction.sph, -1);
  assert.equal(result.leftEye.measurements[0].prediction.sph, -2);
  assert.equal(result.presentation.aggregationMethod, null);
});

for (const trigger of ['RETEST_REQUIRED', 'LOW_CONFIDENCE']) test(`poor quality/low confidence triggers retest after ${trigger}`, () => {
  const initial = validity({ status: trigger });
  let { session, result } = recordRetestAssessment(createRetestSession(configured), initial, { now: fixedClock });
  assert.equal(result.status, 'RETEST_AGAIN');
  session = startRetest(session);
  session = transitionRetestState(session, 'CAPTURING');
  session = transitionRetestState(session, 'ANALYZING');
  session = transitionRetestState(session, 'COMPARING');
  ({ session, result } = recordRetestAssessment(session, validity({ now: '2026-10-06T10:02:00.000Z' }), { now: fixedClock }));
  assert.equal(result.status, 'PASSED');
  assert.equal(result.attempts.length, 2);
});

test('consistent repeated values pass independently for OD and OS and remain separate', () => {
  let { session } = recordRetestAssessment(createRetestSession(configured), validity(), { now: fixedClock });
  session = startRetest(session);
  const repeated = validity({ right: [prediction('right', 'OD', -1.25, 'cap-2')], left: [prediction('left', 'OS', -2.25, 'cap-2')], now: '2026-10-06T10:02:00.000Z' });
  const { result } = recordRetestAssessment(session, repeated, { now: fixedClock });
  assert.equal(result.status, 'PASSED');
  assert.deepEqual(result.rightEye.measurements.map(item => item.prediction.sph), [-1, -1.25]);
  assert.deepEqual(result.leftEye.measurements.map(item => item.prediction.sph), [-2, -2.25]);
  assert.equal(result.rightEye.status, 'CONSISTENT');
  assert.equal(result.leftEye.status, 'CONSISTENT');
});

test('Axis comparison uses the documented modulo-180 circular distance', () => {
  const initialRight = prediction('right', 'OD', -1, 'a'); initialRight.axis = 179;
  const initialLeft = prediction('left', 'OS', -2, 'a'); initialLeft.axis = 45;
  let { session } = recordRetestAssessment(createRetestSession(configured), validity({ right: [initialRight], left: [initialLeft] }), { now: fixedClock });
  session = startRetest(session);
  const right = prediction('right', 'OD', -1, 'b'); right.axis = 1;
  const left = prediction('left', 'OS', -2, 'b'); left.axis = 45;
  const { result } = recordRetestAssessment(session, validity({ right: [right], left: [left], now: '2026-10-06T10:02:00.000Z' }), { now: fixedClock });
  assert.equal(result.status, 'PASSED');
  assert.equal(result.rightEye.pairwiseMaximumDeltas.axis, 2);
});

test('inconsistent repeated values request a retry and are never averaged', () => {
  let { session } = recordRetestAssessment(createRetestSession(configured), validity(), { now: fixedClock });
  session = startRetest(session);
  const repeated = validity({ right: [prediction('right', 'OD', 2, 'cap-2')], now: '2026-10-06T10:02:00.000Z' });
  const { session: next, result } = recordRetestAssessment(session, repeated, { now: fixedClock });
  assert.equal(result.status, 'RETEST_AGAIN');
  assert.equal(result.rightEye.status, 'INCONSISTENT');
  assert.equal(result.presentation.canPresent, false);
  assert.equal(result.presentation.aggregationMethod, null);
  assert.ok(result.reasons.some(item => item.code === 'REPEATED_PREDICTIONS_DISAGREE'));
  assert.equal(next.attempts.length, 2);
});

test('one-eye failure remains mapped separately and preserves the valid eye record', () => {
  const partial = validity({ status: 'RETEST_REQUIRED', rightStatus: 'INVALID', right: [], left: [prediction('left', 'OS', -2)] });
  const { result } = recordRetestAssessment(createRetestSession(configured), partial, { now: fixedClock });
  assert.equal(result.status, 'RETEST_AGAIN');
  assert.equal(result.attempts[0].rightEye.designation, 'OD');
  assert.equal(result.attempts[0].leftEye.designation, 'OS');
  assert.equal(result.attempts[0].rightEye.predictions.length, 0);
  assert.equal(result.attempts[0].leftEye.predictions[0].eye, 'left');
});

test('an earlier inconsistent bundle requires two new valid comparisons', () => {
  let { session } = recordRetestAssessment(createRetestSession(configured), validity({ status: 'INCONSISTENT', rightStatus: 'INCONSISTENT' }), { now: fixedClock });
  session = startRetest(session);
  let outcome = recordRetestAssessment(session, validity({ now: '2026-10-06T10:02:00.000Z' }), { now: fixedClock });
  assert.equal(outcome.result.status, 'RETEST_AGAIN');
  session = startRetest(outcome.session);
  outcome = recordRetestAssessment(session, validity({ now: '2026-10-06T10:03:00.000Z' }), { now: fixedClock });
  assert.equal(outcome.result.status, 'PASSED');
  assert.equal(outcome.result.rightEye.measurements.length, 2);
});

test('maximum retry count fails closed and capture errors add no fake measurements', () => {
  let { session } = recordRetestAssessment(createRetestSession(configured), validity({ status: 'INVALID' }), { now: fixedClock });
  session = startRetest(session);
  let outcome = recordRetestAssessment(session, validity({ status: 'INVALID' }), { now: fixedClock });
  session = startRetest(outcome.session);
  outcome = recordCaptureFailure(session, 'CAMERA_BUSY', { now: fixedClock });
  assert.equal(outcome.result.status, 'FAILED');
  assert.equal(outcome.result.presentation.canPresent, false);
  assert.equal(outcome.result.attempts[2].rightEye.predictions.length, 0);
  assert.ok(outcome.result.reasons.some(item => item.code === 'CAPTURE_INCOMPLETE'));
});

test('retest state transitions are explicit and invalid transitions throw', () => {
  let session = createRetestSession(configured);
  session = { ...session, state: 'RETEST_AGAIN' };
  session = startRetest(session);
  for (const state of ['CAPTURING', 'ANALYZING', 'COMPARING', 'PASSED']) session = transitionRetestState(session, state);
  assert.equal(session.state, 'PASSED');
  assert.throws(() => transitionRetestState(session, 'CAPTURING'), /Invalid Component 13 transition/);
});
