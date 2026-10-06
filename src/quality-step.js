import { analyzeImageQuality, imageQualityFailure } from './image-quality.js';
import { QualitySampler } from './quality-sampler.js';
import { renderSafetyNotice } from './safety.js';

const SAMPLE_INTERVAL_MS = 750;
const MAX_SAMPLE_SIDE = 480;

/** Mount Component 5 over the existing camera element and Component 4 result stream. */
export async function mountQualityStep(root, handoff, { compatibility = null, safetyLayer = null, questionnaire = null, onExit = () => {} } = {}) {
  const { camera, positioningDetector, releaseEyeProcessing } = handoff || {};
  const video = await camera?.withVideoFrame?.(existingVideo => existingVideo);
  if (!video || !camera?.getSnapshot?.().previewReady || !positioningDetector || typeof releaseEyeProcessing !== 'function') {
    root.innerHTML = '<section class="notice urgent" role="alert"><h2>Image quality checking is unavailable</h2><p>Return to camera setup and guided positioning before continuing.</p><button type="button" class="secondary" id="exit-quality">Stop screening</button></section>';
    root.querySelector('#exit-quality').addEventListener('click', async () => { await releaseEyeProcessing?.(); await positioningDetector?.stop?.(); await camera?.stopCamera?.(); onExit(); });
    return async () => {};
  }

  root.innerHTML = `<section aria-labelledby="quality-title"><h2 id="quality-title" tabindex="-1">Image quality check</h2><p>This step samples the existing live preview and reuses Component 4 eye results. It does not start another camera, save a photo, upload frames, estimate a prescription, or diagnose an eye condition.</p><aside class="notice quality-disclosure"><strong>Local image processing</strong><p>With your agreement, a small in-memory copy of the current preview is checked about once every three-quarters of a second. Pixels are not saved to a file or uploaded; temporary buffers are cleared when you stop. This technical check does not establish clinical accuracy.</p><label class="consent"><input id="quality-consent" type="checkbox"> I agree to local image-quality analysis of the existing preview.</label></aside><div id="quality-safety"></div><div class="positioning-frame quality-frame" id="quality-frame"><div class="quality-guide" aria-hidden="true"></div><canvas id="quality-sample" class="hidden" aria-hidden="true"></canvas></div><div class="positioning-status" id="quality-status" role="status" aria-live="polite" aria-atomic="true"><strong id="quality-heading">Image-quality analysis is paused.</strong><span id="quality-summary">Agree to local image-quality checks to begin.</span></div><ul class="quality-feedback" id="quality-feedback" aria-live="polite"></ul><details class="quality-details"><summary>Technical quality result</summary><pre id="quality-json" aria-live="off">No frame has been analyzed.</pre></details><div class="actions"><button class="primary" id="quality-start" type="button" disabled>Start quality check</button><button class="secondary" id="quality-stop" type="button">Stop screening</button></div><p class="hint">Downstream components can subscribe to <code>image-quality-update</code>. Automatic capture must require <code>result.valid === true</code>; <code>technicalUsable</code> alone is not capture clearance.</p></section>`;

  const intervalMs = Number.isFinite(compatibility?.configuration?.qualitySampleIntervalMs) ? compatibility.configuration.qualitySampleIntervalMs : SAMPLE_INTERVAL_MS;
  if (intervalMs !== SAMPLE_INTERVAL_MS) root.insertAdjacentHTML('afterbegin', `<p class="hint">Quality sampling is reduced to once per ${intervalMs} ms based on device performance hints. The existing small quality-preview sample is separate; captured camera frames retain their original resolution.</p>`);

  const consent = root.querySelector('#quality-consent');
  const startButton = root.querySelector('#quality-start');
  const stopButton = root.querySelector('#quality-stop');
  const status = root.querySelector('#quality-status');
  const heading = root.querySelector('#quality-heading');
  const summary = root.querySelector('#quality-summary');
  const feedback = root.querySelector('#quality-feedback');
  const json = root.querySelector('#quality-json');
  const frameElement = root.querySelector('#quality-frame');
  const canvas = root.querySelector('#quality-sample');
  const safetyPanel = root.querySelector('#quality-safety');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  frameElement.insertBefore(video, frameElement.firstChild);
  video.classList.add('positioning-video');
  const updateAspectRatio = () => { if (video.videoWidth && video.videoHeight) frameElement.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`; };
  video.addEventListener('resize', updateAspectRatio);
  video.addEventListener('loadedmetadata', updateAspectRatio);
  updateAspectRatio();

  let disposed = false, uiDetached = false, running = false, lastVideoTime = -1;
  let latestEyeResult = handoff.latestResult?.() || handoff.result || null;
  let previousCenters = null, wasQualityReady = false, latestQuality = null, captureContext = null;
  const sampler = new QualitySampler({ sample, intervalMs });

  function receiveEyeResult(event) {
    if ('result' in (event.detail || {})) latestEyeResult = event.detail.result;
  }
  function renderQuality(result) {
    if (disposed) return;
    latestQuality = result;
    const safety = safetyLayer?.assess?.({ questionnaire, compatibility, imageQuality: result }) || null;
    if (safety) renderSafetyNotice(safetyPanel, safety, { onAction: safety.status === 'REQUIRES_RETEST' ? start : null, actionLabel: 'Repeat quality check' });
    if (!uiDetached) {
      status.classList.toggle('is-ready', result.overallStatus === 'GOOD');
      status.classList.toggle('is-error', result.overallStatus === 'RETAKE');
      heading.textContent = result.overallStatus === 'GOOD' ? 'Image quality is good.'
        : result.overallStatus === 'RETAKE' ? 'Please adjust and try again.'
          : 'Image quality cannot yet be confirmed.';
      summary.textContent = result.overallStatus === 'GOOD' ? 'Both eye regions meet the current technical checks.'
        : result.overallStatus === 'RETAKE' ? 'Make the suggested changes, then hold still for another check.'
          : 'Some required quality information is unavailable; automatic capture remains disabled.';
      feedback.replaceChildren(...(result.feedback.length ? result.feedback : ['Quality check is paused.']).map(message => {
        const item = document.createElement('li'); item.textContent = message; return item;
      }));
      json.textContent = JSON.stringify(result, null, 2);
    }
    root.dispatchEvent(new CustomEvent('image-quality-update', { bubbles: true, detail: { result } }));
    if (result.valid && !wasQualityReady) root.dispatchEvent(new CustomEvent('image-quality-ready', { bubbles: true, detail: { result } }));
    wasQualityReady = result.valid;
  }

  async function sample() {
    if (!running || disposed || !consent.checked) return;
    try {
      const frameData = await camera.withVideoFrame(existingVideo => {
        const sourceWidth = existingVideo.videoWidth, sourceHeight = existingVideo.videoHeight;
        if (existingVideo.readyState < 2 || !sourceWidth || !sourceHeight) throw new Error('PIXEL_DATA_UNAVAILABLE');
        if (existingVideo.currentTime === lastVideoTime) throw new Error('FRAME_STALE');
        lastVideoTime = existingVideo.currentTime;
        const scale = Math.min(1, MAX_SAMPLE_SIDE / Math.max(sourceWidth, sourceHeight));
        const width = Math.max(1, Math.round(sourceWidth * scale));
        const height = Math.max(1, Math.round(sourceHeight * scale));
        canvas.width = width; canvas.height = height;
        context.drawImage(existingVideo, 0, 0, width, height);
        const pixels = context.getImageData(0, 0, width, height).data;
        return { pixels, width, height, sourceWidth, sourceHeight, timestamp: performance.now() };
      });
      if (!running || disposed) return;
      const positioningSnapshot = positioningDetector.getSnapshot();
      const positioning = positioningSnapshot.latest;
      const result = analyzeImageQuality(frameData, {
        eyeResult: latestEyeResult,
        positioning,
        positioningFresh: positioningSnapshot.fresh,
        previousEyeCenters: previousCenters,
      });
      previousCenters = Object.fromEntries(['leftEye', 'rightEye'].map(key => {
        const box = latestEyeResult?.[key]?.boundingBox;
        return [key, box ? { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 } : null];
      }));
      renderQuality(result);
    } catch (error) {
      if (!disposed) renderQuality(imageQualityFailure(error?.message === 'FRAME_STALE' ? 'FRAME_STALE' : 'PIXEL_DATA_UNAVAILABLE', Date.now(), error?.message === 'FRAME_STALE' ? 'RETAKE' : 'UNKNOWN'));
    }
  }

  function pause({ withdrawn = false } = {}) {
    running = false;
    sampler.stop(); startButton.textContent = 'Start quality check';
    if (withdrawn) {
      context.clearRect(0, 0, canvas.width, canvas.height); canvas.width = 0; canvas.height = 0; previousCenters = null;
      renderQuality(imageQualityFailure('QUALITY_CONSENT_WITHDRAWN', Date.now()));
    }
  }
  function start() {
    if (!consent.checked || disposed || running) return;
    running = true; startButton.textContent = 'Quality check running';
    heading.textContent = 'Checking the live image…'; summary.textContent = 'Sampling the existing preview at a low rate.';
    sampler.start();
  }
  function onConsentChange() {
    startButton.disabled = !consent.checked || disposed;
    if (!consent.checked) pause({ withdrawn: true });
  }
  function detachQualityUi() {
    if (uiDetached) return;
    uiDetached = true;
    video.removeEventListener('resize', updateAspectRatio); video.removeEventListener('loadedmetadata', updateAspectRatio);
    consent.removeEventListener('change', onConsentChange); startButton.removeEventListener('click', start); stopButton.removeEventListener('click', stop);
  }
  function makeCaptureContext() {
    return {
      camera, positioningDetector, video,
      getLatestEyeResult: () => latestEyeResult,
      getLatestQuality: () => latestQuality,
      cleanupQualityStep: cleanup,
    };
  }
  async function cleanup() {
    if (disposed) return;
    disposed = true; pause();
    root.removeEventListener('eye-localization-update', receiveEyeResult);
    video.removeEventListener('resize', updateAspectRatio); video.removeEventListener('loadedmetadata', updateAspectRatio);
    consent.removeEventListener('change', onConsentChange); startButton.removeEventListener('click', start); stopButton.removeEventListener('click', stop);
    window.removeEventListener('pagehide', pageHide);
    context.clearRect(0, 0, canvas.width, canvas.height); canvas.width = 0; canvas.height = 0;
    await releaseEyeProcessing();
    await positioningDetector.stop();
    await camera.stopCamera();
  }
  async function stop() { await cleanup(); onExit(); }
  const pageHide = () => { void cleanup(); };
  root.addEventListener('eye-localization-update', receiveEyeResult);
  consent.addEventListener('change', onConsentChange); startButton.addEventListener('click', start); stopButton.addEventListener('click', stop);
  window.addEventListener('pagehide', pageHide, { once: true });
  startButton.disabled = true;
  cleanup.handoff = () => { detachQualityUi(); captureContext ??= makeCaptureContext(); return captureContext; };
  return cleanup;
}
