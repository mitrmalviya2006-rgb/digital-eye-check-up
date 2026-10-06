export const EYE_ANALYSIS_VERSION = '1.0.0';
export const EYE_ANALYSIS_SCHEMA_VERSION = '1.0.0';
export const PREDICTION_SCHEMA_VERSION_SUPPORTED = '1.0.0';
import { isCaptureEvidence } from './capture-evidence.js';

const EYES = Object.freeze([
  Object.freeze({ key: 'rightEye', eye: 'right', designation: 'OD' }),
  Object.freeze({ key: 'leftEye', eye: 'left', designation: 'OS' }),
]);
const PARAMETERS = Object.freeze(['sph', 'cyl', 'axis']);

/**
 * Convert the Component 9 event contract into a stable, eye-separated C10
 * handoff. This module only validates and organizes data; it does no inference.
 */
export function analyzePredictionResult(prediction) {
  if (!isRecord(prediction)) return rejected('PREDICTION_RESULT_INVALID', 'Component 9 did not provide a prediction result object.');
  if (prediction.predictionSchemaVersion !== PREDICTION_SCHEMA_VERSION_SUPPORTED) {
    return rejected('PREDICTION_SCHEMA_UNSUPPORTED', 'Component 9 prediction schema is missing or unsupported.', prediction);
  }

  if (prediction.valid === false && ['UNAVAILABLE', 'ERROR'].includes(prediction.predictionStatus)) {
    return normalizeFailure(prediction);
  }
  if (prediction.valid !== true) return rejected('PREDICTION_STATUS_INVALID', 'Component 9 result is neither a valid prediction batch nor a recognized unavailable/error result.', prediction);

  try {
    return normalizeSuccess(prediction);
  } catch (error) {
    return rejected(error?.code || 'PREDICTION_STRUCTURE_INVALID', error?.message || 'Component 9 prediction structure failed validation.', prediction, error?.details);
  }
}

