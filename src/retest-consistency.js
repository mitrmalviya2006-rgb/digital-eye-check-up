export const RETEST_ENGINE_VERSION = '1.0.0';
export const RETEST_RESULT_SCHEMA_VERSION = '1.0.0';

const EYES = Object.freeze([
  Object.freeze({ key: 'rightEye', eye: 'right', designation: 'OD' }),
  Object.freeze({ key: 'leftEye', eye: 'left', designation: 'OS' }),
]);
const PARAMETERS = Object.freeze(['sph', 'cyl', 'axis']);

export const DEFAULT_RETEST_POLICY = Object.freeze({ maxRetests: 2, consistencyTolerances: null });

export function createRetestSession(policy = {}) {
  const settings = resolvePolicy(policy);
  return {
    schemaVersion: RETEST_RESULT_SCHEMA_VERSION,
    engineVersion: RETEST_ENGINE_VERSION,
    state: 'READY',
    maxRetests: settings.maxRetests,
    retestsUsed: 0,
    consistencyTolerances: settings.consistencyTolerances ? { ...settings.consistencyTolerances } : null,
    initialStatus: null,
    attempts: [],
    reasons: [],
    latestResult: null,
  };
}

/** Record each C11 result as an image-free attempt; retain every OD/OS prediction separately. */
export function recordRetestAssessment(session, validityResult, { now = () => Date.now() } = {}) {
  assertSession(session);
  const timestamp = timestampOf(validityResult, now);
  const attempt = {
    attemptNumber: session.attempts.length + 1,
    sourceAttempt: session.attempts.length === 0 ? 'INITIAL' : 'RETEST',
    timestamp,
    validityStatus: validValidityStatus(validityResult?.status) ? validityResult.status : 'INVALID',
    sourceAnalysis: copySafe(validityResult?.sourceAnalysis),
    reasons: copyReasons(validityResult?.reasons),
    rightEye: copyEye(validityResult?.rightEye, 'right', 'OD'),
    leftEye: copyEye(validityResult?.leftEye, 'left', 'OS'),
  };
  const attempts = [...session.attempts, attempt];
  const initialStatus = session.initialStatus || attempt.validityStatus;
  const comparisonAttempts = initialStatus === 'INCONSISTENT' ? attempts.slice(1) : attempts;
  const comparison = compareAttempts(comparisonAttempts, session.consistencyTolerances, initialStatus === 'INCONSISTENT');
  const currentValid = validityResult?.valid === true && validityResult?.status === 'VALID'
    && EYES.every(expected => validityResult[expected.key]?.valid === true
      && validityResult[expected.key]?.status === 'VALID'
      && validityResult[expected.key]?.predictions?.length > 0);
  let status;
  let reasons;
  if (!currentValid) {
    status = session.retestsUsed >= session.maxRetests ? 'FAILED' : 'RETEST_AGAIN';
    reasons = attempt.reasons.length ? attempt.reasons : [{ code: 'VALID_SCREENING_RESULT_UNAVAILABLE', message: 'Component 11 did not confirm a valid bilateral result.' }];
  } else if (comparison.status === 'INCONSISTENT') {
    status = session.retestsUsed >= session.maxRetests ? 'FAILED' : 'RETEST_AGAIN';
    reasons = comparison.reasons;
  } else if (comparison.status === 'UNASSESSED') {
    status = session.retestsUsed >= session.maxRetests ? 'FAILED' : 'RETEST_AGAIN';
    reasons = comparison.reasons;
  } else {
    status = 'PASSED';
    reasons = [];
  }

  const updated = {
    ...session,
    state: status,
    initialStatus,
    attempts,
    reasons,
    latestResult: copySafe(validityResult),
  };
  return { session: updated, result: buildResult(updated, status, comparison, timestamp) };
}

