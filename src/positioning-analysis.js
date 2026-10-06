import { POSITIONING_CONFIG } from './positioning-config.js';

/** Convert MediaPipe normalized landmarks and its facial transform into honest image-space measurements. */
export function measureFace(landmarks, matrix, dimensions) {
  if (!Array.isArray(landmarks) || landmarks.length < 264 || !dimensions?.width || !dimensions?.height) return null;
  const points = landmarks.filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y));
  if (points.length < 264) return null;
  const xs=points.map(p=>clamp(p.x,0,1)), ys=points.map(p=>clamp(p.y,0,1));
  const box={ left:Math.min(...xs), top:Math.min(...ys), right:Math.max(...xs), bottom:Math.max(...ys) };
  box.width=box.right-box.left; box.height=box.bottom-box.top;
  if (box.width<=0 || box.height<=0) return null;
  const frameDiagonal=Math.hypot(dimensions.width,dimensions.height);
  if(!Number.isFinite(frameDiagonal)||frameDiagonal<=0)return null;
  const leftEye=meanPoint(landmarks,[33,133,159,145]); const rightEye=meanPoint(landmarks,[362,263,386,374]);
  if (!leftEye || !rightEye) return null;
  const eyeCenter={x:(leftEye.x+rightEye.x)/2,y:(leftEye.y+rightEye.y)/2};
  const gaze=irisCentering(landmarks);
  return { faceBoundingBox:box, faceCenter:{x:(box.left+box.right)/2,y:(box.top+box.bottom)/2}, faceHeightRatio:box.height, faceWidthRatio:box.width, faceSizeRatio:Math.hypot(box.width*dimensions.width,box.height*dimensions.height)/frameDiagonal, eyeCenter, gaze, headPose:poseFromMatrix(matrix), videoDimensions:{width:dimensions.width,height:dimensions.height}, landmarks };
}

/** MediaPipe's documented 4x4 face transform is used for estimated pose; missing matrices remain unknown. */
export function poseFromMatrix(matrix) {
  const data=matrix?.data;
  if (!Array.isArray(data) && !ArrayBuffer.isView(data)) return null;
  if (data.length!==16 || [...data].some(value=>!Number.isFinite(value))) return null;
  // Matrix data is column-major, matching the MediaPipe Web example's Matrix4.fromArray usage.
  const r00=data[0], r10=data[1], r20=data[2], r21=data[6], r22=data[10], r11=data[5];
  const sy=Math.sqrt(r00*r00+r10*r10);
  let pitch,yaw,roll;
  if (sy>1e-6) { pitch=Math.atan2(r21,r22); yaw=Math.atan2(-r20,sy); roll=Math.atan2(r10,r00); }
  else { pitch=Math.atan2(-data[9],r11); yaw=Math.atan2(-r20,sy); roll=0; }
  return { yaw:degrees(yaw), pitch:degrees(pitch), roll:degrees(roll) };
}

