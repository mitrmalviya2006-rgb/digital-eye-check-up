import test from 'node:test';
import assert from 'node:assert/strict';
import { localizeEyes } from '../src/eye-localization.js';
import { EyeTracker } from '../src/eye-tracker.js';
import { mapVideoPoint, mapVideoBounds, drawEyeOverlay } from '../src/eye-overlay.js';

const ring = (ids) => [[ids[0],ids[1]],[ids[1],ids[2]],[ids[2],ids[3]],[ids[3],ids[4]],[ids[0],ids[5]],[ids[5],ids[6]],[ids[6],ids[7]],[ids[7],ids[4]]].map(([start,end])=>({start,end}));

function fixture({rightOpenGap=.05,leftOpenGap=.05,missingRight=false,missingLeft=false,missingRightIris=false,missingLeftIris=false,width=1280,height=720}={}) {
  const points=Array.from({length:24},()=>({x:.5,y:.5,z:0}));
  function setEye(offset,centerX,gap,missing){
    const centerY=.41,half=.05,mid=gap/2;
    const coords=[[centerX-half,centerY],[centerX-half*.5,centerY-mid],[centerX,centerY-mid*1.3],[centerX+half*.5,centerY-mid],[centerX+half,centerY],[centerX-half*.5,centerY+mid],[centerX,centerY+mid*1.3],[centerX+half*.5,centerY+mid]];
    coords.forEach(([x,y],i)=>{points[offset+i]={x,y,z:0};});
    if(missing) for(let i=0;i<8;i++)points[offset+i]={x:NaN,y:NaN,z:0};
  }
  function setIris(offset,cx,missing){
    [[cx-.008,.41],[cx,.398],[cx+.008,.41],[cx,.422]].forEach(([x,y],i)=>{points[offset+i]={x,y,z:0};});
    if(missing) for(let i=0;i<4;i++)points[offset+i]={x:NaN,y:NaN,z:0};
  }
  setEye(0,.27,rightOpenGap,missingRight); setEye(8,.73,leftOpenGap,missingLeft);
  setIris(16,.27,missingRightIris); setIris(20,.73,missingLeftIris);
  const rightEye=ring([0,1,2,3,4,5,6,7]),leftEye=ring([8,9,10,11,12,13,14,15]);
  const rightIris=[16,17,18,19].map((id,i,ids)=>({start:id,end:ids[(i+1)%ids.length]}));
  const leftIris=[20,21,22,23].map((id,i,ids)=>({start:id,end:ids[(i+1)%ids.length]}));
  return {detection:{landmarks:points,videoDimensions:{width,height},timestamp:1234,eyeTopology:{rightEye,leftEye,rightIris,leftIris}}};
}

const detect=(options={})=>localizeEyes(fixture(options).detection);

test('localizes both anatomical eyes with explicit OD/OS identifiers and actual model topology',()=>{
  const result=detect();
  assert.equal(result.bothEyesGeometryValid,true); assert.equal(result.bothEyesValid,false); assert.equal(result.leftEye.validity.state,'DETECTED'); assert.equal(result.leftEye.validity.geometryState,'VALID'); assert.equal(result.leftEye.eye,'left'); assert.equal(result.leftEye.designation,'OS'); assert.equal(result.rightEye.eye,'right'); assert.equal(result.rightEye.designation,'OD');
  assert.ok(result.leftEye.boundingBox.left>.6); assert.ok(result.rightEye.boundingBox.right<.4); assert.ok(result.leftEye.landmarks.contour.every(point=>Number.isInteger(point.index)));
  assert.deepEqual(result.leftEye.iris.boundary.map(point=>point.index).sort((a,b)=>a-b),[20,21,22,23]);
});

test('only left eye detected remains partial and does not invent right-eye coordinates',()=>{
  const result=detect({missingRight:true});
  assert.equal(result.leftEye.validity.geometryState,'VALID'); assert.equal(result.rightEye.validity.state,'INVALID'); assert.equal(result.rightEye.detected,false); assert.equal(result.rightEye.boundingBox,null); assert.equal(result.bothEyesGeometryValid,false); assert.equal(result.bothEyesValid,false);
});

test('only right eye detected remains partial and does not invent left-eye coordinates',()=>{
  const result=detect({missingLeft:true});
  assert.equal(result.rightEye.validity.geometryState,'VALID'); assert.equal(result.leftEye.validity.state,'INVALID'); assert.equal(result.leftEye.detected,false); assert.equal(result.leftEye.center,null); assert.equal(result.bothEyesGeometryValid,false); assert.equal(result.bothEyesValid,false);
});

