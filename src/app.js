import { validateQuestionnaire } from './validation.js';
import { createResult } from './model.js';
import { configureSessionDataStore, setQuestionnaireResult, clearQuestionnaireSession } from './session.js';
import { VALIDITY_POLICY, RETEST_POLICY } from './config.js';
import { mountCameraStep } from './camera-step.js';
import { mountPositioningStep } from './positioning-step.js';
import { mountEyeLocalizationStep } from './eye-step.js';
import { mountQualityStep } from './quality-step.js';
import { mountAutomaticCaptureStep } from './automatic-capture-step.js';
import { mountImagePreprocessingStep } from './preprocessing-step.js';
import { mountFeatureExtractionStep } from './feature-extraction-step.js';
import { mountPredictionStep } from './prediction-step.js';
import { mountEyeAnalysisStep } from './eye-analysis-step.js';
import { mountValidityStep } from './validity-step.js';
import { mountPrescriptionResultStep } from './prescription-result-step.js';
import { createRetestSession, recordRetestAssessment, recordCaptureFailure, startRetest, transitionRetestState } from './retest-consistency.js';
import { mountRetestStep } from './retest-step.js';
import { createLocalDataStore } from './local-data-store.js';
import { createDeviceCompatibilityLayer } from './device-compatibility.js';
import { mountHistoryStep } from './history-step.js';
import { createScreeningReportBlob } from './pdf-report.js';
import { createMedicalSafetyLayer, renderSafetyNotice } from './safety.js';

const app = document.querySelector('#app');
const localDataStore = createLocalDataStore();
configureSessionDataStore(localDataStore);
const deviceCompatibilityLayer = createDeviceCompatibilityLayer({ localDataStore });
const medicalSafetyLayer = createMedicalSafetyLayer({ localDataStore });
const answers = new Proxy({}, {
  get(_target, key) {
    if (key === 'right' || key === 'left') return new Proxy({}, {
      get(_side, field) { return localDataStore.getSessionDraft()[key]?.[field]; },
      set(_side, field, value) { const draft = localDataStore.getSessionDraft(); localDataStore.updateSessionDraft({ [key]: { ...draft[key], [field]: value } }); return true; },
    });
    return localDataStore.getSessionDraft()[key];
  },
  set(_target, key, value) { localDataStore.updateSessionDraft({ [key]: value }); return true; },
});
const pipelineState = new Proxy({}, {
  get(_target, key) { return localDataStore.getSessionValue(({ retestSession: 'retestSession', currentRetestResult: 'retestResult', latestValidityResult: 'validityResult' })[key]); },
  set(_target, key, value) { const sessionKey = ({ retestSession: 'retestSession', currentRetestResult: 'retestResult', latestValidityResult: 'validityResult' })[key]; if (!sessionKey) throw new TypeError('Unknown central session field.'); localDataStore.setSessionValue(sessionKey, value); return true; },
});
const choice = (name, label, options = ['yes','no','not-sure']) => `<div class="label">${label}<span class="required"> *</span></div><div class="choices" role="radiogroup" aria-label="${label}">${options.map(([v,t]) => `<label class="choice"><input type="radio" name="${name}" value="${v}" ${answers[name] === v ? 'checked' : ''}> ${t}</label>`).join('')}</div><p class="error" id="error-${name}"></p>`;
const yn = [['yes','Yes'],['no','No'],['not-sure','Not sure']];
const blank = () => ({ sph:'', cyl:'', axis:'' });
let cleanupCameraStep = null;
let cleanupPositioningStep = null;
let cleanupQualityStep = null;
let cleanupCaptureStep = null;
let cleanupPreprocessingStep = null;
let cleanupFeatureExtractionStep = null;
let cleanupPredictionStep = null;
let cleanupEyeAnalysisStep = null;
let cleanupValidityStep = null;
let cleanupPrescriptionResultStep = null;
let cleanupRetestStep = null;
let cleanupHistoryStep = null;
let currentCamera = null;
const historyStore = localDataStore;
const persistedResultKeys = new Set();
const persistedResultIds = new Map();
let historyReturnToResult = false;
window.addEventListener('pagehide', () => { void historyStore.close(); clearQuestionnaireSession(); }, { once: true });
let captureFailureRouted = false;
let qualityStepActive = false;
let captureStepActive = false;
let preprocessingStepActive = false;
let featureExtractionStepActive = false;
let predictionStepActive = false;
let eyeAnalysisStepActive = false;
let validityStepActive = false;
let prescriptionResultStepActive = false;

app.addEventListener('camera-step-ready', async event => {
  const camera=event.detail?.camera;
  if(!camera?.getSnapshot?.().previewReady)return;
  currentCamera = camera;
  if (pipelineState.retestSession?.state === 'PREPARING') pipelineState.retestSession = transitionRetestState(pipelineState.retestSession, 'CAPTURING');
  cleanupCameraStep?.detachUI?.();
  document.querySelector('#page-title').textContent='Guided positioning';
  document.querySelector('.intro').textContent='Follow the live guidance to position your face and hold steady.';
  updateProgress(3);
  try { cleanupPositioningStep=await mountPositioningStep(app,{camera,compatibility: deviceCompatibilityLayer.getSnapshot(),onExit:render}); }
  catch { app.innerHTML='<section class="notice urgent" role="alert"><h2>Positioning could not start</h2><p>The current camera preview is unavailable. Stop screening and try again.</p><button id="exit-positioning" class="secondary" type="button">Return to questionnaire</button></section>'; app.querySelector('#exit-positioning').addEventListener('click',async()=>{await camera.stopCamera();render();}); }
});

