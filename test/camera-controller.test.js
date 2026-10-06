import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraController } from '../src/camera-controller.js';
import { canStartCameraStep, configureSessionDataStore, setQuestionnaireResult } from '../src/session.js';

class FakeVideo {
  constructor({ playError = null } = {}) { this.videoWidth=1280; this.videoHeight=720; this.playError=playError; this.listeners={}; this.srcObject=null; }
  addEventListener(name,fn) { (this.listeners[name] ||= []).push(fn); }
  removeEventListener(name,fn) { this.listeners[name]=(this.listeners[name]||[]).filter(item=>item!==fn); }
  async play() { if(this.playError) throw this.playError; }
  pause() {}
}
function mockTrack({ capabilities={torch:true,zoom:{min:1,max:4,step:.5},focusMode:['continuous','single-shot']}, settings={deviceId:'rear-1',width:1280,height:720,zoom:1}, applyError=null }={}) {
  const listeners={};
  return { kind:'video', stopped:false, applied:[], getCapabilities:()=>capabilities, getSettings:()=>settings, addEventListener:(n,f)=>{listeners[n]=f;}, removeEventListener:()=>{}, stop(){this.stopped=true;}, async applyConstraints(c){ if(applyError) throw applyError; this.applied.push(c); }, listeners };
}
function harness({ track=mockTrack(), getUserMedia, enumerateDevices, playError, secureContext=true }={}) {
  const calls=[]; const video=new FakeVideo({playError}); const md={getUserMedia:async constraints=>{calls.push(constraints); if(getUserMedia) return getUserMedia(constraints); return stream(track); }, enumerateDevices:enumerateDevices || (async()=>[{kind:'videoinput',deviceId:'rear-1',label:'Back camera'}])};
  const controller=new CameraController({video,mediaDevices:md,secureContext,config:{metadataTimeoutMs:10}});
  return {controller,video,calls,track};
}
function stream(track) { return {getVideoTracks:()=>[track],getTracks:()=>[track]}; }