export class PositioningEvaluator {
  constructor(config={}) { this.config={...POSITIONING_CONFIG,...config}; this.smoothed=null; this.history=[]; this.displayState='INITIALIZING'; this.candidate=null; this.candidateFrames=0; this.latest=null; }
  update(measurement,timestamp=performance.now()) {
    if (!measurement) return this.#noFace(timestamp);
    if (!measurement.headPose) return this.#error('Head orientation could not be verified. Check lighting and face the camera, then retry.');
    if(!measurement.gaze)return this.#error('Eye direction could not be checked. Improve lighting and look toward the phone, then retry.');
    const smooth=this.#smooth(measurement); this.latest={...measurement,faceBoundingBox:{...smooth.box},faceCenter:smooth.center,eyeCenter:smooth.eye,faceHeightRatio:smooth.box.height,faceSizeRatio:smooth.size,gaze:smooth.gaze,headPose:smooth.pose};
    this.history.push({timestamp,x:smooth.center.x,y:smooth.eye.y,size:smooth.size,yaw:smooth.pose.yaw,pitch:smooth.pose.pitch,roll:smooth.pose.roll,gaze:smooth.gaze.horizontalOffset});
    if (this.history.length>this.config.stabilityWindow) this.history.shift();
    const target=this.#targetState(smooth); const stable=this.#isStable();
    const next=target || (stable?'READY':'HOLD_STILL');
    const state=this.#confirm(next);
    const result={status:state,faceDetected:true,faceBoundingBox:{...smooth.box},faceCenter:{...smooth.center},eyeCenter:{...smooth.eye},faceSizeRatio:smooth.size,distanceStatus:this.#distance(smooth.size),alignmentStatus:{horizontal:this.#horizontal(smooth.center.x),vertical:this.#vertical(smooth.eye.y),gaze:Math.abs(smooth.gaze.horizontalOffset)<=this.config.maxGazeOffset?'CENTERED':'OFF_CENTER'},eyeGaze:{...smooth.gaze},headPose:{...smooth.pose},stable,ready:state==='READY'&&stable,videoDimensions:{...measurement.videoDimensions},primaryInstruction:instructionFor(state)};
    this.latest={...this.latest,positioning:result}; return result;
  }
  #smooth(m) {
    const alpha=this.config.smoothingAlpha, box=m.faceBoundingBox;
    const values={box,center:m.faceCenter,eye:m.eyeCenter,height:m.faceHeightRatio,pose:m.headPose};
    if (!this.smoothed) this.smoothed={box:{...box},center:{...m.faceCenter},eye:{...m.eyeCenter},size:m.faceSizeRatio,gaze:{...m.gaze},pose:{...m.headPose}};
    else {
      for(const key of ['left','top','right','bottom']) this.smoothed.box[key]=ema(this.smoothed.box[key],box[key],alpha);
      for(const key of ['x','y']) {this.smoothed.center[key]=ema(this.smoothed.center[key],m.faceCenter[key],alpha);this.smoothed.eye[key]=ema(this.smoothed.eye[key],m.eyeCenter[key],alpha);}
      this.smoothed.size=ema(this.smoothed.size,m.faceSizeRatio,alpha);
      this.smoothed.gaze.horizontalOffset=ema(this.smoothed.gaze.horizontalOffset,m.gaze.horizontalOffset,alpha);
      for(const key of ['yaw','pitch','roll']) this.smoothed.pose[key]=ema(this.smoothed.pose[key],m.headPose[key],alpha);
    }
    this.smoothed.box.width=this.smoothed.box.right-this.smoothed.box.left; this.smoothed.box.height=this.smoothed.box.bottom-this.smoothed.box.top;
    return this.smoothed;
  }
  #targetState(s) {
    const distance=this.#distance(s.size); if(distance==='TOO_FAR') return 'TOO_FAR'; if(distance==='TOO_CLOSE') return 'TOO_CLOSE';
    const horizontal=this.#horizontal(s.center.x); if(horizontal!=='CENTERED') return horizontal==='LEFT'?'MOVE_LEFT':'MOVE_RIGHT';
    const vertical=this.#vertical(s.eye.y); if(vertical!=='LEVEL') return vertical==='HIGH'?'MOVE_DOWN':'MOVE_UP';
    const p=s.pose, c=this.config;
    if(Math.abs(p.yaw)>c.maxYawDegrees) return 'FACE_CAMERA';
    if(Math.abs(p.pitch)>c.maxPitchDegrees) return 'LOOK_STRAIGHT';
    if(Math.abs(p.roll)>c.maxRollDegrees) return 'STRAIGHTEN_HEAD';
    if(Math.abs(s.gaze.horizontalOffset)>c.maxGazeOffset) return 'LOOK_AT_PHONE';
    return null;
  }
  #distance(size) { return size<this.config.faceSizeTooFar?'TOO_FAR':size>this.config.faceSizeTooClose?'TOO_CLOSE':'ACCEPTABLE'; }
  #horizontal(x) { return x<0.5-this.config.centerToleranceX?'LEFT':x>0.5+this.config.centerToleranceX?'RIGHT':'CENTERED'; }
  #vertical(y) { return y<this.config.eyeLevel-this.config.eyeLevelTolerance?'HIGH':y>this.config.eyeLevel+this.config.eyeLevelTolerance?'LOW':'LEVEL'; }
  #isStable() {
    if(this.history.length<this.config.stabilityWindow) return false;
    const h=this.history, first=h[0], last=h[h.length-1];
    if(last.timestamp-first.timestamp<this.config.stableDurationMs) return false;
    return range(h,'x')<=this.config.stableCenterRange&&range(h,'y')<=this.config.stableCenterRange&&range(h,'size')<=this.config.stableFaceSizeRange&&range(h,'yaw')<=this.config.stablePoseRangeDegrees&&range(h,'pitch')<=this.config.stablePoseRangeDegrees&&range(h,'roll')<=this.config.stablePoseRangeDegrees&&range(h,'gaze')<=this.config.stableGazeRange;
  }
  #confirm(next) {
    if(next!==this.candidate){this.candidate=next;this.candidateFrames=1;} else this.candidateFrames++;
    if(next==='NO_FACE'||next==='ERROR'||this.displayState==='READY'&&next!=='READY'||this.candidateFrames>=this.config.instructionConfirmFrames) this.displayState=next;
    return this.displayState;
  }
  #noFace(timestamp) { this.history=[];this.smoothed=null;this.latest=null;this.candidate='NO_FACE';this.candidateFrames++;this.displayState='NO_FACE';return {status:'NO_FACE',faceDetected:false,faceBoundingBox:null,faceCenter:null,eyeCenter:null,distanceStatus:'UNKNOWN',alignmentStatus:{horizontal:'UNKNOWN',vertical:'UNKNOWN'},headPose:null,stable:false,ready:false,videoDimensions:null,primaryInstruction:instructionFor('NO_FACE'),timestamp}; }
  #error(message) { this.history=[];this.latest=null;this.candidate='ERROR';this.candidateFrames=1;this.displayState='ERROR';return {status:'ERROR',error:message,faceDetected:false,distanceStatus:'UNKNOWN',alignmentStatus:{horizontal:'UNKNOWN',vertical:'UNKNOWN'},headPose:null,stable:false,ready:false,primaryInstruction:message}; }
  getLatestMeasurement() { return this.latest; }
}