app.addEventListener('positioning-ready', async event => {
  const { camera, positioningDetector, positioning, latestDetection } = event.detail || {};
  if (!camera?.getSnapshot?.().previewReady || !positioningDetector) return;
  if (cleanupPositioningStep) { await cleanupPositioningStep(); cleanupPositioningStep = null; }
  document.querySelector('#page-title').textContent='Eye detection & localization';
  document.querySelector('.intro').textContent='Review what eye landmarks this model can and cannot provide, then choose whether to continue.';
  updateProgress(4);
  try { cleanupQualityStep=await mountEyeLocalizationStep(app,{camera,positioningDetector,positioning,latestDetection,compatibility:deviceCompatibilityLayer.getSnapshot(),onExit:render}); }
  catch {
    await positioningDetector.stop(); await camera.stopCamera();
    app.innerHTML='<section class="notice urgent" role="alert"><h2>Eye localization could not start</h2><p>The current camera and positioning components could not be connected. Stop the screening and retry.</p><button id="exit-eye-localization" class="secondary" type="button">Stop screening</button></section>';
    app.querySelector('#exit-eye-localization').addEventListener('click',async()=>{await positioningDetector.stop();await camera.stopCamera();render();});
  }
});

app.addEventListener('eye-localization-stable', async event => {
  const handoff = event.detail;
  if (qualityStepActive) return;
  if (!handoff?.camera?.getSnapshot?.().previewReady || !handoff?.positioningDetector) return;
  qualityStepActive = true;
  if (cleanupQualityStep) { await cleanupQualityStep.handoff?.(); cleanupQualityStep = null; }
  document.querySelector('#page-title').textContent = 'Image quality check';
  document.querySelector('.intro').textContent = 'Review image quality using the existing live preview and eye-localization results.';
  updateProgress(5);
  try { cleanupQualityStep = await mountQualityStep(app, handoff, { compatibility: deviceCompatibilityLayer.getSnapshot(), safetyLayer: medicalSafetyLayer, questionnaire: localDataStore.getSessionDraft(), onExit: () => { qualityStepActive = false; render(); } }); }
  catch {
    await handoff.releaseEyeProcessing?.(); await handoff.positioningDetector.stop(); await handoff.camera.stopCamera();
    app.innerHTML = '<section class="notice urgent" role="alert"><h2>Image quality checking could not start</h2><p>The existing camera and eye-localization results could not be connected. Stop screening and retry.</p><button id="exit-quality" class="secondary" type="button">Stop screening</button></section>';
    app.querySelector('#exit-quality').addEventListener('click', () => { qualityStepActive = false; render(); });
  }
});

app.addEventListener('image-quality-ready', async event => {
  if (captureStepActive || event.detail?.result?.valid !== true || !cleanupQualityStep?.handoff) return;
  const handoff = cleanupQualityStep.handoff();
  if (!handoff?.camera?.getSnapshot?.().previewReady || !handoff?.positioningDetector) return;
  captureStepActive = true;
  document.querySelector('#page-title').textContent = 'Automatic eye photo capture';
  document.querySelector('.intro').textContent = 'Keep both eyes open and hold still while the system captures a verified camera frame.';
  updateProgress(6);
  try { cleanupCaptureStep = await mountAutomaticCaptureStep(app, handoff, { compatibility: deviceCompatibilityLayer.getSnapshot(), onExit: () => { captureStepActive = false; qualityStepActive = false; render(); } }); }
  catch {
    await handoff.cleanupQualityStep?.();
    app.innerHTML = '<section class="notice urgent" role="alert"><h2>Automatic capture could not start</h2><p>The existing camera or quality checks are unavailable. Stop screening and restart the guided steps.</p><button id="exit-capture" class="secondary" type="button">Stop screening</button></section>';
    app.querySelector('#exit-capture').addEventListener('click', () => { captureStepActive = false; qualityStepActive = false; render(); });
  }
});

app.addEventListener('eye-capture-complete', async event => {
  const captures = event.detail?.captures;
  if (preprocessingStepActive || !Array.isArray(captures) || captures.length === 0) return;
  preprocessingStepActive = true;
  if (pipelineState.retestSession?.state === 'CAPTURING') pipelineState.retestSession = transitionRetestState(pipelineState.retestSession, 'ANALYZING');
  document.querySelector('#page-title').textContent = 'Eye image preprocessing';
  document.querySelector('.intro').textContent = 'The validated captured eye image is being prepared locally for the next processing stage.';
  updateProgress(7);
  try {
    if (cleanupCaptureStep) { await cleanupCaptureStep.handoff?.(); cleanupCaptureStep = null; }
    cleanupPreprocessingStep = mountImagePreprocessingStep(app, { captures }, { onExit: () => { preprocessingStepActive = false; captureStepActive = false; qualityStepActive = false; render(); } });
  } catch {
    await cleanupCaptureStep?.(); cleanupCaptureStep = null;
    app.innerHTML = '<section class="notice urgent" role="alert"><h2>Eye images could not be prepared</h2><p>No captured image was passed to another component. Stop screening and restart if needed.</p><button id="exit-preprocessing" class="secondary" type="button">Stop screening</button></section>';
    app.querySelector('#exit-preprocessing').addEventListener('click', () => { preprocessingStepActive = false; captureStepActive = false; qualityStepActive = false; render(); });
  }
});

