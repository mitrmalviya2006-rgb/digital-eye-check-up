import { FACE_LANDMARKER_ASSETS } from './positioning-config.js';

let landmarker=null;
let stopping=false;
let generation=0;

function serializeConnections(connections){
  if(!Array.isArray(connections))return [];
  return connections.map(({start,end})=>({start:Number(start),end:Number(end)}))
    .filter(({start,end})=>Number.isInteger(start)&&Number.isInteger(end)&&start>=0&&end>=0);
}

self.addEventListener('message',async event=>{
  const message=event.data;
  if(message?.type==='initialize'){
    if(landmarker)return;
    const current=++generation;
    try{
      stopping=false;
      const runtime=await import(`${FACE_LANDMARKER_ASSETS.packageBase}/vision_bundle.mjs`);
      if(stopping||current!==generation)return;
      const vision=await runtime.FilesetResolver.forVisionTasks(`${FACE_LANDMARKER_ASSETS.packageBase}/wasm`);
      const task=await runtime.FaceLandmarker.createFromOptions(vision,{
        baseOptions:{modelAssetPath:FACE_LANDMARKER_ASSETS.model},runningMode:'VIDEO',numFaces:1,
        minFaceDetectionConfidence:0.55,minFacePresenceConfidence:0.55,minTrackingConfidence:0.55,
        outputFacialTransformationMatrixes:true,
      });
      if(stopping||current!==generation){task.close();return;}
      const eyeTopology={
        leftEye:serializeConnections(runtime.FaceLandmarker.FACE_LANDMARKS_LEFT_EYE),
        rightEye:serializeConnections(runtime.FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE),
        leftIris:serializeConnections(runtime.FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS),
        rightIris:serializeConnections(runtime.FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS),
      };
      if(eyeTopology.leftEye.length<8||eyeTopology.rightEye.length<8||eyeTopology.leftIris.length<4||eyeTopology.rightIris.length<4){task.close();throw new Error('This MediaPipe runtime does not expose complete eye landmark definitions.');}
      landmarker=task;
      self.postMessage({type:'initialized',eyeTopology});
    }catch(error){self.postMessage({type:'error',message:error?.message||'Face landmark model could not be loaded.'});}
    return;
  }
  if(message?.type==='frame'){
    const bitmap=message.bitmap;
    try{
      if(stopping||!landmarker)return;
      const result=landmarker.detectForVideo(bitmap,message.timestamp);
      self.postMessage({type:'result',timestamp:message.timestamp,frameWidth:message.frameWidth,frameHeight:message.frameHeight,landmarks:result.faceLandmarks?.[0]||null,matrix:result.facialTransformationMatrixes?.[0]||null});
    }catch(error){self.postMessage({type:'error',message:error?.message||'Face positioning could not process this frame.'});}
    finally{bitmap?.close?.();}
    return;
  }
  if(message?.type==='stop'){
    stopping=true;
    generation++;
    try{landmarker?.close?.();}catch{}
    landmarker=null;
    self.postMessage({type:'stopped'});
  }
});
