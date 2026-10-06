/**
 * Deterministic, local image-quality checks for the current camera frame.
 * Pixel thresholds are engineering defaults, not clinical cutoffs; see QUALITY.md.
 */
export const IMAGE_QUALITY_CONFIG = Object.freeze({
  minLongSide: 640,
  minShortSide: 360,
  minEyeWidthPx: 28,
  minEyeHeightPx: 12,
  edgeMargin: 0.02,
  minimumLaplacianVariance: 32,
  minimumConfidence: 0.65,
  minimumEyeMedian: 42,
  maximumEyeMedian: 222,
  severeShadowLuma: 14,
  severeShadowRatio: 0.28,
  severeHighlightLuma: 250,
  severeHighlightRatio: 0.12,
  glareComponentRatio: 0.055,
  irisGlarePixelRatio: 0.25,
  irisGlareComponentRatio: 0.20,
  unevenEyeMeanDifference: 48,
  maximumSampleMotion: 0.02,
});

const EYE_KEYS = ['leftEye', 'rightEye'];
const FEEDBACK = Object.freeze({
  FRAME_MISSING: 'The live image is unavailable. Keep the camera preview open and try again.',
  FRAME_STALE: 'The live image stopped updating. Restart the camera preview and try again.',
  INVALID_DIMENSIONS: 'The camera image is unavailable. Restart the preview and try again.',
  PIXEL_DATA_INVALID: 'The camera image could not be checked. Restart the preview and try again.',
  PIXEL_DATA_UNAVAILABLE: 'The camera image could not be checked. Try a supported browser and restart the preview.',
  INSUFFICIENT_RESOLUTION: 'Move closer to the phone or use a camera setting with more detail.',
  EYE_NOT_DETECTED: 'Keep your face centered and make sure both eyes are visible.',
  EYE_LANDMARKS_INCOMPLETE: 'Face the phone and uncover both eyes so their outlines can be seen.',
  EYE_TOO_SMALL: 'Move slightly closer to the phone.',
  EYE_OUTSIDE_FRAME: 'Keep both eyes fully inside the camera preview.',
  EYE_TOO_CLOSE_TO_EDGE: 'Move your face toward the center of the preview.',
  EYE_CLOSED: 'Please keep both eyes open.',
  EYE_OPENNESS_UNKNOWN: 'Keep both eyes open and face the phone directly.',
  LOW_SHARPNESS: 'Your eyes are not clear enough. Hold the phone steady and improve the light.',
  TOO_DARK: 'Image is too dark. Improve the lighting.',
  OVEREXPOSED: 'Image is too bright. Reduce direct light.',
  SEVERE_SHADOW: 'Light your face more evenly and avoid strong shadows.',
  UNEVEN_LIGHTING: 'Light both sides of your face evenly.',
  EXCESSIVE_GLARE: 'There is too much reflection. Adjust the phone or glasses angle.',
  MOTION_DETECTED: 'Hold your head and the phone steady.',
  BAD_POSITION: 'Follow the positioning guide and hold still.',
  FACE_CROPPED: 'Keep your whole face inside the camera preview.',
  DISTANCE_TOO_FAR: 'Move closer to the phone.',
  DISTANCE_TOO_CLOSE: 'Move slightly farther from the phone.',
  LOW_EYE_CONFIDENCE: 'Your eyes are not clear enough. Face the phone and try again.',
  EYE_CONFIDENCE_UNAVAILABLE: 'Eye confidence cannot be verified by this model; automatic capture is unavailable.',
  EYE_OCCLUDED: 'Uncover both eyes and remove anything obscuring them.',
  EYE_OCCLUSION_UNVERIFIED: 'The model cannot verify whether an eye is partly hidden; automatic capture is unavailable.',
  POSITIONING_UNAVAILABLE: 'Positioning could not be verified. Return to the positioning guide.',
  QUALITY_CONSENT_WITHDRAWN: 'Image-quality analysis is paused because consent was withdrawn.',
});

/**
 * Analyze one already-sampled RGBA frame and Component 4's latest eye result.
 * frame: { pixels: Uint8Array, width, height, sourceWidth, sourceHeight, timestamp }
 */
