import { URGENT_RESPONSES } from './config.js';

export const MEDICAL_SAFETY_ENGINE_VERSION = '1.0.0';
export const SAFETY_STATUSES = Object.freeze(['SAFE_TO_SCREEN', 'REQUIRES_RETEST', 'SCREENING_LIMITED', 'STOP_AND_SEEK_CARE']);

/**
 * Central, non-diagnostic screening boundary for C1, C5–C13, C16, and C17.
 * Configured values are procedural states, never medical thresholds.
 */
export function assessSafety(input = {}, { now = () => Date.now() } = {}) {
  const context = isRecord(input) ? input : {};
  const questionnaire = questionnaireFrom(context.questionnaire || context.questionnaireResult || context);
  const reasons = [];
  const warnings = [];
  const recommendations = ['This tool provides vision screening/refractive-error estimates only; it does not diagnose eye disease or guarantee accuracy. A professional eye examination may still be needed.'];

  urgentAnswer(questionnaire, 'suddenVisionChange', 'SUDDEN_VISION_CHANGE', 'You reported a sudden change in vision.', reasons);
  urgentAnswer(questionnaire, 'painfulSymptoms', 'EYE_PAIN_OR_REDNESS', 'You reported eye pain, significant redness, or unusual light sensitivity.', reasons);
  urgentAnswer(questionnaire, 'seriousEyeInjury', 'EYE_INJURY_NEEDS_ASSESSMENT', 'You reported a serious eye injury that has not been assessed.', reasons);
  urgentAnswer(questionnaire, 'pendingEyeSurgeryFollowup', 'EYE_SURGERY_FOLLOWUP_PENDING', 'You reported that follow-up after eye surgery is still needed.', reasons);

  if (questionnaire.blurredVision === 'yes') warnings.push(issue('CURRENT_BLURRED_VISION', 'Blurred vision was reported; this screening cannot determine its cause.'));
  if (questionnaire.eyeConditionHistory === 'yes') warnings.push(issue('EYE_HISTORY_REPORTED', 'An eye condition or prior eye surgery was reported; this screening cannot assess or replace its follow-up care.'));
  if (questionnaire.lastExam === 'never' || questionnaire.lastExam === 'more-than-two-years') warnings.push(issue('EYE_EXAM_NOT_RECENT', 'A comprehensive eye examination may be appropriate; this screening is not a substitute.'));
  if (questionnaire.steadyGaze === 'yes') warnings.push(issue('STEADY_GAZE_DIFFICULTY', 'Difficulty keeping a steady gaze was reported; image checks may be limited.'));

  const compatibility = context.compatibility;
  if (compatibility?.status === 'LIMITED') warnings.push(issue('DEVICE_COMPATIBILITY_LIMITED', 'One or more optional device features or local model capabilities are unavailable.'));
  if (compatibility?.status === 'UNSUPPORTED' || Object.values(compatibility?.required || {}).some(capability => capability?.available === false)) {
    reasons.push(issue('DEVICE_REQUIREMENTS_UNAVAILABLE', 'This browser/device is missing a capability required by the current screening pipeline.'));
    recommendations.push('Use a supported browser/device or seek a professional eye examination.');
  }
  if (compatibility?.compute?.modelRuntime?.available === false) {
    reasons.push(issue('PREDICTION_MODEL_UNAVAILABLE', 'The configured local prediction model is unavailable on this device/browser.'));
    recommendations.push('A reliable automated estimate cannot be produced until a compatible, validated local model is configured; arrange a professional eye examination.');
  }

  const quality = context.imageQuality;
  if (quality && (quality.valid === false || ['RETAKE', 'UNKNOWN', 'INVALID'].includes(quality.overallStatus))) {
    reasons.push(issue('IMAGE_QUALITY_INSUFFICIENT', 'Required image-quality evidence is missing or did not pass the configured technical checks.'));
    recommendations.push('Adjust lighting and positioning, then repeat the quality/capture step if it is available.');
  }
  if (context.capture && (context.capture.complete === false || context.capture.valid === false || ['FAILED', 'ERROR', 'INCOMPLETE'].includes(context.capture.status))) {
    reasons.push(issue('CAPTURE_INCOMPLETE', 'The camera capture did not complete with the required technical evidence.'));
    recommendations.push('Repeat capture through the existing guided camera flow.');
  }

  const prediction = context.predictionResult;
  if (prediction && (prediction.predictionStatus === 'UNAVAILABLE' || prediction.error?.code === 'MODEL_NOT_CONFIGURED')) {
    reasons.push(issue('PREDICTION_MODEL_UNAVAILABLE', 'No configured local prediction model produced a screening estimate.'));
    recommendations.push('A reliable automated estimate cannot be produced in this version; arrange a professional eye examination.');
  } else if (prediction && (prediction.valid === false || prediction.outputValidity?.valid === false)) {
    reasons.push(issue('PREDICTION_OUTPUT_INVALID', 'The prediction output failed its technical validity checks.'));
    recommendations.push('Do not use this output. Retry only through the configured retest flow; otherwise seek professional assessment.');
  }

  const retest = context.retestResult;
  const retestPassed = retest?.status === 'PASSED' && retest?.presentation?.canPresent === true;
  const validity = context.validityResult;
  if (!retestPassed && validity && (validity.valid === false || ['INVALID', 'LOW_CONFIDENCE', 'INCONSISTENT', 'RETEST_REQUIRED'].includes(validity.status))) {
    reasons.push(issue(validity.status === 'LOW_CONFIDENCE' ? 'LOW_CONFIDENCE' : validity.status === 'INCONSISTENT' ? 'MEASUREMENTS_INCONSISTENT' : 'VALIDITY_CHECK_FAILED', `Component 11 technical status is ${validity.status || 'invalid'}.`));
    recommendations.push('Do not treat the estimate as reliable. Follow the retest instructions; if a reliable result cannot be obtained, arrange professional assessment.');
  }

  if (retest?.status === 'FAILED' || retest?.state === 'FAILED') {
    reasons.push(issue('RETEST_LIMIT_REACHED', 'The configured retest limit was reached without a reliable screening result.'));
    recommendations.push('Stop automated retesting and arrange a professional eye examination.');
  } else if (retest && ['RETEST_REQUIRED', 'RETEST_AGAIN'].includes(retest.status)) {
    reasons.push(issue('RETEST_REQUIRED', 'Component 13 requires another measurement or consistency check.'));
    recommendations.push('Continue only through the existing Component 13 retest flow.');
  }

  let status = reasons.some(reason => reason.code === 'SUDDEN_VISION_CHANGE' || reason.code === 'EYE_PAIN_OR_REDNESS' || reason.code === 'EYE_INJURY_NEEDS_ASSESSMENT' || reason.code === 'EYE_SURGERY_FOLLOWUP_PENDING')
    ? 'STOP_AND_SEEK_CARE'
    : reasons.some(reason => ['DEVICE_REQUIREMENTS_UNAVAILABLE', 'PREDICTION_MODEL_UNAVAILABLE', 'RETEST_LIMIT_REACHED'].includes(reason.code))
      ? 'SCREENING_LIMITED'
      : reasons.length ? 'REQUIRES_RETEST' : 'SAFE_TO_SCREEN';

  if (status === 'STOP_AND_SEEK_CARE') recommendations.unshift('Do not continue routine screening. Contact an eye-care professional or urgent medical service promptly about the reported symptom/history.');
  if (warnings.some(warning => warning.code === 'CURRENT_BLURRED_VISION')) recommendations.push('If blurred vision is new, worsening, or concerning, contact an eye-care professional.');
  let timestamp;
  try { const date = new Date(now()); timestamp = Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString(); }
  catch { timestamp = new Date().toISOString(); }

  return Object.freeze({
    schemaVersion: MEDICAL_SAFETY_ENGINE_VERSION,
    engineVersion: MEDICAL_SAFETY_ENGINE_VERSION,
    timestamp,
    status,
    reasons: uniqueIssues(reasons),
    warnings: uniqueIssues(warnings),
    recommendations: [...new Set(recommendations)],
    technicalValidityOnly: true,
    clinicalDiagnosis: 'NOT_PROVIDED',
    canContinue: status === 'SAFE_TO_SCREEN' || status === 'REQUIRES_RETEST',
    canPresentEstimate: status === 'SAFE_TO_SCREEN',
  });
}

