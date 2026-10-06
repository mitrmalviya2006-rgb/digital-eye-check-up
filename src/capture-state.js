export const AUTOMATIC_CAPTURE_CONFIG = Object.freeze({
  stableDurationMs: 900,
  minimumDistinctQualitySamples: 2,
  maximumQualityAgeMs: 1200,
  maximumEyeResultAgeMs: 1200,
  maximumFutureTimestampMs: 100,
  retryDelayMs: 500,
  maxAttemptsPerCapture: 3,
  requiredCaptureCount: 1,
});

/** Pure prerequisite check shared by the automatic capture loop and tests. */
export function assessCaptureReadiness(snapshot, now = performance.now(), config = {}) {
  const settings = { ...AUTOMATIC_CAPTURE_CONFIG, ...config };
  const reasons = [];
  if (snapshot?.cameraReady !== true) reasons.push('CAMERA_NOT_READY');

  const positioning = snapshot?.positioning;
  if (!positioning || snapshot?.positioningFresh !== true || positioning.faceDetected !== true) reasons.push('POSITIONING_REQUIRED');
  else if (positioning.distanceStatus !== 'ACCEPTABLE') reasons.push('DISTANCE_NOT_ACCEPTABLE');
  else if (positioning.ready !== true || positioning.stable !== true) reasons.push('POSITION_UNSTABLE');

  const eyes = snapshot?.eyeResult;
  if (!eyes || eyes.bothEyesGeometryValid !== true) reasons.push('EYES_NOT_DETECTED');
  else {
    if (eyes.coordinateSpace !== 'normalized_camera_frame_top_left_unmirrored') reasons.push('EYE_COORDINATE_SPACE_UNVERIFIED');
    for (const [key, side, designation] of [['leftEye', 'left', 'OS'], ['rightEye', 'right', 'OD']]) {
      const eye = eyes[key];
      if (!eye?.detected || !eye.boundingBox || eye.validity?.geometryState !== 'VALID' || eye.iris?.detected !== true || eye.eye !== side || eye.designation !== designation) reasons.push(`${side.toUpperCase()}_EYE_INVALID`);
      if (eye?.eyelid?.state !== 'OPEN') reasons.push(`${side.toUpperCase()}_EYE_NOT_OPEN`);
    }
    if (eyes.trackingStable !== true || eyes.analysisStatus !== 'GEOMETRY_STABLE') reasons.push('EYE_TRACKING_UNSTABLE');
    if (!isFresh(eyes.timestamp, now, settings.maximumEyeResultAgeMs, settings.maximumFutureTimestampMs)) reasons.push('EYE_RESULT_STALE');
  }

  const quality = snapshot?.qualityResult;
  if (!quality || quality.valid !== true || quality.overallStatus !== 'GOOD' || quality.captureReady !== true) reasons.push('QUALITY_NOT_READY');
  if (quality && !isFresh(quality.timestamp, now, settings.maximumQualityAgeMs, settings.maximumFutureTimestampMs)) reasons.push('QUALITY_RESULT_STALE');
  if (quality?.blur?.state !== 'SHARP') reasons.push('BLUR_CHECK_NOT_PASSED');
  if (quality?.exposure?.state !== 'ACCEPTABLE' || quality?.lighting?.state !== 'ACCEPTABLE') reasons.push('EXPOSURE_CHECK_NOT_PASSED');
  if (quality?.glare?.state !== 'NO_EXCESSIVE_GLARE_DETECTED') reasons.push('GLARE_CHECK_NOT_PASSED');
  if (quality?.motion?.state !== 'STABLE' || quality?.positioning?.state !== 'ACCEPTABLE') reasons.push('QUALITY_STABILITY_NOT_PASSED');
  for (const key of ['leftEye', 'rightEye']) {
    if (quality?.[key]?.confidence?.state !== 'SUFFICIENT') reasons.push('EYE_CONFIDENCE_NOT_VERIFIED');
    if (quality?.[key]?.occlusion?.state !== 'CLEAR') reasons.push('EYE_VISIBILITY_NOT_VERIFIED');
  }

  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export class AutomaticCaptureStateMachine {
  constructor(config = {}) {
    this.config = { ...AUTOMATIC_CAPTURE_CONFIG, ...config };
    this.state = 'INITIALIZING';
    this.stableSince = null;
    this.lastQualityTimestamp = null;
    this.qualitySampleCount = 0;
    this.captureCount = 0;
    this.attempts = 0;
    this.retryAfter = 0;
    this.reasons = [];
    this.error = null;
  }

  update(snapshot, now = performance.now()) {
    if (['CAPTURING', 'CAPTURED', 'VALIDATING_CAPTURE', 'COMPLETE', 'ERROR'].includes(this.state)) return this.snapshot(now);
    const readiness = assessCaptureReadiness(snapshot, now, this.config);
    if (!readiness.eligible) {
      this.#resetStability();
      this.reasons = readiness.reasons;
      this.state = readiness.reasons.includes('CAMERA_NOT_READY') ? 'INITIALIZING'
        : readiness.reasons.some(reason => ['POSITIONING_REQUIRED', 'DISTANCE_NOT_ACCEPTABLE', 'EYES_NOT_DETECTED', 'LEFT_EYE_INVALID', 'RIGHT_EYE_INVALID', 'LEFT_EYE_NOT_OPEN', 'RIGHT_EYE_NOT_OPEN', 'EYE_COORDINATE_SPACE_UNVERIFIED'].includes(reason)) ? 'POSITIONING'
          : readiness.reasons.some(reason => ['POSITION_UNSTABLE', 'EYE_TRACKING_UNSTABLE', 'EYE_RESULT_STALE'].includes(reason)) ? 'WAITING_FOR_STABILITY' : 'CHECKING_QUALITY';
      return this.snapshot(now);
    }

    this.reasons = [];
    const qualityTimestamp = snapshot.qualityResult.timestamp;
    if (qualityTimestamp !== this.lastQualityTimestamp) {
      this.lastQualityTimestamp = qualityTimestamp;
      this.qualitySampleCount++;
    }
    if (this.stableSince === null) this.stableSince = now;
    const stableForMs = Math.max(0, now - this.stableSince);
    if (now < this.retryAfter) this.state = 'RETRY_REQUIRED';
    else if (stableForMs >= this.config.stableDurationMs && this.qualitySampleCount >= this.config.minimumDistinctQualitySamples) this.state = 'READY_TO_CAPTURE';
    else this.state = 'WAITING_FOR_STABILITY';
    return this.snapshot(now);
  }

  beginCapture(now = performance.now()) {
    if (this.state !== 'READY_TO_CAPTURE') return false;
    this.state = 'CAPTURING'; this.error = null; this.captureStartedAt = now;
    return true;
  }

  setValidating() {
    if (this.state !== 'CAPTURING') return false;
    this.state = 'VALIDATING_CAPTURE';
    return true;
  }

  captureValidated() {
    if (this.state !== 'VALIDATING_CAPTURE') return false;
    this.state = 'CAPTURED';
    return true;
  }

  captureSucceeded(now = performance.now()) {
    if (this.state !== 'CAPTURED') return false;
    this.captureCount++; this.attempts = 0; this.error = null;
    if (this.captureCount >= this.config.requiredCaptureCount) this.state = 'COMPLETE';
    else { this.state = 'WAITING_FOR_STABILITY'; this.retryAfter = now + this.config.retryDelayMs; this.#resetStability(); }
    return true;
  }

  captureFailed(code, now = performance.now()) {
    if (!['CAPTURING', 'VALIDATING_CAPTURE', 'CAPTURED'].includes(this.state)) return false;
    this.attempts++; this.error = code; this.#resetStability();
    if (this.attempts >= this.config.maxAttemptsPerCapture) this.state = 'ERROR';
    else { this.state = 'RETRY_REQUIRED'; this.retryAfter = now + this.config.retryDelayMs; }
    return true;
  }

  withdrawConsent() {
    this.state = 'INITIALIZING'; this.error = null; this.reasons = [];
    this.captureCount = 0; this.attempts = 0; this.retryAfter = 0;
    this.#resetStability();
    return true;
  }

  restart() {
    if (this.state !== 'ERROR') return false;
    this.state = 'INITIALIZING'; this.stableSince = null; this.lastQualityTimestamp = null;
    this.qualitySampleCount = 0; this.captureCount = 0; this.attempts = 0; this.retryAfter = 0; this.reasons = []; this.error = null;
    return true;
  }

  snapshot(now = performance.now()) {
    return { state: this.state, reasons: [...this.reasons], error: this.error, captureCount: this.captureCount, requiredCaptureCount: this.config.requiredCaptureCount, attempts: this.attempts, maxAttempts: this.config.maxAttemptsPerCapture, qualitySampleCount: this.qualitySampleCount, stableForMs: this.stableSince === null ? 0 : Math.max(0, now - this.stableSince) };
  }

  #resetStability() { this.stableSince = null; this.lastQualityTimestamp = null; this.qualitySampleCount = 0; }
}

function isFresh(timestamp, now, maxAge, maxFuture) {
  return Number.isFinite(timestamp) && now - timestamp <= maxAge && timestamp - now <= maxFuture;
}
