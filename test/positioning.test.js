import test from 'node:test';
import assert from 'node:assert/strict';
import { measureFace, poseFromMatrix, PositioningEvaluator, mapVideoBounds, drawPositionOverlay } from '../src/positioning-analysis.js';
import { PositioningDetector } from '../src/positioning-detector.js';

function matrixForPose({yaw=0,pitch=0,roll=0}={}) {
  const y=yaw*Math.PI/180,p=pitch*Math.PI/180,r=roll*Math.PI/180,cy=Math.cos(y),sy=Math.sin(y),cx=Math.cos(p),sx=Math.sin(p),cz=Math.cos(r),sz=Math.sin(r);
  const r00=cz*cy,r10=sz*cy,r20=-sy,r11=cz*cx-sz*sy*sx,r21=cy*sx,r22=cy*cx;
  const data=Array(16).fill(0);data[0]=r00;data[1]=r10;data[2]=r20;data[4]=-sz*cx;data[5]=r11;data[6]=r21;data[8]=cz*sy;data[9]=-sz*sy*cx-cz*sx;data[10]=r22;data[15]=1;return {rows:4,columns:4,data};
}
function faceLandmarks({centerX=.5,height=.32,widthRatio=height*.9375,eyeY=.43}={}) {
  const top=eyeY-height*.42,bottom=top+height;
  const points=Array.from({length:478},()=>({x:centerX,y:eyeY,z:0}));
  const halfWidth=widthRatio/2;points[10]={x:centerX-halfWidth,y:top,z:-.01};points[152]={x:centerX+halfWidth,y:bottom,z:.01};
  points[33]={x:centerX-halfWidth*.8,y:eyeY,z:0};points[133]={x:centerX-halfWidth*.2,y:eyeY,z:0};for(const i of [159,145])points[i]={x:centerX-halfWidth*.5,y:eyeY,z:0};
  points[362]={x:centerX+halfWidth*.2,y:eyeY,z:0};points[263]={x:centerX+halfWidth*.8,y:eyeY,z:0};for(const i of [386,374])points[i]={x:centerX+halfWidth*.5,y:eyeY,z:0};
  for(const i of [468,469,470,471,472])points[i]={x:centerX-halfWidth*.5,y:eyeY,z:0};for(const i of [473,474,475,476,477])points[i]={x:centerX+halfWidth*.5,y:eyeY,z:0};
  return points;
}
function measurement(options={},pose={}) { return measureFace(faceLandmarks(options),matrixForPose(pose),{width:1280,height:720}); }
function setGaze(points,fraction){const halfWidth=.32*.46875,leftMin=.5-halfWidth*.8,leftMax=.5-halfWidth*.2,rightMin=.5+halfWidth*.2,rightMax=.5+halfWidth*.8;for(const i of [468,469,470,471,472])points[i].x=leftMin+(leftMax-leftMin)*fraction;for(const i of [473,474,475,476,477])points[i].x=rightMin+(rightMax-rightMin)*fraction;return points;}
function evaluator(config={}) {return new PositioningEvaluator({instructionConfirmFrames:1,stabilityWindow:4,stableDurationMs:300,...config});}
function state(options={},pose={},evalr=evaluator(),time=1000){return evalr.update(measurement(options,pose),time);}