export function analyzeImageQuality(frame, {
  eyeResult,
  positioning,
  positioningFresh = true,
  previousEyeCenters = null,
  config = {},
} = {}) {
  const settings = { ...IMAGE_QUALITY_CONFIG, ...config };
  const timestamp = Number.isFinite(frame?.timestamp) ? frame.timestamp : Date.now();
  const invalid = validateFrame(frame);
  if (invalid) return resultShell(timestamp, 'RETAKE', [{ code: invalid, severity: 'RETAKE' }], { image: frameSummary(frame) });

  const sourceWidth = frame.sourceWidth ?? frame.width;
  const sourceHeight = frame.sourceHeight ?? frame.height;
  const longSide = Math.max(sourceWidth, sourceHeight);
  const shortSide = Math.min(sourceWidth, sourceHeight);
  const reasons = [];
  if (longSide < settings.minLongSide || shortSide < settings.minShortSide) addReason(reasons, 'INSUFFICIENT_RESOLUTION', 'RETAKE');

  const globalExposure = exposureStats(frame.pixels, frame.width, frame.height, 0, 0, frame.width, frame.height, settings);
  const eyes = {};
  for (const key of EYE_KEYS) {
    const eye = eyeResult?.[key];
    const quality = analyzeEye(frame, eye, key, settings);
    eyes[key] = quality;
    for (const reason of quality.reasons) addReason(reasons, reason.code, reason.severity, key);
  }

  const means = EYE_KEYS.map(key => eyes[key].exposure.meanLuminance).filter(Number.isFinite);
  const eyeMeanDifference = means.length === 2 ? Math.abs(means[0] - means[1]) : null;
  let lightingState = 'ACCEPTABLE';
  if (EYE_KEYS.some(key => eyes[key].exposure.shadowState === 'SEVERE_SHADOW')) lightingState = 'SEVERE_SHADOW';
  else if (EYE_KEYS.some(key => eyes[key].exposure.state === 'UNDEREXPOSED')) lightingState = 'UNDEREXPOSED';
  else if (EYE_KEYS.some(key => eyes[key].exposure.state === 'OVEREXPOSED')) lightingState = 'OVEREXPOSED';
  else if (eyeMeanDifference !== null && eyeMeanDifference > settings.unevenEyeMeanDifference) lightingState = 'UNEVEN';
  else if (means.length !== 2) lightingState = 'UNKNOWN';

  if (lightingState === 'UNEVEN') addReason(reasons, 'UNEVEN_LIGHTING', 'RETAKE');
  if (lightingState === 'SEVERE_SHADOW') addReason(reasons, 'SEVERE_SHADOW', 'RETAKE');
  if (lightingState === 'UNDEREXPOSED') addReason(reasons, 'TOO_DARK', 'RETAKE');
  if (lightingState === 'OVEREXPOSED') addReason(reasons, 'OVEREXPOSED', 'RETAKE');

  const position = analyzePosition(positioning, positioningFresh, eyeResult, settings);
  for (const reason of position.reasons) addReason(reasons, reason.code, reason.severity);

  const motion = analyzeMotion(positioning, positioningFresh, eyeResult, eyes, previousEyeCenters, settings);
  for (const reason of motion.reasons) addReason(reasons, reason.code, reason.severity);

  const aggregateBlur = EYE_KEYS.some(key => eyes[key].sharpness.state === 'BLURRED') ? 'BLUR_DETECTED'
    : EYE_KEYS.every(key => eyes[key].sharpness.state === 'SHARP') ? 'SHARP' : 'UNKNOWN';
  const overallStatus = reasons.some(reason => reason.severity === 'RETAKE') ? 'RETAKE'
    : reasons.some(reason => reason.severity === 'UNKNOWN') ? 'UNKNOWN' : 'GOOD';
  const messages = unique(reasons.map(reason => FEEDBACK[reason.code]).filter(Boolean));
  if (overallStatus === 'GOOD') messages.push('Image quality is good.');
  return {
    schemaVersion: '1.0.0', timestamp, valid: overallStatus === 'GOOD', overallStatus,
    technicalUsable: !reasons.some(reason => reason.severity === 'RETAKE'),
    captureReady: overallStatus === 'GOOD',
    image: { ...frameSummary(frame), resolution: longSide >= settings.minLongSide && shortSide >= settings.minShortSide ? 'ACCEPTABLE' : 'INSUFFICIENT' },
    leftEye: eyes.leftEye, rightEye: eyes.rightEye,
    blur: { state: aggregateBlur, method: 'per-eye 4-neighbour Laplacian variance', threshold: settings.minimumLaplacianVariance },
    exposure: { state: lightingState, wholeFrame: globalExposure, eyeMeanDifference, thresholds: { minimumMedian: settings.minimumEyeMedian, maximumMedian: settings.maximumEyeMedian } },
    lighting: { state: lightingState, eyeMeanDifference, threshold: settings.unevenEyeMeanDifference },
    glare: { state: EYE_KEYS.some(key => eyes[key].glare.state === 'EXCESSIVE') ? 'EXCESSIVE' : EYE_KEYS.every(key => eyes[key].glare.state === 'CHECKED') ? 'NO_EXCESSIVE_GLARE_DETECTED' : 'UNKNOWN', method: 'bright-pixel coverage and connected-component coverage within each eye box' },
    motion, positioning: position,
    eyeVisibility: { left: eyes.leftEye.visibility, right: eyes.rightEye.visibility },
    occlusion: { state: EYE_KEYS.every(key => eyes[key].occlusion.state === 'CLEAR') ? 'CLEAR' : EYE_KEYS.some(key => eyes[key].occlusion.state === 'OCCLUDED') ? 'OCCLUDED' : 'UNKNOWN' },
    detectionConfidence: { state: EYE_KEYS.every(key => eyes[key].confidence.state === 'SUFFICIENT') ? 'SUFFICIENT' : EYE_KEYS.some(key => eyes[key].confidence.state === 'LOW') ? 'LOW' : 'UNAVAILABLE' },
    reasons, feedback: messages,
  };
}

