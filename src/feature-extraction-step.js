import {
  FEATURE_EXTRACTION_VERSION,
  FEATURE_ORDER,
  FeatureExtractionError,
  extractFeaturesBatch,
} from './feature-extraction.js';

export function mountFeatureExtractionStep(root, { preprocessingBatch } = {}, { onExit = () => {}, ...options } = {}) {
  root.innerHTML = `<section aria-labelledby="features-title"><h2 id="features-title" tabindex="-1">Optical feature extraction</h2><p>Component 8 is measuring descriptive geometry and image statistics from the validated, preprocessed eye images. It does not estimate a prescription or diagnose an eye condition.</p><aside class="notice feature-disclosure"><strong>Local, descriptive measurements</strong><p>Feature extraction runs in this browser using the existing Component 7 pixel arrays and Component 4 landmarks. Images and feature vectors are not uploaded or written to persistent storage. The current detector does not provide pupil boundaries or per-eye confidence; those measurements will be shown as unavailable.</p></aside><div id="feature-status" class="positioning-status" role="status" aria-live="polite" aria-atomic="true"><strong id="feature-heading">Extracting features…</strong><span id="feature-detail">Both eyes are processed independently; no prediction is being run.</span></div><ul id="feature-summary" class="feature-summary"></ul><p id="feature-error" class="error" role="alert"></p><div class="actions"><button id="feature-stop" class="secondary" type="button">Stop screening</button></div><p class="hint">The versioned data is emitted through <code>eye-features-ready</code> and <code>eye-features-complete</code>. It is not a validated refractive-error feature vector.</p></section>`;
  const heading = root.querySelector('#feature-heading');
  const detail = root.querySelector('#feature-detail');
  const summary = root.querySelector('#feature-summary');
  const errorElement = root.querySelector('#feature-error');
  const stopButton = root.querySelector('#feature-stop');
  let disposed = false, generation = 0, featureBatch = null;
  const sourceCaptureIds = Array.isArray(preprocessingBatch?.captures)
    ? preprocessingBatch.captures.map(capture => capture?.sourceCaptureId).filter(Boolean)
    : [];

  async function process() {
    const currentGeneration = ++generation;
    try {
      const result = await extractFeaturesBatch(preprocessingBatch, {
        ...options,
        shouldContinue: () => !disposed && generation === currentGeneration,
      });
      if (disposed || generation !== currentGeneration) return;
      preprocessingBatch = null;
      featureBatch = result;
      heading.textContent = 'Feature extraction complete.';
      detail.textContent = 'Descriptive eye and iris features are ready. No refractive-error prediction was produced.';
      summary.replaceChildren(...result.captures.flatMap(capture => [
        makeSummaryItem(`Right eye (OD): ${statusText(capture.rightEye)}`),
        makeSummaryItem(`Left eye (OS): ${statusText(capture.leftEye)}`),
      ]));
      root.dispatchEvent(new CustomEvent('eye-features-ready', { bubbles: true, detail: result }));
      root.dispatchEvent(new CustomEvent('eye-features-complete', { bubbles: true, detail: result }));
    } catch (error) {
      if (disposed || generation !== currentGeneration) return;
      preprocessingBatch = null;
      const result = {
        featureSchemaVersion: '1.0.0',
        featureExtractionVersion: FEATURE_EXTRACTION_VERSION,
        sourceCaptureIds,
        featureOrder: [...FEATURE_ORDER],
        timestamp: Date.now(),
        valid: false,
        modelReady: false,
        error: {
          code: error?.code || 'FEATURE_EXTRACTION_FAILED',
          message: error?.message || 'The eye features could not be safely extracted.',
          details: error?.details || {},
        },
      };
      heading.textContent = 'Feature extraction could not be completed.';
      detail.textContent = 'No partial feature batch was passed downstream.';
      errorElement.textContent = result.error.message;
      root.dispatchEvent(new CustomEvent('eye-feature-error', { bubbles: true, detail: result }));
    }
  }

  async function cleanup() {
    if (disposed) return;
    disposed = true;
    generation++;
    stopButton.removeEventListener('click', stop);
    window.removeEventListener('pagehide', pageHide);
    featureBatch = null;
    preprocessingBatch = null;
  }
  async function stop() { await cleanup(); onExit(); }
  const pageHide = () => { void cleanup(); };
  stopButton.addEventListener('click', stop);
  window.addEventListener('pagehide', pageHide, { once: true });
  void process();
  return cleanup;
}

function makeSummaryItem(text) { const item = document.createElement('li'); item.textContent = text; return item; }
function statusText(eye) {
  const available = FEATURE_ORDER.filter(name => eye.features[name].valid).length;
  return `${eye.completeness.toLowerCase()} — ${available} of ${FEATURE_ORDER.length} descriptive features; pupil measurements and detector confidence unavailable`;
}