app.addEventListener('automatic-capture-state', event => {
  if (event.detail?.state !== 'ERROR' || captureFailureRouted) return;
  captureFailureRouted = true;
  queueMicrotask(async () => {
    const session = pipelineState.retestSession || createRetestSession(RETEST_POLICY);
    const recorded = recordCaptureFailure(session, event.detail.error || 'CAPTURE_INCOMPLETE');
    pipelineState.retestSession = recorded.session; pipelineState.currentRetestResult = recorded.result;
    publishRetestResult(pipelineState.currentRetestResult);
    captureStepActive = false; qualityStepActive = false;
    await cleanupCaptureStep?.(); cleanupCaptureStep = null;
    await cleanupQualityStep?.(); cleanupQualityStep = null;
    if (recorded.result.status === 'FAILED') await enterPrescriptionResultStep({ detail: pipelineState.latestValidityResult }, recorded.result);
    else await enterRetestStep(recorded.result);
  });
});

app.addEventListener('eye-preprocessing-complete', async event => {
  const preprocessingBatch = event.detail;
  if (featureExtractionStepActive || preprocessingBatch?.valid !== true || !Array.isArray(preprocessingBatch.captures) || preprocessingBatch.captures.length === 0) return;
  featureExtractionStepActive = true;
  document.querySelector('#page-title').textContent = 'Optical feature extraction';
  document.querySelector('.intro').textContent = 'Validated eye images are being converted into local, descriptive measurements.';
  updateProgress(8);
  try {
    if (cleanupPreprocessingStep) { await cleanupPreprocessingStep(); cleanupPreprocessingStep = null; }
    cleanupFeatureExtractionStep = mountFeatureExtractionStep(app, { preprocessingBatch }, {
      onExit: () => { featureExtractionStepActive = false; preprocessingStepActive = false; captureStepActive = false; qualityStepActive = false; render(); },
    });
  } catch {
    await cleanupPreprocessingStep?.(); cleanupPreprocessingStep = null;
    app.innerHTML = '<section class="notice urgent" role="alert"><h2>Eye features could not be extracted</h2><p>No partial feature batch was passed to another component. Stop screening and restart if needed.</p><button id="exit-feature-extraction" class="secondary" type="button">Stop screening</button></section>';
    app.querySelector('#exit-feature-extraction').addEventListener('click', () => { featureExtractionStepActive = false; preprocessingStepActive = false; captureStepActive = false; qualityStepActive = false; render(); });
  }
});

app.addEventListener('eye-features-complete', async event => {
  const featureBatch = event.detail;
  if (predictionStepActive || featureBatch?.valid !== true || !Array.isArray(featureBatch.captures) || featureBatch.captures.length === 0) return;
  predictionStepActive = true;
  document.querySelector('#page-title').textContent = 'AI refractive-error prediction';
  document.querySelector('.intro').textContent = 'Component 9 checks whether a compatible local SPH/CYL/Axis model is available for the validated eye features.';
  updateProgress(9);
  try {
    if (cleanupFeatureExtractionStep) { await cleanupFeatureExtractionStep(); cleanupFeatureExtractionStep = null; }
    cleanupPredictionStep = mountPredictionStep(app, { featureBatch }, {
      compatibility: deviceCompatibilityLayer.getSnapshot(),
      onExit: () => { predictionStepActive = false; featureExtractionStepActive = false; preprocessingStepActive = false; captureStepActive = false; qualityStepActive = false; render(); },
    });
  } catch {
    await cleanupFeatureExtractionStep?.(); cleanupFeatureExtractionStep = null;
    app.innerHTML = '<section class="notice urgent" role="alert"><h2>Prediction engine could not start</h2><p>No eye features were sent to an external service, and no prediction values were produced. Stop screening and restart the guided steps.</p><button id="exit-prediction" class="secondary" type="button">Stop screening</button></section>';
    app.querySelector('#exit-prediction').addEventListener('click', () => { predictionStepActive = false; featureExtractionStepActive = false; preprocessingStepActive = false; captureStepActive = false; qualityStepActive = false; render(); });
  }
});

async function enterEyeAnalysis(event) {
  if (eyeAnalysisStepActive || !event.detail) return;
  eyeAnalysisStepActive = true;
  if (cleanupPredictionStep) { await cleanupPredictionStep(); cleanupPredictionStep = null; }
  document.querySelector('#page-title').textContent = 'Left/right eye analysis';
  document.querySelector('.intro').textContent = 'Component 10 independently validates and organizes Component 9 results by anatomical eye.';
  updateProgress(10);
  try {
    cleanupEyeAnalysisStep = mountEyeAnalysisStep(app, { predictionResult: event.detail }, {
      onExit: () => {
        eyeAnalysisStepActive = false;
        predictionStepActive = false;
        featureExtractionStepActive = false;
        preprocessingStepActive = false;
        captureStepActive = false;
        qualityStepActive = false;
        resetPipelineSession();
        render();
      },
    });
  } catch {
    app.innerHTML = '<section class="notice urgent" role="alert"><h2>Eye analysis could not start</h2><p>The Component 9 result was not presented as an eye result. Stop screening and restart the guided steps.</p><button id="exit-eye-analysis" class="secondary" type="button">Stop screening</button></section>';
    app.querySelector('#exit-eye-analysis').addEventListener('click', () => {
      eyeAnalysisStepActive = false;
      predictionStepActive = false;
      featureExtractionStepActive = false;
      preprocessingStepActive = false;
      captureStepActive = false;
      qualityStepActive = false;
      resetPipelineSession();
      render();
    });
  }
}

app.addEventListener('eye-prediction-complete', enterEyeAnalysis);
app.addEventListener('eye-prediction-unavailable', enterEyeAnalysis);
app.addEventListener('eye-prediction-error', event => {
  if (event.detail?.retryable !== true) void enterEyeAnalysis(event);
});