export function imageQualityFailure(code, timestamp = Date.now(), severity = 'UNKNOWN') {
  return resultShell(timestamp, severity === 'RETAKE' ? 'RETAKE' : 'UNKNOWN', [{ code, severity }]);
}

function analyzeEye(frame, eye, key, config) {
  const reasons = [];
  const box = eye?.detected === true ? eye.boundingBox : null;
  const hasBox = validBox(box);
  const detected = Boolean(eye?.detected && hasBox);
  const geometryComplete = eye?.validity?.geometryState === 'VALID' && eye?.iris?.detected === true;
  if (!detected) addReason(reasons, 'EYE_NOT_DETECTED', 'RETAKE');
  else if (!geometryComplete) addReason(reasons, 'EYE_LANDMARKS_INCOMPLETE', 'RETAKE');

  const eyeWidthPx = hasBox ? (box.right - box.left) * (frame.sourceWidth ?? frame.width) : null;
  const eyeHeightPx = hasBox ? (box.bottom - box.top) * (frame.sourceHeight ?? frame.height) : null;
  if (detected && (eyeWidthPx < config.minEyeWidthPx || eyeHeightPx < config.minEyeHeightPx)) addReason(reasons, 'EYE_TOO_SMALL', 'RETAKE');
  if (hasBox && (box.left < 0 || box.top < 0 || box.right > 1 || box.bottom > 1)) addReason(reasons, 'EYE_OUTSIDE_FRAME', 'RETAKE');
  else if (hasBox && (box.left < config.edgeMargin || box.top < config.edgeMargin || box.right > 1 - config.edgeMargin || box.bottom > 1 - config.edgeMargin)) addReason(reasons, 'EYE_TOO_CLOSE_TO_EDGE', 'RETAKE');

  const openness = eye?.eyelid?.state || 'UNAVAILABLE';
  if (openness === 'CLOSED' || openness === 'PARTIALLY_CLOSED') addReason(reasons, 'EYE_CLOSED', 'RETAKE');
  else if (openness !== 'OPEN') addReason(reasons, 'EYE_OPENNESS_UNKNOWN', 'UNKNOWN');

  const confidenceValue = eye?.confidence;
  let confidence = { state: 'UNAVAILABLE', value: null, threshold: config.minimumConfidence };
  if (Number.isFinite(confidenceValue)) {
    confidence = { state: confidenceValue >= config.minimumConfidence ? 'SUFFICIENT' : 'LOW', value: confidenceValue, threshold: config.minimumConfidence };
    if (confidence.state === 'LOW') addReason(reasons, 'LOW_EYE_CONFIDENCE', 'RETAKE');
  } else addReason(reasons, 'EYE_CONFIDENCE_UNAVAILABLE', 'UNKNOWN');

  const visibilityState = eye?.visibility?.state;
  let occlusion = { state: 'UNKNOWN', source: 'not provided by the current face-landmark model' };
  if (['VISIBLE', 'CLEAR'].includes(visibilityState)) occlusion = { state: 'CLEAR', source: 'Component 4 visibility result' };
  else if (visibilityState === 'OCCLUDED') {
    occlusion = { state: 'OCCLUDED', source: 'Component 4 visibility result' };
    addReason(reasons, 'EYE_OCCLUDED', 'RETAKE');
  } else addReason(reasons, 'EYE_OCCLUSION_UNVERIFIED', 'UNKNOWN');
  const visibility = !detected ? { state: 'NOT_DETECTED', geometryPresent: false, source: 'Component 4 eye geometry' }
    : visibilityState === 'OCCLUDED' ? { state: 'OCCLUDED', geometryPresent: geometryComplete, source: 'Component 4 visibility result' }
      : ['VISIBLE', 'CLEAR'].includes(visibilityState) ? { state: 'VISIBLE', geometryPresent: geometryComplete, source: 'Component 4 visibility result' }
        : { state: 'UNKNOWN', geometryPresent: geometryComplete, source: 'current model does not provide per-eye visibility' };

  const sampleBox = hasBox ? normalizedBoxToPixels(box, frame.width, frame.height) : null;
  const roiValid = Boolean(sampleBox && sampleBox.right - sampleBox.left >= 5 && sampleBox.bottom - sampleBox.top >= 5 && sampleBox.left >= 0 && sampleBox.top >= 0 && sampleBox.right <= frame.width && sampleBox.bottom <= frame.height);
  const stats = roiValid ? exposureStats(frame.pixels, frame.width, frame.height, sampleBox.left, sampleBox.top, sampleBox.right, sampleBox.bottom, config) : null;
  const sharpnessScore = roiValid ? laplacianVariance(frame.pixels, frame.width, sampleBox) : null;
  const sharpnessState = sharpnessScore === null ? 'UNKNOWN' : sharpnessScore < config.minimumLaplacianVariance ? 'BLURRED' : 'SHARP';
  if (sharpnessState === 'BLURRED') addReason(reasons, 'LOW_SHARPNESS', 'RETAKE');

  let exposureState = stats ? classifyExposure(stats, config) : 'UNKNOWN';
  if (exposureState === 'UNDEREXPOSED') addReason(reasons, 'TOO_DARK', 'RETAKE');
  else if (exposureState === 'OVEREXPOSED') addReason(reasons, 'OVEREXPOSED', 'RETAKE');
  else if (exposureState === 'UNKNOWN') addReason(reasons, 'PIXEL_DATA_UNAVAILABLE', 'UNKNOWN');
  const shadowState = stats && stats.shadowRatio >= config.severeShadowRatio ? 'SEVERE_SHADOW' : stats ? 'ACCEPTABLE' : 'UNKNOWN';
  if (shadowState === 'SEVERE_SHADOW') addReason(reasons, 'SEVERE_SHADOW', 'RETAKE');

  const irisBox = roiValid ? irisBounds(eye?.iris?.boundary, frame.width, frame.height) : null;
  const glare = roiValid ? glareStats(frame.pixels, frame.width, sampleBox, config, irisBox) : { state: 'UNKNOWN', brightPixelRatio: null, largestBrightComponentRatio: null, irisBrightPixelRatio: null, largestIrisBrightComponentRatio: null };
  if (glare.state === 'EXCESSIVE') addReason(reasons, 'EXCESSIVE_GLARE', 'RETAKE');

  return {
    eye: key === 'leftEye' ? 'left' : 'right', designation: eye?.designation ?? null,
    state: reasons.some(reason => reason.severity === 'RETAKE') ? 'RETAKE' : reasons.some(reason => reason.severity === 'UNKNOWN') ? 'UNKNOWN' : 'GOOD',
    detected, geometryComplete, boundingBox: hasBox ? { ...box } : null,
    eyeRegionPixels: eyeWidthPx === null ? null : { width: eyeWidthPx, height: eyeHeightPx }, openness,
    confidence, visibility, occlusion,
    sharpness: { state: sharpnessState, laplacianVariance: sharpnessScore, threshold: config.minimumLaplacianVariance },
    exposure: stats ? { state: exposureState, shadowState, meanLuminance: round(stats.mean), medianLuminance: stats.median, p10Luminance: stats.p10, p90Luminance: stats.p90, clippedShadowRatio: round(stats.shadowRatio), clippedHighlightRatio: round(stats.highlightRatio) } : { state: 'UNKNOWN', shadowState: 'UNKNOWN', meanLuminance: null, medianLuminance: null, p10Luminance: null, p90Luminance: null, clippedShadowRatio: null, clippedHighlightRatio: null },
    glare, reasons,
  };
}