/** Application facade: keeps the latest decision in Component 16 session memory. */
export function createMedicalSafetyLayer({ localDataStore = null, now = () => Date.now() } = {}) {
  let latest = null;
  return Object.freeze({
    assess(input = {}) {
      latest = assessSafety(input, { now });
      try { localDataStore?.setSessionValue?.('medicalSafetyResult', latest); } catch { /* Safety decisions remain usable if session storage fails. */ }
      return latest;
    },
    getSnapshot() { return latest; },
  });
}

/** Shared human-readable status copy for C1/C5/C12 and app-level safety stops. */
export function safetyStatusCopy(result) {
  return ({
    SAFE_TO_SCREEN: { title: 'Screening may continue', message: 'No stop condition was reported. This is not a medical assessment; professional eye care may still be appropriate.' },
    REQUIRES_RETEST: { title: 'A retest is needed', message: 'The current screening evidence is not reliable enough to proceed to a result. Follow the retest instructions.' },
    SCREENING_LIMITED: { title: 'A reliable screening result is unavailable', message: 'The screening cannot be completed reliably with the current device/model or after the allowed retests. Arrange a professional eye examination.' },
    STOP_AND_SEEK_CARE: { title: 'Stop screening and seek professional care', message: 'A reported symptom or follow-up need is outside routine automated screening. Contact an eye-care professional or urgent medical service promptly.' },
  })[result?.status] || { title: 'Safety status unavailable', message: 'The safety checks could not be completed. Do not rely on an automated result; seek professional assessment.' };
}