test('face detection derives normalized bounds, center, eyes, pose, and real dimensions',()=>{
  const m=measurement({centerX:.48,height:.3,eyeY:.44},{yaw:5,pitch:-3,roll:4});
  assert.ok(Math.abs(m.faceBoundingBox.width-.28125)<1e-8);assert.ok(Math.abs(m.faceBoundingBox.height-.3)<1e-8);assert.ok(Math.abs(m.faceCenter.x-.48)<1e-8);assert.ok(Math.abs(m.eyeCenter.y-.44)<1e-8);assert.deepEqual(m.videoDimensions,{width:1280,height:720});assert.ok(Math.abs(m.headPose.yaw-5)<.01);assert.ok(Math.abs(m.headPose.pitch+3)<.01);assert.ok(Math.abs(m.headPose.roll-4)<.01);
});
test('missing face, invalid landmarks, and unavailable head pose do not pass as ready',()=>{
  const e=evaluator();assert.equal(e.update(null,1).status,'NO_FACE');assert.equal(measureFace([],matrixForPose(),{width:1,height:1}),null);assert.equal(state({}, {}, e,2).ready,false);
  const withoutPose=new PositioningEvaluator();assert.equal(withoutPose.update(measureFace(faceLandmarks(),null,{width:1280,height:720}),3).status,'ERROR');
});
test('face-size proxy detects too far and too close without inventing centimeters',()=>{
  assert.equal(state({height:.12}).status,'TOO_FAR');assert.equal(state({height:.6}).status,'TOO_CLOSE');assert.equal(state({height:.32}).distanceStatus,'ACCEPTABLE');
});
test('horizontal framing gives left and right corrections',()=>{
  assert.equal(state({centerX:.25}).status,'MOVE_LEFT');assert.equal(state({centerX:.76}).status,'MOVE_RIGHT');
});
test('eye-level framing gives up and down corrections',()=>{
  assert.equal(state({eyeY:.2}).status,'MOVE_DOWN');assert.equal(state({eyeY:.7}).status,'MOVE_UP');
});
test('head yaw, pitch, and roll each prevent readiness with distinct guidance',()=>{
  assert.equal(state({}, {yaw:27}).status,'FACE_CAMERA');assert.equal(state({}, {pitch:25}).status,'LOOK_STRAIGHT');assert.equal(state({}, {roll:20}).status,'STRAIGHTEN_HEAD');
});
test('iris alignment requires looking toward the phone and rejects unavailable eye landmarks',()=>{
  const points=setGaze(faceLandmarks(),.05);const away=measureFace(points,matrixForPose(),{width:1280,height:720});assert.ok(away.gaze.horizontalOffset<-.23);assert.equal(evaluator().update(away,2).status,'LOOK_AT_PHONE');
  const missing=faceLandmarks();missing[468].x=NaN;const m=measureFace(missing,matrixForPose(),{width:1280,height:720});assert.equal(m.gaze,null);const e=new PositioningEvaluator();assert.equal(e.update(m,2).status,'ERROR');
});
test('looking away generates one clear corrective instruction',()=>{const points=setGaze(faceLandmarks(),.05);const e=evaluator();const m=measureFace(points,matrixForPose(),{width:1280,height:720});assert.equal(e.update(m,1000).status,'LOOK_AT_PHONE');assert.equal(e.update(m,1200).primaryInstruction,'Look toward the phone.');});
test('acceptable alignment reports hold still before it reports ready',()=>{
  const e=evaluator();const p=state({}, {}, e,1000);assert.equal(p.status,'HOLD_STILL');assert.equal(p.stable,false);assert.equal(p.ready,false);
});
test('temporal stability rejects movement and accepts sustained stable measurements',()=>{
  const moving=evaluator({stableCenterRange:.025});let p;for(let i=0;i<8;i++)p=state({centerX:i%2?.2:.8},{},moving,i*100);assert.equal(p.stable,false);
  const stable=evaluator({instructionConfirmFrames:2});for(let i=0;i<4;i++)p=state({}, {},stable,i*100);assert.equal(p.stable,true);assert.equal(p.ready,false);p=state({}, {},stable,400);assert.equal(p.status,'READY');assert.equal(p.ready,true);
});
test('smoothing and instruction hysteresis prevent one-frame direction flips',()=>{
  const e=evaluator({instructionConfirmFrames:2,smoothingAlpha:.25});assert.notEqual(state({centerX:.2},{},e,1).status,'MOVE_LEFT');assert.equal(state({centerX:.2},{},e,2).status,'MOVE_LEFT');assert.equal(state({centerX:.5},{},e,3).status,'MOVE_LEFT');
});
test('a detected face uses refreshed dimensions after orientation/resolution changes',()=>{
  const first=measureFace(faceLandmarks(),matrixForPose(),{width:720,height:1280});const second=measureFace(faceLandmarks(),matrixForPose(),{width:1280,height:720});assert.deepEqual(first.videoDimensions,{width:720,height:1280});assert.deepEqual(second.videoDimensions,{width:1280,height:720});assert.equal(first.faceHeightRatio,second.faceHeightRatio);
});
test('distance proxy stays comparable when the same face and frame rotate between portrait and landscape',()=>{
  const portrait=measureFace(faceLandmarks({height:.3,widthRatio:.28125}),matrixForPose(),{width:1280,height:720});const landscape=measureFace(faceLandmarks({height:.28125,widthRatio:.3}),matrixForPose(),{width:720,height:1280});assert.ok(Math.abs(portrait.faceSizeRatio-landscape.faceSizeRatio)<1e-8);
});
test('overlay mapping accounts for contain letterboxing and mirrored coordinates',()=>{
  const box={left:.1,top:.2,right:.4,bottom:.8};const normal=mapVideoBounds(box,{width:400,height:400},{width:1280,height:720},'contain',false);const mirror=mapVideoBounds(box,{width:400,height:400},{width:1280,height:720},'contain',true);
  assert.ok(Math.abs(normal.offsetY-87.5)<1e-8);assert.ok(Math.abs(normal.x-40)<1e-8);assert.ok(Math.abs(normal.y-132.5)<1e-8);assert.ok(Math.abs(normal.width-120)<1e-8);assert.ok(Math.abs(mirror.x-240)<1e-8);
});
test('overlay mapping handles cover crop, portrait, and landscape containers',()=>{
  const box={left:.25,top:.25,right:.75,bottom:.75};const cover=mapVideoBounds(box,{width:400,height:400},{width:1280,height:720},'cover');assert.ok(cover.offsetX<0);assert.ok(cover.width>200);
  const portrait=mapVideoBounds(box,{width:300,height:500},{width:720,height:1280});const landscape=mapVideoBounds(box,{width:500,height:300},{width:1280,height:720});assert.ok(portrait&&landscape);assert.ok(portrait.width>0&&landscape.width>0);assert.notEqual(portrait.width,landscape.width);
});
test('canvas overlay redraw maps a live face box and displays target geometry',()=>{
  const calls=[];const ctx=new Proxy({}, {get(_t,key){if(key==='setTransform'||key==='clearRect'||key==='beginPath'||key==='ellipse'||key==='stroke'||key==='moveTo'||key==='lineTo'||key==='strokeRect'||key==='arc'||key==='fill'||key==='setLineDash'){return (...args)=>calls.push([key,...args]);}return undefined;},set(){return true;}});const canvas={style:{},getContext:()=>ctx};const result=drawPositionOverlay(canvas,{faceBoundingBox:{left:.3,top:.2,right:.7,bottom:.8},eyeCenter:{x:.5,y:.43},ready:true},{width:360,height:640},{width:720,height:1280});assert.ok(result);assert.ok(calls.some(c=>c[0]==='strokeRect'));assert.ok(calls.some(c=>c[0]==='ellipse'));assert.equal(canvas.width,360);
});
test('pose matrix is rejected when malformed instead of returning made-up angles',()=>{assert.equal(poseFromMatrix(null),null);assert.equal(poseFromMatrix({data:[1,2]}),null);});