function analyzePosition(positioning, fresh, eyeResult, config) {
  const reasons = [];
  let state = 'ACCEPTABLE';
  if (!positioning) { state = 'UNKNOWN'; addReason(reasons, 'POSITIONING_UNAVAILABLE', 'UNKNOWN'); }
  else {
    if (positioning.distanceStatus === 'TOO_FAR') addReason(reasons, 'DISTANCE_TOO_FAR', 'RETAKE');
    else if (positioning.distanceStatus === 'TOO_CLOSE') addReason(reasons, 'DISTANCE_TOO_CLOSE', 'RETAKE');
    else if (positioning.ready !== true || positioning.stable !== true || fresh !== true) addReason(reasons, 'BAD_POSITION', 'RETAKE');
    const box = positioning.faceBoundingBox;
    if (!validBox(box)) addReason(reasons, 'POSITIONING_UNAVAILABLE', 'UNKNOWN');
    else if (box.left <= config.edgeMargin / 2 || box.top <= config.edgeMargin / 2 || box.right >= 1 - config.edgeMargin / 2 || box.bottom >= 1 - config.edgeMargin / 2) addReason(reasons, 'FACE_CROPPED', 'RETAKE');
  }
  if (eyeResult?.bothEyesGeometryValid !== true) addReason(reasons, 'EYE_LANDMARKS_INCOMPLETE', 'RETAKE');
  if (reasons.some(reason => reason.severity === 'RETAKE')) state = 'RETAKE';
  else if (reasons.some(reason => reason.severity === 'UNKNOWN')) state = 'UNKNOWN';
  return { state, positioningReady: positioning?.ready === true && fresh === true, distanceStatus: positioning?.distanceStatus ?? 'UNKNOWN', faceBoundingBox: positioning?.faceBoundingBox ?? null, reasons };
}

