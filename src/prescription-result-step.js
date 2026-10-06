export const PRESCRIPTION_RESULT_SCHEMA_VERSION = '1.0.0';
import { renderSafetyNotice } from './safety.js';

const EYES = Object.freeze([
  Object.freeze({ key: 'rightEye', eye: 'right', designation: 'OD', label: 'Right Eye (OD)' }),
  Object.freeze({ key: 'leftEye', eye: 'left', designation: 'OS', label: 'Left Eye (OS)' }),
]);

/** Prepare a display-only view. Refractive values are exposed only by C11's explicit C12 gate. */
export function preparePrescriptionResult(validityResult, { locale, retestResult = null, safetyResult = null } = {}) {
  if (!isRecord(validityResult) || validityResult.schemaVersion !== '1.0.0'
    || validityResult.engineVersion !== '1.0.0'
    || validityResult.technicalValidityOnly !== true || validityResult.clinicalValidity !== 'NOT_ASSESSED'
    || !['VALID', 'LOW_CONFIDENCE', 'INCONSISTENT', 'RETEST_REQUIRED', 'INVALID'].includes(validityResult.status)
    || typeof validityResult.timestamp !== 'string' || !Number.isFinite(Date.parse(validityResult.timestamp))) {
    if (retestResult?.status === 'FAILED' && retestResult.presentation?.canPresent === false) {
      const timestamp = typeof retestResult.timestamp === 'string' && Number.isFinite(Date.parse(retestResult.timestamp)) ? new Date(retestResult.timestamp).toISOString() : null;
      return { state: 'ERROR', status: 'INVALID', canPresent: false, reasons: Array.isArray(retestResult.reasons) ? retestResult.reasons : [], timestamp, dateTime: timestamp ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp)) : null, eyes: EYES.map(eye => ({ ...eye, status: 'INVALID', predictionCount: 0 })), component13Status: 'FAILED', affectedEyes: [], message: 'The configured retest limit was reached without a reliable result. No estimates are shown; arrange professional assessment.', retestResult };
    }
    return { state: 'ERROR', status: 'INVALID', canPresent: false, reasons: [], timestamp: null, eyes: [], message: 'Component 11 did not provide a supported, timestamped validity result.' };
  }

  const retestMeasurements = validRetestMeasurements(retestResult);
  const canPresent = retestResult
    ? retestResult.status === 'PASSED' && retestResult.presentation?.canPresent === true && retestMeasurements !== null
    : validityResult.status === 'VALID' && validityResult.valid === true
    && validityResult.overallValid === true && validityResult.component12?.status === 'READY_FOR_SCREENING_ESTIMATE'
    && validityResult.component12?.canPresentScreeningEstimate === true;
  const safetyAllowsPresentation = !safetyResult || safetyResult.status === 'SAFE_TO_SCREEN' && safetyResult.canPresentEstimate === true;
  const finalCanPresent = canPresent && safetyAllowsPresentation;
  if (finalCanPresent && !retestResult && !EYES.every(expected => validEyeGroup(validityResult[expected.key], expected))) {
    return { state: 'ERROR', status: 'INVALID', canPresent: false, reasons: [{ code: 'C12_EYE_RESULT_INVALID', message: 'A Component 11 eye result did not match the required OD/OS result contract.' }], timestamp: null, eyes: [], message: 'The result could not be safely displayed. No estimates are shown.' };
  }

  const sourceTimestamp = retestResult?.timestamp || validityResult.timestamp;
  const date = new Date(sourceTimestamp);
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  const needsConsistencyReview = validityResult.component12?.status === 'CONSISTENCY_REVIEW_REQUIRED'
    || validityResult.component13?.status === 'CONSISTENCY_REVIEW_REQUIRED';
  const status = retestResult ? (retestResult.status === 'PASSED' ? 'VALID' : retestResult.status === 'FAILED' ? 'INVALID' : 'RETEST_REQUIRED') : validityResult.status;
  const state = finalCanPresent ? 'READY' : status === 'INVALID' ? 'ERROR' : 'UNCERTAIN';
  const eyes = EYES.map(expected => {
    const group = validityResult[expected.key];
    const measurements = retestMeasurements?.[expected.designation] || [];
    return {
      eye: expected.eye,
      designation: expected.designation,
      label: expected.label,
      status: ['VALID', 'LOW_CONFIDENCE', 'INCONSISTENT', 'RETEST_REQUIRED', 'INVALID'].includes(group?.status) ? group.status : 'RETEST_REQUIRED',
      predictionCount: Number.isSafeInteger(group?.predictionCount) ? group.predictionCount : Array.isArray(group?.predictions) ? group.predictions.length : 0,
      ...(finalCanPresent && retestResult ? { measurements: measurements.map(item => ({
        attemptNumber: item.attemptNumber, timestamp: item.timestamp, estimate: item.prediction,
      })) } : finalCanPresent ? { estimate: {
        sph: group.predictions[0].sph,
        cyl: group.predictions[0].cyl,
        axis: group.predictions[0].axis,
        axisStatus: group.predictions[0].axisStatus,
        units: { ...group.predictions[0].units },
      } } : {}),
    };
  });
  const reasons = safetyResult && safetyResult.status !== 'SAFE_TO_SCREEN' && Array.isArray(safetyResult.reasons) ? safetyResult.reasons
    : retestResult && retestResult.status !== 'PASSED' && Array.isArray(retestResult.reasons) ? retestResult.reasons
    : Array.isArray(validityResult.reasons) ? validityResult.reasons
    .filter(reason => isRecord(reason) && typeof reason.code === 'string' && typeof reason.message === 'string')
    .map(reason => ({ ...(typeof reason.eye === 'string' ? { eye: reason.eye } : {}), code: reason.code, message: reason.message })) : [];

  return {
    state,
    status,
    canPresent: finalCanPresent,
    timestamp: date.toISOString(),
    dateTime,
    eyes,
    reasons,
    component13Status: retestResult?.status || validityResult.component13?.status || null,
    retestResult,
    safetyResult,
    affectedEyes: Array.isArray(validityResult.component13?.affectedEyes) ? validityResult.component13.affectedEyes.filter(eye => ['OD', 'OS'].includes(eye)) : [],
    message: !safetyAllowsPresentation && safetyResult?.status === 'SCREENING_LIMITED' ? 'This screening cannot provide a reliable result in the current configuration. No estimates are shown; seek professional assessment.'
      : !safetyAllowsPresentation && safetyResult?.status === 'REQUIRES_RETEST' ? 'The central safety checks require a retest. No estimates are shown until the retest flow permits it.'
        : retestResult?.status === 'FAILED' ? 'The configured retest limit was reached without a reliable result. No estimates are shown; arrange professional assessment.' : statusMessage(status, finalCanPresent, needsConsistencyReview),
  };
}

