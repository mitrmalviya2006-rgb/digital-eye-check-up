export const CAPTURE_SCHEMA_VERSION = '1.0.0';

/** Stable Component 7 handoff shape; image pixels remain an in-memory Blob. */
export function buildCaptureRecord({
  image,
  width,
  height,
  timestamp,
  frameTimestamp,
  eyeResult,
  positioningState,
  qualityResult,
  liveQualityResult,
  stability,
  captureIndex = 1,
  requiredCaptureCount = 1,
  captureId,
}) {
  return {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    valid: true,
    validationStatus: 'VALIDATED',
    validation: { component: '6', valid: true },
    captureId,
    image,
    mimeType: image?.type || null,
    width,
    height,
    timestamp,
    frameTimestamp,
    leftEyeDetection: captureEyeMetadata(eyeResult?.leftEye),
    rightEyeDetection: captureEyeMetadata(eyeResult?.rightEye),
    positioningState,
    qualityResult,
    liveQualityResult,
    stability,
    captureIndex,
    requiredCaptureCount,
  };
}

/** Preserve Component 4's anatomical identity and unmirrored coordinates verbatim. */
export function captureEyeMetadata(eye) {
  if (!eye) return null;
  const landmarkPoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y) ? { x: point.x, y: point.y } : null;
  return {
    eye: eye.eye, designation: eye.designation, detected: eye.detected,
    boundingBox: eye.boundingBox ? { ...eye.boundingBox } : null,
    center: eye.center ? { x: eye.center.x, y: eye.center.y } : null,
    coordinateSpace: eye.boundingBox?.coordinateSpace || 'normalized_camera_frame_top_left_unmirrored',
    eyeCorners: {
      nasal: landmarkPoint(eye.landmarks?.eyeCorners?.nasal),
      temporal: landmarkPoint(eye.landmarks?.eyeCorners?.temporal),
    },
    orientationDegrees: Number.isFinite(eye.orientation?.angleDegrees) ? eye.orientation.angleDegrees : null,
    iris: {
      detected: eye.iris?.detected === true,
      center: landmarkPoint(eye.iris?.center),
      boundingBox: eye.iris?.boundingBox ? { ...eye.iris.boundingBox } : null,
      boundary: Array.isArray(eye.iris?.boundary) ? eye.iris.boundary.map(landmarkPoint).filter(Boolean) : [],
    },
    openness: eye.eyelid?.state ?? 'UNKNOWN',
    opennessRatio: Number.isFinite(eye.eyelid?.opennessRatio) ? eye.eyelid.opennessRatio : null,
    irisDetected: eye.iris?.detected === true,
    confidence: eye.confidence ?? null, confidenceStatus: eye.confidenceStatus ?? 'UNAVAILABLE',
  };
}
