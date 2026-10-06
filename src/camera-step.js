import { CameraController } from './camera-controller.js';
import { canStartCameraStep } from './session.js';
import { renderSafetyNotice } from './safety.js';

/** Mount Component 2 and return a cleanup function for route/page teardown. */
export function mountCameraStep(root, { onBack, compatibilityLayer, safetyLayer, questionnaire } = {}) {
  if (!canStartCameraStep()) {
    root.innerHTML = '<section class="notice urgent" role="alert"><h2>Camera setup is unavailable</h2><p>Complete the questionnaire, grant screening consent, and pass its safety check before starting the camera.</p><button class="secondary" id="back-intake" type="button">Back to questionnaire</button></section>';
    root.querySelector('#back-intake').addEventListener('click', () => onBack?.());
    return () => {};
  }
  root.innerHTML = `<section aria-labelledby="camera-title"><h2 id="camera-title" tabindex="-1">Device compatibility &amp; camera setup</h2><p>We check browser APIs before opening the camera. No camera permission is requested by the check. The preview starts only after you choose Start Camera; microphone access is not requested.</p><section id="device-compatibility" class="compatibility-panel notice" aria-labelledby="compatibility-heading"><h3 id="compatibility-heading">Checking browser and device support…</h3><p id="compatibility-summary" role="status" aria-live="polite">Camera, local processing, and storage capabilities are being checked.</p><ul id="compatibility-items"></ul><div id="compatibility-safety"></div><p id="compatibility-caveat" class="hint">Hardware detection is not a medical assessment. Camera-specific capabilities are confirmed only after browser permission.</p></section><p class="hint">Use HTTPS or localhost. A rear camera is preferred only when the browser and active camera report support. Torch and adjustment controls are optional.</p><div id="camera-status" class="notice" role="status" aria-live="polite">Camera is off. No permission has been requested.</div><div class="camera-preview"><video id="camera-preview" autoplay muted playsinline aria-label="Live camera preview"></video><p id="preview-placeholder">Live preview will appear here after you start the camera.</p></div><div id="camera-controls"></div><div class="actions"><button class="primary" id="start-camera" type="button" disabled>Start Camera</button><button class="secondary hidden" id="stop-camera" type="button">Stop Camera</button><button class="primary hidden" id="continue-camera" type="button">Continue</button><button class="secondary" id="back-intake" type="button">Back</button></div><p id="continue-hint" class="hint"></p></section>`;
  const video = root.querySelector('video'); const status = root.querySelector('#camera-status'); const controls = root.querySelector('#camera-controls');
  const compatibilityHeading = root.querySelector('#compatibility-heading'); const compatibilitySummary = root.querySelector('#compatibility-summary'); const compatibilityItems = root.querySelector('#compatibility-items');
  const safetyPanel = root.querySelector('#compatibility-safety');
  const startButton = root.querySelector('#start-camera'); const stopButton = root.querySelector('#stop-camera'); const continueButton = root.querySelector('#continue-camera'); const placeholder = root.querySelector('#preview-placeholder');
  let controller = null, compatibility = null, checking = true, compatibilitySequence = 0;
  let disposed = false;
  function renderCompatibility(result) {
    compatibility = result;
    const safety = safetyLayer?.assess?.({ questionnaire, compatibility: result }) || null;
    if (safety) renderSafetyNotice(safetyPanel, safety, { onAction: safety.status === 'STOP_AND_SEEK_CARE' || safety.status === 'SCREENING_LIMITED' ? onBack : null, actionLabel: 'Return to questionnaire' });
    compatibilityHeading.textContent = result.status === 'SUPPORTED' ? 'Supported' : result.status === 'LIMITED' ? 'Limited support' : 'Unsupported';
    compatibilitySummary.textContent = `${result.browser.family} · ${result.browser.secureContext ? 'secure context' : 'not a secure context'} · ${result.camera.availability === 'AVAILABLE' ? 'camera available' : result.camera.availability === 'UNAVAILABLE' ? 'camera unavailable' : 'camera not yet verified'}.`;
    compatibilityItems.replaceChildren(...[
      ...Object.entries(result.required).map(([key, item]) => [`Required: ${humanize(key)}`, item.available === true ? 'Available' : item.available === false ? 'Unavailable' : 'Not verified']),
      ...Object.entries(result.optional).map(([key, item]) => [`Optional: ${humanize(key)}`, item.available === true ? 'Available' : item.available === false ? 'Unavailable' : 'Unknown']),
      ['Camera permission', result.camera.permission],
      ['Prediction model', result.compute.modelRuntime.available ? `Local ${result.compute.modelRuntime.runtime}` : 'Not configured'],
    ].map(([name, value]) => { const li = document.createElement('li'); li.textContent = `${name}: ${value}`; return li; }));
    compatibilityHeading.dataset.status = result.status.toLowerCase();
    compatibilitySummary.textContent += result.recommendations.length ? ` ${result.recommendations.join(' ')}` : '';
    startButton.disabled = checking || Object.values(result.required).some(item => item.available === false)
      || safety?.status === 'STOP_AND_SEEK_CARE' || safety?.status === 'SCREENING_LIMITED';
    startButton.title = startButton.disabled ? 'One or more browser APIs required by the existing pipeline are unavailable.' : '';
  }
  async function refreshCompatibility(cameraSnapshot = null) {
    if (!compatibilityLayer?.assess) { checking = false; startButton.disabled = true; compatibilityHeading.textContent = 'Unsupported'; compatibilitySummary.textContent = 'The centralized compatibility service is unavailable, so camera startup is disabled. Reload the app and try again.'; return; }
    const sequence = ++compatibilitySequence;
    checking = !controller;
    try {
      const result = await compatibilityLayer.assess({ cameraSnapshot });
      if (disposed || sequence !== compatibilitySequence) return;
      if (!controller) controller = new CameraController({ video, onStateChange: update, config: { videoConstraints: compatibilityLayer.cameraConfiguration(), cameraSelectionSupported: result.configuration.cameraSelectionSupported, width: 1280, height: 720, frameRate: 24 } });
      checking = false; renderCompatibility(result);
    } catch {
      if (disposed) return;
      checking = false; startButton.disabled = true;
      compatibilityHeading.textContent = 'Limited support'; compatibilitySummary.textContent = 'Some capabilities could not be checked. Camera support will be tested when you choose Start Camera.';
    }
  }
  function update(s) {
    if (disposed) return;
    if (s.status !== 'idle') void refreshCompatibility(s);
    const messages = { idle:'Camera is off.', requesting_permission:'Waiting for your browser’s camera permission…', initializing:'Camera permission is available. Starting the live preview…', switching_camera:'Switching camera…', stopping:'Stopping camera…', ready:`Live preview ready · ${s.actualResolution?.width ?? '?'} × ${s.actualResolution?.height ?? '?'} pixels`, permission_denied:'Camera permission is unavailable.', unsupported:'Camera access is unsupported here.', error:'Camera is not ready.' };
    const cameraInfo = s.previewReady ? `${s.activeCameraLabel ? ` · ${s.activeCameraLabel}` : ''}${s.activeFacingMode ? ` · ${s.activeFacingMode} facing` : ''}${s.facingModeFallback ? ' · rear camera preference unavailable; browser-selected camera is active' : ''}` : '';
    status.textContent = s.error ? `${messages[s.status] || 'Camera unavailable.'} ${s.error}` : `${messages[s.status] || 'Camera is off.'}${cameraInfo}`;
    status.classList.toggle('urgent', Boolean(s.error)); placeholder.classList.toggle('hidden', s.previewReady);
    startButton.classList.toggle('hidden', ['ready','requesting_permission','initializing','switching_camera'].includes(s.status));
    stopButton.classList.toggle('hidden', !s.previewReady); continueButton.classList.toggle('hidden', !s.previewReady);
    controls.replaceChildren();
    if (s.previewReady) renderControls(s);
    else if (s.cameras.length > 1 && s.deviceSelectionSupported) renderCameraSelector(s);
    root.querySelector('#continue-hint').textContent = s.previewReady ? 'The live preview is ready. Continue will make the camera controller available to the next screening component.' : '';
  }
  function renderControls(s) {
    if (s.cameras.length > 1 && s.deviceSelectionSupported) renderCameraSelector(s);
    if (s.torchSupported) { const button=document.createElement('button'); button.type='button'; button.className='secondary'; button.setAttribute('aria-pressed',String(s.torchEnabled)); button.textContent=s.torchEnabled?'Turn torch off':'Turn torch on'; button.addEventListener('click', async()=>{ button.disabled=true; try { await controller.setTorch(!s.torchEnabled); } catch(error) { status.textContent=error.message; } finally { button.disabled=false; } }); controls.append(button); }
    else { const note=document.createElement('p'); note.className='hint'; note.textContent='Torch control is unavailable for this camera. The screening may continue without it.'; controls.append(note); }
    const optional = ['zoom','exposureCompensation','focusDistance','focusMode','whiteBalanceMode'];
    for (const key of optional) {
      const capability=s.capabilities[key]; if (capability === undefined || capability === null) continue;
      const label=document.createElement('label'); label.className='camera-control'; label.textContent=controlLabel(key);
      let input;
      if (Array.isArray(capability)) { input=document.createElement('select'); for (const value of capability) { const option=document.createElement('option'); option.value=String(value); option.textContent=String(value); option.selected=s.settings[key]===value; input.append(option); } }
      else if (typeof capability==='object' && Number.isFinite(capability.min) && Number.isFinite(capability.max)) { input=document.createElement('input'); input.type='range'; input.min=String(capability.min); input.max=String(capability.max); input.step=String(capability.step || (capability.max-capability.min)/100 || 1); input.value=String(s.settings[key] ?? capability.min); const value=document.createElement('output'); value.textContent=input.value; input.addEventListener('input',()=>value.textContent=input.value); label.append(input,value); }
      else continue;
      input.setAttribute('aria-label',controlLabel(key)); input.addEventListener('change', async()=>{ const previous=controller.getCurrentSettings()[key]; try { const value=input.type==='range'?Number(input.value):input.value; await controller.applyCameraSettings({[key]:value}); status.textContent=`${controlLabel(key)} applied.`; } catch(error) { status.textContent=error.message; if(previous!==undefined){input.value=String(previous); const output=label.querySelector('output'); if(output) output.textContent=String(previous);} } }); if (!label.contains(input)) label.append(input); controls.append(label);
    }
  }
  function renderCameraSelector(s) {
    const label=document.createElement('label'); label.className='camera-control'; label.textContent='Camera'; const select=document.createElement('select'); select.setAttribute('aria-label','Select camera');
    for (const camera of s.cameras) { const option=document.createElement('option'); option.value=camera.deviceId; option.textContent=camera.label; option.selected=camera.deviceId===s.activeDeviceId; select.append(option); }
    select.addEventListener('change',async()=>{ try { await controller.switchCamera(select.value); } catch { /* State callback presents controller failures. */ } }); label.append(select); controls.append(label);
  }
  startButton.addEventListener('click',()=>{ if (!canStartCameraStep()) { status.textContent='Screening authorization is no longer available. Return to the questionnaire.'; return; } if (!controller) { status.textContent='Device compatibility is still being checked. Try again in a moment.'; return; } void controller.startCamera(); });
  stopButton.addEventListener('click',()=>void controller.stopCamera());
  continueButton.addEventListener('click',()=>{ if (!controller?.getSnapshot().previewReady || !canStartCameraStep()) return; root.dispatchEvent(new CustomEvent('camera-step-ready',{ bubbles:true, detail:{ compatibility: compatibilityLayer?.getSnapshot?.() || compatibility, camera: { getSnapshot:()=>controller.getSnapshot(), getCapabilities:()=>controller.getCapabilities(), getCurrentSettings:()=>controller.getCurrentSettings(), withVideoFrame:callback=>controller.withVideoFrame(callback), captureFrame:()=>controller.captureFrame(), stopCamera:()=>controller.stopCamera() } } })); status.textContent='Camera interface is ready for the next component.'; });
  root.querySelector('#back-intake').addEventListener('click',async()=>{ await controller?.stopCamera(); onBack?.(); });
  const pageHide = () => { disposed=true; void controller?.stopCamera(); };
  window.addEventListener('pagehide',pageHide,{once:true});
  status.textContent='Camera is off. No permission has been requested.';
  void refreshCompatibility();
  const cleanup=()=>{ disposed=true; window.removeEventListener('pagehide',pageHide); void controller?.stopCamera(); };
  cleanup.detachUI=()=>{ disposed=true; window.removeEventListener('pagehide',pageHide); };
  return cleanup;
}

function controlLabel(key) { return ({ zoom:'Zoom', exposureCompensation:'Exposure compensation', focusDistance:'Focus distance', focusMode:'Focus mode', whiteBalanceMode:'White balance' })[key] || key; }
function humanize(value) { return value.replaceAll(/([a-z])([A-Z])/g, '$1 $2').replaceAll(/([A-Z])([A-Z][a-z])/g, '$1 $2').replaceAll(/\b\w/g, character => character.toUpperCase()); }