/** Record a terminal C6 capture failure without creating any measurement values. */
export function recordCaptureFailure(session, errorCode = 'CAPTURE_INCOMPLETE', { now = () => Date.now() } = {}) {
  assertSession(session);
  const timestamp = timestampOf(null, now);
  const reasons = [{ code: 'CAPTURE_INCOMPLETE', message: `The existing automatic capture step could not complete a validated capture (${String(errorCode).slice(0, 80)}).` }];
  const attempt = { attemptNumber: session.attempts.length + 1, sourceAttempt: session.attempts.length ? 'RETEST' : 'INITIAL', timestamp, validityStatus: 'RETEST_REQUIRED', sourceAnalysis: null, reasons, rightEye: copyEye(null, 'right', 'OD'), leftEye: copyEye(null, 'left', 'OS') };
  const updated = { ...session, state: session.retestsUsed >= session.maxRetests ? 'FAILED' : 'RETEST_AGAIN', initialStatus: session.initialStatus || 'RETEST_REQUIRED', attempts: [...session.attempts, attempt], reasons, latestResult: null };
  const comparison = compareAttempts([], session.consistencyTolerances);
  return { session: updated, result: buildResult(updated, updated.state, comparison, timestamp) };
}

export function startRetest(session) {
  assertSession(session);
  if (!['RETEST_AGAIN', 'RETEST_REQUIRED'].includes(session.state)) return { ...session, state: 'FAILED', reasons: [{ code: 'RETEST_STATE_INVALID', message: 'A retest cannot begin from the current Component 13 state.' }] };
  if (session.retestsUsed >= session.maxRetests) return { ...session, state: 'FAILED', reasons: [{ code: 'MAX_RETESTS_REACHED', message: 'The configured retest limit has been reached.' }] };
  return { ...session, state: 'PREPARING', retestsUsed: session.retestsUsed + 1 };
}

export function transitionRetestState(session, nextState) {
  assertSession(session);
  const allowed = {
    PREPARING: ['CAPTURING', 'FAILED'],
    CAPTURING: ['ANALYZING', 'FAILED'],
    ANALYZING: ['COMPARING', 'FAILED'],
    COMPARING: ['PASSED', 'RETEST_AGAIN', 'FAILED'],
  };
  if (!allowed[session.state]?.includes(nextState)) throw new TypeError(`Invalid Component 13 transition: ${session.state} → ${nextState}.`);
  return { ...session, state: nextState };
}

export function assessRetestTrigger(validityResult, captureState = null) {
  const reasons = [];
  if (captureState && ['ERROR', 'RETRY_REQUIRED'].includes(captureState.state)) {
    reasons.push({ code: 'CAPTURE_INCOMPLETE', message: 'The automatic capture step could not complete a validated capture.' });
  }
  for (const item of Array.isArray(validityResult?.reasons) ? validityResult.reasons : []) {
    if (item && typeof item.code === 'string' && typeof item.message === 'string') reasons.push({ ...(item.eye ? { eye: item.eye } : {}), code: item.code, message: item.message });
  }
  const needsRetest = validityResult?.status !== 'VALID' || validityResult?.valid !== true
    || validityResult?.component12?.canPresentScreeningEstimate !== true
    || Boolean(captureState && captureState.state !== 'COMPLETE');
  return { required: needsRetest, reasons: uniqueReasons(reasons) };
}

