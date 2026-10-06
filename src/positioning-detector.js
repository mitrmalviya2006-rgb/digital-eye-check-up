import { PositioningEvaluator, measureFace } from './positioning-analysis.js';
import { POSITIONING_CONFIG } from './positioning-config.js';

/** Owns one worker and a rate-limited frame loop; it never owns or stops the camera. */
export class PositioningDetector {
  constructor({camera,video,onState=()=>{},onResult=()=>{},workerFactory,bitmapFactory,requestFrame,cancelFrame,now,config={}}={}){
    this.camera=camera;this.video=video;this.onState=onState;this.onResult=onResult;this.stateListeners=new Set();this.resultListeners=new Set();this.config={...POSITIONING_CONFIG,...config};
    this.workerFactory=workerFactory||(()=>new Worker(new URL('./positioning-worker.js',import.meta.url),{type:'module',name:'vision-positioning'}));
    this.bitmapFactory=bitmapFactory||((v)=>createImageBitmap(v));this.worker=null;this.evaluator=new PositioningEvaluator(config);this.running=false;this.busy=false;this.rafId=null;this.lastFrameAt=0;this.lastVideoTime=-1;this.lastTimestamp=0;this.startPromise=null;this.stopResolve=null;this.status='idle';this.error=null;this.latestDetection=null;
    this.workerSupported=Boolean(workerFactory)||typeof Worker!=='undefined';this.bitmapSupported=Boolean(bitmapFactory)||typeof createImageBitmap!=='undefined';this.animationSupported=Boolean(requestFrame)||typeof requestAnimationFrame!=='undefined';this.requestFrame=requestFrame||((callback)=>requestAnimationFrame(callback));this.cancelFrame=cancelFrame||((id)=>cancelAnimationFrame(id));this.now=now||(()=>performance.now());this.latestPosition=null;this.eyeTopology=null;this.initReject=null;this.lastResultAt=0;
  }
  getSnapshot(){const resultAgeMs=this.lastResultAt?this.now()-this.lastResultAt:Infinity;return {status:this.status,error:this.error,latest:this.latestPosition,ready:this.latestPosition?.ready===true,resultAgeMs,fresh:resultAgeMs<=this.config.maxResultAgeMs};}
  subscribeState(listener){if(typeof listener!=='function')return()=>{};this.stateListeners.add(listener);return()=>this.stateListeners.delete(listener);}
  subscribeResults(listener){if(typeof listener!=='function')return()=>{};this.resultListeners.add(listener);return()=>this.resultListeners.delete(listener);}
  #publish(status,error=null){this.status=status;this.error=error;const snapshot=this.getSnapshot();try{this.onState(snapshot);}catch{}for(const listener of this.stateListeners){try{listener(snapshot);}catch{}}}
  start(){if(this.status==='ready'&&this.running)return Promise.resolve(this.getSnapshot());if(this.startPromise)return this.startPromise;this.startPromise=this.#initialize().finally(()=>{this.startPromise=null;});return this.startPromise;}
  async #initialize(){
    if(!this.camera?.getSnapshot?.().previewReady||!this.video?.videoWidth||!this.video?.videoHeight){this.#publish('error','The live camera preview is not available. Return to camera setup and try again.');return this.getSnapshot();}
    if(!this.workerSupported||!this.bitmapSupported||!this.animationSupported){this.#publish('error','This browser cannot run local face positioning. Try a current browser on a secure connection.');return this.getSnapshot();}
    this.#publish('initializing');
    try{
      this.worker=this.workerFactory();
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{this.initReject=null;reject(new Error('The face model took too long to load. Check your connection and retry.'));},45000);
        this.initReject=error=>{clearTimeout(timer);this.initReject=null;reject(error);};
        this.worker.addEventListener('message',event=>{this.#handleMessage(event.data);if(event.data?.type==='initialized'){clearTimeout(timer);this.initReject=null;resolve();}else if(event.data?.type==='error'){clearTimeout(timer);this.initReject=null;reject(new Error(event.data.message));}});
        this.worker.addEventListener('error',()=>{clearTimeout(timer);this.initReject=null;reject(new Error('The face model could not start in this browser. Retry or use a supported browser.'));});
        this.worker.postMessage({type:'initialize'});
      });
      if(!this.camera.getSnapshot().previewReady)throw new Error('The camera stopped while positioning was starting.');
      this.running=true;this.#publish('ready');this.#schedule();
    }catch(error){await this.stop();this.#publish('error',error?.message||'Face positioning could not start.');}
    return this.getSnapshot();
  }
  #schedule(){if(!this.running)return;this.rafId=this.requestFrame(()=>{void this.#tick();});}
  async #tick(){
    if(!this.running)return;
    this.#schedule();
    if(!this.camera?.getSnapshot?.().previewReady){await this.#fail('The camera stopped. Positioning has paused; return to camera setup.');return;}
    if(!Number.isFinite(this.video.videoWidth)||!Number.isFinite(this.video.videoHeight)||this.video.videoWidth<=0||this.video.videoHeight<=0){await this.#fail('The camera preview dimensions are unavailable. Restart the camera and try again.');return;}
    const now=this.now();
    if(this.busy&&now-this.lastFrameAt>this.config.maxInferenceMs){await this.#fail('Face positioning stopped responding. Retry or return to camera setup.');return;}
    if(this.lastResultAt&&now-this.lastResultAt>this.config.maxResultAgeMs){await this.#fail('Fresh positioning results are no longer available. Retry guidance before continuing.');return;}
    if(this.busy||this.video.readyState<2||this.video.currentTime===this.lastVideoTime||now-this.lastFrameAt<this.config.processIntervalMs)return;
    this.busy=true;this.lastFrameAt=now;this.lastVideoTime=this.video.currentTime;this.lastTimestamp=Math.max(now,this.lastTimestamp+1);
    const frameWidth=this.video.videoWidth,frameHeight=this.video.videoHeight;
    let bitmap;
    try{bitmap=await this.bitmapFactory(this.video);if(!this.running){bitmap?.close?.();this.busy=false;return;}this.worker.postMessage({type:'frame',bitmap,timestamp:this.lastTimestamp,frameWidth,frameHeight},[bitmap]);}
    catch(error){bitmap?.close?.();this.busy=false;await this.#fail(error?.message||'A camera frame could not be processed.');}
  }
  #handleMessage(message){
    if(message?.type==='initialized'){
      this.eyeTopology=message.eyeTopology||null;
    }else if(message?.type==='result'){
      this.busy=false;
      if(!this.running)return;
      this.lastResultAt=this.now();
      try{
        const dimensions={width:message.frameWidth||this.video.videoWidth,height:message.frameHeight||this.video.videoHeight};
        const measurement=measureFace(message.landmarks,message.matrix,dimensions);
        const position=this.evaluator.update(measurement,message.timestamp);
        this.latestPosition=position;
        this.latestDetection=measurement?{landmarks:message.landmarks,facialTransformationMatrix:message.matrix,eyeTopology:this.eyeTopology,videoDimensions:dimensions,timestamp:message.timestamp}:null;
        try{this.onResult(position,this.latestDetection);}catch{}
        for(const listener of this.resultListeners){try{listener(position,this.latestDetection);}catch{}}
      }catch(error){void this.#fail(error?.message||'Positioning results could not be displayed.');}
    }else if(message?.type==='error'){this.busy=false;if(this.status!=='initializing')void this.#fail(message.message||'Face positioning stopped unexpectedly.');}
    else if(message?.type==='stopped'){this.stopResolve?.();this.stopResolve=null;}
  }
  async #fail(message){if(!this.running&&this.status==='error')return;const errorPosition={status:'ERROR',faceDetected:false,distanceStatus:'UNKNOWN',alignmentStatus:{horizontal:'UNKNOWN',vertical:'UNKNOWN'},headPose:null,stable:false,ready:false,primaryInstruction:message,error:message};await this.stop();this.latestPosition=errorPosition;this.#publish('error',message);}
  async stop(){
    this.running=false;if(this.rafId!==null)this.cancelFrame(this.rafId);this.rafId=null;this.initReject?.(new Error('Positioning was stopped.'));this.initReject=null;
    const worker=this.worker;this.worker=null;
    if(worker){await new Promise(resolve=>{let timer=setTimeout(resolve,500);this.stopResolve=()=>{clearTimeout(timer);resolve();};try{worker.postMessage({type:'stop'});}catch{clearTimeout(timer);resolve();}});worker.terminate?.();}
    this.busy=false;this.stopResolve=null;this.latestDetection=null;this.latestPosition=null;this.eyeTopology=null;this.lastResultAt=0;this.lastFrameAt=0;this.lastVideoTime=-1;this.lastTimestamp=0;this.evaluator=new PositioningEvaluator(this.config);if(this.status!=='error')this.#publish('idle');
  }
  getLatestDetection(){return this.latestDetection;}
}