test('no face produces not-detected states with no fallback boxes',()=>{
  const result=localizeEyes(null);
  assert.equal(result.analysisStatus,'NO_FACE'); assert.equal(result.leftEye.validity.state,'NOT_DETECTED'); assert.equal(result.rightEye.validity.state,'NOT_DETECTED'); assert.equal(result.leftEye.boundingBox,null);
});

test('confidence is unavailable rather than fabricated when the task emits no per-eye score',()=>{
  const result=detect();
  assert.equal(result.leftEye.confidence,null); assert.equal(result.leftEye.confidenceStatus,'UNAVAILABLE'); assert.equal(result.visibilityAssessment,'UNAVAILABLE');
});

test('openness uses normalized eyelid geometry to classify open, partially closed, and closed eyes',()=>{
  assert.equal(detect({rightOpenGap:.05}).rightEye.eyelid.state,'OPEN');
  assert.equal(detect({rightOpenGap:.02}).rightEye.eyelid.state,'PARTIALLY_CLOSED');
  assert.equal(detect({rightOpenGap:0}).rightEye.eyelid.state,'CLOSED');
  assert.ok(detect({rightOpenGap:.05}).rightEye.eyelid.opennessRatio>detect({rightOpenGap:.02}).rightEye.eyelid.opennessRatio);
});

test('iris boundary is model-derived, its center is labeled as estimated, and pupil remains unavailable',()=>{
  const result=detect();
  assert.equal(result.rightEye.iris.detected,true); assert.equal(result.rightEye.iris.source,'mediapipe_face_landmarker_boundary_landmarks'); assert.equal(result.rightEye.iris.centerType,'ESTIMATED_FROM_BOUNDARY');
  assert.equal(result.rightEye.pupil.status,'UNAVAILABLE'); assert.equal(result.rightEye.pupil.center,null);
});

test('incomplete iris landmarks do not pass the full eye output as valid',()=>{
  const result=detect({missingRightIris:true});
  assert.equal(result.rightEye.detected,true); assert.equal(result.rightEye.iris.detected,false); assert.equal(result.rightEye.validity.state,'DETECTED'); assert.equal(result.bothEyesValid,false);
});

test('mirroring changes preview coordinates, never anatomical eye identifiers',()=>{
  const result=detect();
  const container={width:400,height:400},intrinsic={width:1280,height:720};
  const anatomicalLeftOnScreen=mapVideoPoint(result.leftEye.center,container,intrinsic,'contain',false);
  const anatomicalLeftMirrored=mapVideoPoint(result.leftEye.center,container,intrinsic,'contain',true);
  const anatomicalRightMirrored=mapVideoPoint(result.rightEye.center,container,intrinsic,'contain',true);
  assert.equal(result.leftEye.designation,'OS'); assert.ok(anatomicalLeftOnScreen.x>container.width/2); assert.ok(anatomicalLeftMirrored.x<container.width/2); assert.ok(anatomicalRightMirrored.x>container.width/2);
});

test('preview coordinate conversion handles contain letterboxing and cover cropping',()=>{
  const point={x:.5,y:.5},container={width:400,height:400},intrinsic={width:1280,height:720};
  const contain=mapVideoPoint(point,container,intrinsic,'contain'); const cover=mapVideoPoint(point,container,intrinsic,'cover');
  assert.equal(contain.y,200); assert.ok(contain.offsetY>0); assert.equal(cover.x,200); assert.ok(cover.offsetX<0);
  const box=mapVideoBounds({left:.25,top:.2,right:.75,bottom:.8},container,intrinsic,'cover'); assert.ok(box.width>0&&box.height>0);
});

test('camera resolution and portrait/landscape dimensions determine pixel outputs',()=>{
  const landscape=detect({width:1280,height:720}),portrait=detect({width:720,height:1280});
  assert.equal(landscape.frameWidth,1280); assert.equal(portrait.frameWidth,720); assert.equal(landscape.rightEye.center.pixel.x,landscape.rightEye.center.x*1280); assert.equal(portrait.rightEye.center.pixel.y,portrait.rightEye.center.y*1280);
  const portraitPoint=mapVideoPoint({x:.4,y:.6},{width:300,height:500},{width:720,height:1280});
  const landscapePoint=mapVideoPoint({x:.4,y:.6},{width:500,height:300},{width:1280,height:720});
  assert.ok(portraitPoint&&landscapePoint); assert.notEqual(portraitPoint.x,landscapePoint.x);
});

test('eye orientation is derived from source-frame pixel geometry',()=>{
  const result=detect();
  assert.ok(Number.isFinite(result.leftEye.orientation.angleDegrees)); assert.equal(result.leftEye.orientation.method,'estimated from the eye-corner line in camera-frame pixels');
});