function compareAttempts(attempts, tolerances, requireRepeated = false) {
  const measurements = Object.fromEntries(EYES.map(expected => [expected.designation, collectEligibleMeasurements(attempts, expected)]));
  const comparison = {};
  const reasons = [];
  let unassessed = false;
  for (const expected of EYES) {
    const values = measurements[expected.designation];
    if (!values.length) {
      comparison[expected.designation] = { status: 'INSUFFICIENT_DATA', count: 0, pairwiseMaximumDeltas: null };
      unassessed = true;
      reasons.push({ eye: expected.designation, code: 'VALID_EYE_MEASUREMENT_MISSING', message: `${expected.designation} has no Component 11-valid measurement available for consistency review.` });
      continue;
    }
    if (values.length === 1) {
      comparison[expected.designation] = { status: requireRepeated ? 'UNASSESSED' : 'SINGLE_MEASUREMENT', count: 1, pairwiseMaximumDeltas: null };
      if (requireRepeated) {
        unassessed = true;
        reasons.push({ eye: expected.designation, code: 'REPEAT_MEASUREMENT_REQUIRED', message: `${expected.designation} needs at least two new valid measurements after the earlier inconsistency.` });
      }
      continue;
    }
    if (!tolerances) {
      comparison[expected.designation] = { status: 'UNASSESSED', count: values.length, pairwiseMaximumDeltas: null };
      unassessed = true;
      reasons.push({ eye: expected.designation, code: 'CONSISTENCY_POLICY_UNCONFIGURED', message: `${expected.designation} repeated measurements require configured SPH, CYL, and Axis tolerances.` });
      continue;
    }
    const deltas = { sph: 0, cyl: 0, axis: 0 };
    let missingAxis = false;
    for (let left = 0; left < values.length; left++) for (let right = left + 1; right < values.length; right++) {
      for (const parameter of PARAMETERS) {
        const a = values[left].prediction[parameter], b = values[right].prediction[parameter];
        if (parameter === 'axis' && a === null && b === null
          && values[left].prediction.axisStatus === 'NOT_APPLICABLE'
          && values[right].prediction.axisStatus === 'NOT_APPLICABLE') continue;
        if (!Number.isFinite(a) || !Number.isFinite(b)) { missingAxis ||= parameter === 'axis'; continue; }
        const delta = parameter === 'axis' ? axisDifference(a, b) : Math.abs(a - b);
        deltas[parameter] = Math.max(deltas[parameter], delta);
      }
    }
    const unstable = PARAMETERS.some(parameter => deltas[parameter] > tolerances[parameter]) || missingAxis;
    comparison[expected.designation] = {
      status: unstable ? 'INCONSISTENT' : 'CONSISTENT',
      count: values.length,
      pairwiseMaximumDeltas: deltas,
      tolerances: { ...tolerances },
    };
    if (unstable) reasons.push({ eye: expected.designation, code: missingAxis ? 'CONSISTENCY_PARAMETER_UNAVAILABLE' : 'REPEATED_PREDICTIONS_DISAGREE', message: `${expected.designation} repeated measurements do not all satisfy the configured consistency rules.` });
  }
  const inconsistent = EYES.some(expected => comparison[expected.designation].status === 'INCONSISTENT');
  return {
    status: inconsistent ? 'INCONSISTENT' : unassessed ? 'UNASSESSED' : 'CONSISTENT',
    eyes: comparison,
    measurements,
    reasons,
  };
}

function collectEligibleMeasurements(attempts, expected) {
  return attempts.flatMap(attempt => {
    const group = attempt[expected.key];
    if (group.status !== 'VALID') return [];
    return group.predictions.filter(prediction => prediction.valid === true && prediction.eye === expected.eye && prediction.designation === expected.designation)
      .map(prediction => ({ attemptNumber: attempt.attemptNumber, timestamp: attempt.timestamp, prediction }));
  });
}

function buildResult(session, status, comparison, timestamp) {
  const recommendation = status === 'PASSED'
    ? 'Technical screening checks passed. This is not a diagnosis or prescription; seek professional assessment when appropriate.'
    : status === 'RETEST_AGAIN'
      ? 'Another measurement is needed. Follow the existing capture instructions; estimates remain withheld until checks pass.'
      : 'A reliable screening result could not be obtained. Stop retesting and arrange a professional eye examination.';
  return {
    schemaVersion: RETEST_RESULT_SCHEMA_VERSION,
    engineVersion: RETEST_ENGINE_VERSION,
    status,
    state: status,
    retestsUsed: session.retestsUsed,
    maxRetests: session.maxRetests,
    attempts: session.attempts,
    rightEye: { designation: 'OD', ...comparison.eyes.OD, measurements: comparison.measurements.OD },
    leftEye: { designation: 'OS', ...comparison.eyes.OS, measurements: comparison.measurements.OS },
    consistency: { status: comparison.status, tolerances: session.consistencyTolerances ? { ...session.consistencyTolerances } : null },
    reasons: [...session.reasons],
    recommendation,
    timestamp,
    presentation: {
      canPresent: status === 'PASSED',
      mode: status === 'PASSED' ? 'PRESERVE_EACH_MEASUREMENT' : 'WITHHOLD_ESTIMATES',
      aggregationMethod: null,
    },
    session: { retestsUsed: session.retestsUsed, maxRetests: session.maxRetests },
  };
}

