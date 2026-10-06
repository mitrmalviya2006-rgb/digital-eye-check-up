import { PREPROCESSING_VERSION } from './image-preprocessing.js';
import { isCaptureEvidence } from './capture-evidence.js';

export const FEATURE_EXTRACTION_VERSION = '1.0.0';
export const FEATURE_SCHEMA_VERSION = '1.0.0';

/** Fixed schema order; no runtime object/property iteration controls model order. */
export const FEATURE_DEFINITIONS = Object.freeze([
  Object.freeze({ name: 'eyeWidthFraction', unit: 'source-frame-width-fraction', description: 'Component 4 eye bounding-box width divided by source frame width.' }),
  Object.freeze({ name: 'eyeHeightFraction', unit: 'source-frame-height-fraction', description: 'Component 4 eye bounding-box height divided by source frame height.' }),
  Object.freeze({ name: 'eyeAspectRatio', unit: 'ratio', description: 'Eye bounding-box width in source pixels divided by its height in source pixels.' }),
  Object.freeze({ name: 'eyeCornerDistanceFractionOfFrameDiagonal', unit: 'source-frame-diagonal-fraction', description: 'Distance between Component 4 nasal and temporal eye-corner landmarks divided by source-frame diagonal.' }),
  Object.freeze({ name: 'eyeOpennessRatio', unit: 'ratio', description: 'Component 4 mean eyelid gap divided by eye-corner distance.' }),
  Object.freeze({ name: 'eyeOrientationDegrees', unit: 'degrees', description: 'Component 4 eye-corner-line orientation in the unmirrored camera frame.' }),
  Object.freeze({ name: 'irisWidthFraction', unit: 'source-frame-width-fraction', description: 'Component 4 iris-boundary bounding-box width divided by source frame width.' }),
  Object.freeze({ name: 'irisHeightFraction', unit: 'source-frame-height-fraction', description: 'Component 4 iris-boundary bounding-box height divided by source frame height.' }),
  Object.freeze({ name: 'irisAspectRatio', unit: 'ratio', description: 'Iris-boundary bounding-box width in source pixels divided by its height in source pixels.' }),
  Object.freeze({ name: 'irisToEyeWidthRatio', unit: 'ratio', description: 'Iris-boundary bounding-box width divided by eye bounding-box width.' }),
  Object.freeze({ name: 'irisToEyeHeightRatio', unit: 'ratio', description: 'Iris-boundary bounding-box height divided by eye bounding-box height.' }),
  Object.freeze({ name: 'irisCenterOffsetXWithinEye', unit: 'eye-width-fraction', description: 'Estimated iris center horizontal offset from eye-box center divided by eye-box width.' }),
  Object.freeze({ name: 'irisCenterOffsetYWithinEye', unit: 'eye-height-fraction', description: 'Estimated iris center vertical offset from eye-box center divided by eye-box height.' }),
  Object.freeze({ name: 'irisRegionMeanEncodedLuma', unit: 'encoded-RGB-luma-0-to-255', description: 'Mean Rec. 709 weighted encoded-RGB intensity inside the transformed model iris-boundary polygon.' }),
  Object.freeze({ name: 'irisRegionStdDevEncodedLuma', unit: 'encoded-RGB-luma-0-to-255', description: 'Population standard deviation of the same iris-boundary-region encoded-RGB intensity samples.' }),
]);

export const FEATURE_ORDER = Object.freeze(FEATURE_DEFINITIONS.map(definition => definition.name));
const DEFINITION_BY_NAME = new Map(FEATURE_DEFINITIONS.map(definition => [definition.name, definition]));
const EYE_PAIRS = Object.freeze([
  Object.freeze({ key: 'rightEye', eye: 'right', designation: 'OD' }),
  Object.freeze({ key: 'leftEye', eye: 'left', designation: 'OS' }),
]);

export class FeatureExtractionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FeatureExtractionError';
    this.code = code;
    this.details = details;
  }
}

