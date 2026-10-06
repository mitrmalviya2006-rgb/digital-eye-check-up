import { POSITIONING_CONFIG } from './positioning-config.js';
import { localizeEyes } from './eye-localization.js';

const EYES = ['leftEye', 'rightEye'];
const OMIT_SMOOTHING_KEYS = new Set(['index', 'timestamp', 'lastSeenAt', 'missedFrames', 'frameWidth', 'frameHeight', 'closedMax', 'openMin']);

/** Smooths current eye geometry without publishing stale coordinates as live detections. */
export class EyeTracker {
  constructor(config = {}) {
    this.config = { ...POSITIONING_CONFIG.eyeTracking, ...config };
    this.latest = null;
    this.smoothed = { leftEye: null, rightEye: null };
    this.lastSeenAt = { leftEye: null, rightEye: null };
    this.missedFrames = { leftEye: 0, rightEye: 0 };
    this.history = [];
  }

  update(detection, { positioningReady = false, timestamp } = {}) {
    const raw = localizeEyes(detection, { positioningReady, timestamp, config: this.config });
    if (!positioningReady) {
      this.reset();
      this.latest = raw;
      return raw;
    }

    const at = Number.isFinite(timestamp) ? timestamp : raw.timestamp;
    const currentValid = {};
    for (const key of EYES) {
      const current = raw[key];
      const valid = current.validity.geometryState === 'VALID';
      currentValid[key] = valid;
      if (valid) {
        this.missedFrames[key] = 0;
        this.lastSeenAt[key] = at;
        this.smoothed[key] = this.smoothed[key] ? smoothValue(current, this.smoothed[key], this.config.smoothingAlpha) : current;
        refreshPixelCoordinates(this.smoothed[key], raw.frameWidth, raw.frameHeight);
        raw[key] = this.smoothed[key];
        raw[key].tracking = { state: 'TRACKING', missedFrames: 0, lastSeenAt: at };
      } else {
        this.missedFrames[key]++;
        const elapsed = this.lastSeenAt[key] === null || at === null ? Infinity : at - this.lastSeenAt[key];
        if (this.missedFrames[key] > this.config.temporaryLossFrames || elapsed > this.config.resetAfterLossMs) {
          this.smoothed[key] = null;
          this.history = [];
        }
        current.tracking = { state: this.missedFrames[key] <= this.config.temporaryLossFrames ? 'TEMPORARY_LOSS' : current.validity.state, missedFrames: this.missedFrames[key], lastSeenAt: this.lastSeenAt[key] };
      }
    }

    const bothEyesGeometryValid = currentValid.leftEye && currentValid.rightEye;
    if (bothEyesGeometryValid) {
      const left = raw.leftEye, right = raw.rightEye;
      this.history.push({ timestamp: at, left: eyeStabilitySample(left), right: eyeStabilitySample(right) });
      if (this.history.length > this.config.trackingWindow) this.history.shift();
    } else if (Math.max(...Object.values(this.missedFrames)) > this.config.temporaryLossFrames) {
      this.history = [];
    }

    const temporarilyLost = Math.max(...Object.values(this.missedFrames)) <= this.config.temporaryLossFrames && Math.max(...Object.values(this.missedFrames)) > 0;
    const trackingStable = this.#isStable() && (!temporarilyLost || Math.max(...Object.values(this.missedFrames)) <= this.config.temporaryLossFrames);
    const analysisStatus = bothEyesGeometryValid ? (trackingStable ? 'GEOMETRY_STABLE' : 'TRACKING') : raw.analysisStatus;
    for (const key of EYES) {
      if (currentValid[key]) raw[key].tracking = { state: trackingStable ? 'STABLE' : 'TRACKING', missedFrames: 0, lastSeenAt: this.lastSeenAt[key] };
    }
    raw.analysisStatus = analysisStatus;
    raw.bothEyesDetected = raw.leftEye.detected && raw.rightEye.detected;
    raw.bothEyesGeometryValid = bothEyesGeometryValid;
    raw.bothEyesValid = false;
    raw.trackingStable = trackingStable;
    this.latest = raw;
    return raw;
  }

  #isStable() {
    if (this.history.length < this.config.trackingWindow) return false;
    const first = this.history[0], last = this.history.at(-1);
    if (!Number.isFinite(first.timestamp) || !Number.isFinite(last.timestamp) || last.timestamp - first.timestamp < this.config.stableDurationMs) return false;
    for (const eyeKey of ['left', 'right']) {
      const centersX = this.history.map(sample => sample[eyeKey].x);
      const centersY = this.history.map(sample => sample[eyeKey].y);
      const widths = this.history.map(sample => sample[eyeKey].width);
      const heights = this.history.map(sample => sample[eyeKey].height);
      if (range(centersX) > this.config.stableCenterRange || range(centersY) > this.config.stableCenterRange || range(widths) > this.config.stableScaleRange || range(heights) > this.config.stableScaleRange) return false;
    }
    return true;
  }

  getLatest() { return this.latest; }

  reset() {
    this.latest = null;
    this.smoothed = { leftEye: null, rightEye: null };
    this.lastSeenAt = { leftEye: null, rightEye: null };
    this.missedFrames = { leftEye: 0, rightEye: 0 };
    this.history = [];
  }
}

function eyeStabilitySample(eye) {
  return { x: eye.center.x, y: eye.center.y, width: eye.boundingBox.width, height: eye.boundingBox.height };
}
function range(values) { return Math.max(...values) - Math.min(...values); }
function smoothValue(current, previous, alpha) {
  if (typeof current === 'number' && typeof previous === 'number') return previous + alpha * (current - previous);
  if (Array.isArray(current)) {
    if (current.every(item => item && typeof item === 'object' && Number.isInteger(item.index))) {
      const previousByIndex = new Map(previous.filter(item => item && Number.isInteger(item.index)).map(item => [item.index, item]));
      return current.map(item => previousByIndex.has(item.index) ? smoothValue(item, previousByIndex.get(item.index), alpha) : item);
    }
    return current.map((item, index) => previous[index] === undefined ? item : smoothValue(item, previous[index], alpha));
  }
  if (current && previous && typeof current === 'object' && typeof previous === 'object') {
    if (Number.isInteger(current.index) && Number.isInteger(previous.index) && current.index !== previous.index) return current;
    return Object.fromEntries(Object.entries(current).map(([key, value]) => [key, OMIT_SMOOTHING_KEYS.has(key) || previous[key] === undefined ? value : smoothValue(value, previous[key], alpha)]));
  }
  return current;
}
function refreshPixelCoordinates(value, width, height) {
  if (!value || typeof value !== 'object') return;
  if (value.pixel && Number.isFinite(value.x) && Number.isFinite(value.y)) value.pixel = { x: value.x * width, y: value.y * height };
  if (value.pixel && ['left', 'top', 'right', 'bottom'].every(key => Number.isFinite(value[key]))) {
    value.pixel = { left: value.left * width, top: value.top * height, right: value.right * width, bottom: value.bottom * height, width: (value.right - value.left) * width, height: (value.bottom - value.top) * height };
  }
  if (Array.isArray(value)) for (const item of value) refreshPixelCoordinates(item, width, height);
  else for (const child of Object.values(value)) if (child && typeof child === 'object') refreshPixelCoordinates(child, width, height);
}
