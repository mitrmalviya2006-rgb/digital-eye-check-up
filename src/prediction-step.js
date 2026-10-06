import { PREDICTION_ENGINE_VERSION, PREDICTION_SCHEMA_VERSION, createPredictionEngine } from './prediction-engine.js';

export function mountPredictionStep(root, { featureBatch } = {}, {
  compatibility = null,
  engine = createPredictionEngine(),
  onExit = () => {},
  now = () => Date.now(),
  disposeEngineOnCleanup = true,
} = {}) {
  root.innerHTML = `<section aria-labelledby="prediction-title"><h2 id="prediction-title" tabindex="-1">AI refractive-error prediction</h2><p>Component 9 accepts only validated Component 8 feature records. Any configured inference adapter must run locally on this device.</p><aside class="notice prediction-disclosure"><strong>Model and clinical limitations</strong><p>No trained SPH/CYL/Axis model is currently installed. No prescription values or confidence scores will be generated. A future model's outputs must pass Component 10 and Component 11 before they can be considered for presentation; this step does not diagnose disease or establish a clinically valid prescription.</p></aside><div id="prediction-status" class="positioning-status" role="status" aria-live="polite" aria-atomic="true"><strong id="prediction-heading">Checking model availability…</strong><span id="prediction-detail">No image or feature data is uploaded by this component.</span></div><ul id="prediction-summary" class="prediction-summary"></ul><p id="prediction-error" class="error" role="alert"></p><div class="actions"><button id="prediction-retry" class="primary hidden" type="button">Retry model initialization</button><button id="prediction-stop" class="secondary" type="button">Stop screening</button></div><p class="hint">Successful outputs are emitted as <code>eye-prediction-complete</code> for downstream analysis. An unavailable model emits no estimates.</p></section>`;

  const heading = root.querySelector('#prediction-heading');
  const detail = root.querySelector('#prediction-detail');
  const summary = root.querySelector('#prediction-summary');
  const errorElement = root.querySelector('#prediction-error');
  const retryButton = root.querySelector('#prediction-retry');
  const stopButton = root.querySelector('#prediction-stop');
  let disposed = false;
  let running = false;
  let lastErrorCode = null;
  let retainedFeatureBatch = featureBatch;
  let controller = new AbortController();
  const sourceCaptureIds = Array.isArray(featureBatch?.captures)
    ? featureBatch.captures.map(capture => capture?.sourceCaptureId).filter(Boolean)
    : [];

  async function run({ retry = false } = {}) {
    if (disposed || running) return;
    running = true;
    retryButton.classList.add('hidden');
    retryButton.textContent = 'Retry model initialization';
    errorElement.textContent = '';
    heading.textContent = retry ? 'Retrying local model initialization…' : 'Checking local prediction model…';
    detail.textContent = `${compatibility?.compute?.modelRuntime?.reason || 'Local model compatibility will be checked against its declared manifest.'} Both anatomical eye records remain separate; no unsupported backend fallback is used.`;
    try {
      if (retry) {
        const retrySnapshot = await engine.retry({ reinitialize: lastErrorCode === 'RUNTIME_MEMORY_ERROR' });
        if (retrySnapshot.status !== 'ready') throw errorFromSnapshot(retrySnapshot);
      }
      const result = await engine.predictBatch(retainedFeatureBatch, { signal: controller.signal });
      if (disposed) return;
      retainedFeatureBatch = null;
      lastErrorCode = null;
      heading.textContent = 'Model inference complete; reliability review is still required.';
      detail.textContent = 'Prediction values are withheld from this screen and are not clinically assessed. Component 11 must assess reliability before presentation.';
      summary.replaceChildren(...result.captures.flatMap(capture => [
        makeSummaryItem(`Right eye (OD): model output validated; awaiting Component 11 reliability assessment.`),
        makeSummaryItem(`Left eye (OS): model output validated; awaiting Component 11 reliability assessment.`),
      ]));
      root.dispatchEvent(new CustomEvent('eye-prediction-complete', { bubbles: true, detail: result }));
    } catch (error) {
      if (disposed) return;
      lastErrorCode = error?.code || 'PREDICTION_FAILED';
      const snapshot = engine.getSnapshot?.() || { status: 'error', modelReady: false, model: null };
      const unavailable = error?.code === 'MODEL_NOT_CONFIGURED' || snapshot.status === 'unavailable';
      const retryable = snapshot.status === 'error' || ['INFERENCE_FAILED', 'RUNTIME_MEMORY_ERROR'].includes(error?.code);
      const result = makeFailureResult(error, snapshot, sourceCaptureIds, now(), unavailable, retainedFeatureBatch, retryable);
      heading.textContent = unavailable ? 'Prediction model unavailable.' : 'Prediction could not be completed.';
      detail.textContent = unavailable
        ? 'No trained prediction model is configured. No SPH, CYL, Axis, or confidence values were produced.'
        : 'No partial or invalid prediction was passed downstream. Retry only if this model/runtime failure may be transient.';
      errorElement.textContent = result.error.message;
      retryButton.textContent = snapshot.status === 'error' ? 'Retry model initialization' : 'Retry local inference';
      retryButton.classList.toggle('hidden', !retryable);
      root.dispatchEvent(new CustomEvent(unavailable ? 'eye-prediction-unavailable' : 'eye-prediction-error', { bubbles: true, detail: result }));
    } finally {
      running = false;
    }
  }

  async function cleanup() {
    if (disposed) return;
    disposed = true;
    controller.abort();
    retainedFeatureBatch = null;
    retryButton.removeEventListener('click', retry);
    stopButton.removeEventListener('click', stop);
    window.removeEventListener('pagehide', pageHide);
    if (disposeEngineOnCleanup) await engine.dispose?.();
  }
  async function retry() { await run({ retry: true }); }
  async function stop() { await cleanup(); onExit(); }
  const pageHide = () => { void cleanup(); };
  retryButton.addEventListener('click', retry);
  stopButton.addEventListener('click', stop);
  window.addEventListener('pagehide', pageHide, { once: true });
  void run();
  return cleanup;
}

