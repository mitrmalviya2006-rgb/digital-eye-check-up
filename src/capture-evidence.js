export const CAPTURE_EVIDENCE_SCHEMA_VERSION = '1.0.0';

const EYES = Object.freeze([
  Object.freeze({ key: 'rightEye', designation: 'OD', eye: 'right' }),
  Object.freeze({ key: 'leftEye', designation: 'OS', eye: 'left' }),
]);

/** Copy only small, non-image quality and stability fields from a validated C6 capture. */
export function summarizeCaptureEvidence(capture) {
  return {
    schemaVersion: CAPTURE_EVIDENCE_SCHEMA_VERSION,
    sourceCaptureId: capture?.captureId ?? null,
    captureIndex: positiveIntegerOrNull(capture?.captureIndex),
    requiredCaptureCount: positiveIntegerOrNull(capture?.requiredCaptureCount),
    stability: {
      positionStable: capture?.stability?.positionStable === true,
      eyeTrackingStable: capture?.stability?.eyeTrackingStable === true,
      stableForMs: finiteOrNull(capture?.stability?.stableForMs),
      qualitySamples: positiveIntegerOrNull(capture?.stability?.qualitySamples),
    },
    positioning: {
      status: stringOr(capture?.positioningState?.status, 'UNKNOWN'),
      ready: capture?.positioningState?.ready === true,
      stable: capture?.positioningState?.stable === true,
      distanceStatus: stringOr(capture?.positioningState?.distanceStatus, 'UNKNOWN'),
    },
    capturedQuality: summarizeQuality(capture?.qualityResult),
    liveQuality: summarizeQuality(capture?.liveQualityResult),
  };
}

export function isCaptureEvidence(value, sourceCaptureId) {
  return isPlainRecord(value)
    && value.schemaVersion === CAPTURE_EVIDENCE_SCHEMA_VERSION
    && value.sourceCaptureId === sourceCaptureId
    && (value.captureIndex === null || positiveInteger(value.captureIndex))
    && (value.requiredCaptureCount === null || positiveInteger(value.requiredCaptureCount))
    && isPlainRecord(value.stability)
    && typeof value.stability.positionStable === 'boolean'
    && typeof value.stability.eyeTrackingStable === 'boolean'
    && (value.stability.stableForMs === null || Number.isFinite(value.stability.stableForMs))
    && (value.stability.qualitySamples === null || positiveInteger(value.stability.qualitySamples))
    && isPlainRecord(value.positioning)
    && isQualitySummary(value.capturedQuality)
    && isQualitySummary(value.liveQuality)
    && isJsonFinitePlain(value)
    && !containsImagePayload(value);
}

function summarizeQuality(quality) {
  if (!isPlainRecord(quality)) return null;
  return {
    schemaVersion: stringOr(quality.schemaVersion, null),
    valid: quality.valid === true,
    overallStatus: stringOr(quality.overallStatus, 'UNKNOWN'),
    captureReady: quality.captureReady === true,
    blurState: stringOr(quality.blur?.state, 'UNKNOWN'),
    exposureState: stringOr(quality.exposure?.state, 'UNKNOWN'),
    lightingState: stringOr(quality.lighting?.state, 'UNKNOWN'),
    glareState: stringOr(quality.glare?.state, 'UNKNOWN'),
    motion: {
      state: stringOr(quality.motion?.state, 'UNKNOWN'),
      stable: quality.motion?.stable === true,
      eyeMovementPixels: finiteOrNull(quality.motion?.eyeMovementPixels),
    },
    positioning: {
      state: stringOr(quality.positioning?.state, 'UNKNOWN'),
      positioningReady: quality.positioning?.positioningReady === true,
      distanceStatus: stringOr(quality.positioning?.distanceStatus, 'UNKNOWN'),
    },
    eyes: Object.fromEntries(EYES.map(expected => [expected.designation, summarizeQualityEye(quality[expected.key], expected)])),
    reasons: summarizeReasons(quality.reasons),
  };
}

function summarizeQualityEye(eye, expected) {
  if (!isPlainRecord(eye)) return null;
  return {
    eye: typeof eye.eye === 'string' ? eye.eye : null,
    designation: typeof eye.designation === 'string' ? eye.designation : null,
    state: stringOr(eye.state, 'UNKNOWN'),
    detected: eye.detected === true,
    geometryComplete: eye.geometryComplete === true,
    openness: stringOr(eye.openness, 'UNKNOWN'),
    confidence: {
      state: stringOr(eye.confidence?.state, 'UNKNOWN'),
      value: finiteOrNull(eye.confidence?.value),
      threshold: finiteOrNull(eye.confidence?.threshold),
    },
    visibility: {
      state: stringOr(eye.visibility?.state, 'UNKNOWN'),
      geometryPresent: eye.visibility?.geometryPresent === true,
    },
    occlusionState: stringOr(eye.occlusion?.state, 'UNKNOWN'),
    sharpness: {
      state: stringOr(eye.sharpness?.state, 'UNKNOWN'),
      value: finiteOrNull(eye.sharpness?.laplacianVariance),
      threshold: finiteOrNull(eye.sharpness?.threshold),
    },
    exposureState: stringOr(eye.exposure?.state, 'UNKNOWN'),
    glareState: stringOr(eye.glare?.state, 'UNKNOWN'),
    reasons: summarizeReasons(eye.reasons),
  };
}

function summarizeReasons(reasons) {
  if (!Array.isArray(reasons)) return [];
  return reasons.filter(isPlainRecord)
    .filter(reason => typeof reason.code === 'string' && typeof reason.severity === 'string')
    .map(reason => ({ code: reason.code, severity: reason.severity, ...(typeof reason.eye === 'string' ? { eye: reason.eye } : {}) }));
}

function isQualitySummary(value) {
  return value === null || isPlainRecord(value)
    && typeof value.valid === 'boolean'
    && typeof value.overallStatus === 'string'
    && isPlainRecord(value.eyes)
    && ['OD', 'OS'].every(designation => value.eyes[designation] === null || isPlainRecord(value.eyes[designation]))
    && Array.isArray(value.reasons);
}

function containsImagePayload(value) {
  if (Array.isArray(value)) return value.some(containsImagePayload);
  if (!isPlainRecord(value)) return false;
  return Object.entries(value).some(([key, item]) => ['image', 'pixels', 'blob', 'rawFrame', 'imagedata', 'featurevector'].includes(key.toLowerCase())
    || containsImagePayload(item));
}

function isJsonFinitePlain(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every(item => isJsonFinitePlain(item, ancestors))
    : Object.values(value).every(item => isJsonFinitePlain(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function isPlainRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function positiveInteger(value) { return Number.isSafeInteger(value) && value > 0; }
function positiveIntegerOrNull(value) { return positiveInteger(value) ? value : null; }
function finiteOrNull(value) { return Number.isFinite(value) ? value : null; }
function stringOr(value, fallback) { return typeof value === 'string' ? value : fallback; }
