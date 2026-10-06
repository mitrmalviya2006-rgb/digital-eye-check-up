import { analyzeImageQuality, IMAGE_QUALITY_CONFIG } from './image-quality.js';
import { AUTOMATIC_CAPTURE_CONFIG, AutomaticCaptureStateMachine, assessCaptureReadiness } from './capture-state.js';
import { extractCaptureImage } from './capture-image.js';
import { buildCaptureRecord } from './capture-contract.js';

let fallbackCaptureId = 0;

/** Component 6: stability-gated capture from the existing video element. */
export async function mountAutomaticCaptureStep(root, context, { compatibility = null, onExit = () => {}, config = {} } = {}) {
  const settings = { ...AUTOMATIC_CAPTURE_CONFIG, ...config };
  const { camera, positioningDetector, getLatestEyeResult, getLatestQuality, cleanupQualityStep } = context || {};
  const video = await camera?.withVideoFrame?.(existingVideo => existingVideo);
  if (!video || !camera?.getSnapshot?.().previewReady || !positioningDetector || typeof cleanupQualityStep !== 'function') {
    root.innerHTML = '<section class="notice urgent" role="alert"><h2>Automatic capture is unavailable</h2><p>Return to image quality checking and restart the guided steps.</p><button id="exit-capture" class="secondary" type="button">Stop screening</button></section>';
    root.querySelector('#exit-capture').addEventListener('click', async () => { await cleanupQualityStep?.(); onExit(); });
    return async () => {};
  }

  root.innerHTML = `<section aria-labelledby="capture-title"><h2 id="capture-title" tabindex="-1">Automatic eye photo capture</h2><p>After you agree, the system will capture a camera frame only when positioning, both-eye detection, stability, and image quality remain acceptable. No shutter press is needed.</p><aside class="notice capture-disclosure"><strong>Local capture</strong><p>Captured PNG images stay in memory for the next processing step. They are not saved to your device or uploaded. Stop screening to discard them. This is a technical screening step, not a diagnosis or prescription.</p><label class="consent"><input id="capture-consent" type="checkbox"> I agree to capture and locally process eye images for this screening.</label></aside><div class="positioning-frame capture-frame" id="capture-frame"><div class="quality-guide" aria-hidden="true"></div></div><div id="capture-status" class="positioning-status" role="status" aria-live="polite" aria-atomic="true"><strong id="capture-heading">Automatic capture is paused.</strong><span id="capture-detail">Agree to local image capture to begin.</span></div><ul class="capture-checks" aria-label="Capture readiness"><li id="capture-position-check">Positioning: waiting</li><li id="capture-eyes-check">Both eyes: waiting</li><li id="capture-quality-check">Image quality: waiting</li></ul><p id="capture-progress" class="capture-progress" aria-live="polite"></p><p id="capture-feedback" class="hint"></p><div class="actions"><button id="capture-restart" class="primary hidden" type="button">Restart automatic capture</button><button id="capture-stop" class="secondary" type="button">Stop screening</button></div><p class="hint">No manual shutter is used. Only validated frames are emitted through <code>eye-capture-ready</code> and <code>eye-capture-complete</code> for Component 7.</p></section>`;
  if (compatibility?.camera?.resolution?.status === 'below-requested') root.insertAdjacentHTML('afterbegin', '<p class="notice">This camera preview is below the device layer’s requested size. No model-specific minimum is configured, so capture quality checks still decide whether a frame can proceed.</p>');

  const consent = root.querySelector('#capture-consent');
  const statusElement = root.querySelector('#capture-status');
  const heading = root.querySelector('#capture-heading');
  const detail = root.querySelector('#capture-detail');
  const progress = root.querySelector('#capture-progress');
  const feedback = root.querySelector('#capture-feedback');
  const positionCheck = root.querySelector('#capture-position-check');
  const eyesCheck = root.querySelector('#capture-eyes-check');
  const qualityCheck = root.querySelector('#capture-quality-check');
  const restartButton = root.querySelector('#capture-restart');
  const stopButton = root.querySelector('#capture-stop');
  const frameElement = root.querySelector('#capture-frame');
  frameElement.insertBefore(video, frameElement.firstChild);
  video.classList.add('positioning-video');
  const updateAspectRatio = () => { if (video.videoWidth && video.videoHeight) frameElement.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`; };
  video.addEventListener('resize', updateAspectRatio); video.addEventListener('loadedmetadata', updateAspectRatio); updateAspectRatio();

  const captureCanvas = document.createElement('canvas');
  const validationCanvas = document.createElement('canvas');
  const machine = new AutomaticCaptureStateMachine(settings);
  const captures = [];
  let disposed = false, running = false, captureInFlight = false, captureFinished = false, timer = null, consentGeneration = 0;
  let latestReadiness = assessCaptureReadiness(currentSnapshot(), performance.now(), settings);

  function currentSnapshot(now = performance.now()) {
    const positionSnapshot = positioningDetector.getSnapshot();
    return {
      cameraReady: camera.getSnapshot().previewReady === true,
      positioning: positionSnapshot.latest,
      positioningFresh: positionSnapshot.fresh === true,
      eyeResult: getLatestEyeResult?.() || null,
      qualityResult: getLatestQuality?.() || null,
      now,
    };
  }

  function userStatus(machineState) {
    if (machineState.state === 'INITIALIZING') return ['Starting the camera…', 'The existing live preview is being checked.'];
    if (machineState.state === 'POSITIONING') {
      const reasons = machineState.reasons;
      if (reasons.includes('DISTANCE_NOT_ACCEPTABLE')) return ['Adjust your distance.', 'Follow the positioning guide.'];
      if (reasons.some(reason => reason.includes('EYE_NOT_OPEN'))) return ['Please keep both eyes open.', 'Look toward the phone and keep your face centered.'];
      if (reasons.includes('EYES_NOT_DETECTED') || reasons.some(reason => reason.endsWith('_EYE_INVALID'))) return ['Keep both eyes visible.', 'Face the phone and move anything that covers your eyes.'];
      return ['Position yourself in the guide.', 'Center your face in the preview.'];
    }
    if (machineState.state === 'CHECKING_QUALITY') return ['Checking image quality…', 'Keep both eyes visible while the live image is checked.'];
    if (machineState.state === 'WAITING_FOR_STABILITY') return ['Good position. Hold still.', 'Keep both eyes open and avoid moving.'];
    if (machineState.state === 'RETRY_REQUIRED') return ['Trying again automatically…', 'Hold still while another frame is checked.'];
    if (machineState.state === 'READY_TO_CAPTURE') return ['Capturing…', 'Please hold still.'];
    if (machineState.state === 'CAPTURING') return ['Capturing…', 'Reading a full-resolution frame from the live camera.'];
    if (machineState.state === 'VALIDATING_CAPTURE') return ['Checking the captured image…', 'The image is being verified before it is passed on.'];
    if (machineState.state === 'CAPTURED') return ['Capture verified.', 'Preparing the next frame.'];
    if (machineState.state === 'COMPLETE') return ['Capture successful.', 'Validated image capture is ready for the next processing step.'];
    if (machineState.state === 'ERROR') return ['We could not get a clear image.', 'Improve the lighting or positioning, then restart automatic capture.'];
    return ['Automatic capture is paused.', 'Agree to local image capture to begin.'];
  }

  function renderState(machineState) {
    if (disposed) return;
    const [title, message] = userStatus(machineState);
    heading.textContent = title; detail.textContent = message;
    statusElement.classList.toggle('is-ready', machineState.state === 'COMPLETE');
    statusElement.classList.toggle('is-error', machineState.state === 'ERROR');
    progress.textContent = `Images captured: ${machineState.captureCount} of ${machineState.requiredCaptureCount}. Attempt ${Math.min(machineState.attempts + 1, machineState.maxAttempts)} of ${machineState.maxAttempts}.`;
    feedback.textContent = machineState.state === 'ERROR' ? `No clear image after ${machineState.maxAttempts} attempts. Last issue: ${friendlyCaptureError(machineState.error)}.`
      : machineState.state === 'RETRY_REQUIRED' ? `The last frame was not usable: ${friendlyCaptureError(machineState.error)}.` : '';
    const reasons = new Set(latestReadiness.reasons);
    const positionOk = consent.checked && !['CAMERA_NOT_READY', 'POSITIONING_REQUIRED', 'DISTANCE_NOT_ACCEPTABLE', 'POSITION_UNSTABLE'].some(reason => reasons.has(reason));
    const eyesOk = consent.checked && !['EYES_NOT_DETECTED', 'LEFT_EYE_INVALID', 'RIGHT_EYE_INVALID', 'LEFT_EYE_NOT_OPEN', 'RIGHT_EYE_NOT_OPEN', 'EYE_TRACKING_UNSTABLE', 'EYE_RESULT_STALE', 'EYE_COORDINATE_SPACE_UNVERIFIED'].some(reason => reasons.has(reason));
    const qualityOk = consent.checked && !['QUALITY_NOT_READY', 'QUALITY_RESULT_STALE', 'BLUR_CHECK_NOT_PASSED', 'EXPOSURE_CHECK_NOT_PASSED', 'GLARE_CHECK_NOT_PASSED', 'QUALITY_STABILITY_NOT_PASSED', 'EYE_CONFIDENCE_NOT_VERIFIED', 'EYE_VISIBILITY_NOT_VERIFIED'].some(reason => reasons.has(reason));
    positionCheck.textContent = `Positioning: ${positionOk ? 'ready' : 'waiting'}`;
    eyesCheck.textContent = `Both eyes: ${eyesOk ? 'ready' : 'waiting'}`;
    qualityCheck.textContent = `Image quality: ${qualityOk ? 'ready' : 'waiting'}`;
    for (const [node, ready] of [[positionCheck, positionOk], [eyesCheck, eyesOk], [qualityCheck, qualityOk]]) node.classList.toggle('is-ready', ready);
    restartButton.classList.toggle('hidden', machineState.state !== 'ERROR');
    root.dispatchEvent(new CustomEvent('automatic-capture-state', { bubbles: true, detail: { ...machineState } }));
  }

  function tick() {
    if (!running || disposed || captureInFlight) return;
    const snapshot = currentSnapshot();
    latestReadiness = assessCaptureReadiness(snapshot, performance.now(), settings);
    const state = machine.update(snapshot, performance.now());
    renderState(state);
    if (state.state === 'READY_TO_CAPTURE' && machine.beginCapture()) void performCapture();
  }

  async function performCapture() {
    if (captureInFlight || disposed) return;
    captureInFlight = true;
    const operationGeneration = consentGeneration;
    renderState(machine.snapshot());
    let blob = null;
    try {
      const captureTimestamp = performance.now();
      const captureWallClock = Date.now();
      const initial = currentSnapshot(captureTimestamp);
      const readiness = assessCaptureReadiness(initial, captureTimestamp, settings);
      if (!readiness.eligible) throw new Error('PREREQUISITES_CHANGED');
      const extracted = await extractCaptureImage(video, {
        captureCanvas, validationCanvas,
        minLongSide: IMAGE_QUALITY_CONFIG.minLongSide,
        minShortSide: IMAGE_QUALITY_CONFIG.minShortSide,
      });
      blob = extracted.blob;
      if (disposed) return;
      if (!consent.checked || operationGeneration !== consentGeneration) throw new Error('CAPTURE_CONSENT_WITHDRAWN');

      machine.setValidating(); renderState(machine.snapshot());
      const postSnapshot = currentSnapshot();
      const capturedQuality = analyzeImageQuality({ pixels: extracted.pixels, width: extracted.sampleWidth, height: extracted.sampleHeight, sourceWidth: extracted.width, sourceHeight: extracted.height, timestamp: captureTimestamp }, {
        eyeResult: initial.eyeResult,
        positioning: initial.positioning,
        positioningFresh: initial.positioningFresh,
      });
      const stillEligible = assessCaptureReadiness(postSnapshot, performance.now(), settings).eligible;
      if (!stillEligible || !capturedQuality.valid) throw new Error(capturedQuality.reasons?.[0]?.code || 'CAPTURE_VALIDATION_FAILED');
      if (!consent.checked || operationGeneration !== consentGeneration) throw new Error('CAPTURE_CONSENT_WITHDRAWN');
      machine.captureValidated(); renderState(machine.snapshot());

      const nextIndex = machine.captureCount + 1;
      const capture = buildCaptureRecord({
        captureId: createCaptureId(), image: blob,
        width: extracted.width, height: extracted.height, timestamp: captureWallClock, frameTimestamp: captureTimestamp,
        eyeResult: initial.eyeResult,
        positioningState: compactPositioning(initial.positioning),
        qualityResult: capturedQuality,
        liveQualityResult: postSnapshot.qualityResult,
        stability: { positionStable: initial.positioning.stable === true, eyeTrackingStable: initial.eyeResult.trackingStable === true, stableForMs: machine.snapshot().stableForMs, qualitySamples: machine.snapshot().qualitySampleCount },
        captureIndex: nextIndex, requiredCaptureCount: settings.requiredCaptureCount,
      });
      if (disposed) return;
      captures.push(capture);
      machine.captureSucceeded();
      root.dispatchEvent(new CustomEvent('eye-capture-ready', { bubbles: true, detail: { capture, captureIndex: nextIndex, requiredCaptureCount: settings.requiredCaptureCount, complete: machine.state === 'COMPLETE' } }));
      if (machine.state === 'COMPLETE') {
        captureFinished = true;
        running = false; if (timer !== null) clearInterval(timer); timer = null;
        renderState(machine.snapshot());
        root.dispatchEvent(new CustomEvent('eye-capture-complete', { bubbles: true, detail: { schemaVersion: '1.0.0', captures: [...captures], requiredCaptureCount: settings.requiredCaptureCount } }));
        video.classList.add('hidden');
        await cleanupQualityStep();
      } else renderState(machine.snapshot());
    } catch (error) {
      if (!disposed && error?.message === 'CAPTURE_CONSENT_WITHDRAWN') {
        if (consent.checked && running) renderState(machine.snapshot());
      } else if (!disposed) {
        machine.captureFailed(error?.message || 'CAPTURE_FAILED');
        renderState(machine.snapshot());
      }
    } finally {
      if (blob && !captures.some(capture => capture.image === blob)) blob = null;
      captureInFlight = false;
    }
  }

  function start() {
    if (!consent.checked || disposed || running) return;
    running = true; tick(); timer = setInterval(tick, 100);
  }
  function restart() {
    if (disposed || machine.state !== 'ERROR') return;
    discardCapturedRecords('RESTARTED'); machine.restart(); renderState(machine.snapshot()); start();
  }
  function onConsentChange() {
    if (consent.checked && captureFinished) {
      consent.checked = false; consent.disabled = true;
      heading.textContent = 'This capture is already complete.';
      detail.textContent = 'Stop screening and restart the guided steps if you need another image.';
    } else if (consent.checked) start();
    else {
      consentGeneration++;
      running = false; if (timer !== null) clearInterval(timer); timer = null;
      discardCapturedRecords('CONSENT_WITHDRAWN');
      machine.withdrawConsent();
      latestReadiness = { eligible: false, reasons: ['CAPTURE_CONSENT_WITHDRAWN'] };
      renderState(machine.snapshot());
      heading.textContent = 'Automatic capture is paused.'; detail.textContent = 'Capture consent was withdrawn.';
      for (const node of [positionCheck, eyesCheck, qualityCheck]) { node.textContent = `${node.textContent.split(':')[0]}: paused`; node.classList.remove('is-ready'); }
      if (captureFinished) { consent.disabled = true; detail.textContent = 'Your captured image was discarded. Stop screening and restart the guided steps if you want to continue.'; }
    }
  }
  function onQualityUpdate() { tick(); }
  async function cleanup({ discardCaptures = true } = {}) {
    if (disposed) return;
    disposed = true; consentGeneration++; running = false; if (timer !== null) clearInterval(timer); timer = null;
    root.removeEventListener('image-quality-update', onQualityUpdate);
    consent.removeEventListener('change', onConsentChange); restartButton.removeEventListener('click', restart); stopButton.removeEventListener('click', stop);
    video.removeEventListener('resize', updateAspectRatio); video.removeEventListener('loadedmetadata', updateAspectRatio);
    window.removeEventListener('pagehide', pageHide);
    if (discardCaptures) discardCapturedRecords('SCREENING_ENDED');
    else captures.length = 0;
    for (const canvas of [captureCanvas, validationCanvas]) { try { canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height); } catch {} canvas.width = 0; canvas.height = 0; }
    await cleanupQualityStep();
  }
  async function stop() { await cleanup(); onExit(); }
  function discardCapturedRecords(reason) {
    if (!captures.length) return;
    const captureIds = captures.map(capture => capture.captureId);
    captures.length = 0;
    root.dispatchEvent(new CustomEvent('eye-capture-cancelled', { bubbles: true, detail: { schemaVersion: '1.0.0', captureIds, reason } }));
  }
  const pageHide = () => { void cleanup(); };
  root.addEventListener('image-quality-update', onQualityUpdate);
  consent.addEventListener('change', onConsentChange); restartButton.addEventListener('click', restart); stopButton.addEventListener('click', stop);
  window.addEventListener('pagehide', pageHide, { once: true });
  const initialState = machine.snapshot();
  renderState(initialState);
  cleanup.handoff = () => cleanup({ discardCaptures: false });
  return cleanup;
}

function compactPositioning(position) {
  return { status: position.status, faceDetected: position.faceDetected, ready: position.ready, stable: position.stable, distanceStatus: position.distanceStatus, alignmentStatus: position.alignmentStatus, faceBoundingBox: position.faceBoundingBox ? { ...position.faceBoundingBox } : null };
}

function createCaptureId() {
  try { if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID(); } catch { /* Use a local non-sensitive fallback. */ }
  fallbackCaptureId++;
  return `capture-${Date.now()}-${fallbackCaptureId}`;
}

function friendlyCaptureError(code) {
  if (code === 'INSUFFICIENT_CAPTURE_RESOLUTION') return 'the camera does not provide enough detail';
  if (code === 'CAPTURE_RESOLUTION_TOO_LARGE') return 'the camera image is larger than this device can safely process';
  if (code === 'EYE_CLOSED' || code?.includes('EYE_NOT_OPEN')) return 'one or both eyes closed';
  if (code === 'EXCESSIVE_GLARE') return 'a reflection obscured an eye';
  if (code === 'FRAME_EXTRACTION_FAILED' || code === 'CAPTURE_IMAGE_INVALID') return 'the camera frame could not be read';
  if (code === 'PREREQUISITES_CHANGED') return 'position or image quality changed';
  if (code === 'MAX_RETRIES_EXCEEDED') return 'the retry limit was reached';
  return 'the captured image did not pass quality checks';
}