async function enterValidityStep(event) {
  if (validityStepActive || !event.detail) return;
  validityStepActive = true;
  if (cleanupEyeAnalysisStep) { await cleanupEyeAnalysisStep(); cleanupEyeAnalysisStep = null; }
  document.querySelector('#page-title').textContent = 'Confidence & validity review';
  document.querySelector('.intro').textContent = 'Technical checks determine whether the eye estimates can proceed to a screening result or need a retest.';
  updateProgress(11);
  try {
    cleanupValidityStep = mountValidityStep(app, { eyeAnalysis: event.detail }, {
      policy: VALIDITY_POLICY,
      onExit: () => {
        validityStepActive = false;
        eyeAnalysisStepActive = false;
        predictionStepActive = false;
        featureExtractionStepActive = false;
        preprocessingStepActive = false;
        captureStepActive = false;
        qualityStepActive = false;
        resetPipelineSession();
        render();
      },
    });
  } catch {
    app.innerHTML = '<section class="notice urgent" role="alert"><h2>Confidence review could not start</h2><p>The Component 10 eye-separated result was not passed to a result screen. Stop screening and restart the guided steps.</p><button id="exit-validity" class="secondary" type="button">Stop screening</button></section>';
    app.querySelector('#exit-validity').addEventListener('click', () => {
      validityStepActive = false;
      eyeAnalysisStepActive = false;
      predictionStepActive = false;
      featureExtractionStepActive = false;
      preprocessingStepActive = false;
      captureStepActive = false;
      qualityStepActive = false;
      resetPipelineSession();
      render();
    });
  }
}

app.addEventListener('eye-analysis-complete', event => { queueMicrotask(() => void enterValidityStep(event)); });
app.addEventListener('eye-analysis-complete', event => { localDataStore.setSessionValue('eyeAnalysis', event.detail); });
app.addEventListener('eye-validity-complete', event => { localDataStore.setSessionValue('validityResult', event.detail); });
app.addEventListener('component13-retest-result-ready', event => { localDataStore.setSessionValue('retestResult', event.detail); });
app.addEventListener('image-quality-update', event => {
  medicalSafetyLayer.assess({ questionnaire: localDataStore.getSessionDraft(), compatibility: deviceCompatibilityLayer.getSnapshot(), imageQuality: event.detail?.result });
});
app.addEventListener('eye-prediction-unavailable', event => {
  medicalSafetyLayer.assess({ questionnaire: localDataStore.getSessionDraft(), compatibility: deviceCompatibilityLayer.getSnapshot(), predictionResult: event.detail });
});
app.addEventListener('eye-prediction-error', event => {
  medicalSafetyLayer.assess({ questionnaire: localDataStore.getSessionDraft(), compatibility: deviceCompatibilityLayer.getSnapshot(), predictionResult: event.detail });
});
app.addEventListener('eye-capture-ready', event => {
  const detail = event.detail || {};
  localDataStore.setSessionValue('captureMetadata', {
    captureIndex: Number.isSafeInteger(detail.captureIndex) ? detail.captureIndex : null,
    timestamp: new Date().toISOString(),
    status: detail.complete === true ? 'COMPLETE' : 'CAPTURED',
  });
});

async function enterPrescriptionResultStep(event, retestResult = null) {
  const validityResult = event?.detail || pipelineState.latestValidityResult;
  if (prescriptionResultStepActive || (!validityResult && retestResult?.status !== 'FAILED')) return;
  const safetyResult = assessCurrentSafety({ validityResult, retestResult });
  if (safetyResult.status === 'STOP_AND_SEEK_CARE') { safetyStop(safetyResult); return; }
  if (safetyResult.status === 'REQUIRES_RETEST' && retestResult?.status !== 'PASSED') { await enterRetestStep(retestResult || pipelineState.currentRetestResult); return; }
  prescriptionResultStepActive = true;
  await cleanupRetestStep?.(); cleanupRetestStep = null;
  if (cleanupValidityStep) { await cleanupValidityStep(); cleanupValidityStep = null; }
  document.querySelector('#page-title').textContent = 'Prescription result';
  document.querySelector('.intro').textContent = 'Review the Component 11-validated screening result and any required next steps.';
  updateProgress(12);
  try {
    cleanupPrescriptionResultStep = mountPrescriptionResultStep(app, { validityResult, retestResult, safetyResult }, {
      onExit: () => {
        prescriptionResultStepActive = false;
        validityStepActive = false;
        eyeAnalysisStepActive = false;
        predictionStepActive = false;
        featureExtractionStepActive = false;
        preprocessingStepActive = false;
        captureStepActive = false;
        qualityStepActive = false;
        resetPipelineSession();
        render();
      },
    });
  } catch {
    app.innerHTML = '<section class="notice urgent" role="alert"><h2>Result screen could not open</h2><p>No estimate was presented. Stop screening and restart the guided steps.</p><button id="exit-result-screen" class="secondary" type="button">Stop screening</button></section>';
    app.querySelector('#exit-result-screen').addEventListener('click', () => {
      prescriptionResultStepActive = false;
      validityStepActive = false;
      eyeAnalysisStepActive = false;
      predictionStepActive = false;
      featureExtractionStepActive = false;
      preprocessingStepActive = false;
      captureStepActive = false;
      qualityStepActive = false;
      resetPipelineSession();
      render();
    });
  }
}

