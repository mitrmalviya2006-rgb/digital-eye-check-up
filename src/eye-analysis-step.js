import { analyzePredictionResult } from './eye-analysis.js';

export function mountEyeAnalysisStep(root, { predictionResult } = {}, { onExit = () => {} } = {}) {
  let result = analyzePredictionResult(predictionResult);
  root.innerHTML = `<section aria-labelledby="eye-analysis-title"><h2 id="eye-analysis-title" tabindex="-1">Left/right eye analysis</h2><p>Component 10 validates and organizes Component 9's existing results. It does not capture images, run inference, or combine the two eyes.</p><aside class="notice eye-analysis-disclosure"><strong>Not a clinical assessment</strong><p>These structural checks do not establish that an estimate is reliable or clinically valid. Component 11 reliability review is still required before any values could be considered for display.</p></aside><div id="eye-analysis-status" class="positioning-status" role="status" aria-live="polite" aria-atomic="true"><strong id="eye-analysis-heading"></strong><span id="eye-analysis-detail"></span></div><ul id="eye-analysis-summary" class="eye-analysis-summary"></ul><p id="eye-analysis-error" class="error" role="alert"></p><div class="actions"><button id="eye-analysis-stop" class="secondary" type="button">Stop screening</button></div></section>`;

  const heading = root.querySelector('#eye-analysis-heading');
  const detail = root.querySelector('#eye-analysis-detail');
  const summary = root.querySelector('#eye-analysis-summary');
  const errorElement = root.querySelector('#eye-analysis-error');
  const status = root.querySelector('#eye-analysis-status');
  const stopButton = root.querySelector('#eye-analysis-stop');
  let disposed = false;

  if (result.analysisStatus === 'ANALYZED') {
    heading.textContent = 'Right and left eye results are independently validated.';
    detail.textContent = 'Values remain grouped by source capture; no predictions were averaged. Component 11 reliability review is pending.';
  } else if (result.analysisStatus === 'UNAVAILABLE') {
    heading.textContent = 'No eye predictions are available.';
    detail.textContent = 'Component 9 did not have a trained local model. Both eye results remain explicitly unavailable; no values were substituted.';
  } else if (result.analysisStatus === 'ERROR') {
    heading.textContent = 'Component 9 did not complete prediction.';
    detail.textContent = 'Neither eye has a usable prediction. No values were substituted or passed as valid.';
  } else {
    heading.textContent = 'Prediction structure rejected.';
    detail.textContent = 'The prediction data did not meet the versioned Component 9 contract. No SPH, CYL, or Axis values were passed onward.';
    errorElement.textContent = result.structuralValidationErrors.map(error => error.message).join(' ');
    status.classList.add('is-error');
  }

  summary.replaceChildren(
    makeSummaryItem(`Right eye (OD): ${result.rightEye.status.toLowerCase()}${result.rightEye.status === 'VALID' ? `; ${result.rightEye.predictions.length} separate prediction(s)` : ''}.`),
    makeSummaryItem(`Left eye (OS): ${result.leftEye.status.toLowerCase()}${result.leftEye.status === 'VALID' ? `; ${result.leftEye.predictions.length} separate prediction(s)` : ''}.`),
    makeSummaryItem(`Model version: ${result.sourcePrediction.model?.version || 'unavailable'}.`),
  );

  root.dispatchEvent(new CustomEvent('eye-analysis-complete', { bubbles: true, detail: result }));

  async function stop() {
    if (disposed) return;
    await cleanup();
    onExit();
  }
  async function cleanup() {
    if (disposed) return;
    disposed = true;
    result = null;
    stopButton.removeEventListener('click', stop);
  }
  stopButton.addEventListener('click', stop);
  return cleanup;
}

function makeSummaryItem(text) {
  const item = document.createElement('li');
  item.textContent = text;
  return item;
}