function makeFailureResult(error, snapshot, sourceCaptureIds, inferenceTimestamp, unavailable, featureBatch, retryable) {
  const code = typeof error?.code === 'string' ? error.code : 'PREDICTION_FAILED';
  const message = typeof error?.message === 'string' ? error.message : 'The local prediction model could not produce a valid result.';
  return {
    predictionSchemaVersion: PREDICTION_SCHEMA_VERSION,
    predictionEngineVersion: PREDICTION_ENGINE_VERSION,
    model: snapshot.model || null,
    inferenceTimestamp,
    predictionStatus: unavailable ? 'UNAVAILABLE' : 'ERROR',
    inputValidity: {
      valid: featureBatch?.valid === true,
      featureSchemaVersion: featureBatch?.featureSchemaVersion || null,
      sourcePreprocessingVersion: featureBatch?.sourcePreprocessingVersion || null,
      status: unavailable ? 'NOT_EVALUATED_BY_MODEL' : 'REJECTED_OR_UNAVAILABLE',
    },
    outputValidity: { valid: false },
    clinicalValidity: 'NOT_ASSESSED',
    component11ReliabilityAssessmentRequired: true,
    sourceCaptureIds: [...sourceCaptureIds],
    valid: false,
    modelReady: false,
    retryable,
    error: { code, message, details: error?.details || {} },
  };
}

function errorFromSnapshot(snapshot) {
  const error = snapshot?.error || {};
  const result = new Error(error.message || 'The local model could not be initialized.');
  result.code = error.code || 'MODEL_NOT_READY';
  result.details = error.details || {};
  return result;
}

function makeSummaryItem(text) {
  const item = document.createElement('li');
  item.textContent = text;
  return item;
}