export function formatRefractionValue(value) {
  if (!Number.isFinite(value)) return 'Unavailable';
  const exact = String(value);
  return value > 0 || Object.is(value, 0) ? `+${exact}` : exact;
}

export function mountPrescriptionResultStep(root, { validityResult, retestResult = null, safetyResult = null } = {}, { onExit = () => {}, locale } = {}) {
  const view = preparePrescriptionResult(validityResult, { locale, retestResult, safetyResult });
  root.innerHTML = `<section aria-labelledby="prescription-result-title"><h2 id="prescription-result-title" tabindex="-1">Screening result</h2><p class="prescription-safety">This is a vision screening and refractive-error estimate, not a medical diagnosis or a professional prescription. It does not replace a comprehensive eye examination. Arrange professional assessment for symptoms, concerns, or decisions about corrective lenses.</p><div id="prescription-medical-safety"></div><div id="prescription-result-status" class="positioning-status" role="status" aria-live="polite" aria-atomic="true"><strong id="prescription-result-heading"></strong><span id="prescription-result-message"></span></div><p id="prescription-result-date" class="hint"></p><div id="prescription-result-eyes" class="result-eye-grid" aria-label="Separate eye results"></div><section id="prescription-result-reasons" aria-labelledby="prescription-reasons-title"><h3 id="prescription-reasons-title">Why this status was assigned</h3><ul id="prescription-result-reason-list"></ul></section><p id="prescription-result-retest-note" class="hint" role="status" aria-live="polite"></p><p id="prescription-history-status" class="hint" role="status" aria-live="polite">Saving final result to this device's history…</p><p id="prescription-result-pdf-status" class="hint" role="status" aria-live="polite"></p><div class="actions"><button id="prescription-result-retest" class="primary" type="button">Retest</button><button id="prescription-result-download" class="secondary" type="button">Download PDF report</button><button id="prescription-result-preview" class="secondary" type="button">Preview PDF report</button><button id="prescription-result-history" class="secondary" type="button">View history</button><button id="prescription-result-finish" class="secondary" type="button">Finish screening</button></div></section>`;
  if (safetyResult) renderSafetyNotice(root.querySelector('#prescription-medical-safety'), safetyResult);

  const statusNode = root.querySelector('#prescription-result-status');
  const heading = root.querySelector('#prescription-result-heading');
  const message = root.querySelector('#prescription-result-message');
  const dateNode = root.querySelector('#prescription-result-date');
  const eyeContainer = root.querySelector('#prescription-result-eyes');
  const reasonContainer = root.querySelector('#prescription-result-reasons');
  const reasonList = root.querySelector('#prescription-result-reason-list');
  const retestNote = root.querySelector('#prescription-result-retest-note');
  const retestButton = root.querySelector('#prescription-result-retest');
  const finishButton = root.querySelector('#prescription-result-finish');
  const historyButton = root.querySelector('#prescription-result-history');
  const downloadButton = root.querySelector('#prescription-result-download');
  const previewButton = root.querySelector('#prescription-result-preview');
  const pdfStatus = root.querySelector('#prescription-result-pdf-status');
  let disposed = false;

  heading.textContent = statusLabel(view.status, view.canPresent, view.component13Status);
  root.querySelector('#prescription-result-title')?.focus?.();
  message.textContent = view.message;
  if (view.state !== 'READY') statusNode.classList.add('is-error');
  dateNode.textContent = view.dateTime ? `Measurement/session time: ${view.dateTime}` : 'Measurement/session time unavailable.';
  eyeContainer.replaceChildren(...view.eyes.map(eye => makeEyeCard(eye, view.canPresent)));
  reasonContainer.hidden = view.reasons.length === 0;
  reasonList.replaceChildren(...view.reasons.map(reason => makeListItem(`${reason.eye ? `${reason.eye}: ` : ''}${reason.code} — ${reason.message}`)));
  finishButton.textContent = view.canPresent ? 'Finish screening' : 'Return to start';
  if (retestResult?.status === 'FAILED' || retestResult && retestResult.retestsUsed >= retestResult.maxRetests) retestButton.hidden = true;

  const eventDetail = {
    schemaVersion: PRESCRIPTION_RESULT_SCHEMA_VERSION,
    timestamp: view.timestamp,
    status: view.status,
    canPresent: view.canPresent,
    eyeStatuses: Object.fromEntries(view.eyes.map(eye => [eye.designation, eye.status])),
    validity: validityResult ? {
      status: validityResult.status,
      engineVersion: validityResult.engineVersion || null,
      valid: validityResult.valid === true,
      technicalValidityOnly: validityResult.technicalValidityOnly === true,
      clinicalValidity: validityResult.clinicalValidity || 'NOT_ASSESSED',
      confidence: { OD: validityResult.rightEye?.confidence || null, OS: validityResult.leftEye?.confidence || null },
      consistency: { OD: validityResult.rightEye?.consistency || null, OS: validityResult.leftEye?.consistency || null },
      sourceAnalysis: validityResult.sourceAnalysis || null,
    } : { status: 'NOT_PRODUCED', valid: false, technicalValidityOnly: true, clinicalValidity: 'NOT_ASSESSED', confidence: { OD: null, OS: null }, consistency: { OD: null, OS: null }, sourceAnalysis: null },
    retest: retestResult ? {
      status: retestResult.status, retestsUsed: retestResult.retestsUsed,
      maxRetests: retestResult.maxRetests, consistency: retestResult.consistency || null,
      perEyeConsistency: {
        OD: { status: retestResult.rightEye?.status || null, pairwiseMaximumDeltas: retestResult.rightEye?.pairwiseMaximumDeltas || null, count: retestResult.rightEye?.count ?? null },
        OS: { status: retestResult.leftEye?.status || null, pairwiseMaximumDeltas: retestResult.leftEye?.pairwiseMaximumDeltas || null, count: retestResult.leftEye?.count ?? null },
      },
      engineVersion: retestResult.engineVersion || null, attempts: retestResult.attempts || [],
    } : null,
    reasons: view.reasons,
    medicalSafety: safetyResult ? { status: safetyResult.status, engineVersion: safetyResult.engineVersion, reasons: safetyResult.reasons, warnings: safetyResult.warnings, recommendations: safetyResult.recommendations, canPresentEstimate: safetyResult.canPresentEstimate } : null,
    ...(view.canPresent ? { eyes: Object.fromEntries(view.eyes.map(eye => [eye.designation, {
      ...(eye.measurements?.length === 1 ? { sph: eye.measurements[0].estimate.sph, cyl: eye.measurements[0].estimate.cyl, axis: eye.measurements[0].estimate.axis, axisStatus: eye.measurements[0].estimate.axisStatus, units: { ...eye.measurements[0].estimate.units } } : eye.estimate ? { sph: eye.estimate.sph, cyl: eye.estimate.cyl, axis: eye.estimate.axis, axisStatus: eye.estimate.axisStatus, units: { ...eye.estimate.units } } : {}),
      measurements: eye.measurements?.map(item => ({ eye: eye.designation, designation: eye.designation, attemptNumber: item.attemptNumber, timestamp: item.timestamp, sph: item.estimate.sph, cyl: item.estimate.cyl, axis: item.estimate.axis, axisStatus: item.estimate.axisStatus, units: { ...item.estimate.units } }))
        || [{ eye: eye.designation, designation: eye.designation, sph: eye.estimate.sph, cyl: eye.estimate.cyl, axis: eye.estimate.axis, axisStatus: eye.estimate.axisStatus, units: { ...eye.estimate.units } }],
    }])) } : {}),
  };
  root.dispatchEvent(new CustomEvent('prescription-result-ready', { bubbles: true, detail: eventDetail }));

  function openHistory() {
    root.dispatchEvent(new CustomEvent('component14-history-open', { bubbles: true, detail: { sourceComponent: '12' } }));
  }

  function requestPdf(mode) {
    const event = new CustomEvent('component15-pdf-generate-request', {
      bubbles: true, cancelable: true,
      detail: { schemaVersion: '1.0.0', sourceComponent: '12', mode, result: eventDetail },
    });
    root.dispatchEvent(event);
    if (!event.defaultPrevented) pdfStatus.textContent = 'PDF report generation is not available in this version.';
  }

  function requestRetest() {
    root.dispatchEvent(new CustomEvent('component13-retest-request', {
      bubbles: true,
      detail: {
        schemaVersion: PRESCRIPTION_RESULT_SCHEMA_VERSION,
        sourceComponent: '12',
        validityStatus: view.status,
        validityResult,
        affectedEyes: [...new Set([...view.affectedEyes, ...view.reasons.map(reason => reason.eye).filter(Boolean)])],
        reasons: view.reasons,
      },
    }));
    retestNote.textContent = 'Retest requested. Component 13 will resume the existing guided capture flow.';
  }
  async function finish() {
    if (disposed) return;
    await cleanup();
    root.dispatchEvent(new CustomEvent('prescription-result-finished', { bubbles: true, detail: { schemaVersion: PRESCRIPTION_RESULT_SCHEMA_VERSION, status: view.status } }));
    onExit();
  }
  async function cleanup() {
    if (disposed) return;
    disposed = true;
    retestButton.removeEventListener('click', requestRetest);
    historyButton.removeEventListener('click', openHistory);
    downloadButton.removeEventListener('click', downloadPdf);
    previewButton.removeEventListener('click', previewPdf);
    finishButton.removeEventListener('click', finish);
  }
  retestButton.addEventListener('click', requestRetest);
  historyButton.addEventListener('click', openHistory);
  const downloadPdf = () => requestPdf('download');
  const previewPdf = () => requestPdf('preview');
  downloadButton.addEventListener('click', downloadPdf);
  previewButton.addEventListener('click', previewPdf);
  finishButton.addEventListener('click', finish);
  return cleanup;
}