function normalizeSuccess(prediction) {
  if (prediction.predictionEngineVersion !== '1.0.0'
    || prediction.inputValidity?.valid !== true
    || !nonEmptyString(prediction.inputValidity.featureSchemaVersion)
    || !nonEmptyString(prediction.inputValidity.sourcePreprocessingVersion)
    || prediction.inputValidity.captureCount !== prediction.captures?.length
    || prediction.outputValidity?.valid !== true
    || prediction.clinicalValidity !== 'NOT_ASSESSED'
    || prediction.component11ReliabilityAssessmentRequired !== true
    || !nonEmptyString(prediction.predictionBatchId)) {
    throw analysisError('PREDICTION_ENVELOPE_INVALID', 'Component 9 validity and downstream-review metadata are inconsistent.');
  }
  if (!Number.isFinite(prediction.inferenceTimestamp)
    || !(prediction.inferenceTimeMs === null || Number.isFinite(prediction.inferenceTimeMs))) {
    throw analysisError('PREDICTION_TIMESTAMP_INVALID', 'Component 9 inference timing metadata is invalid.');
  }
  const model = validateModel(prediction.model);
  if (!Array.isArray(prediction.captures) || prediction.captures.length === 0) {
    throw analysisError('PREDICTION_CAPTURE_MISSING', 'A successful Component 9 result must contain at least one capture.');
  }

  const ids = new Set();
  const predictionIds = new Set();
  const predictionsByEye = { rightEye: [], leftEye: [] };
  for (const capture of prediction.captures) {
    if (!isRecord(capture) || !nonEmptyString(capture.sourceCaptureId) || ids.has(capture.sourceCaptureId)) {
      throw analysisError('SOURCE_CAPTURE_ID_INVALID', 'Prediction captures must have unique, non-empty source capture IDs.');
    }
    if (!nonEmptyString(capture.predictionId) || predictionIds.has(capture.predictionId)) {
      throw analysisError('PREDICTION_ID_INVALID', 'Each source capture must have a unique, non-empty prediction ID.');
    }
    ids.add(capture.sourceCaptureId);
    predictionIds.add(capture.predictionId);
    if (capture.captureEvidence !== undefined && capture.captureEvidence !== null
      && !isCaptureEvidence(capture.captureEvidence, capture.sourceCaptureId)) {
      throw analysisError('CAPTURE_EVIDENCE_INVALID', 'Capture-quality evidence is malformed or does not match its source capture.');
    }
    for (const expected of EYES) {
      const sourceEye = capture[expected.key];
      predictionsByEye[expected.key].push(sourceEye == null
        ? makeUnavailableEyePrediction(expected, capture, 'MISSING')
        : validateEyePrediction(sourceEye, expected, capture, model, prediction));
    }
  }

  const rightEye = makeEyeGroup(EYES[0], predictionsByEye.rightEye);
  const leftEye = makeEyeGroup(EYES[1], predictionsByEye.leftEye);
  const overallValid = rightEye.valid && leftEye.valid;
  return {
    analysisSchemaVersion: EYE_ANALYSIS_SCHEMA_VERSION,
    analysisVersion: EYE_ANALYSIS_VERSION,
    analysisStatus: overallValid ? 'ANALYZED' : 'PARTIAL',
    valid: overallValid,
    overallValid,
    structurallyValid: true,
    clinicalValidity: 'NOT_ASSESSED',
    component11ReliabilityAssessmentRequired: true,
    component11InputCompatible: true,
    sourcePrediction: {
      schemaVersion: prediction.predictionSchemaVersion,
      engineVersion: prediction.predictionEngineVersion,
      batchId: nonEmptyString(prediction.predictionBatchId) ? prediction.predictionBatchId : null,
      model,
      inferenceTimestamp: prediction.inferenceTimestamp,
      inferenceTimeMs: prediction.inferenceTimeMs,
      inputValidity: copyInputValidity(prediction.inputValidity),
      outputValidity: { valid: true },
    },
    rightEye,
    leftEye,
    structuralValidationErrors: [],
  };
}

function validateModel(model) {
  if (!isRecord(model)
    || !nonEmptyString(model.id) || !nonEmptyString(model.version) || !nonEmptyString(model.runtime)
    || !nonEmptyString(model.artifactFormat) || !/^[a-f\d]{64}$/i.test(model.artifactSha256 || '')
    || !nonEmptyString(model.manifestVersion) || !nonEmptyString(model.decoderId)
    || !nonEmptyString(model.axisConvention)
    || !['float32', 'float16', 'int8', 'uint8'].includes(model.inputDataType)
    || !Array.isArray(model.inputTensorShape) || model.inputTensorShape.length === 0
    || model.inputTensorShape.some(size => !Number.isSafeInteger(size) || size <= 0)) {
    throw analysisError('MODEL_METADATA_INVALID', 'The prediction model identity, version, runtime, or tensor metadata is missing or invalid.');
  }
  const outputDomains = {};
  for (const parameter of PARAMETERS) outputDomains[parameter] = validateDomain(model.outputDomains?.[parameter], parameter);
  const confidenceDomain = model.outputConfidenceDomain === null ? null : validateConfidenceDomain(model.outputConfidenceDomain);
  if (model.outputConfidenceDomain === undefined) {
    throw analysisError('MODEL_METADATA_INVALID', 'The prediction result must explicitly declare whether confidence is supported.');
  }
  if (model.outputUncertaintyFormat !== null && !nonEmptyString(model.outputUncertaintyFormat)) {
    throw analysisError('MODEL_METADATA_INVALID', 'The prediction result uncertainty format is invalid.');
  }
  if (model.outputUncertaintyFormat === undefined) {
    throw analysisError('MODEL_METADATA_INVALID', 'The prediction result must explicitly declare whether uncertainty is supported.');
  }
  return {
    id: model.id,
    version: model.version,
    runtime: model.runtime,
    artifactFormat: model.artifactFormat,
    artifactSha256: model.artifactSha256,
    manifestVersion: model.manifestVersion,
    decoderId: model.decoderId,
    inputDataType: model.inputDataType,
    inputTensorShape: [...model.inputTensorShape],
    axisConvention: model.axisConvention,
    outputDomains,
    outputConfidenceDomain: confidenceDomain,
    outputUncertaintyFormat: model.outputUncertaintyFormat,
  };
}