export function validatePreprocessedBatch(batch) {
  if (!batch || batch.valid !== true || batch.preprocessingVersion !== PREPROCESSING_VERSION || !Array.isArray(batch.captures) || batch.captures.length === 0) {
    throw new FeatureExtractionError('PREPROCESSING_BATCH_INVALID', 'A non-empty, valid Component 7 batch is required.');
  }
  const ids = new Set();
  for (const capture of batch.captures) {
    if (!capture || capture.valid !== true || typeof capture.sourceCaptureId !== 'string' || !capture.sourceCaptureId
      || ids.has(capture.sourceCaptureId) || !positiveInteger(capture.sourceDimensions?.width) || !positiveInteger(capture.sourceDimensions?.height)) {
      throw new FeatureExtractionError('PREPROCESSING_CAPTURE_INVALID', 'A Component 7 capture has invalid identity, dimensions, or validity metadata.');
    }
    if (capture.captureEvidence !== undefined && !isCaptureEvidence(capture.captureEvidence, capture.sourceCaptureId)) {
      throw new FeatureExtractionError('CAPTURE_EVIDENCE_INVALID', 'Component 7 capture-quality evidence is malformed or contains non-summary payload data.');
    }
    ids.add(capture.sourceCaptureId);
    for (const pair of EYE_PAIRS) validatePreprocessedEye(capture[pair.key], pair, capture.sourceDimensions);
  }
  return batch;
}

export function extractEyeFeatures(preprocessedEye, { pair, sourceDimensions, sourceCaptureId } = {}) {
  const expectedPair = pair || EYE_PAIRS.find(item => item.eye === preprocessedEye?.eye);
  if (!expectedPair) throw new FeatureExtractionError('EYE_IDENTITY_INVALID', 'The eye side is not recognized.');
  validatePreprocessedEye(preprocessedEye, expectedPair, sourceDimensions);
  const source = preprocessedEye.sourceMetadata;
  const eyeBox = source.boundingBox;
  const iris = source.iris;
  const eyeWidth = (eyeBox.right - eyeBox.left) * sourceDimensions.width;
  const eyeHeight = (eyeBox.bottom - eyeBox.top) * sourceDimensions.height;
  const irisWidth = (iris.boundingBox.right - iris.boundingBox.left) * sourceDimensions.width;
  const irisHeight = (iris.boundingBox.bottom - iris.boundingBox.top) * sourceDimensions.height;
  const corners = source.eyeCorners;
  const eyeCornerDistance = validNormalizedPoint(corners?.nasal) && validNormalizedPoint(corners?.temporal)
    ? Math.hypot((corners.temporal.x - corners.nasal.x) * sourceDimensions.width, (corners.temporal.y - corners.nasal.y) * sourceDimensions.height)
      / Math.hypot(sourceDimensions.width, sourceDimensions.height)
    : null;
  const stats = sampleIrisRegion(preprocessedEye);
  const values = {
    eyeWidthFraction: eyeBox.right - eyeBox.left,
    eyeHeightFraction: eyeBox.bottom - eyeBox.top,
    eyeAspectRatio: eyeWidth / eyeHeight,
    eyeCornerDistanceFractionOfFrameDiagonal: eyeCornerDistance,
    eyeOpennessRatio: finiteOrNull(source.opennessRatio),
    eyeOrientationDegrees: finiteOrNull(source.orientationDegrees),
    irisWidthFraction: iris.boundingBox.right - iris.boundingBox.left,
    irisHeightFraction: iris.boundingBox.bottom - iris.boundingBox.top,
    irisAspectRatio: irisWidth / irisHeight,
    irisToEyeWidthRatio: irisWidth / eyeWidth,
    irisToEyeHeightRatio: irisHeight / eyeHeight,
    irisCenterOffsetXWithinEye: iris.center ? (iris.center.x - (eyeBox.left + eyeBox.right) / 2) / (eyeBox.right - eyeBox.left) : null,
    irisCenterOffsetYWithinEye: iris.center ? (iris.center.y - (eyeBox.top + eyeBox.bottom) / 2) / (eyeBox.bottom - eyeBox.top) : null,
    irisRegionMeanEncodedLuma: stats?.mean ?? null,
    irisRegionStdDevEncodedLuma: stats?.standardDeviation ?? null,
  };
  const unavailableReasons = {
    eyeOpennessRatio: 'Component 4 did not provide a finite eyelid openness ratio.',
    eyeCornerDistanceFractionOfFrameDiagonal: 'Component 4 did not provide both eye-corner landmarks.',
    eyeOrientationDegrees: 'Component 4 did not provide a finite eye orientation.',
    irisCenterOffsetXWithinEye: 'The estimated iris center is unavailable.',
    irisCenterOffsetYWithinEye: 'The estimated iris center is unavailable.',
    irisRegionMeanEncodedLuma: stats ? null : 'The transformed iris boundary is unavailable or contains no readable pixels.',
    irisRegionStdDevEncodedLuma: stats ? null : 'The transformed iris boundary is unavailable or contains no readable pixels.',
  };
  const confidence = resolveConfidence(source);
  const features = {};
  for (const definition of FEATURE_DEFINITIONS) {
    const value = values[definition.name];
    const confidenceApplies = definition.name.startsWith('eye') || definition.name.startsWith('iris') && !definition.name.includes('Luma');
    features[definition.name] = makeFeature(value, definition, {
      unavailableReason: unavailableReasons[definition.name],
      confidence: confidenceApplies ? confidence : { value: null, status: 'UNAVAILABLE', reason: 'No per-pixel detector confidence is provided.' },
      source: definition.name.includes('Luma') ? 'component-7-pixels-within-component-4-iris-boundary' : 'component-4-landmark-geometry',
    });
  }
  const vectorMissing = FEATURE_ORDER.filter(name => features[name].valid !== true);
  let candidateVector = null;
  if (vectorMissing.length === 0) candidateVector = toFeatureVector({ eye: expectedPair.eye, designation: expectedPair.designation, features });
  const pupilUnavailable = {
    status: 'UNAVAILABLE',
    reason: 'The current Component 4 Face Landmarker provides no pupil boundary or center, and Component 8 does not infer one from intensity.',
    diameterPx: unavailableMeasurement('A pupil boundary is not provided.'),
    centerXNormalized: unavailableMeasurement('A pupil center is not provided.'),
    centerYNormalized: unavailableMeasurement('A pupil center is not provided.'),
    pupilToIrisRatio: unavailableMeasurement('A pupil boundary is not provided.'),
    eccentricity: unavailableMeasurement('A pupil boundary is not provided.'),
  };
  const output = {
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    featureExtractionVersion: FEATURE_EXTRACTION_VERSION,
    sourceCaptureId,
    eye: expectedPair.eye,
    designation: expectedPair.designation,
    coordinateSpace: 'normalized_camera_frame_top_left_unmirrored',
    valid: true,
    completeness: vectorMissing.length === 0 ? 'COMPLETE' : 'PARTIAL',
    features,
    featureOrder: [...FEATURE_ORDER],
    candidateVector,
    missingFeatureNames: vectorMissing,
    pupil: pupilUnavailable,
    confidence,
    sourceMetadata: {
      preprocessingVersion: PREPROCESSING_VERSION,
      colorMode: preprocessedEye.colorMode,
      layout: preprocessedEye.layout,
      normalization: structuredCloneSafe(preprocessedEye.normalization),
      rotationDegrees: preprocessedEye.transform.rotationDegrees,
      irisRegionSampleCount: stats?.count ?? 0,
      irisBoundarySource: 'component-4-mediapipe-face-landmarker-boundary-landmarks',
      eyeCornerLandmarksAvailable: Boolean(source.eyeCorners?.nasal && source.eyeCorners?.temporal),
    },
  };
  validateFeatureSet(output);
  return output;
}