export function instructionFor(state) { return ({INITIALIZING:'Preparing face positioning…',NO_FACE:'Center your face in the guide.',TOO_FAR:'Move closer to the phone.',TOO_CLOSE:'Move farther from the phone.',MOVE_LEFT:'Move left.',MOVE_RIGHT:'Move right.',MOVE_UP:'Move up slightly.',MOVE_DOWN:'Move down slightly.',FACE_CAMERA:'Face the camera.',LOOK_STRAIGHT:'Look straight ahead.',STRAIGHTEN_HEAD:'Keep your head straight.',LOOK_AT_PHONE:'Look toward the phone.',HOLD_STILL:'Good position. Hold still.',READY:'Good position. Hold still.',ERROR:'Positioning could not verify alignment.'})[state]||'Positioning is unavailable.'; }

/** Map normalized source-video bounds into a CSS-sized, object-fit video container. */
export function mapVideoBounds(box,container,intrinsic,objectFit='contain',mirrored=false) {
  if(!box||!container?.width||!container?.height||!intrinsic?.width||!intrinsic?.height)return null;
  const sx=container.width/intrinsic.width,sy=container.height/intrinsic.height,scale=objectFit==='cover'?Math.max(sx,sy):Math.min(sx,sy);
  const renderedWidth=intrinsic.width*scale,renderedHeight=intrinsic.height*scale,offsetX=(container.width-renderedWidth)/2,offsetY=(container.height-renderedHeight)/2;
  const left=mirrored?1-box.right:box.left,right=mirrored?1-box.left:box.right;
  return {x:offsetX+left*renderedWidth,y:offsetY+box.top*renderedHeight,width:(right-left)*renderedWidth,height:(box.bottom-box.top)*renderedHeight,offsetX,offsetY,renderedWidth,renderedHeight};
}