test('positioning gate skips eye extraction until Component 3 reports READY',()=>{
  const result=localizeEyes(fixture().detection,{positioningReady:false});
  assert.equal(result.analysisStatus,'POSITIONING_REQUIRED'); assert.equal(result.leftEye.validity.state,'INVALID'); assert.equal(result.leftEye.boundingBox,null);
});

test('temporal smoothing reduces one-frame landmark motion and reports stable output after sustained samples',()=>{
  const tracker=new EyeTracker({trackingWindow:5,stableDurationMs:400,stableCenterRange:.04,stableScaleRange:.05});
  let result;
  for(let i=0;i<5;i++){const frame=fixture();frame.detection.timestamp=i*100;result=tracker.update(frame.detection,{positioningReady:true,timestamp:i*100});}
  assert.equal(result.analysisStatus,'GEOMETRY_STABLE'); assert.equal(result.trackingStable,true); assert.equal(result.bothEyesGeometryValid,true); assert.equal(result.bothEyesValid,false);
  const moved=fixture(); moved.detection.landmarks[0].x+=.04; moved.detection.timestamp=500;
  const smoothed=tracker.update(moved.detection,{positioningReady:true,timestamp:500});
  assert.ok(smoothed.rightEye.landmarks.contour.find(point=>point.index===0).x<.31);
});

test('single-frame eye loss is marked temporary without publishing stale coordinates as valid',()=>{
  const tracker=new EyeTracker({trackingWindow:4,stableDurationMs:300,stableCenterRange:.04,stableScaleRange:.05});
  for(let i=0;i<4;i++){const frame=fixture();frame.detection.timestamp=i*100;tracker.update(frame.detection,{positioningReady:true,timestamp:i*100});}
  const lost=fixture({missingRight:true}); lost.detection.timestamp=400;
  const result=tracker.update(lost.detection,{positioningReady:true,timestamp:400});
  assert.equal(result.rightEye.detected,false); assert.equal(result.rightEye.boundingBox,null); assert.equal(result.rightEye.tracking.state,'TEMPORARY_LOSS'); assert.equal(result.bothEyesValid,false); assert.equal(result.trackingStable,true);
  const recovered=fixture(); recovered.detection.timestamp=500;
  assert.equal(tracker.update(recovered.detection,{positioningReady:true,timestamp:500}).rightEye.validity.geometryState,'VALID');
});

test('prolonged detection loss clears temporal stability and eye smoothing history',()=>{
  const tracker=new EyeTracker({trackingWindow:4,stableDurationMs:300,stableCenterRange:.04,stableScaleRange:.05,temporaryLossFrames:1});
  for(let i=0;i<4;i++){const frame=fixture();tracker.update(frame.detection,{positioningReady:true,timestamp:i*100});}
  tracker.update(fixture({missingLeft:true}).detection,{positioningReady:true,timestamp:400});
  const secondLoss=fixture({missingLeft:true}); secondLoss.detection.timestamp=500;
  const result=tracker.update(secondLoss.detection,{positioningReady:true,timestamp:500});
  assert.equal(result.leftEye.tracking.state,'INVALID'); assert.equal(result.trackingStable,false);
});

test('debug overlay maps actual eye boxes, contours, and iris boundary',()=>{
  const calls=[]; const context=new Proxy({}, {get(_target,key){if(['setTransform','clearRect','strokeRect','beginPath','arc','fill','stroke','moveTo','lineTo','fillText'].includes(key))return (...args)=>calls.push([key,...args]); return undefined;},set(){return true;}});
  const canvas={width:0,height:0,style:{},getContext:()=>context};
  assert.equal(drawEyeOverlay(canvas,detect(),{width:360,height:640},{width:720,height:1280}),true);
  assert.ok(calls.some(call=>call[0]==='strokeRect')); assert.ok(calls.some(call=>call[0]==='fillText')); assert.ok(calls.some(call=>call[0]==='lineTo'));
});

test('machine-readable output remains consumable without claiming pupil, confidence, or visibility',()=>{
  const result=detect();
  assert.equal(result.schemaVersion,'1.0.0'); assert.equal(result.coordinateSpace,'normalized_camera_frame_top_left_unmirrored');
  for(const eye of [result.leftEye,result.rightEye]) { assert.ok(eye.boundingBox&&eye.center&&eye.landmarks.contour.length); assert.equal(eye.pupil.center,null); assert.equal(eye.confidence,null); assert.equal(eye.visibility.state,'UNAVAILABLE'); assert.equal(eye.validity.state,'DETECTED'); }
  assert.equal(result.bothEyesValid,false); assert.equal(result.bothEyesGeometryValid,true); assert.equal(result.trackingStable,false);
});