/** Convert selected known features to a fixed Float32 tensor without inventing missing values. */
export function toFeatureVector(featureSet, {
  featureOrder = FEATURE_ORDER,
  normalization = { method: 'none' },
} = {}) {
  if (!featureSet || !['right', 'left'].includes(featureSet.eye) || featureSet.designation !== (featureSet.eye === 'right' ? 'OD' : 'OS')) {
    throw new FeatureExtractionError('FEATURE_EYE_IDENTITY_INVALID', 'Feature-vector eye side and designation do not match.');
  }
  if (!Array.isArray(featureOrder) || featureOrder.length === 0 || new Set(featureOrder).size !== featureOrder.length
    || featureOrder.some(name => !DEFINITION_BY_NAME.has(name))) {
    throw new FeatureExtractionError('FEATURE_ORDER_INVALID', 'Feature order must be a non-empty unique list of names in the versioned schema.');
  }
  const missing = featureOrder.filter(name => featureSet.features?.[name]?.valid !== true || !Number.isFinite(featureSet.features[name].value));
  if (missing.length) throw new FeatureExtractionError('FEATURE_VECTOR_INCOMPLETE', 'A vector cannot contain missing features; configure a model-supported subset or explicit missing-value policy.', { missingFeatureNames: missing });
  const sourceValues = featureOrder.map(name => featureSet.features[name].value);
  const settings = resolveVectorNormalization(normalization, featureOrder.length);
  const values = new Float32Array(sourceValues.length);
  for (let index = 0; index < sourceValues.length; index++) {
    values[index] = settings.method === 'mean-std' ? (sourceValues[index] - settings.mean[index]) / settings.std[index] : sourceValues[index];
  }
  if (values.some(value => !Number.isFinite(value))) throw new FeatureExtractionError('FEATURE_VECTOR_INVALID', 'Feature-vector conversion produced a non-finite value.');
  const vector = {
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    eye: featureSet.eye,
    designation: featureSet.designation,
    featureOrder: [...featureOrder],
    featureUnits: featureOrder.map(name => DEFINITION_BY_NAME.get(name).unit),
    values,
    dataType: 'float32',
    normalization: settings.method === 'mean-std' ? { method: settings.method, mean: [...settings.mean], std: [...settings.std] } : { method: 'none' },
    valid: true,
    modelReady: false,
  };
  validateFeatureVector(vector, { expectedFeatureOrder: featureOrder });
  return vector;
}