function validateDomain(domain, parameter) {
  const expectedUnit = parameter === 'axis' ? 'deg' : 'D';
  if (!isRecord(domain) || !Number.isFinite(domain.min) || !Number.isFinite(domain.max) || domain.min >= domain.max
    || typeof domain.minInclusive !== 'boolean' || typeof domain.maxInclusive !== 'boolean' || domain.unit !== expectedUnit) {
    throw analysisError('MODEL_DOMAIN_INVALID', `Model-declared ${parameter.toUpperCase()} bounds, units, or boundary semantics are invalid.`);
  }
  return { min: domain.min, max: domain.max, minInclusive: domain.minInclusive, maxInclusive: domain.maxInclusive, unit: domain.unit };
}

function validateConfidenceDomain(domain) {
  if (!isRecord(domain) || !nonEmptyString(domain.kind) || !Number.isFinite(domain.min) || !Number.isFinite(domain.max)
    || domain.min >= domain.max || typeof domain.minInclusive !== 'boolean' || typeof domain.maxInclusive !== 'boolean') {
    throw analysisError('MODEL_METADATA_INVALID', 'Declared confidence metadata has an invalid model domain.');
  }
  return { kind: domain.kind, min: domain.min, max: domain.max, minInclusive: domain.minInclusive, maxInclusive: domain.maxInclusive };
}

