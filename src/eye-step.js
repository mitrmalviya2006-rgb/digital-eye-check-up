import { EyeTracker } from './eye-tracker.js';
import { drawEyeOverlay } from './eye-overlay.js';

/** Mounts Component 4 over Component 2's existing video and Component 3's detector. */
export async function mountEyeLocalizationStep(root, { camera, positioningDetector, positioning, latestDetection = () => null, mirroredPreview = false, compatibility = null, onExit = () => {} } = {}) {
  const video = await camera?.withVideoFrame?.(existingVideo => existingVideo);
  if (!video || !camera?.getSnapshot?.().previewReady || !positioningDetector) {
    root.innerHTML = '<section class="notice urgent" role="alert"><h2>Eye localization is unavailable</h2><p>Return to camera setup and guided positioning before starting eye localization.</p><button type="button" class="secondary" id="exit-eye-localization">Stop screening</button></section>';
    root.querySelector('#exit-eye-localization').addEventListener('click', async () => { await positioningDetector?.stop?.(); await camera?.stopCamera?.(); onExit(); });
    return () => {};
  }

  root.innerHTML = `<section aria-labelledby="eye-localization-title"><h2 id="eye-localization-title" tabindex="-1">Eye detection &amp; localization</h2><p>With your agreement, this step reuses the current on-device face landmarks to localize each eye. It does not open the camera again, capture a photo, upload frames, or estimate a prescription.</p><aside class="notice eye-disclosure"><strong>What the model can and cannot provide</strong><p>The model provides eye-contour and iris-boundary landmarks. Iris centers are estimated from the boundary; it does not provide separate pupil coordinates or per-eye confidence/occlusion scores. Eye geometry is preliminary and is not image-quality clearance or a clinical result.</p><label class="consent"><input id="eye-consent" type="checkbox"> I agree to local processing of eye and iris landmarks from the existing live preview. They are used in memory for this session and are not stored or uploaded.</label></aside><div class="positioning-frame eye-localization-frame" id="eye-localization-frame"><canvas id="eye-debug-overlay" class="hidden" aria-hidden="true"></canvas></div><div class="positioning-status" id="eye-localization-status" role="status" aria-live="polite" aria-atomic="true"><strong id="eye-localization-instruction">Eye localization has not started.</strong><span id="eye-localization-detail">The current positioning detector remains active; eye-specific results begin only after you agree and choose Start eye localization.</span></div><pre id="eye-debug-output" class="eye-debug-output hidden" aria-live="off"></pre><div class="actions"><button class="primary" id="start-eye-localization" type="button" disabled>Start eye localization</button><button class="secondary" id="stop-eye-localization" type="button">Stop screening</button></div><p class="hint">Eye-localization updates are available in memory to the next component through the <code>eye-localization-update</code> and <code>eye-localization-stable</code> events. Stability provides geometric landmarks, not image-quality clearance or capture authorization.</p></section>`;
  if (compatibility?.status === 'LIMITED') root.insertAdjacentHTML('afterbegin', '<p class="hint">Device check: limited support. Optional camera controls or the prediction model may be unavailable; eye localization will use the existing local positioning stream.</p>');

  const frame = root.querySelector('#eye-localization-frame');
  const canvas = root.querySelector('#eye-debug-overlay');
  const consent = root.querySelector('#eye-consent');
  const startButton = root.querySelector('#start-eye-localization');
  const instruction = root.querySelector('#eye-localization-instruction');
  const detail = root.querySelector('#eye-localization-detail');
  const status = root.querySelector('#eye-localization-status');
  const debugOutput = root.querySelector('#eye-debug-output');
  const stopButton = root.querySelector('#stop-eye-localization');
  const tracker = new EyeTracker();
  const debugEnabled = localDebugEnabled();
  if (debugEnabled) { canvas.classList.remove('hidden'); debugOutput.classList.remove('hidden'); }

  video.classList.add('positioning-video');
  frame.insertBefore(video, canvas);
  let disposed = false, preserveProcessing = false, processingReleased = false, started = false, readyAnnounced = false, resultUnsubscribe = null, stateUnsubscribe = null, revoking = Promise.resolve();
  let latestResult = null, latestPosition = positioning;

  function redraw() {
    const bounds = frame.getBoundingClientRect();
    if (!bounds.width || !bounds.height || !video.videoWidth || !video.videoHeight) return;
    frame.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    if (debugEnabled) drawEyeOverlay(canvas, latestResult, { width: bounds.width, height: bounds.height }, { width: video.videoWidth, height: video.videoHeight }, { objectFit: getComputedStyle(video).objectFit || 'contain', mirrored: mirroredPreview });
  }
  function publish(result) {
    if (disposed && !preserveProcessing) return;
    latestResult = result;
    if (!disposed) {
      const bothDetected = Boolean(result?.bothEyesDetected);
      if (result?.analysisStatus === 'POSITIONING_REQUIRED') {
        instruction.textContent = 'Adjust your positioning first.';
        detail.textContent = 'Eye-specific analysis is paused until Component 3 confirms acceptable, fresh positioning.';
      } else if (result?.analysisStatus === 'NO_FACE') {
        instruction.textContent = 'Face not detected.';
        detail.textContent = 'Center your face in the live preview and improve lighting. No eye coordinates are being substituted.';
      } else if (result?.analysisStatus === 'INVALID_LANDMARKS' || result?.analysisStatus === 'PARTIAL_OR_INVALID') {
        instruction.textContent = bothDetected ? 'Eye landmarks are incomplete.' : 'Both eyes are not currently usable.';
        detail.textContent = 'Face the phone, open both eyes, and remove anything obscuring them. Confidence and occlusion scores are unavailable from this model.';
      } else if (result?.analysisStatus === 'GEOMETRY_STABLE') {
        instruction.textContent = 'Both eyes localized and tracking steadily.';
        detail.textContent = 'Stable geometry is available to the image-quality stage. Confidence and occlusion remain unverified; this is not capture authorization.';
      } else if (result?.analysisStatus === 'TRACKING' || result?.analysisStatus === 'DETECTED') {
        instruction.textContent = bothDetected ? 'Both eyes detected; checking stability…' : 'Eye tracking is stabilizing.';
        detail.textContent = 'Hold your face steady and keep both eyes visible.';
      }
      status.classList.toggle('is-ready', result?.analysisStatus === 'GEOMETRY_STABLE');
      status.classList.toggle('is-error', result?.analysisStatus === 'INVALID_LANDMARKS');
      if (debugEnabled) debugOutput.textContent = JSON.stringify(result, null, 2);
      redraw();
    }
    root.dispatchEvent(new CustomEvent('eye-localization-update', { bubbles: true, detail: { result } }));
    if (result?.analysisStatus === 'GEOMETRY_STABLE' && !readyAnnounced) {
      readyAnnounced = true;
      root.dispatchEvent(new CustomEvent('eye-localization-stable', { bubbles: true, detail: handoffDetail(result) }));
    } else if (result?.analysisStatus !== 'GEOMETRY_STABLE') readyAnnounced = false;
  }
  function handleFrame(nextPosition, detection) {
    if ((disposed && !preserveProcessing) || !started) return;
    latestPosition = nextPosition;
    const positioningReady = nextPosition?.ready === true && positioningDetector.getSnapshot().fresh && camera.getSnapshot().previewReady;
    const result = tracker.update(detection, { positioningReady, timestamp: detection?.timestamp ?? performance.now() });
    publish(result);
  }
  function handleDetectorState(snapshot) {
    if (disposed || snapshot.status !== 'error') return;
    status.classList.add('is-error');
    instruction.textContent = 'Local eye detection stopped.';
    detail.textContent = `${snapshot.error || 'The face model is unavailable.'} Select Retry; no new camera permission is required.`;
    startButton.disabled = !consent.checked;
    startButton.textContent = 'Retry eye localization';
  }
  function handoffDetail(result) {
    return {
      result,
      latestResult: () => tracker.getLatest(),
      camera: { getSnapshot: () => camera.getSnapshot(), withVideoFrame: callback => camera.withVideoFrame(callback), captureFrame: () => camera.captureFrame(), stopCamera: () => camera.stopCamera() },
      positioning: latestPosition,
      positioningDetector,
      latestDetection,
      releaseEyeProcessing: () => releaseProcessing(),
      coordinateSpace: result.coordinateSpace,
    };
  }
  async function start() {
    if (!consent.checked || disposed) return;
    await revoking;
    if (!consent.checked || disposed) return;
    started = true; startButton.disabled = true; startButton.textContent = 'Eye localization running';
    instruction.textContent = 'Starting local eye localization…'; detail.textContent = 'The existing camera and positioning worker are reused.';
    resultUnsubscribe ??= positioningDetector.subscribeResults(handleFrame);
    stateUnsubscribe ??= positioningDetector.subscribeState(handleDetectorState);
    try {
      const state = await positioningDetector.start();
      if (state.status === 'error') handleDetectorState(state);
      else if (state.fresh && state.latest && latestDetection()) handleFrame(state.latest, latestDetection());
    } catch (error) {
      handleDetectorState({ status: 'error', error: error?.message || 'The local face model could not start.' });
    }
  }
  async function onConsentChange() {
    startButton.disabled = !consent.checked || disposed;
    if (consent.checked || !started || disposed) return;
    started = false; resultUnsubscribe?.(); stateUnsubscribe?.(); resultUnsubscribe = null; stateUnsubscribe = null; tracker.reset(); latestResult = null; readyAnnounced = false;
    debugOutput.textContent = ''; status.classList.remove('is-ready', 'is-error'); instruction.textContent = 'Eye localization paused.'; detail.textContent = 'Your eye-specific assent was withdrawn. Select the checkbox and Start eye localization to resume.'; startButton.textContent = 'Start eye localization'; redraw();
    root.dispatchEvent(new CustomEvent('eye-localization-update', { bubbles: true, detail: { result: null, status: 'CONSENT_WITHDRAWN' } }));
    revoking = positioningDetector.stop();
    await revoking;
  }
  consent.addEventListener('change', onConsentChange);
  startButton.addEventListener('click', start);
  stopButton.addEventListener('click', async () => { await cleanup(); await positioningDetector.stop(); await camera.stopCamera(); onExit(); });
  const pageHide = () => { void cleanup(); void camera.stopCamera(); };
  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(redraw) : null;
  resizeObserver?.observe(frame);
  video.addEventListener('resize', redraw); video.addEventListener('loadedmetadata', redraw); window.addEventListener('resize', redraw); window.addEventListener('pagehide', pageHide, { once: true });
  redraw();

  function detachUi() {
    resizeObserver?.disconnect();
    video.removeEventListener('resize', redraw); video.removeEventListener('loadedmetadata', redraw); window.removeEventListener('resize', redraw); window.removeEventListener('pagehide', pageHide);
    consent.removeEventListener('change', onConsentChange);
  }
  async function releaseProcessing() {
    if (processingReleased) return;
    processingReleased = true; preserveProcessing = false;
    resultUnsubscribe?.(); stateUnsubscribe?.(); resultUnsubscribe = null; stateUnsubscribe = null;
    tracker.reset();
  }
  async function cleanup({ handoff = false } = {}) {
    if (handoff) {
      if (disposed) return;
      disposed = true; preserveProcessing = true; detachUi();
      return;
    }
    if (!disposed) { disposed = true; detachUi(); }
    await releaseProcessing();
    await positioningDetector.stop();
  }
  cleanup.handoff = () => cleanup({ handoff: true });
  return cleanup;
}

function localDebugEnabled() {
  const host = globalThis.location?.hostname;
  return ['localhost', '127.0.0.1', '[::1]'].includes(host) && new URLSearchParams(globalThis.location?.search || '').get('debugEyes') === '1';
}