export function validateFeatureVector(vector, { expectedFeatureOrder = FEATURE_ORDER } = {}) {
  if (!Array.isArray(expectedFeatureOrder) || expectedFeatureOrder.length === 0 || new Set(expectedFeatureOrder).size !== expectedFeatureOrder.length
    || expectedFeatureOrder.some(name => !DEFINITION_BY_NAME.has(name))
    || !vector || vector.valid !== true || vector.modelReady !== false || vector.featureSchemaVersion !== FEATURE_SCHEMA_VERSION || vector.dataType !== 'float32'
    || !['right', 'left'].includes(vector.eye) || vector.designation !== (vector.eye === 'right' ? 'OD' : 'OS')
    || !Array.isArray(vector.featureOrder) || vector.featureOrder.length !== expectedFeatureOrder.length
    || vector.featureOrder.some((name, index) => name !== expectedFeatureOrder[index])
    || !Array.isArray(vector.featureUnits) || vector.featureUnits.length !== expectedFeatureOrder.length
    || vector.featureUnits.some((unit, index) => unit !== DEFINITION_BY_NAME.get(expectedFeatureOrder[index])?.unit)
    || !(vector.values instanceof Float32Array) || vector.values.length !== expectedFeatureOrder.length
    || vector.values.some(value => !Number.isFinite(value)) || !validVectorNormalization(vector.normalization, expectedFeatureOrder.length)) {
    throw new FeatureExtractionError('FEATURE_VECTOR_INVALID', 'Feature vector does not match the expected eye identity, schema, ordering, size, or finite-value contract.');
  }
  return vector;
}

export async function extractFeaturesBatch(batch, { now = () => Date.now(), shouldContinue = () => true, yieldToMainThread = () => new Promise(resolve => setTimeout(resolve, 0)) } = {}) {
  validatePreprocessedBatch(batch);
  const captures = [];
  for (let index = 0; index < batch.captures.length; index++) {
    if (!shouldContinue()) throw new FeatureExtractionError('FEATURE_EXTRACTION_CANCELLED', 'Feature extraction was cancelled before the batch completed.');
    const capture = batch.captures[index];
    captures.push({
      sourceCaptureId: capture.sourceCaptureId,
      valid: true,
      ...(capture.captureEvidence ? { captureEvidence: structuredCloneSafe(capture.captureEvidence) } : {}),
      rightEye: extractEyeFeatures(capture.rightEye, { pair: EYE_PAIRS[0], sourceDimensions: capture.sourceDimensions, sourceCaptureId: capture.sourceCaptureId }),
      leftEye: extractEyeFeatures(capture.leftEye, { pair: EYE_PAIRS[1], sourceDimensions: capture.sourceDimensions, sourceCaptureId: capture.sourceCaptureId }),
    });
    if (index + 1 < batch.captures.length) await yieldToMainThread();
  }
  if (!shouldContinue()) throw new FeatureExtractionError('FEATURE_EXTRACTION_CANCELLED', 'Feature extraction was cancelled before output validation.');
  const output = {
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    featureExtractionVersion: FEATURE_EXTRACTION_VERSION,
    sourcePreprocessingVersion: batch.preprocessingVersion,
    timestamp: now(),
    valid: true,
    modelReady: false,
    featureOrder: [...FEATURE_ORDER],
    captures,
  };
  validateFeatureBatch(output);
  return output;
}