function copyEye(group, eye, designation) {
  const predictions = Array.isArray(group?.predictions) ? group.predictions.map(prediction => ({
    valid: prediction?.valid === true,
    eye: prediction?.eye ?? eye,
    designation: prediction?.designation ?? designation,
    sourceCaptureId: typeof prediction?.sourceCaptureId === 'string' ? prediction.sourceCaptureId : null,
    sourcePredictionId: typeof prediction?.sourcePredictionId === 'string' ? prediction.sourcePredictionId : null,
    sph: Number.isFinite(prediction?.sph) ? prediction.sph : null,
    cyl: Number.isFinite(prediction?.cyl) ? prediction.cyl : null,
    axis: Number.isFinite(prediction?.axis) || prediction?.axis === null ? prediction.axis : null,
    axisStatus: typeof prediction?.axisStatus === 'string' ? prediction.axisStatus : 'UNAVAILABLE',
    units: prediction?.units && typeof prediction.units === 'object' ? { ...prediction.units } : null,
    confidence: copySafe(prediction?.confidence) || { status: 'UNAVAILABLE' },
    uncertainty: copySafe(prediction?.uncertainty) || { status: 'UNAVAILABLE' },
    modelId: typeof prediction?.modelId === 'string' ? prediction.modelId : null,
    modelVersion: typeof prediction?.modelVersion === 'string' ? prediction.modelVersion : null,
  })) : [];
  return { eye, designation, status: group?.status || 'MISSING', valid: group?.valid === true, predictions };
}

function copyReasons(reasons) { return Array.isArray(reasons) ? reasons.filter(reason => typeof reason?.code === 'string' && typeof reason?.message === 'string').map(reason => ({ ...(reason.eye ? { eye: reason.eye } : {}), code: reason.code, message: reason.message })) : []; }
function copySafe(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(copySafe);
  if (!value || typeof value !== 'object') return null;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/(image|blob|pixel|feature.?vector|raw.?frame|bitmap|dataurl)/i.test(key)).map(([key, item]) => [key, copySafe(item)]));
}
function resolvePolicy(policy) {
  const value = { ...DEFAULT_RETEST_POLICY, ...policy };
  if (!Number.isSafeInteger(value.maxRetests) || value.maxRetests < 0
    || (value.consistencyTolerances !== null && (!value.consistencyTolerances || PARAMETERS.some(parameter => !Number.isFinite(value.consistencyTolerances[parameter]) || value.consistencyTolerances[parameter] < 0)))) {
    throw new TypeError('Component 13 requires a non-negative retry limit and explicit finite per-parameter consistency tolerances.');
  }
  return value;
}
function assertSession(session) {
  if (!session || session.schemaVersion !== RETEST_RESULT_SCHEMA_VERSION || session.engineVersion !== RETEST_ENGINE_VERSION || !Array.isArray(session.attempts)) throw new TypeError('A Component 13 session is required.');
}
function validValidityStatus(status) { return ['VALID', 'LOW_CONFIDENCE', 'INCONSISTENT', 'RETEST_REQUIRED', 'INVALID'].includes(status); }
function timestampOf(result, now) {
  const parsed = typeof result?.timestamp === 'string' ? Date.parse(result.timestamp) : NaN;
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  try { const supplied = new Date(now()); if (Number.isFinite(supplied.getTime())) return supplied.toISOString(); } catch { /* use the local clock */ }
  return new Date().toISOString();
}
function axisDifference(a, b) { const difference = Math.abs(a - b) % 180; return Math.min(difference, 180 - difference); }
function uniqueReasons(reasons) { return [...new Map(reasons.map(item => [`${item.eye || ''}:${item.code}`, item])).values()]; }
