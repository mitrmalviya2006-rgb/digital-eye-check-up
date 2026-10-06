import { assessEyeValidity } from './validity-engine.js';

export function mountValidityStep(root, { eyeAnalysis } = {}, { onExit = () => {}, policy = {}, now } = {}) {
  const result = assessEyeValidity(eyeAnalysis, { policy, ...(now ? { now } : {}) });
  root.innerHTML = `<section aria-labelledby="validity-title"><h2 id="validity-title" tabindex="-1">Confidence &amp; validity review</h2><p>Component 11 checks technical completeness, captured-image evidence, model reliability signals, and repeat-capture consistency. It does not diagnose an eye condition or establish clinical accuracy.</p><aside class="notice validity-disclosure"><strong>Technical screening status only</strong><p>A valid status means the configured technical checks passed; it is not a prescription or a medical diagnosis. Component 12 must respect the machine-readable presentation gate.</p></aside><div id="validity-status" class="positioning-status" role="status" aria-live="polite" aria-atomic="true"><strong id="validity-heading"></strong><span id="validity-detail"></span></div><ul id="validity-summary" class="validity-summary"></ul><details id="validity-reasons"><summary>Review validation reasons and next steps</summary><ul id="validity-reason-list"></ul><ul id="validity-recommendations"></ul></details><div class="actions"><button id="validity-stop" class="secondary" type="button">Stop screening</button></div></section>`;

  const heading = root.querySelector('#validity-heading');
  const detail = root.querySelector('#validity-detail');
  const statusNode = root.querySelector('#validity-status');
  const summary = root.querySelector('#validity-summary');
  const reasonList = root.querySelector('#validity-reason-list');
  const recommendationList = root.querySelector('#validity-recommendations');
  const stopButton = root.querySelector('#validity-stop');
  const reasonsDetails = root.querySelector('#validity-reasons');
  let disposed = false;

  heading.textContent = statusLabel(result.status);
  detail.textContent = statusDetail(result);
  if (result.status !== 'VALID') statusNode.classList.add('is-error');
  summary.replaceChildren(
    makeItem(`Right eye (OD): ${result.rightEye.status.toLowerCase()}; ${result.rightEye.predictionCount} usable prediction(s).`),
    makeItem(`Left eye (OS): ${result.leftEye.status.toLowerCase()}; ${result.leftEye.predictionCount} usable prediction(s).`),
    makeItem(`Component 12: ${result.component12.status.replaceAll('_', ' ').toLowerCase()}.`),
    makeItem(`Component 13: ${result.component13.status.replaceAll('_', ' ').toLowerCase()}.`),
  );
  reasonList.replaceChildren(...result.reasons.map(item => makeItem(`${item.eye ? `${item.eye}: ` : ''}${item.code} — ${item.message}`)));
  recommendationList.replaceChildren(...result.recommendations.map(makeItem));
  reasonsDetails.open = result.status !== 'VALID';

  root.dispatchEvent(new CustomEvent('eye-validity-complete', { bubbles: true, detail: result }));
  root.dispatchEvent(new CustomEvent('eye-consistency-assessment', {
    bubbles: true,
    detail: {
      schemaVersion: result.schemaVersion,
      engineVersion: result.engineVersion,
      sourceAnalysis: result.sourceAnalysis,
      rightEye: result.rightEye,
      leftEye: result.leftEye,
      component13: result.component13,
      reasons: result.reasons,
    },
  }));

  async function stop() {
    if (disposed) return;
    await cleanup();
    onExit();
  }
  async function cleanup() {
    if (disposed) return;
    disposed = true;
    stopButton.removeEventListener('click', stop);
  }
  stopButton.addEventListener('click', stop);
  return cleanup;
}

function makeItem(text) { const item = document.createElement('li'); item.textContent = text; return item; }
function statusLabel(status) {
  return ({
    VALID: 'Technical validity checks passed.',
    LOW_CONFIDENCE: 'The configured reliability threshold was not met.',
    INCONSISTENT: 'Repeated predictions disagree beyond configured tolerances.',
    RETEST_REQUIRED: 'More or better evidence is required before proceeding.',
    INVALID: 'The result failed structural or value validation.',
  })[status] || 'The result could not be assessed.';
}
function statusDetail(result) {
  if (result.status === 'VALID') return result.component12.canPresentScreeningEstimate
    ? 'The configured technical checks passed for both eyes. This remains a screening estimate, not clinical validity.'
    : 'The technical checks passed, but multiple captures need Component 13 review before Component 12 can present a single estimate.';
  if (result.status === 'INCONSISTENT') return 'Do not combine or average the conflicting predictions. Component 13 should review the affected eye and request a retest when appropriate.';
  if (result.status === 'LOW_CONFIDENCE') return 'At least one configured model or eye-detection confidence threshold was not met.';
  if (result.status === 'INVALID') return 'No invalid or structurally rejected values are eligible for presentation.';
  return 'No estimate should proceed to the result screen until the required missing evidence is addressed.';
}