export function validateFeatureBatch(batch) {
  if (!batch || batch.valid !== true || batch.featureSchemaVersion !== FEATURE_SCHEMA_VERSION || batch.featureExtractionVersion !== FEATURE_EXTRACTION_VERSION
    || batch.modelReady !== false || !Array.isArray(batch.featureOrder) || batch.featureOrder.length !== FEATURE_ORDER.length || batch.featureOrder.some((name, index) => name !== FEATURE_ORDER[index])
    || !Array.isArray(batch.captures) || batch.captures.length === 0) {
    throw new FeatureExtractionError('FEATURE_BATCH_INVALID', 'Feature batch does not match the versioned Component 8 schema.');
  }
  const captureIds = new Set();
  for (const capture of batch.captures) {
    if (capture?.valid !== true || !capture.sourceCaptureId || captureIds.has(capture.sourceCaptureId)) throw new FeatureExtractionError('FEATURE_BATCH_INVALID', 'A feature capture is incomplete or duplicated.');
    captureIds.add(capture.sourceCaptureId);
    if (capture.captureEvidence !== undefined && !isCaptureEvidence(capture.captureEvidence, capture.sourceCaptureId)) {
      throw new FeatureExtractionError('CAPTURE_EVIDENCE_INVALID', 'Feature capture quality evidence does not match its source capture.');
    }
    validateFeatureSet(capture.rightEye);
    validateFeatureSet(capture.leftEye);
    if (capture.rightEye.eye !== 'right' || capture.rightEye.designation !== 'OD' || capture.leftEye.eye !== 'left' || capture.leftEye.designation !== 'OS'
      || capture.rightEye.sourceCaptureId !== capture.sourceCaptureId || capture.leftEye.sourceCaptureId !== capture.sourceCaptureId) {
      throw new FeatureExtractionError('FEATURE_EYE_IDENTITY_INVALID', 'Feature batch eyes are not in the expected OD/OS slots.');
    }
  }
  return batch;
}

function validatePreprocessedEye(eye, pair, sourceDimensions) {
  if (!eye || eye.valid === false || eye.eye !== pair.eye || eye.designation !== pair.designation
    || !positiveInteger(eye.width) || !positiveInteger(eye.height) || eye.width * eye.height > 4_000_000
    || !['RGB', 'RGBA', 'GRAYSCALE'].includes(eye.colorMode) || !['HWC', 'CHW'].includes(eye.layout)
    || eye.channels !== (eye.colorMode === 'RGBA' ? 4 : eye.colorMode === 'RGB' ? 3 : 1)
    || !(eye.image instanceof Uint8Array || eye.image instanceof Float32Array)
    || eye.image.length !== eye.width * eye.height * eye.channels
    || eye.dataType !== (eye.image instanceof Uint8Array ? 'uint8' : 'float32')
    || !eye.transform || !Number.isFinite(eye.transform.rotationDegrees)) {
    throw new FeatureExtractionError('PREPROCESSED_EYE_INVALID', `The ${pair.eye}/${pair.designation} Component 7 image has invalid tensor metadata.`, { eye: pair.eye });
  }
  const source = eye.sourceMetadata;
  const eyeBox = source?.boundingBox, iris = source?.iris;
  if (!sourceDimensions || !positiveInteger(sourceDimensions.width) || !positiveInteger(sourceDimensions.height)
    || !validNormalizedBox(eyeBox) || !validNormalizedBox(iris?.boundingBox) || iris.detected !== true
    || !validNormalizedPoint(iris.center) || !containsPoint(iris.boundingBox, iris.center) || !containsBox(eyeBox, iris.boundingBox)) {
    throw new FeatureExtractionError('FEATURE_GEOMETRY_MISSING', `Complete eye and iris geometry is required for ${pair.eye}/${pair.designation}.`, { eye: pair.eye });
  }
  if (source?.eyeCorners && (source.eyeCorners.nasal && !validNormalizedPoint(source.eyeCorners.nasal)
    || source.eyeCorners.temporal && !validNormalizedPoint(source.eyeCorners.temporal))) {
    throw new FeatureExtractionError('EYE_LANDMARK_INVALID', 'Eye-corner coordinates must be finite normalized points.', { eye: pair.eye });
  }
  if (!validNormalization(eye.normalization, eye.channels, eye.dataType)) throw new FeatureExtractionError('PREPROCESSED_NORMALIZATION_INVALID', 'Component 7 pixel normalization metadata is invalid.', { eye: pair.eye });
  validateConfidence(source);
  if (Array.isArray(eye.irisOutputBoundary) && eye.irisOutputBoundary.length >= 3
    && eye.irisOutputBoundary.some(point => !Number.isFinite(point?.x) || !Number.isFinite(point?.y) || point.x < -1 || point.y < -1 || point.x > eye.width + 1 || point.y > eye.height + 1)) {
    throw new FeatureExtractionError('IRIS_BOUNDARY_INVALID', 'The transformed iris boundary contains invalid output coordinates.', { eye: pair.eye });
  }
  validatePixelValues(eye, pair.eye);
}