function validateEyePrediction(eye, expected, capture, model, prediction) {
  if (!isRecord(eye) || eye.eye !== expected.eye || eye.designation !== expected.designation) {
    throw analysisError('EYE_IDENTITY_MISMATCH', `The ${expected.designation} slot does not contain a valid, explicitly identified ${expected.eye} eye result.`, { designation: expected.designation });
  }
  if (eye.valid === false) {
    if (!['MISSING', 'NOT_DETECTED', 'INVALID', 'ERROR', 'UNAVAILABLE'].includes(eye.status)
      || PARAMETERS.some(parameter => eye[parameter] !== undefined && eye[parameter] !== null)) {
      throw analysisError('EYE_STATUS_INVALID', `The ${expected.designation} failure state must be explicit and must not contain prediction values.`, { designation: expected.designation });
    }
    return makeUnavailableEyePrediction(expected, capture, eye.status, eye.errorCode);
  }
  if (eye.valid !== true) {
    throw analysisError('EYE_STATUS_INVALID', `The ${expected.designation} result must explicitly report valid=true or a recognized per-eye failure state.`, { designation: expected.designation });
  }
  if (!isRecord(eye.units)) throw analysisError('PREDICTION_UNITS_INVALID', `The ${expected.designation} result is missing parameter units.`, { designation: expected.designation });
  const values = {};
  for (const parameter of ['sph', 'cyl']) {
    const domain = model.outputDomains[parameter];
    const value = eye[parameter];
    if (!Number.isFinite(value) || !withinDomain(value, domain) || eye.units[parameter] !== domain.unit) {
      throw analysisError('PREDICTION_VALUE_INVALID', `${expected.designation} ${parameter.toUpperCase()} is non-finite, outside the model domain, or has mismatched units.`, { designation: expected.designation, parameter });
    }
    values[parameter] = value;
  }

  let axis;
  let axisStatus;
  if (Number.isFinite(eye.axis)) {
    const domain = model.outputDomains.axis;
    if (!withinDomain(eye.axis, domain) || eye.units.axis !== domain.unit || eye.axisConvention !== model.axisConvention) {
      throw analysisError('PREDICTION_AXIS_INVALID', `${expected.designation} Axis is outside the declared model domain or has inconsistent units/convention.`, { designation: expected.designation });
    }
    axis = eye.axis;
    axisStatus = 'AVAILABLE';
  } else if (eye.axis === null && ['UNAVAILABLE', 'NOT_APPLICABLE'].includes(eye.axisStatus)) {
    axis = null;
    axisStatus = eye.axisStatus;
    if (eye.axisConvention !== model.axisConvention || eye.units.axis !== model.outputDomains.axis.unit) {
      throw analysisError('PREDICTION_AXIS_INVALID', `${expected.designation} Axis convention does not match model metadata.`, { designation: expected.designation });
    }
  } else {
    throw analysisError('PREDICTION_AXIS_INVALID', `${expected.designation} Axis must be finite or have an explicit unavailable/not-applicable status.`, { designation: expected.designation });
  }

  const confidence = validateConfidence(eye.confidence, model, expected.designation);
  const uncertainty = validateUncertainty(eye.uncertainty, model, expected.designation);
  return {
    eye: expected.eye,
    designation: expected.designation,
    sourceCaptureId: capture.sourceCaptureId,
    sourcePredictionId: capture.predictionId,
    sourcePredictionIdStatus: 'AVAILABLE',
    status: 'VALID',
    valid: true,
    sph: values.sph,
    cyl: values.cyl,
    axis,
    axisStatus,
    axisConvention: model.axisConvention,
    units: { sph: model.outputDomains.sph.unit, cyl: model.outputDomains.cyl.unit, axis: model.outputDomains.axis.unit },
    confidence,
    uncertainty,
    modelId: model.id,
    modelVersion: model.version,
    predictionBatchId: nonEmptyString(prediction.predictionBatchId) ? prediction.predictionBatchId : null,
    captureEvidence: capture.captureEvidence ? cloneJson(capture.captureEvidence) : null,
  };
}

function validateConfidence(confidence, model, designation) {
  if (!isRecord(confidence) || !['AVAILABLE', 'UNAVAILABLE'].includes(confidence.status)) {
    throw analysisError('CONFIDENCE_INVALID', `${designation} confidence must have an explicit availability status.`, { designation });
  }
  if (confidence.status === 'UNAVAILABLE') {
    if (confidence.value !== null) throw analysisError('CONFIDENCE_INVALID', `${designation} unavailable confidence must not contain a value.`, { designation });
    return { status: 'UNAVAILABLE', value: null, reason: nonEmptyString(confidence.reason) ? confidence.reason : null };
  }
  const domain = model.outputConfidenceDomain;
  if (!domain || !Number.isFinite(confidence.value) || !withinDomain(confidence.value, domain) || confidence.kind !== domain.kind) {
    throw analysisError('CONFIDENCE_INVALID', `${designation} confidence does not match the model-declared confidence domain.`, { designation });
  }
  return { status: 'AVAILABLE', value: confidence.value, kind: confidence.kind };
}

function validateUncertainty(uncertainty, model, designation) {
  if (!isRecord(uncertainty) || !['AVAILABLE', 'UNAVAILABLE'].includes(uncertainty.status)) {
    throw analysisError('UNCERTAINTY_INVALID', `${designation} uncertainty must have an explicit availability status.`, { designation });
  }
  if (uncertainty.status === 'UNAVAILABLE') {
    if (uncertainty.value !== null) throw analysisError('UNCERTAINTY_INVALID', `${designation} unavailable uncertainty must not contain a value.`, { designation });
    return { status: 'UNAVAILABLE', value: null, reason: nonEmptyString(uncertainty.reason) ? uncertainty.reason : null };
  }
  if (!model.outputUncertaintyFormat || uncertainty.format !== model.outputUncertaintyFormat || !isJsonFinite(uncertainty.value)) {
    throw analysisError('UNCERTAINTY_INVALID', `${designation} uncertainty does not match the model-declared output.`, { designation });
  }
  return { status: 'AVAILABLE', value: cloneJson(uncertainty.value), format: uncertainty.format };
}