async function enterRetestStep(result) {
  const safety = assessCurrentSafety({ validityResult: pipelineState.latestValidityResult, retestResult: result });
  if (safety.status === 'STOP_AND_SEEK_CARE' || safety.status === 'SCREENING_LIMITED') { safetyStop(safety); return; }
  await cleanupValidityStep?.(); cleanupValidityStep = null;
  await cleanupPrescriptionResultStep?.(); cleanupPrescriptionResultStep = null;
  prescriptionResultStepActive = false;
  validityStepActive = false;
  document.querySelector('#page-title').textContent = 'Retest & consistency check';
  document.querySelector('.intro').textContent = 'Component 13 will guide a bounded retest through the existing capture pipeline.';
  updateProgress(13);
  try {
    cleanupRetestStep = mountRetestStep(app, { result, safetyResult: safety }, {
      onStart: () => { void beginRetest(); },
      onExit: () => { resetPipelineSession(); if (result.status === 'FAILED') resetQuestionnaireDraft(); render(); },
    });
  } catch {
    app.innerHTML = '<section class="notice urgent" role="alert"><h2>Retest could not start</h2><p>No measurement was changed or presented. Return to the start or seek professional assessment.</p><button id="exit-retest-error" class="secondary" type="button">Return to start</button></section>';
    app.querySelector('#exit-retest-error').addEventListener('click', () => render());
  }
}

async function assessAndRouteValidity(event) {
  if (!event?.detail) return;
  pipelineState.latestValidityResult = event.detail;
  validityStepActive = false;
  if (pipelineState.retestSession?.state === 'ANALYZING') pipelineState.retestSession = transitionRetestState(pipelineState.retestSession, 'COMPARING');
  const session = pipelineState.retestSession || createRetestSession(RETEST_POLICY);
  const assessed = recordRetestAssessment(session, event.detail);
  pipelineState.retestSession = assessed.session;
  pipelineState.currentRetestResult = assessed.result;
  publishRetestResult(pipelineState.currentRetestResult);
  const safetyResult = assessCurrentSafety({ validityResult: event.detail, retestResult: assessed.result });
  if (safetyResult.status === 'STOP_AND_SEEK_CARE') { safetyStop(safetyResult); return; }
  if (safetyResult.status === 'SCREENING_LIMITED' || assessed.result.status === 'FAILED') {
    await enterPrescriptionResultStep({ detail: event.detail }, assessed.result);
  } else if (safetyResult.status === 'REQUIRES_RETEST' || assessed.result.status !== 'PASSED') {
    await enterRetestStep(assessed.result);
  } else {
    await enterPrescriptionResultStep({ detail: event.detail }, assessed.result);
  }
}

async function beginRetest() {
  const safety = assessCurrentSafety({ validityResult: pipelineState.latestValidityResult, retestResult: pipelineState.currentRetestResult });
  if (safety.status === 'STOP_AND_SEEK_CARE' || safety.status === 'SCREENING_LIMITED') { safetyStop(safety); return; }
  await cleanupRetestStep?.(); cleanupRetestStep = null;
  const started = startRetest(pipelineState.retestSession);
  pipelineState.retestSession = started;
  if (started.state === 'FAILED') { pipelineState.currentRetestResult = { ...pipelineState.currentRetestResult, status: 'FAILED', state: 'FAILED', reasons: started.reasons, presentation: { canPresent: false } }; await enterPrescriptionResultStep({ detail: pipelineState.latestValidityResult }, pipelineState.currentRetestResult); return; }
  qualityStepActive = false; captureStepActive = false; preprocessingStepActive = false;
  captureFailureRouted = false;
  featureExtractionStepActive = false; predictionStepActive = false; eyeAnalysisStepActive = false;
  await cleanupCaptureStep?.(); cleanupCaptureStep = null;
  await cleanupQualityStep?.(); cleanupQualityStep = null;
  await cleanupPositioningStep?.(); cleanupPositioningStep = null;
  await cleanupCameraStep?.(); cleanupCameraStep = null;
  currentCamera = null;
  document.querySelector('#page-title').textContent = 'Camera setup';
  document.querySelector('.intro').textContent = 'Start the camera again to repeat the existing guided measurement. Your questionnaire remains in this session.';
  updateProgress(2);
  cleanupCameraStep = mountCameraStep(app, { compatibilityLayer: deviceCompatibilityLayer, safetyLayer: medicalSafetyLayer, questionnaire: localDataStore.getSessionDraft(), onBack: () => { void enterRetestStep(pipelineState.currentRetestResult); } });
}

async function enterHistoryStep(returnToResult) {
  historyReturnToResult = returnToResult;
  if (cleanupPrescriptionResultStep) { await cleanupPrescriptionResultStep(); cleanupPrescriptionResultStep = null; }
  prescriptionResultStepActive = false;
  document.querySelector('#page-title').textContent = 'Result history';
  document.querySelector('.intro').textContent = 'Review screening sessions saved locally in this browser.';
  updateProgress(14);
  await cleanupHistoryStep?.(); cleanupHistoryStep = null;
  cleanupHistoryStep = mountHistoryStep(app, { store: historyStore }, {
    onResetSession: resetActiveSessionView,
    onClearAllData: resetActiveSessionView,
    onBack: () => {
      void (async () => {
        await cleanupHistoryStep?.(); cleanupHistoryStep = null;
        if (historyReturnToResult && pipelineState.latestValidityResult) await enterPrescriptionResultStep({ detail: pipelineState.latestValidityResult }, pipelineState.currentRetestResult);
        else if (historyReturnToResult && pipelineState.currentRetestResult?.status === 'FAILED') await enterPrescriptionResultStep({ detail: null }, pipelineState.currentRetestResult);
        else render();
      })();
    },
  });
}