function sampleIrisRegion(eye) {
  const polygon = eye.irisOutputBoundary;
  if (!Array.isArray(polygon) || polygon.length < 3) return null;
  const left = Math.max(0, Math.floor(Math.min(...polygon.map(point => point.x))));
  const right = Math.min(eye.width - 1, Math.ceil(Math.max(...polygon.map(point => point.x))));
  const top = Math.max(0, Math.floor(Math.min(...polygon.map(point => point.y))));
  const bottom = Math.min(eye.height - 1, Math.ceil(Math.max(...polygon.map(point => point.y))));
  const reader = createPixelReader(eye);
  let count = 0, mean = 0, sumSquaredDifferences = 0;
  for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
    if (!pointInPolygon(x + 0.5, y + 0.5, polygon)) continue;
    const luma = reader.lumaAt(x, y);
    if (luma === null) continue;
    count++;
    const delta = luma - mean;
    mean += delta / count;
    sumSquaredDifferences += delta * (luma - mean);
  }
  return count ? { count, mean, standardDeviation: Math.sqrt(sumSquaredDifferences / count) } : null;
}

function createPixelReader(eye) {
  const normalization = eye.normalization;
  const pixelCount = eye.width * eye.height;
  const index = (x, y, channel) => eye.layout === 'HWC' ? (y * eye.width + x) * eye.channels + channel : channel * pixelCount + y * eye.width + x;
  const decode = (value, channel) => {
    if (normalization.method === 'none') return value;
    if (normalization.method === 'zero-to-one') return value * 255;
    if (normalization.method === 'minus-one-to-one') return (value + 1) * 127.5;
    return value * normalization.std[channel] + normalization.mean[channel];
  };
  return {
    lumaAt(x, y) {
      if (eye.colorMode === 'GRAYSCALE') return clampByteDomain(decode(eye.image[index(x, y, 0)], 0));
      const red = clampByteDomain(decode(eye.image[index(x, y, 0)], 0));
      const green = clampByteDomain(decode(eye.image[index(x, y, 1)], 1));
      const blue = clampByteDomain(decode(eye.image[index(x, y, 2)], 2));
      if (eye.colorMode === 'RGBA' && clampByteDomain(decode(eye.image[index(x, y, 3)], 3)) <= 0) return null;
      return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    },
  };
}