function analyzeMotion(positioning, fresh, eyeResult, eyes, previousEyeCenters, config) {
  const reasons = [];
  const stable = positioning?.stable === true && positioning?.ready === true && fresh === true && eyeResult?.trackingStable === true;
  let eyeMovement = null;
  if (previousEyeCenters && EYE_KEYS.every(key => previousEyeCenters[key] && eyes[key].boundingBox)) {
    const centers = Object.fromEntries(EYE_KEYS.map(key => [key, boxCenter(eyes[key].boundingBox)]));
    const width = eyeResult.frameWidth || 1, height = eyeResult.frameHeight || 1;
    const diagonal = Math.hypot(width, height);
    eyeMovement = Math.max(...EYE_KEYS.map(key => Math.hypot((centers[key].x - previousEyeCenters[key].x) * width, (centers[key].y - previousEyeCenters[key].y) * height)));
    if (eyeMovement / diagonal > config.maximumSampleMotion) addReason(reasons, 'MOTION_DETECTED', 'RETAKE');
  }
  if (!stable && !reasons.some(reason => reason.code === 'MOTION_DETECTED')) addReason(reasons, 'BAD_POSITION', 'RETAKE');
  const state = reasons.length ? 'UNSTABLE' : 'STABLE';
  return { state, stable, source: 'Component 3 positioning and Component 4 eye tracking stability', eyeMovementPixels: eyeMovement, reasons };
}

function validateFrame(frame) {
  if (!frame || !frame.pixels) return 'FRAME_MISSING';
  const { width, height, pixels } = frame;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || !Number.isInteger(frame.sourceWidth ?? width) || !Number.isInteger(frame.sourceHeight ?? height) || (frame.sourceWidth ?? width) <= 0 || (frame.sourceHeight ?? height) <= 0) return 'INVALID_DIMENSIONS';
  if (!(pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray) || pixels.length !== width * height * 4) return 'PIXEL_DATA_INVALID';
  return null;
}