app.addEventListener('eye-validity-complete', event => { queueMicrotask(() => void assessAndRouteValidity(event)); });
app.addEventListener('component13-retest-request', event => {
  queueMicrotask(async () => {
    const validity = event.detail?.validityResult || pipelineState.latestValidityResult;
    if (validity && !pipelineState.retestSession) {
      const assessed = recordRetestAssessment(createRetestSession(RETEST_POLICY), validity);
      pipelineState.retestSession = assessed.session; pipelineState.currentRetestResult = assessed.result;
    } else if (pipelineState.retestSession?.state === 'PASSED') {
      pipelineState.retestSession = { ...pipelineState.retestSession, state: 'RETEST_REQUIRED' };
      pipelineState.currentRetestResult = { ...pipelineState.currentRetestResult, status: 'RETEST_AGAIN', state: 'RETEST_AGAIN', reasons: [{ code: 'USER_REQUESTED_RETEST', message: 'A repeat measurement was requested.' }] };
    }
    await enterRetestStep(pipelineState.currentRetestResult);
  });
});

app.addEventListener('prescription-result-ready', event => {
  const result = event.detail;
  if (!result) return;
  localDataStore.setSessionValue('validatedResult', result);
  const key = `${result.timestamp || 'no-time'}:${result.status}:${result.retest?.attempts?.length ?? 0}`;
  const statusNode = app.querySelector('#prescription-history-status');
  if (localDataStore.getSessionValue('consentState')?.saveHistory !== true) {
    if (statusNode) statusNode.textContent = 'This result was not added to local history; you did not opt in to saving test results.';
    return;
  }
  if (persistedResultKeys.has(key)) { if (statusNode) statusNode.textContent = 'This result is already saved in local history.'; return; }
  persistedResultKeys.add(key);
  queueMicrotask(async () => {
    try { const saved = await historyStore.save(result); if (saved?.id) persistedResultIds.set(key, saved.id); if (statusNode?.isConnected) statusNode.textContent = 'Final screening result saved in this browser on this device.'; }
    catch { persistedResultKeys.delete(key); if (statusNode?.isConnected) statusNode.textContent = 'This result could not be saved locally. History storage may be unavailable or full; the screening result remains visible.'; }
  });
});

app.addEventListener('component14-history-open', event => { queueMicrotask(() => void enterHistoryStep(event.detail?.sourceComponent === '12')); });

app.addEventListener('component15-pdf-generate-request', event => {
  event.preventDefault();
  deliverScreeningReport(localDataStore.getSessionValue('validatedResult') || event.detail?.result, event.detail?.mode, '#prescription-result-pdf-status');
});
app.addEventListener('component15-report-export-request', event => {
  event.preventDefault();
  deliverScreeningReport(event.detail?.record, event.detail?.mode, '#history-state');
});

function deliverScreeningReport(source, mode, statusSelector) {
  const status = app.querySelector(statusSelector);
  try {
    const sourceKey = source?.timestamp ? `${source.timestamp}:${source.status}:${source.retest?.attempts?.length ?? 0}` : null;
    const reportSource = sourceKey && persistedResultIds.has(sourceKey) ? { ...source, id: persistedResultIds.get(sourceKey) } : source;
    const generated = createScreeningReportBlob(reportSource);
    const url = URL.createObjectURL(generated.blob);
    const link = document.createElement('a');
    link.href = url;
    link.rel = 'noopener';
    if (mode === 'preview') {
      link.target = '_blank';
      link.removeAttribute('download');
      link.setAttribute('aria-label', 'Open local PDF screening report in a new tab');
    } else {
      link.download = generated.filename;
    }
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    if (status) status.textContent = mode === 'preview'
      ? 'The local PDF preview was requested in a new tab. If your browser blocks previews, download the report instead.'
      : 'PDF report generated locally and sent to your browser downloads.';
  } catch {
    if (status) {
      status.textContent = 'The PDF could not be generated from this result. The saved screening data was not changed.';
      status.classList?.add('is-error');
    }
  }
}

function publishRetestResult(result) {
  assessCurrentSafety({ validityResult: pipelineState.latestValidityResult, retestResult: result });
  app.dispatchEvent(new CustomEvent('component13-retest-result-ready', { bubbles: true, detail: result }));
}

function assessCurrentSafety(additional = {}) {
  return medicalSafetyLayer.assess({
    questionnaire: localDataStore.getSessionDraft(),
    compatibility: deviceCompatibilityLayer.getSnapshot(),
    ...additional,
  });
}