function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
    const a = polygon[current], b = polygon[previous];
    const intersects = (a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function makeFeature(value, definition, { unavailableReason, confidence, source }) {
  const isValid = Number.isFinite(value) && isFeatureValueInRange(definition.name, value);
  return {
    value: isValid ? value : null,
    valid: isValid,
    status: isValid ? (definition.name.includes('Luma') ? 'MEASURED' : 'ESTIMATED') : 'UNAVAILABLE',
    unit: definition.unit,
    description: definition.description,
    source,
    confidence: structuredCloneSafe(confidence),
    ...(isValid ? {} : { reason: unavailableReason || 'The measurement was non-finite or outside its defined physical range.' }),
  };
}

function validateFeatureSet(eye) {
  if (!eye || eye.featureSchemaVersion !== FEATURE_SCHEMA_VERSION || !['right', 'left'].includes(eye.eye)
    || eye.designation !== (eye.eye === 'right' ? 'OD' : 'OS') || eye.valid !== true || !eye.features
    || !Array.isArray(eye.featureOrder) || eye.featureOrder.some((name, index) => name !== FEATURE_ORDER[index])) {
    throw new FeatureExtractionError('FEATURE_SET_INVALID', 'Eye feature set does not match the versioned OD/OS schema.');
  }
  for (const name of FEATURE_ORDER) {
    const feature = eye.features[name];
    if (!feature || typeof feature.valid !== 'boolean' || !DEFINITION_BY_NAME.has(name)
      || (feature.valid && (!Number.isFinite(feature.value) || !isFeatureValueInRange(name, feature.value)))
      || (!feature.valid && feature.value !== null)
      || feature.unit !== DEFINITION_BY_NAME.get(name).unit
      || (feature.valid && !['ESTIMATED', 'MEASURED'].includes(feature.status))
      || (!feature.valid && feature.status !== 'UNAVAILABLE')) {
      throw new FeatureExtractionError('FEATURE_VALUE_INVALID', `Feature ${name} has invalid value or validity metadata.`, { eye: eye.eye, feature: name });
    }
  }
  const missing = FEATURE_ORDER.filter(name => eye.features[name].valid !== true);
  if (!Array.isArray(eye.missingFeatureNames) || eye.missingFeatureNames.length !== missing.length
    || eye.missingFeatureNames.some((name, index) => name !== missing[index])
    || eye.completeness !== (missing.length ? 'PARTIAL' : 'COMPLETE')) {
    throw new FeatureExtractionError('FEATURE_COMPLETENESS_INVALID', 'Feature completeness metadata does not match the validity map.', { eye: eye.eye });
  }
  if (missing.length === 0) validateFeatureVector(eye.candidateVector);
  else if (eye.candidateVector !== null) throw new FeatureExtractionError('FEATURE_VECTOR_INVALID', 'An incomplete feature set must not produce a zero-filled candidate vector.', { eye: eye.eye });
  return eye;
}

function resolveConfidence(source) {
  if (Number.isFinite(source.confidence) && source.confidence >= 0 && source.confidence <= 1) {
    return { value: source.confidence, status: 'AVAILABLE', source: 'component-4-detector' };
  }
  return { value: null, status: 'UNAVAILABLE', source: source.confidenceStatus || 'Component 4 provides no per-eye confidence score.' };
}

function validateConfidence(source) {
  if (source.confidence !== null && source.confidence !== undefined
    && (!Number.isFinite(source.confidence) || source.confidence < 0 || source.confidence > 1)) {
    throw new FeatureExtractionError('FEATURE_CONFIDENCE_INVALID', 'Source confidence must be unavailable or a finite value from 0 to 1.');
  }
  if (source.confidenceStatus === 'AVAILABLE' && !Number.isFinite(source.confidence)) {
    throw new FeatureExtractionError('FEATURE_CONFIDENCE_INVALID', 'Confidence marked available must contain a finite numeric score.');
  }
}

function resolveVectorNormalization(value, length) {
  const normalization = typeof value === 'string' ? { method: value } : value;
  if (!normalization || normalization.method === 'none') return { method: 'none' };
  if (normalization.method !== 'mean-std' || !Array.isArray(normalization.mean) || !Array.isArray(normalization.std)
    || normalization.mean.length !== length || normalization.std.length !== length
    || normalization.mean.some(item => !Number.isFinite(item)) || normalization.std.some(item => !Number.isFinite(item) || item <= 0)) {
    throw new FeatureExtractionError('FEATURE_NORMALIZATION_INVALID', 'Model-specific mean/std normalization requires one finite mean and positive standard deviation per ordered feature.');
  }
  return normalization;
}

function validVectorNormalization(value, length) {
  if (value?.method === 'none') return true;
  return value?.method === 'mean-std' && Array.isArray(value.mean) && Array.isArray(value.std)
    && value.mean.length === length && value.std.length === length
    && value.mean.every(Number.isFinite) && value.std.every(item => Number.isFinite(item) && item > 0);
}

function validNormalization(value, channels, dataType) {
  if (!value || !['none', 'zero-to-one', 'minus-one-to-one', 'mean-std'].includes(value.method)) return false;
  if (dataType === 'uint8') return value.method === 'none' && sameRange(value.inputRange, [0, 255]) && sameRange(value.outputRange, [0, 255]);
  if (value.method === 'none') return false;
  if (value.method === 'zero-to-one') return sameRange(value.inputRange, [0, 255]) && sameRange(value.outputRange, [0, 1]);
  if (value.method === 'minus-one-to-one') return sameRange(value.inputRange, [0, 255]) && sameRange(value.outputRange, [-1, 1]);
  return value.method === 'mean-std' && sameRange(value.inputRange, [0, 255])
    && Array.isArray(value.mean) && Array.isArray(value.std) && value.mean.length === channels && value.std.length === channels
    && value.mean.every(item => Number.isFinite(item) && item >= 0 && item <= 255) && value.std.every(item => Number.isFinite(item) && item > 0);
}

function validatePixelValues(eye, side) {
  const normalization = eye.normalization;
  const pixelCount = eye.width * eye.height;
  for (let index = 0; index < eye.image.length; index++) {
    const value = eye.image[index];
    if (!Number.isFinite(value)) throw new FeatureExtractionError('PREPROCESSED_PIXELS_INVALID', 'Component 7 pixels contain a non-finite value.', { eye: side });
    if (eye.dataType === 'uint8') continue;
    if (normalization.method === 'zero-to-one' && (value < 0 || value > 1)
      || normalization.method === 'minus-one-to-one' && (value < -1 || value > 1)) {
      throw new FeatureExtractionError('PREPROCESSED_PIXELS_INVALID', 'A normalized pixel is outside the declared range.', { eye: side });
    }
    if (normalization.method === 'mean-std') {
      const channel = eye.layout === 'HWC' ? index % eye.channels : Math.floor(index / pixelCount);
      const raw = value * normalization.std[channel] + normalization.mean[channel];
      if (raw < -1e-3 || raw > 255.001) throw new FeatureExtractionError('PREPROCESSED_PIXELS_INVALID', 'A denormalized pixel is outside the supported 0–255 range.', { eye: side });
    }
  }
}

function validNormalizedBox(box) {
  return Boolean(box && [box.left, box.top, box.right, box.bottom].every(Number.isFinite)
    && box.left >= 0 && box.top >= 0 && box.right <= 1 && box.bottom <= 1 && box.right > box.left && box.bottom > box.top);
}
function sameRange(value, expected) { return Array.isArray(value) && value.length === 2 && value[0] === expected[0] && value[1] === expected[1]; }
function validNormalizedPoint(point) { return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1); }
function containsBox(outer, inner) { return inner.left >= outer.left && inner.top >= outer.top && inner.right <= outer.right && inner.bottom <= outer.bottom; }
function containsPoint(box, point) { return point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom; }
function isFeatureValueInRange(name, value) {
  if (!Number.isFinite(value)) return false;
  if (name.endsWith('Fraction')) return value > 0 && value <= 1;
  if (name === 'eyeCornerDistanceFractionOfFrameDiagonal') return value > 0 && value <= 1;
  if (name === 'eyeWidthFraction' || name === 'eyeHeightFraction' || name === 'irisWidthFraction' || name === 'irisHeightFraction') return value > 0 && value <= 1;
  if (name === 'eyeOrientationDegrees') return value >= -180 && value <= 180;
  if (name === 'eyeOpennessRatio') return value >= 0;
  if (name === 'irisRegionMeanEncodedLuma') return value >= 0 && value <= 255;
  if (name === 'irisRegionStdDevEncodedLuma') return value >= 0 && value <= 127.5 + 1e-6;
  if (name === 'irisCenterOffsetXWithinEye' || name === 'irisCenterOffsetYWithinEye') return Math.abs(value) <= 0.5;
  return value > 0;
}
function unavailableMeasurement(reason) { return { value: null, valid: false, status: 'UNAVAILABLE', reason }; }
function finiteOrNull(value) { return Number.isFinite(value) ? value : null; }
function positiveInteger(value) { return Number.isInteger(value) && value > 0; }
function clampByteDomain(value) { return value < -1e-3 || value > 255.001 ? Number.NaN : Math.max(0, Math.min(255, value)); }
function structuredCloneSafe(value) { return value === undefined ? null : globalThis.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value)); }