export function drawPositionOverlay(canvas,position,container,intrinsic,{objectFit='contain',mirrored=false,eyeLevel=POSITIONING_CONFIG.eyeLevel}={}) {
  const rect=mapVideoBounds(position?.faceBoundingBox,container,intrinsic,objectFit,mirrored),ctx=canvas?.getContext?.('2d'); if(!ctx)return rect;
  const dpr=globalThis.devicePixelRatio||1,targetWidth=Math.round(container.width*dpr),targetHeight=Math.round(container.height*dpr);if(canvas.width!==targetWidth)canvas.width=targetWidth;if(canvas.height!==targetHeight)canvas.height=targetHeight;canvas.style.width=`${container.width}px`;canvas.style.height=`${container.height}px`;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,container.width,container.height);
  const color=position?.ready?'#51d88a':'#ffd166';ctx.strokeStyle=color;ctx.lineWidth=3;ctx.setLineDash([8,6]);ctx.beginPath();ctx.ellipse(container.width/2,container.height*eyeLevel,container.width*.18,container.height*.25,0,0,Math.PI*2);ctx.stroke();ctx.setLineDash([]);ctx.strokeStyle='#ffffffc9';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(container.width/2,0);ctx.lineTo(container.width/2,container.height);ctx.moveTo(0,container.height*eyeLevel);ctx.lineTo(container.width,container.height*eyeLevel);ctx.stroke();
  if(rect){ctx.strokeStyle=color;ctx.lineWidth=3;ctx.strokeRect(rect.x,rect.y,rect.width,rect.height);if(position.eyeCenter){const eyeX=(mirrored?1-position.eyeCenter.x:position.eyeCenter.x)*rect.renderedWidth+rect.offsetX,eyeY=position.eyeCenter.y*rect.renderedHeight+rect.offsetY;ctx.fillStyle=color;ctx.beginPath();ctx.arc(eyeX,eyeY,5,0,Math.PI*2);ctx.fill();}}
  return rect;
}

function meanPoint(points,indices){const selected=indices.map(i=>points[i]).filter(p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y));if(selected.length!==indices.length)return null;return {x:selected.reduce((a,p)=>a+p.x,0)/selected.length,y:selected.reduce((a,p)=>a+p.y,0)/selected.length};}
function irisCentering(points){const left=meanPoint(points,[468,469,470,471,472]),right=meanPoint(points,[473,474,475,476,477]);if(!left||!right)return null;const leftCorners=[points[33]?.x,points[133]?.x],rightCorners=[points[362]?.x,points[263]?.x];if([...leftCorners,...rightCorners].some(x=>!Number.isFinite(x)))return null;const leftWidth=Math.max(...leftCorners)-Math.min(...leftCorners),rightWidth=Math.max(...rightCorners)-Math.min(...rightCorners);if(leftWidth<.01||rightWidth<.01)return null;const leftPosition=(left.x-Math.min(...leftCorners))/leftWidth,rightPosition=(right.x-Math.min(...rightCorners))/rightWidth;return {horizontalOffset:((leftPosition+rightPosition)/2)-.5};}
function range(values,key){const a=values.map(v=>v[key]);return Math.max(...a)-Math.min(...a);}
function ema(previous,current,alpha){return previous+alpha*(current-previous);}
function clamp(value,min,max){return Math.min(max,Math.max(min,value));}
function degrees(radians){return radians*180/Math.PI;}