function normalizeFailure(prediction) {
  const status = prediction.predictionStatus;
  if (prediction.predictionEngineVersion !== '1.0.0'
    || prediction.component11ReliabilityAssessmentRequired !== true
    || prediction.outputValidity?.valid !== false || prediction.valid !== false
    || !isRecord(prediction.error) || !nonEmptyString(prediction.error.code) || !nonEmptyString(prediction.error.message)
    || prediction.clinicalValidity !== 'NOT_ASSESSED') {
    return rejected('PREDICTION_FAILURE_INVALID', 'Component 9 failure metadata is incomplete or inconsistent.', prediction);
  }
  if (!Array.isArray(prediction.sourceCaptureIds) || prediction.sourceCaptureIds.some(id => !nonEmptyString(id))) {
    return rejected('SOURCE_CAPTURE_ID_INVALID', 'Failed predictions must retain an explicit list of valid source capture IDs.', prediction);
  }
  const ids = [...prediction.sourceCaptureIds];
  if (new Set(ids).size !== ids.length) return rejected('SOURCE_CAPTURE_ID_INVALID', 'Failed prediction contains duplicate source capture IDs.', prediction);
  const failure = {
    code: prediction.error.code,
    message: prediction.error.message,
    retryable: prediction.retryable === true,
  };
  const eyeStatus = status === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'ERROR';
  const failedPredictions = expected => ids.map(sourceCaptureId => ({
    eye: expected.eye,
    designation: expected.designation,
    sourceCaptureId,
    sourcePredictionId: null,
    sourcePredictionIdStatus: 'NOT_PROVIDED',
    status: eyeStatus,
    valid: false,
  }));
  return {
    analysisSchemaVersion: EYE_ANALYSIS_SCHEMA_VERSION,
    analysisVersion: EYE_ANALYSIS_VERSION,
    analysisStatus: status,
    valid: false,
    overallValid: false,
    structurallyValid: true,
    clinicalValidity: 'NOT_ASSESSED',
    component11ReliabilityAssessmentRequired: true,
    component11InputCompatible: true,
    sourcePrediction: {
      schemaVersion: prediction.predictionSchemaVersion,
      engineVersion: prediction.predictionEngineVersion || null,
      batchId: nonEmptyString(prediction.predictionBatchId) ? prediction.predictionBatchId : null,
      model: safeFailureModel(prediction.model),
      inferenceTimestamp: Number.isFinite(prediction.inferenceTimestamp) ? prediction.inferenceTimestamp : null,
      inferenceTimeMs: Number.isFinite(prediction.inferenceTimeMs) ? prediction.inferenceTimeMs : null,
      inputValidity: copyInputValidity(prediction.inputValidity),
      outputValidity: { valid: false },
      failure,
    },
    rightEye: makeEyeGroup(EYES[0], failedPredictions(EYES[0]), eyeStatus),
    leftEye: makeEyeGroup(EYES[1], failedPredictions(EYES[1]), eyeStatus),
    structuralValidationErrors: [],
  };
}