test('unsupported API and insecure context never request access', async()=>{
  const noApi=new CameraController({video:new FakeVideo(),mediaDevices:{},secureContext:true}); assert.equal((await noApi.startCamera()).status,'unsupported');
  const insecure=harness({secureContext:false}); const state=await insecure.controller.startCamera(); assert.equal(state.status,'unsupported'); assert.equal(insecure.calls.length,0);
});
test('successful start requests rear camera without microphone and reports actual dimensions', async()=>{
  const h=harness(); const state=await h.controller.startCamera(); assert.equal(state.status,'ready'); assert.equal(state.previewReady,true); assert.deepEqual(state.actualResolution,{width:1280,height:720}); assert.equal(h.calls[0].audio,false); assert.equal(h.calls[0].video.facingMode.ideal,'environment'); assert.equal(h.video.srcObject!==null,true);
});
test('preview does not become ready until metadata dimensions are available',async()=>{
  const video=new FakeVideo(); video.videoWidth=0; video.videoHeight=0; const track=mockTrack(); const mediaDevices={getUserMedia:async()=>stream(track),enumerateDevices:async()=>[]};
  const controller=new CameraController({video,mediaDevices,config:{metadataTimeoutMs:100}}); const pending=controller.startCamera(); await new Promise(resolve=>setImmediate(resolve)); assert.equal(controller.getSnapshot().status,'initializing'); video.videoWidth=640; video.videoHeight=480; for(const fn of video.listeners.loadedmetadata||[]) fn(); const s=await pending; assert.equal(s.previewReady,true); assert.deepEqual(s.actualResolution,{width:640,height:480});
});
test('permission and hardware errors are actionable', async t=>{
  for(const [name,status,phrase] of [['NotAllowedError','permission_denied','permission was denied'],['NotFoundError','error','No usable camera'],['NotReadableError','error','may be in use'],['OverconstrainedError','error','cannot meet']]) await t.test(name,async()=>{ const h=harness({getUserMedia:async()=>{throw Object.assign(new Error(name),{name});}}); const s=await h.controller.startCamera(); assert.equal(s.status,status); assert.match(s.error,new RegExp(phrase,'i')); });
});
test('camera switching stops old stream and requests selected device', async()=>{
  const first=mockTrack({settings:{deviceId:'rear-1'}}), second=mockTrack({settings:{deviceId:'front-1'}}); let count=0;
  const h=harness({getUserMedia:async()=>stream(++count===1?first:second),enumerateDevices:async()=>[{kind:'videoinput',deviceId:'rear-1',label:'Back'},{kind:'videoinput',deviceId:'front-1',label:'Front'}]});
  await h.controller.startCamera(); const s=await h.controller.switchCamera('front-1'); assert.equal(first.stopped,true); assert.equal(s.activeDeviceId,'front-1'); assert.equal(h.calls[1].video.deviceId.exact,'front-1');
});
test('torch support is capability-based and updates only after success', async()=>{
  const track=mockTrack(); const h=harness({track}); await h.controller.startCamera(); assert.equal(await h.controller.setTorch(true),true); assert.equal(h.controller.getSnapshot().torchEnabled,true); assert.deepEqual(track.applied[0],{advanced:[{torch:true}]});
  const unsupported=harness({track:mockTrack({capabilities:{},settings:{}})}); await unsupported.controller.startCamera(); await assert.rejects(unsupported.controller.setTorch(true),/not available/i);
  const fail=harness({track:mockTrack({applyError:new Error('no torch')})}); await fail.controller.startCamera(); await assert.rejects(fail.controller.setTorch(true),/rejected/i); assert.equal(fail.controller.getSnapshot().torchEnabled,false);
});
test('settings validate exposed ranges and enums before applying', async()=>{
  const h=harness(); await h.controller.startCamera(); const result=await h.controller.applyCameraSettings({zoom:2}); assert.deepEqual(result.applied,{zoom:2}); await assert.rejects(h.controller.applyCameraSettings({zoom:8}),/supported range/i); await assert.rejects(h.controller.applyCameraSettings({focusMode:'manual'}),/supported focusMode option/i); await assert.rejects(h.controller.applyCameraSettings({exposureCompensation:1}),/not supported/i);
});
test('preview playback failure does not report ready', async()=>{ const h=harness({playError:new Error('autoplay refused')}); const s=await h.controller.startCamera(); assert.equal(s.previewReady,false); assert.equal(s.status,'error'); assert.match(s.error,/blocked live preview playback/i); });
test('stop releases every track, torch, and video reference', async()=>{
  const track=mockTrack(); const h=harness({track}); await h.controller.startCamera(); await h.controller.setTorch(true); const s=await h.controller.stopCamera(); assert.equal(s.status,'idle'); assert.equal(s.previewReady,false); assert.equal(track.stopped,true); assert.equal(h.video.srcObject,null); assert.deepEqual(track.applied.at(-1),{advanced:[{torch:false}]});
});
test('repeated starts share an initialization and avoid duplicate streams', async()=>{
  let resolve; let count=0; const pending=new Promise(r=>resolve=r); const track=mockTrack(); const h=harness({getUserMedia:async()=>{count++; await pending; return stream(track);}});
  const a=h.controller.startCamera(), b=h.controller.startCamera(); resolve(); await Promise.all([a,b]); await h.controller.startCamera(); assert.equal(count,1);
});
test('stopping during permission prompt closes late stream instead of reporting ready', async()=>{
  let resolve; const waiting=new Promise(r=>resolve=r); const track=mockTrack(); const h=harness({getUserMedia:async()=>{await waiting;return stream(track);}});
  const start=h.controller.startCamera(); await h.controller.stopCamera(); resolve(); const state=await start; assert.equal(track.stopped,true); assert.equal(state.status,'idle'); assert.equal(state.previewReady,false);
});
test('retry after a camera error can initialize successfully',async()=>{
  let count=0; const track=mockTrack(); const h=harness({getUserMedia:async()=>{ if(count++===0) throw Object.assign(new Error('blocked'),{name:'NotAllowedError'}); return stream(track); }});
  assert.equal((await h.controller.startCamera()).status,'permission_denied'); assert.equal((await h.controller.startCamera()).status,'ready');
});
test('torch and frame access are invalid before preview readiness',async()=>{
  const h=harness(); await assert.rejects(h.controller.setTorch(true),/not available/i); await assert.rejects(h.controller.withVideoFrame(()=>{}),/until the preview is ready/i); await assert.rejects(h.controller.captureFrame(),/until the preview is ready/i);
});
test('rear constraint rejection retries once with browser camera selection',async()=>{
  const track=mockTrack(); let count=0; const h=harness({getUserMedia:async constraints=>{ count++; if(count===1) throw Object.assign(new Error('constraint'),{name:'OverconstrainedError'}); assert.equal('facingMode' in constraints.video,false); return stream(track); }});
  const state=await h.controller.startCamera(); assert.equal(count,2); assert.equal(state.status,'ready'); assert.equal(state.facingModeFallback,true);
});
test('Component 1 consent and safety state gates Component 2',()=>{
  let value=null; configureSessionDataStore({ getSessionValue: key => key === 'questionnaireResult' ? value : null, setSessionValue: (key,next) => { if(key==='questionnaireResult') value=next; } });
  setQuestionnaireResult({completionStatus:'complete',workflowAllowed:false,consent:{screening:true}}); assert.equal(canStartCameraStep(),false);
  setQuestionnaireResult({completionStatus:'complete',workflowAllowed:true,consent:{screening:false}}); assert.equal(canStartCameraStep(),false);
  setQuestionnaireResult({completionStatus:'complete',workflowAllowed:true,consent:{screening:true}}); assert.equal(canStartCameraStep(),true);
});
