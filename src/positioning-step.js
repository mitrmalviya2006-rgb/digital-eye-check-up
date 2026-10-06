import { PositioningDetector } from './positioning-detector.js';
import { drawPositionOverlay, instructionFor } from './positioning-analysis.js';

/** Mount Component 3 over the existing Component 2 video element; never opens a camera. */
export async function mountPositioningStep(root,{camera,compatibility=null,onExit=()=>{},mirroredPreview=false}={}){
  const video=await camera?.withVideoFrame?.(existingVideo=>existingVideo);
  if(!video||!camera?.getSnapshot?.().previewReady){root.innerHTML='<section class="notice urgent" role="alert"><h2>Live camera preview unavailable</h2><p>Return to camera setup and start the camera before positioning.</p><button type="button" class="secondary" id="exit-positioning">Stop screening</button></section>';root.querySelector('#exit-positioning').addEventListener('click',onExit);return ()=>{};}
  root.innerHTML=`<section aria-labelledby="positioning-title"><h2 id="positioning-title" tabindex="-1">Guided positioning</h2><p>Place your face inside the guide, look toward the phone, and hold still. This step only checks camera framing and alignment; it does not assess your eyes or estimate a prescription.</p><aside class="notice model-disclosure"><strong>On-device processing and service metrics</strong><p>Video frames are processed on this device and are not sent to the model hosts. Starting guidance downloads the MediaPipe runtime and face model from jsDelivr and Google Cloud. MediaPipe says its service also sends performance and usage metrics to Google. Review the <a href="https://developers.google.com/edge/mediapipe/solutions/tasks" target="_blank" rel="noreferrer">MediaPipe privacy notice</a> before agreeing.</p><label class="consent"><input id="metrics-consent" type="checkbox"> I understand and agree to use this positioning service, including its runtime downloads and usage metrics.</label></aside><div class="positioning-frame" id="positioning-frame"><canvas id="position-overlay" aria-hidden="true"></canvas><p id="position-placeholder" class="hidden">Waiting for positioning…</p></div><div id="positioning-status" class="positioning-status" role="status" aria-live="polite" aria-atomic="true"><strong id="position-instruction">Positioning has not started.</strong><span id="position-detail">Your face is analyzed only after you choose Start guidance.</span></div><div class="actions"><button class="primary" id="start-positioning" type="button" disabled>Start guidance</button><button class="primary hidden" id="continue-positioning" type="button">Continue</button><button class="secondary" id="exit-positioning" type="button">Stop screening</button></div><p class="hint">Distance is estimated from the face size in the preview. It is not measured in centimeters. This step does not take or save a photograph.</p></section>`;
  const intervalMs=compatibility?.configuration?.processing?.intervalMs;
  if(Number.isFinite(intervalMs))root.insertAdjacentHTML('afterbegin',`<p class="hint">Positioning frame processing uses a ${intervalMs} ms interval based on available device performance hints. Full camera resolution is preserved.</p>`);
  const frame=root.querySelector('#positioning-frame'),canvas=root.querySelector('#position-overlay'),consent=root.querySelector('#metrics-consent');
  const startButton=root.querySelector('#start-positioning'),continueButton=root.querySelector('#continue-positioning'),instruction=root.querySelector('#position-instruction'),detail=root.querySelector('#position-detail'),status=root.querySelector('#positioning-status');
  video.classList.add('positioning-video');frame.insertBefore(video,canvas);
  let detector=null,disposed=false,handedOff=false,position=null,latestDetection=null;
  consent.addEventListener('change',()=>{startButton.disabled=!consent.checked||disposed;});
  function showPosition(next,detection){
    if(disposed)return;position=next;latestDetection=detection;
    instruction.textContent=next?.primaryInstruction||instructionFor('INITIALIZING');
    detail.textContent=next?.faceDetected?`Face found. Distance: ${next.distanceStatus==='ACCEPTABLE'?'within the guide':next.distanceStatus==='TOO_FAR'?'too far':next.distanceStatus==='TOO_CLOSE'?'too close':'checking'}. ${next.stable?'Position is steady.':'Checking alignment and movement.'}`:next?.error||'Positioning checks are running locally.';
    status.classList.toggle('is-ready',Boolean(next?.ready));status.classList.toggle('is-error',next?.status==='ERROR');continueButton.classList.toggle('hidden',!next?.ready);
    redraw();root.dispatchEvent(new CustomEvent('positioning-update',{bubbles:true,detail:{positioning:next}}));
  }
  function redraw(){const bounds=frame.getBoundingClientRect();if(!bounds.width||!bounds.height||!video.videoWidth||!video.videoHeight)return;frame.style.aspectRatio=`${video.videoWidth} / ${video.videoHeight}`;drawPositionOverlay(canvas,position,{width:bounds.width,height:bounds.height},{width:video.videoWidth,height:video.videoHeight},{objectFit:getComputedStyle(video).objectFit||'contain',mirrored:mirroredPreview,eyeLevel:0.43});}
  const observer=typeof ResizeObserver!=='undefined'?new ResizeObserver(redraw):null;observer?.observe(frame);video.addEventListener('resize',redraw);window.addEventListener('resize',redraw);
  async function start(){
    if(!consent.checked||disposed)return;
    startButton.disabled=true;instruction.textContent='Loading the on-device positioning model…';detail.textContent='The camera preview remains in this browser.';
    try{await detector?.stop();detector=new PositioningDetector({camera,video,config:Number.isFinite(intervalMs)?{processIntervalMs:intervalMs}:{},onState:s=>{if(disposed)return;if(s.status==='initializing'){instruction.textContent='Loading the on-device positioning model…';detail.textContent='This may take a moment on the first use.';}else if(s.status==='error'){instruction.textContent='Positioning is unavailable.';detail.textContent=s.error||'Check camera and browser support, then retry.';status.classList.add('is-error');startButton.disabled=false;startButton.textContent='Retry guidance';}},onResult:showPosition});const result=await detector.start();if(result.status==='error')startButton.disabled=false;else startButton.textContent='Guidance running';}
    catch(error){instruction.textContent='Positioning is unavailable.';detail.textContent=error?.message||'Check camera and browser support, then retry.';status.classList.add('is-error');startButton.disabled=false;}
  }
  startButton.addEventListener('click',start);
  continueButton.addEventListener('click',async()=>{
    if(!position?.ready||disposed)return;
    const detectorState=detector?.getSnapshot();if(!detectorState?.fresh){instruction.textContent='Wait for a fresh positioning check.';detail.textContent='The last face result is too old to continue safely.';continueButton.classList.add('hidden');return;}
    const final={positioning:position,latestDetection:()=>detector?.getLatestDetection?.()||latestDetection,positioningDetector:detector,camera:{getSnapshot:()=>camera.getSnapshot(),withVideoFrame:callback=>camera.withVideoFrame(callback),captureFrame:()=>camera.captureFrame(),stopCamera:()=>camera.stopCamera()}};
    handedOff=true;continueButton.disabled=true;instruction.textContent='Positioning is ready.';detail.textContent='The live positioning worker and latest face landmarks are being handed to eye localization. No photograph was captured.';
    await cleanup();
    root.dispatchEvent(new CustomEvent('positioning-ready',{bubbles:true,detail:final}));
  });
  root.querySelector('#exit-positioning').addEventListener('click',async()=>{await cleanup();await camera.stopCamera();onExit();});
  const pageHide=()=>{void cleanup();void camera.stopCamera();};window.addEventListener('pagehide',pageHide,{once:true});
  video.addEventListener('loadedmetadata',redraw);redraw();
  async function cleanup(){if(disposed)return;disposed=true;observer?.disconnect();video.removeEventListener('resize',redraw);video.removeEventListener('loadedmetadata',redraw);window.removeEventListener('resize',redraw);window.removeEventListener('pagehide',pageHide);if(!handedOff)await detector?.stop();}
  return cleanup;
}