function rejected(code, message, prediction = null, details = {}) {
  const sourceCaptureIds = Array.isArray(prediction?.captures)
    ? prediction.captures.map(capture => capture?.sourceCaptureId).filter(nonEmptyString)
    : Array.isArray(prediction?.sourceCaptureIds) ? prediction.sourceCaptureIds.filter(nonEmptyString) : [];
  const errors = [{ code, message, ...(isRecord(details) && Object.keys(details).length ? { details: { ...details } } : {}) }];
  return {
    analysisSchemaVersion: EYE_ANALYSIS_SCHEMA_VERSION,
    analysisVersion: EYE_ANALYSIS_VERSION,
    analysisStatus: 'REJECTED',
    valid: false,
    overallValid: false,
    structurallyValid: false,
    clinicalValidity: 'NOT_ASSESSED',
    component11ReliabilityAssessmentRequired: true,
    component11InputCompatible: true,
    sourcePrediction: {
      schemaVersion: prediction?.predictionSchemaVersion || null,
      engineVersion: prediction?.predictionEngineVersion || null,
      batchId: nonEmptyString(prediction?.predictionBatchId) ? prediction.predictionBatchId : null,
      model: safeFailureModel(prediction?.model),
      inferenceTimestamp: Number.isFinite(prediction?.inferenceTimestamp) ? prediction.inferenceTimestamp : null,
      inferenceTimeMs: Number.isFinite(prediction?.inferenceTimeMs) ? prediction.inferenceTimeMs : null,
      sourceCaptureIds: [...new Set(sourceCaptureIds)],
    },
    rightEye: makeEyeGroup(EYES[0], [], 'REJECTED'),
    leftEye: makeEyeGroup(EYES[1], [], 'REJECTED'),
    structuralValidationErrors: errors,
  };
}

function safeFailureModel(model) {
  if (!isRecord(model)) return null;
  const fields = ['id', 'version', 'runtime', 'artifactFormat'];
  const safe = Object.fromEntries(fields.filter(field => nonEmptyString(model[field])).map(field => [field, model[field]]));
  return Object.keys(safe).length ? safe : null;
}

function makeUnavailableEyePrediction(expected, capture, status, errorCode = undefined) {
  return {
    eye: expected.eye,
    designation: expected.designation,
    sourceCaptureId: capture.sourceCaptureId,
    sourcePredictionId: capture.predictionId,
    sourcePredictionIdStatus: 'AVAILABLE',
    status,
    valid: false,
    captureEvidence: capture.captureEvidence ? cloneJson(capture.captureEvidence) : null,
    ...(nonEmptyString(errorCode) ? { errorCode } : {}),
  };
}

function makeEyeGroup(expected, predictions, forcedStatus = null) {
  const valid = !forcedStatus && predictions.length > 0 && predictions.every(prediction => prediction.valid === true);
  const status = forcedStatus || (valid ? 'VALID' : predictions.some(prediction => prediction.valid) ? 'PARTIAL' : commonFailureStatus(predictions));
  return {
    eye: expected.eye,
    designation: expected.designation,
    status,
    valid,
    predictions: [...predictions],
  };
}

function commonFailureStatus(predictions) {
  const statuses = new Set(predictions.map(prediction => prediction.status));
  return statuses.size === 1 ? [...statuses][0] : 'PARTIAL';
}

function copyInputValidity(input) {
  if (!isRecord(input)) return null;
  return {
    valid: input.valid === true,
    featureSchemaVersion: nonEmptyString(input.featureSchemaVersion) ? input.featureSchemaVersion : null,
    sourcePreprocessingVersion: nonEmptyString(input.sourcePreprocessingVersion) ? input.sourcePreprocessingVersion : null,
    captureCount: Number.isSafeInteger(input.captureCount) && input.captureCount >= 0 ? input.captureCount : null,
    status: nonEmptyString(input.status) ? input.status : null,
  };
}

function withinDomain(value, domain) {
  return value >= domain.min && value <= domain.max
    && (value !== domain.min || domain.minInclusive)
    && (value !== domain.max || domain.maxInclusive);
}

function analysisError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function nonEmptyString(value) { return typeof value === 'string' && value.trim().length > 0; }

function isJsonFinite(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every(item => isJsonFinite(item, ancestors))
    : isRecord(value) && Object.values(value).every(item => isJsonFinite(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function cloneJson(value) {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item)]));
  return value;
}