function validEyeGroup(group, expected) {
  if (!isRecord(group) || group.eye !== expected.eye || group.designation !== expected.designation
    || group.status !== 'VALID' || group.valid !== true || group.predictionCount !== 1 || !Array.isArray(group.predictions) || group.predictions.length !== 1) return false;
  const prediction = group.predictions[0];
  const axisValid = Number.isFinite(prediction?.axis) && prediction.axisStatus === 'AVAILABLE'
    || prediction?.axis === null && prediction.axisStatus === 'NOT_APPLICABLE';
  return isRecord(prediction) && prediction.valid === true && prediction.eye === expected.eye && prediction.designation === expected.designation
    && typeof prediction.sourceCaptureId === 'string' && typeof prediction.sourcePredictionId === 'string'
    && Number.isFinite(prediction.sph) && Number.isFinite(prediction.cyl)
    && axisValid
    && isRecord(prediction.units) && prediction.units.sph === 'D' && prediction.units.cyl === 'D' && prediction.units.axis === 'deg';
}

function makeEyeCard(eye, showEstimate) {
  const card = document.createElement('article');
  card.className = 'result-eye-card';
  const title = document.createElement('h3');
  title.textContent = eye.label;
  const status = document.createElement('p');
  status.className = 'result-eye-status';
  status.textContent = `Technical status: ${eye.status.replaceAll('_', ' ').toLowerCase()}.`;
  card.append(title, status);
  if (showEstimate && eye.measurements?.length) {
    for (const measurement of eye.measurements) {
      const section = document.createElement('section');
      section.className = 'result-measurement';
      const label = document.createElement('h4');
      label.textContent = `Measurement ${measurement.attemptNumber}`;
      section.append(label, makeValueList(measurement.estimate));
      card.append(section);
    }
  } else if (showEstimate && eye.estimate) {
    card.append(makeValueList(eye.estimate));
  } else {
    const note = document.createElement('p');
    note.className = 'result-estimate-hidden';
    note.textContent = 'Estimate withheld until Component 11 confirms both eyes are eligible for presentation.';
    card.append(note);
  }
  return card;
}