function frameSummary(frame) {
  return { width: frame?.sourceWidth ?? frame?.width ?? null, height: frame?.sourceHeight ?? frame?.height ?? null, sampledWidth: frame?.width ?? null, sampledHeight: frame?.height ?? null, timestamp: frame?.timestamp ?? null };
}
function resultShell(timestamp, overallStatus, reasons, details = {}) {
  const unknownEye = eye => ({ eye, designation: null, state: 'UNKNOWN', detected: false, geometryComplete: false, boundingBox: null, eyeRegionPixels: null, openness: 'UNKNOWN', confidence: { state: 'UNKNOWN', value: null }, visibility: { state: 'UNKNOWN', geometryPresent: false }, occlusion: { state: 'UNKNOWN' }, sharpness: { state: 'UNKNOWN', laplacianVariance: null }, exposure: { state: 'UNKNOWN', meanLuminance: null, medianLuminance: null }, glare: { state: 'UNKNOWN', brightPixelRatio: null }, reasons: [] });
  return {
    schemaVersion: '1.0.0', timestamp, valid: false, overallStatus, technicalUsable: false, captureReady: false,
    ...details,
    image: { width: null, height: null, sampledWidth: null, sampledHeight: null, timestamp: null, resolution: 'UNKNOWN', ...details.image },
    leftEye: unknownEye('left'), rightEye: unknownEye('right'), blur: { state: 'UNKNOWN' },
    exposure: { state: 'UNKNOWN', wholeFrame: null }, lighting: { state: 'UNKNOWN' }, glare: { state: 'UNKNOWN' },
    motion: { state: 'UNKNOWN' }, positioning: { state: 'UNKNOWN' },
    eyeVisibility: { left: { state: 'UNKNOWN' }, right: { state: 'UNKNOWN' } }, occlusion: { state: 'UNKNOWN' },
    detectionConfidence: { state: 'UNKNOWN' }, reasons,
    feedback: unique(reasons.map(reason => FEEDBACK[reason.code]).filter(Boolean)),
  };
}
function addReason(reasons, code, severity, eye = null) { if (!reasons.some(reason => reason.code === code && reason.eye === eye)) reasons.push({ code, severity, ...(eye ? { eye } : {}) }); }
function validBox(box) { return box && ['left', 'top', 'right', 'bottom'].every(key => Number.isFinite(box[key])) && box.right > box.left && box.bottom > box.top; }
function normalizedBoxToPixels(box, width, height) { return { left: Math.max(0, Math.floor(box.left * width)), top: Math.max(0, Math.floor(box.top * height)), right: Math.min(width, Math.ceil(box.right * width)), bottom: Math.min(height, Math.ceil(box.bottom * height)) }; }
function boxCenter(box) { return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 }; }

function exposureStats(pixels, width, height, left, top, right, bottom, config) {
  const histogram = new Uint32Array(256);
  let sum = 0, count = 0, shadows = 0, highlights = 0;
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const offset = (y * width + x) * 4;
    const value = luminance(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
    histogram[value]++; sum += value; count++;
    if (value <= config.severeShadowLuma) shadows++;
    if (value >= config.severeHighlightLuma) highlights++;
  }
  return { mean: count ? sum / count : 0, median: percentile(histogram, count, 0.5), p10: percentile(histogram, count, 0.1), p90: percentile(histogram, count, 0.9), shadowRatio: count ? shadows / count : 0, highlightRatio: count ? highlights / count : 0, count };
}
function classifyExposure(stats, config) {
  if (!stats.count) return 'UNKNOWN';
  if (stats.median < config.minimumEyeMedian) return 'UNDEREXPOSED';
  if (stats.median > config.maximumEyeMedian || stats.highlightRatio >= config.severeHighlightRatio) return 'OVEREXPOSED';
  return 'ACCEPTABLE';
}
function percentile(histogram, count, fraction) {
  if (!count) return null;
  const target = Math.max(1, Math.ceil(count * fraction));
  let cumulative = 0;
  for (let value = 0; value < histogram.length; value++) { cumulative += histogram[value]; if (cumulative >= target) return value; }
  return 255;
}
function luminance(red, green, blue) { return Math.max(0, Math.min(255, Math.round(0.2126 * red + 0.7152 * green + 0.0722 * blue))); }