/** Safe DOM renderer; user-provided history text is never inserted as markup. */
export function renderSafetyNotice(container, result, { onAction = null, actionLabel = null } = {}) {
  const copy = safetyStatusCopy(result);
  container.replaceChildren();
  const section = document.createElement('section');
  section.className = `notice medical-safety-state ${result?.status === 'STOP_AND_SEEK_CARE' || result?.status === 'SCREENING_LIMITED' ? 'urgent' : ''}`;
  section.setAttribute('role', result?.status === 'SAFE_TO_SCREEN' ? 'status' : 'alert');
  section.setAttribute('aria-live', result?.status === 'SAFE_TO_SCREEN' ? 'polite' : 'assertive');
  const heading = document.createElement('h2'); heading.textContent = copy.title;
  const message = document.createElement('p'); message.textContent = copy.message;
  const list = document.createElement('ul');
  for (const item of [...(result?.reasons || []), ...(result?.warnings || [])]) { const li = document.createElement('li'); li.textContent = item.message; list.append(li); }
  const recommendations = document.createElement('p'); recommendations.textContent = (result?.recommendations || []).join(' ');
  section.append(heading, message);
  if (list.childNodes.length) section.append(list);
  if (recommendations.textContent) section.append(recommendations);
  if (typeof onAction === 'function') { const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = actionLabel || 'Continue'; button.addEventListener('click', onAction); section.append(button); }
  container.append(section);
  return section;
}

function urgentAnswer(questionnaire, field, code, message, reasons) {
  if (questionnaire?.[field] === URGENT_RESPONSES[field]) reasons.push(issue(code, message));
}
function questionnaireFrom(value) {
  if (!isRecord(value)) return {};
  if (isRecord(value.responses)) return { ...value.responses };
  if (isRecord(value.questionnaire)) return questionnaireFrom(value.questionnaire);
  return value;
}
function issue(code, message) { return Object.freeze({ code, message }); }
function uniqueIssues(items) { return [...new Map(items.map(item => [item.code, item])).values()]; }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