function prescription(eye, title) { return `<div><strong>${title}</strong><div class="prescription"><label>SPH<input inputmode="decimal" name="${eye}.sph" value="${answers[eye].sph}" aria-label="${title} sphere"></label><label>CYL<input inputmode="decimal" name="${eye}.cyl" value="${answers[eye].cyl}" aria-label="${title} cylinder"></label><label>Axis<input inputmode="numeric" name="${eye}.axis" value="${answers[eye].axis}" aria-label="${title} axis"></label></div>${['sph','cyl','axis'].map(k=>`<p class="error" id="error-${eye}.${k}"></p>`).join('')}</div>`; }
function render() { if(cleanupHistoryStep){cleanupHistoryStep();cleanupHistoryStep=null;} if(cleanupPrescriptionResultStep){void cleanupPrescriptionResultStep();cleanupPrescriptionResultStep=null;} if(cleanupValidityStep){void cleanupValidityStep();cleanupValidityStep=null;} if(cleanupEyeAnalysisStep){void cleanupEyeAnalysisStep();cleanupEyeAnalysisStep=null;} if(cleanupPredictionStep){void cleanupPredictionStep();cleanupPredictionStep=null;} if(cleanupFeatureExtractionStep){void cleanupFeatureExtractionStep();cleanupFeatureExtractionStep=null;} if(cleanupPreprocessingStep){void cleanupPreprocessingStep();cleanupPreprocessingStep=null;} if(cleanupCaptureStep){void cleanupCaptureStep();cleanupCaptureStep=null;} if(cleanupQualityStep){void cleanupQualityStep();cleanupQualityStep=null;} if(cleanupPositioningStep){void cleanupPositioningStep();cleanupPositioningStep=null;} if (cleanupCameraStep) { cleanupCameraStep(); cleanupCameraStep = null; } document.querySelector('#page-title').textContent='Before you begin'; document.querySelector('.intro').textContent='Answer a few questions so we can check whether routine vision screening is appropriate today.'; updateProgress(1); app.innerHTML = `<form id="questionnaire" novalidate>
  <div class="notice">This is a preliminary screening, not a diagnosis or a replacement for an eye examination.</div>
  <aside class="notice local-privacy-notice"><strong>Privacy and local data</strong><p>Questionnaire answers and the active test session stay in this browser tab’s memory and are cleared when you reset or leave. Eye photos and camera frames are not saved. You may optionally save the final screening result and consent choice in this browser’s local history; that data stays on this device unless you export it.</p><p id="questionnaire-storage-status" class="hint" role="status">Checking whether local browser storage is available…</p></aside>
  <fieldset><legend>Basic information</legend><label for="age">Age <span class="required">*</span><input id="age" name="age" inputmode="numeric" value="${answers.age}" aria-describedby="age-hint error-age"></label><p id="age-hint" class="hint">Routine screening has age eligibility limits.</p><p class="error" id="error-age"></p>
  ${choice('previousPrescription','Do you have an existing spectacle prescription?',yn)}<div id="prescription-fields" class="${answers.previousPrescription === 'yes' ? '' : 'hidden'}"><p class="hint">Optional. Enter only values you know; this information is not treated as a current or clinically valid prescription.</p>${prescription('right','Right eye (OD)')}${prescription('left','Left eye (OS)')}</div></fieldset>
  <fieldset><legend>Vision and eye history</legend>${choice('wearsCorrection','Do you currently wear spectacles or contact lenses?',yn)}${choice('lastExam','When was your last comprehensive eye examination?',[['within-year','Within the last year'],['one-two-years','1–2 years ago'],['more-than-two-years','More than 2 years ago'],['never','Never'],['not-sure','Not sure']])}${choice('blurredVision','Are you currently experiencing blurred vision?',yn)}${choice('suddenVisionChange','Have you recently noticed a sudden change in your vision?',yn)}${choice('painfulSymptoms','Are you experiencing eye pain, significant redness, or unusual light sensitivity?',yn)}${choice('seriousEyeInjury','Have you had a serious eye injury that has not yet been assessed?',yn)}${choice('pendingEyeSurgeryFollowup','Do you still need follow-up after eye surgery?',yn)}${choice('eyeConditionHistory','Have you been diagnosed with an eye condition or had eye surgery?',yn)}${choice('steadyGaze','Do you have difficulty keeping your eyes open or looking steadily at a target?',yn)}<label for="historyDescription">Optional details about relevant history<textarea id="historyDescription" name="historyDescription" maxlength="500">${answers.historyDescription}</textarea></label></fieldset>
  <fieldset><legend>Screening consent</legend><p class="notice">This application provides preliminary vision screening and refractive-error estimates. Results may be inaccurate and must not be used to diagnose an eye condition or treated as a prescription. Seek professional care for concerning symptoms. Camera and image-processing permissions are requested separately at the relevant steps.</p><div class="consent"><label><input type="checkbox" name="requiredConsent" ${answers.requiredConsent ? 'checked' : ''} aria-describedby="error-requiredConsent"> I understand the screening limitations and want to proceed. <span class="required">*</span></label><p class="error" id="error-requiredConsent"></p><label><input type="checkbox" name="saveHistory" ${answers.saveHistory ? 'checked' : ''}> Save my final screening results and this choice to local history on this device (optional).</label></div></fieldset>
  <div class="actions"><button class="primary" type="submit">Continue</button><button class="secondary" type="button" id="open-history">View result history</button><button class="secondary" type="button" id="cancel">Cancel</button></div></form>`;
  const form = app.querySelector('form');
  void localDataStore.getStorageAvailability().then(result => {
    const status = app.querySelector('#questionnaire-storage-status');
    if (!status) return;
    status.textContent = result.available
      ? 'Local history storage is available in this browser. Questionnaire answers and camera images are not stored.'
      : 'Local history storage is unavailable or restricted in this browser; screening can continue, but history may not save.';
  });
  form.addEventListener('input', capture); form.addEventListener('change', capture); form.addEventListener('submit', submit);
  app.querySelector('#open-history').addEventListener('click', () => app.dispatchEvent(new CustomEvent('component14-history-open', { detail: { sourceComponent: '1' } })));
  app.querySelector('#cancel').addEventListener('click', () => { localDataStore.resetSession(); clearQuestionnaireSession(); render(); document.querySelector('#age').focus(); });
}
function capture(event) { const { name, value, type, checked } = event.target; if (!name) return; if (name.includes('.')) { const [eye,key] = name.split('.'); answers[eye][key] = value; } else answers[name] = type === 'checkbox' ? checked : value; if (name === 'previousPrescription') app.querySelector('#prescription-fields').classList.toggle('hidden', value !== 'yes'); }
function showErrors(errors) { Object.entries(errors).forEach(([key, message]) => { const node = app.querySelector(`#error-${CSS.escape(key)}`); const input = app.querySelector(`[name="${CSS.escape(key)}"]`); if (node) node.textContent = message; if (input) input.setAttribute('aria-invalid','true'); }); const first = Object.keys(errors)[0]; if (first) app.querySelector(`[name="${CSS.escape(first)}"]`)?.focus(); }
function submit(event) { event.preventDefault(); app.querySelectorAll('.error').forEach(n=>n.textContent=''); app.querySelectorAll('[aria-invalid]').forEach(n=>n.removeAttribute('aria-invalid')); const questionnaire = localDataStore.getSessionDraft(); const { errors } = validateQuestionnaire(questionnaire); const safety = medicalSafetyLayer.assess({ questionnaire }); if (safety.status === 'STOP_AND_SEEK_CARE') return safetyStop(safety); if (Object.keys(errors).length) return showErrors(errors); try { const result = createResult(questionnaire, safety); setQuestionnaireResult(result); resetPipelineSession(); void localDataStore.saveConsentState({ screeningAccepted: true, saveHistory: questionnaire.saveHistory }).catch(() => {}); captureFailureRouted = false; document.querySelector('#page-title').textContent='Device compatibility & camera setup'; document.querySelector('.intro').textContent='Check this browser and device before starting the live camera. No camera permission is requested by the preflight check.'; updateProgress(2); cleanupCameraStep = mountCameraStep(app,{compatibilityLayer:deviceCompatibilityLayer,safetyLayer:medicalSafetyLayer,questionnaire,onBack:render}); app.dispatchEvent(new CustomEvent('questionnaire-complete',{detail:result})); } catch { app.insertAdjacentHTML('afterbegin','<p class="notice urgent" role="alert">We could not continue. Your answers are still here; please try again.</p>'); }
}
function safetyStop(safety) { const action = safety?.status === 'STOP_AND_SEEK_CARE' ? 'Review my answers' : 'Return to start'; renderSafetyNotice(app, safety, { onAction: render, actionLabel: action }); app.querySelector('h2')?.focus(); }
function resetPipelineSession() { pipelineState.retestSession = null; pipelineState.currentRetestResult = null; pipelineState.latestValidityResult = null; localDataStore.setSessionValue('validatedResult', null); localDataStore.setSessionValue('eyeAnalysis', null); }
function resetQuestionnaireDraft() { localDataStore.replaceSessionDraft({ age: '', previousPrescription: '', right: blank(), left: blank(), wearsCorrection: '', lastExam: '', blurredVision: '', suddenVisionChange: '', painfulSymptoms: '', seriousEyeInjury: '', pendingEyeSurgeryFollowup: '', eyeConditionHistory: '', steadyGaze: '', historyDescription: '', requiredConsent: false, saveHistory: false }); }
async function resetActiveSessionView() {
  for (const name of ['cleanupHistoryStep', 'cleanupPrescriptionResultStep', 'cleanupRetestStep', 'cleanupValidityStep', 'cleanupEyeAnalysisStep', 'cleanupPredictionStep', 'cleanupFeatureExtractionStep', 'cleanupPreprocessingStep', 'cleanupCaptureStep', 'cleanupQualityStep', 'cleanupPositioningStep', 'cleanupCameraStep']) {
    const cleanup = ({ cleanupHistoryStep, cleanupPrescriptionResultStep, cleanupRetestStep, cleanupValidityStep, cleanupEyeAnalysisStep, cleanupPredictionStep, cleanupFeatureExtractionStep, cleanupPreprocessingStep, cleanupCaptureStep, cleanupQualityStep, cleanupPositioningStep, cleanupCameraStep })[name];
    try { await cleanup?.(); } catch { /* Continue releasing the remaining local session resources. */ }
    if (name === 'cleanupHistoryStep') cleanupHistoryStep = null;
    else if (name === 'cleanupPrescriptionResultStep') cleanupPrescriptionResultStep = null;
    else if (name === 'cleanupRetestStep') cleanupRetestStep = null;
    else if (name === 'cleanupValidityStep') cleanupValidityStep = null;
    else if (name === 'cleanupEyeAnalysisStep') cleanupEyeAnalysisStep = null;
    else if (name === 'cleanupPredictionStep') cleanupPredictionStep = null;
    else if (name === 'cleanupFeatureExtractionStep') cleanupFeatureExtractionStep = null;
    else if (name === 'cleanupPreprocessingStep') cleanupPreprocessingStep = null;
    else if (name === 'cleanupCaptureStep') cleanupCaptureStep = null;
    else if (name === 'cleanupQualityStep') cleanupQualityStep = null;
    else if (name === 'cleanupPositioningStep') cleanupPositioningStep = null;
    else cleanupCameraStep = null;
  }
  await localDataStore.resetSessionData(); clearQuestionnaireSession(); persistedResultKeys.clear(); persistedResultIds.clear(); resetPipelineSession();
  captureStepActive = qualityStepActive = preprocessingStepActive = featureExtractionStepActive = predictionStepActive = eyeAnalysisStepActive = validityStepActive = prescriptionResultStepActive = false;
  render();
}
function updateProgress(step) { document.querySelectorAll('.progress li').forEach((item,index)=>{ if(index+1===step) item.setAttribute('aria-current','step'); else item.removeAttribute('aria-current'); }); }
render();