function laplacianVariance(pixels, stride, box) {
  let count = 0, sum = 0, sumSquares = 0;
  for (let y = box.top + 1; y < box.bottom - 1; y++) for (let x = box.left + 1; x < box.right - 1; x++) {
    const center = lumaAt(pixels, (y * stride + x) * 4);
    const lap = lumaAt(pixels, ((y - 1) * stride + x) * 4) + lumaAt(pixels, ((y + 1) * stride + x) * 4) + lumaAt(pixels, (y * stride + x - 1) * 4) + lumaAt(pixels, (y * stride + x + 1) * 4) - 4 * center;
    count++; sum += lap; sumSquares += lap * lap;
  }
  return count ? Math.max(0, sumSquares / count - (sum / count) ** 2) : null;
}
function lumaAt(pixels, offset) { return luminance(pixels[offset], pixels[offset + 1], pixels[offset + 2]); }

function glareStats(pixels, stride, box, config, irisBox = null) {
  const eyeHighlights = connectedHighlights(pixels, stride, box, config);
  const irisHighlights = irisBox ? connectedHighlights(pixels, stride, irisBox, config) : null;
  const excessiveEye = eyeHighlights.brightPixelRatio >= config.severeHighlightRatio || (eyeHighlights.largestBrightComponentPixels >= 6 && eyeHighlights.largestBrightComponentRatio >= config.glareComponentRatio);
  const excessiveIris = irisHighlights && (irisHighlights.brightPixelRatio >= config.irisGlarePixelRatio || (irisHighlights.largestBrightComponentPixels >= 6 && irisHighlights.largestBrightComponentRatio >= config.irisGlareComponentRatio));
  return {
    state: excessiveEye || excessiveIris ? 'EXCESSIVE' : 'CHECKED',
    brightPixelRatio: round(eyeHighlights.brightPixelRatio), largestBrightComponentRatio: round(eyeHighlights.largestBrightComponentRatio),
    irisBrightPixelRatio: irisHighlights ? round(irisHighlights.brightPixelRatio) : null,
    largestIrisBrightComponentRatio: irisHighlights ? round(irisHighlights.largestBrightComponentRatio) : null,
    method: 'clipped-luminance connected components in eye and, when available, iris bounds; small isolated highlights are not rejected',
  };
}

function connectedHighlights(pixels, stride, box, config) {
  const width = box.right - box.left, height = box.bottom - box.top, area = width * height;
  if (!area) return { brightPixelRatio: 0, largestBrightComponentRatio: 0, largestBrightComponentPixels: 0 };
  const mask = new Uint8Array(area);
  let brightCount = 0, largest = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = ((box.top + y) * stride + box.left + x) * 4;
    if (lumaAt(pixels, offset) >= config.severeHighlightLuma) { mask[y * width + x] = 1; brightCount++; }
  }
  const queue = new Int32Array(area);
  for (let start = 0; start < area; start++) {
    if (!mask[start]) continue;
    mask[start] = 0; let read = 0, write = 0; queue[write++] = start;
    while (read < write) {
      const index = queue[read++], x = index % width, y = Math.floor(index / width);
      for (const neighbor of [x > 0 ? index - 1 : -1, x + 1 < width ? index + 1 : -1, y > 0 ? index - width : -1, y + 1 < height ? index + width : -1]) {
        if (neighbor >= 0 && mask[neighbor]) { mask[neighbor] = 0; queue[write++] = neighbor; }
      }
    }
    largest = Math.max(largest, write);
  }
  const brightRatio = brightCount / area, componentRatio = largest / area;
  return { brightPixelRatio: brightRatio, largestBrightComponentRatio: componentRatio, largestBrightComponentPixels: largest };
}

function irisBounds(boundary, width, height) {
  if (!Array.isArray(boundary) || boundary.length < 4 || boundary.some(point => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))) return null;
  const left = Math.max(0, Math.floor(Math.min(...boundary.map(point => point.x)) * width));
  const top = Math.max(0, Math.floor(Math.min(...boundary.map(point => point.y)) * height));
  const right = Math.min(width, Math.ceil(Math.max(...boundary.map(point => point.x)) * width));
  const bottom = Math.min(height, Math.ceil(Math.max(...boundary.map(point => point.y)) * height));
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

function round(value) { return Number.isFinite(value) ? Math.round(value * 10000) / 10000 : null; }
function unique(values) { return [...new Set(values)]; }