class MockWorker {
  constructor({fail=false,landmarks=faceLandmarks(),matrix=matrixForPose()}={}){this.listeners={};this.fail=fail;this.landmarks=landmarks;this.matrix=matrix;this.terminated=false;this.frameCount=0;this.eyeTopology={leftEye:[{start:1,end:2}],rightEye:[{start:3,end:4}],leftIris:[{start:5,end:6}],rightIris:[{start:7,end:8}]};}
  addEventListener(name,fn){(this.listeners[name]||=[]).push(fn);}
  emit(type,data={}){for(const fn of this.listeners.message||[])fn({data:{type,...data}});}
  postMessage(message){if(message.type==='initialize')queueMicrotask(()=>this.fail?this.emit('error',{message:'model unavailable'}):this.emit('initialized',{eyeTopology:this.eyeTopology}));if(message.type==='frame'){this.frameCount++;queueMicrotask(()=>this.emit('result',{timestamp:message.timestamp,frameWidth:message.frameWidth,frameHeight:message.frameHeight,landmarks:this.landmarks,matrix:this.matrix}));}if(message.type==='stop')queueMicrotask(()=>this.emit('stopped'));}
  terminate(){this.terminated=true;}
}
function detectorHarness({worker,cameraReady=true}={}){
  const theWorker=worker||new MockWorker(),video={videoWidth:1280,videoHeight:720,currentTime:1,readyState:2};let tick=null,cancelled=false,clock=300;
  const camera={getSnapshot:()=>({previewReady:cameraReady})};const detector=new PositioningDetector({camera,video,workerFactory:()=>theWorker,bitmapFactory:async()=>({close(){}}),requestFrame:fn=>{tick=fn;return 5;},cancelFrame:()=>{cancelled=true;tick=null;},now:()=>clock,config:{processIntervalMs:200}});
  return {detector,worker:theWorker,video,camera,setReady(value){cameraReady=value;},async frame(time=clock+200){clock=time;video.currentTime+=.2;const next=tick;tick=null;next?.();await new Promise(resolve=>setImmediate(resolve));}};
}
test('Component 3 detector reuses Component 2 camera, returns detections for Component 4, and never reopens camera',async()=>{
  const h=detectorHarness();let emitted;h.detector.onResult=(position)=>{emitted=position;};const started=await h.detector.start();assert.equal(started.status,'ready');await h.frame();assert.equal(h.worker.frameCount,1);assert.equal(emitted.faceDetected,true);assert.ok(h.detector.getLatestDetection().landmarks.length>=264);assert.equal(typeof h.camera.getUserMedia,'undefined');await h.detector.stop();assert.equal(h.worker.terminated,true);
});
test('Component 4 subscribes to the existing worker stream without starting another model or camera',async()=>{
  const h=detectorHarness();let received=0;let latest;
  const unsubscribe=h.detector.subscribeResults((_position,detection)=>{received++;latest=detection;});
  await h.detector.start();await h.frame(500);assert.equal(received,1);assert.equal(latest.eyeTopology,h.worker.eyeTopology);assert.deepEqual(latest.videoDimensions,{width:1280,height:720});
  unsubscribe();await h.frame(700);assert.equal(received,1);assert.equal(h.worker.frameCount,2);assert.equal(typeof h.camera.getUserMedia,'undefined');
  await h.detector.stop();assert.equal(h.worker.terminated,true);assert.equal(h.detector.getLatestDetection(),null);assert.equal(h.detector.getSnapshot().fresh,false);
});
test('camera stopping pauses inference and never yields READY',async()=>{
  const h=detectorHarness();await h.detector.start();h.setReady(false);await h.frame();assert.equal(h.detector.getSnapshot().status,'error');assert.equal(h.detector.getSnapshot().ready,false);assert.equal(h.worker.frameCount,0);assert.equal(h.camera.stopCamera,undefined);
});
test('model initialization failure exposes recovery state and can release worker resources',async()=>{
  const h=detectorHarness({worker:new MockWorker({fail:true})});const s=await h.detector.start();assert.equal(s.status,'error');assert.match(s.error,/model unavailable/);assert.equal(h.worker.terminated,true);
});
test('inference timeout revokes READY and stops stale positioning results',async()=>{
  class StalledWorker extends MockWorker{postMessage(message){if(message.type==='frame'){this.frameCount++;return;}super.postMessage(message);}}
  const h=detectorHarness({worker:new StalledWorker()});await h.detector.start();await h.frame(500);assert.equal(h.detector.getSnapshot().ready,false);await h.frame(7000);assert.equal(h.detector.getSnapshot().status,'error');assert.equal(h.detector.getSnapshot().ready,false);assert.match(h.detector.getSnapshot().error,/stopped responding/i);assert.equal(h.worker.terminated,true);
});
test('stop cancels the processing loop and closes the model without stopping Component 2 camera',async()=>{
  const h=detectorHarness();await h.detector.start();await h.detector.stop();assert.equal(h.detector.getSnapshot().status,'idle');assert.equal(h.worker.terminated,true);assert.equal(h.camera.stopCamera,undefined);
});