function addValue(list, label, value, unit) {
  const term = document.createElement('dt'); term.textContent = label;
  const description = document.createElement('dd'); description.textContent = unit ? `${value} ${unit}` : value;
  list.append(term, description);
}
function makeValueList(estimate) {
  const table = document.createElement('dl'); table.className = 'result-values';
  addValue(table, 'SPH', formatRefractionValue(estimate.sph), 'D');
  addValue(table, 'CYL', formatRefractionValue(estimate.cyl), 'D');
  addValue(table, 'Axis', estimate.axisStatus === 'NOT_APPLICABLE' ? 'Not applicable' : `${String(estimate.axis)}°`, '');
  return table;
}
function validRetestMeasurements(result) {
  if (!result) return null;
  if (result.status !== 'PASSED' || result.presentation?.canPresent !== true) return null;
  const output = {};
  for (const expected of EYES) {
    const eyeResult = result[expected.key];
    if (!isRecord(eyeResult) || eyeResult.designation !== expected.designation || eyeResult.status !== 'CONSISTENT' && eyeResult.status !== 'SINGLE_MEASUREMENT' || !Array.isArray(eyeResult.measurements) || !eyeResult.measurements.length) return null;
    const valid = eyeResult.measurements.every(item => {
      const p = item?.prediction;
      return isRecord(p) && p.valid === true && p.eye === expected.eye && p.designation === expected.designation
        && Number.isFinite(p.sph) && Number.isFinite(p.cyl)
        && (Number.isFinite(p.axis) && p.axisStatus === 'AVAILABLE' || p.axis === null && p.axisStatus === 'NOT_APPLICABLE')
        && isRecord(p.units) && p.units.sph === 'D' && p.units.cyl === 'D' && p.units.axis === 'deg';
    });
    if (!valid) return null;
    output[expected.designation] = eyeResult.measurements;
  }
  return output;
}
function makeListItem(text) { const item = document.createElement('li'); item.textContent = text; return item; }
function statusLabel(status, canPresent, component13Status) {
  if (component13Status === 'FAILED') return 'Reliable screening result unavailable';
  if (component13Status === 'PASSED') return 'Retest consistency checks passed';
  if (status === 'VALID' && !canPresent && component13Status === 'CONSISTENCY_REVIEW_REQUIRED') return 'Consistency review required before showing estimates';
  if (status === 'VALID' && !canPresent) return 'Result presentation is blocked';
  return ({
    VALID: 'Screening checks passed',
    LOW_CONFIDENCE: 'Low-confidence screening result',
    INCONSISTENT: 'Inconsistent repeat measurements',
    RETEST_REQUIRED: 'Retest required before showing estimates',
    INVALID: 'Result unavailable or invalid',
  })[status] || 'Result could not be assessed';
}
function statusMessage(status, canPresent, needsConsistencyReview) {
  if (canPresent) return 'Both eyes passed the configured technical screening checks. These values are estimates only, not a medical diagnosis or prescription.';
  if (status === 'VALID' && needsConsistencyReview) return 'Repeated measurements passed the configured pairwise checks, but Component 13 must review them before Component 12 can select a single estimate. No measurements are shown here.';
  if (status === 'LOW_CONFIDENCE') return 'The available technical confidence checks were not met. This result is not sufficiently reliable; no estimates are shown as confirmed.';
  if (status === 'INCONSISTENT') return 'Repeated measurements disagree. The values are withheld; do not combine or average them.';
  if (status === 'INVALID') return 'The result failed validation or is unavailable. No estimates are shown.';
  return 'The result is not sufficiently reliable to display. Complete a retest or professional eye examination.';
}
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
