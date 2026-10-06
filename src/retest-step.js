import { renderSafetyNotice } from './safety.js';

/** Component 13 instructions and explicit handoff to the existing Component 2/3 capture route. */
export function mountRetestStep(root, { result, safetyResult = null } = {}, { onStart = () => {}, onExit = () => {} } = {}) {
  if (!result || !['RETEST_AGAIN', 'FAILED', 'PASSED'].includes(result.status)) {
    throw new TypeError('Component 13 requires a supported retest result.');
  }
  let disposed = false;
  root.innerHTML = `<section aria-labelledby="retest-title" class="retest-panel">
    <h2 id="retest-title" tabindex="-1">Retest &amp; consistency check</h2>
    <p class="prescription-safety">This is a technical vision-screening check, not a diagnosis or a prescription. It does not replace a professional eye examination.</p>
    <div id="retest-medical-safety"></div><div class="positioning-status ${result.status === 'FAILED' ? 'is-error' : ''}" role="status" aria-live="polite"><strong>${result.status === 'FAILED' ? 'Reliable result unavailable' : result.status === 'PASSED' ? 'Consistency checks passed' : 'Another measurement is needed'}</strong><span>${escapeText(result.recommendation || 'Follow the instructions below before another capture.')}</span></div>
    <p id="retest-attempt-count" class="hint">${result.retestsUsed} of ${result.maxRetests} retests used · ${result.attempts.length} measurement attempt${result.attempts.length === 1 ? '' : 's'} retained</p>
    <section aria-labelledby="retest-reasons-title"><h3 id="retest-reasons-title">Why this status was assigned</h3><ul id="retest-reasons"></ul></section>
    <section aria-labelledby="retest-instructions-title"><h3 id="retest-instructions-title">Before continuing</h3><ol><li>Clean the camera lens and face the screen in steady, even lighting.</li><li>Remove anything that obscures either eye, if comfortable to do so.</li><li>Keep both eyes open, look toward the on-screen target, and hold still during capture.</li><li>The existing camera, positioning, capture, preprocessing, and prediction steps will run again; no previous measurement is overwritten.</li></ol></section>
    <p class="hint">No SPH/CYL/Axis values are displayed here. Repeated estimates will not be averaged.</p>
    <div class="actions"><button id="retest-start" class="primary" type="button">Start retest</button><button id="retest-exit" class="secondary" type="button">${result.status === 'FAILED' ? 'Return to start' : 'Stop screening'}</button></div>
  </section>`;
  root.querySelector('#retest-title')?.focus();
  if (safetyResult) renderSafetyNotice(root.querySelector('#retest-medical-safety'), safetyResult);
  const list = root.querySelector('#retest-reasons');
  const reasons = Array.isArray(result.reasons) ? result.reasons : [];
  list.replaceChildren(...reasons.map(item => { const li = document.createElement('li'); li.textContent = `${item.eye ? `${item.eye}: ` : ''}${item.code || 'RETEST_REQUIRED'} — ${item.message || 'Technical checks did not pass.'}`; return li; }));
  const start = root.querySelector('#retest-start');
  const exit = root.querySelector('#retest-exit');
  if (result.status !== 'RETEST_AGAIN') start.hidden = true;
  const handleStart = () => { if (!disposed) onStart(); };
  const handleExit = () => { if (!disposed) onExit(); };
  start.addEventListener('click', handleStart);
  exit.addEventListener('click', handleExit);
  return () => { if (disposed) return; disposed = true; start.removeEventListener('click', handleStart); exit.removeEventListener('click', handleExit); };
}

function escapeText(value) { return String(value).replace(/[<>]/g, ''); }
