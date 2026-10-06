import { isCaptureEvidence } from './capture-evidence.js';

export const VALIDITY_ENGINE_VERSION = '1.0.0';
export const VALIDITY_RESULT_SCHEMA_VERSION = '1.0.0';

export const DEFAULT_VALIDITY_POLICY = Object.freeze({
  confidenceMinimumByKind: Object.freeze({}),
  uncertaintyMaximumByFormat: Object.freeze({}),
  consistencyTolerances: null,
  requireCaptureEvidence: true,
  requireCaptureStability: true,
});

const EYES = Object.freeze([
  Object.freeze({ key: 'rightEye', eye: 'right', designation: 'OD' }),
  Object.freeze({ key: 'leftEye', eye: 'left', designation: 'OS' }),
]);
const REFRACTION_PARAMETERS = Object.freeze(['sph', 'cyl', 'axis']);

/** Assess technical completeness and repeatability only; this is not diagnosis. */
export function assessEyeValidity(eyeAnalysis, { policy = {}, now = () => Date.now() } = {}) {
  const settings = resolvePolicy(policy);
  const timestamp = makeTimestamp(now);
  if (!isRecord(eyeAnalysis) || eyeAnalysis.analysisSchemaVersion !== '1.0.0'
    || eyeAnalysis.clinicalValidity !== 'NOT_ASSESSED') {
    return invalidResult('ANALYSIS_SCHEMA_INVALID', 'Component 10 output is missing or unsupported.', timestamp, eyeAnalysis);
  }
  if (!['ANALYZED', 'PARTIAL', 'UNAVAILABLE', 'ERROR', 'REJECTED'].includes(eyeAnalysis.analysisStatus)) {
    return invalidResult('ANALYSIS_STATUS_INVALID', 'Component 10 analysis status is missing or unsupported.', timestamp, eyeAnalysis);
  }
  if (eyeAnalysis.structurallyValid !== true || eyeAnalysis.analysisStatus === 'REJECTED') {
    const sourceErrors = Array.isArray(eyeAnalysis.structuralValidationErrors) ? eyeAnalysis.structuralValidationErrors : [];
    const errors = sourceErrors.length ? sourceErrors.map(error => reason(error?.code || 'STRUCTURAL_VALIDATION_FAILED', 'INVALID', null, 'Component 10 structural validation rejected the result.'))
      : [reason('STRUCTURAL_VALIDATION_FAILED', 'INVALID', null, 'Component 10 structural validation rejected the result.')];
    return invalidResult(errors[0].code, errors[0].message, timestamp, eyeAnalysis, errors);
  }

  const model = eyeAnalysis.sourcePrediction?.model;
  const inputValidity = eyeAnalysis.sourcePrediction?.inputValidity;
  const envelopeReasons = [];
  if (eyeAnalysis.sourcePrediction?.outputValidity?.valid === false) {
    envelopeReasons.push(reason('MODEL_OUTPUT_UNAVAILABLE', 'RETEST', null, 'Component 9 produced no usable model output.'));
  } else if (eyeAnalysis.sourcePrediction?.outputValidity?.valid !== true) {
    envelopeReasons.push(reason('MODEL_OUTPUT_VALIDITY_MISSING', 'INVALID', null, 'Component 10 is missing Component 9 output-validity metadata.'));
  }
  if (!isRecord(inputValidity) || inputValidity.valid !== true) {
    envelopeReasons.push(reason('FEATURE_INPUT_INVALID', 'INVALID', null, 'Component 9 did not confirm valid Component 8 model input.'));
  }
  if (!nonEmptyString(inputValidity?.featureSchemaVersion) || !nonEmptyString(inputValidity?.sourcePreprocessingVersion)) {
    envelopeReasons.push(reason('FEATURE_SCHEMA_METADATA_MISSING', 'RETEST', null, 'The feature/preprocessing schema versions needed to interpret the model input are unavailable.'));
  }
  if (!Number.isSafeInteger(inputValidity?.captureCount) || inputValidity.captureCount <= 0) {
    envelopeReasons.push(reason('CAPTURE_COUNT_UNAVAILABLE', 'RETEST', null, 'The number of source captures is missing or insufficient for assessment.'));
  }
  if (!isRecord(model) || !nonEmptyString(model.id) || !nonEmptyString(model.version)) {
    envelopeReasons.push(reason('MODEL_IDENTITY_UNAVAILABLE', 'RETEST', null, 'A versioned prediction model is unavailable.'));
  }
  if (eyeAnalysis.analysisStatus === 'UNAVAILABLE' || eyeAnalysis.analysisStatus === 'ERROR') {
    envelopeReasons.push(reason('PREDICTION_UNAVAILABLE', 'RETEST', null, 'Component 9 did not produce refractive estimates.'));
  }

  const eyes = {};
  for (const expected of EYES) {
    eyes[expected.key] = assessEye(eyeAnalysis[expected.key], expected, { model, inputValidity, policy: settings });
  }

  const reasons = [...envelopeReasons, ...EYES.flatMap(eye => eyes[eye.key].reasons)];
  const allEyesExplicitlyInvalid = EYES.every(eye => eyes[eye.key].status === 'INVALID');
  const status = envelopeReasons.some(item => item.severity === 'INVALID') || allEyesExplicitlyInvalid ? 'INVALID'
    : EYES.some(eye => eyes[eye.key].status === 'INCONSISTENT') ? 'INCONSISTENT'
      : EYES.some(eye => eyes[eye.key].status === 'LOW_CONFIDENCE') ? 'LOW_CONFIDENCE'
        : EYES.every(eye => eyes[eye.key].status === 'VALID') ? 'VALID' : 'RETEST_REQUIRED';
  const valid = status === 'VALID';
  const retestRequired = status !== 'VALID';
  const predictionCounts = Object.fromEntries(EYES.map(eye => [eye.designation, eyes[eye.key].predictions.length]));
  const exactlyOnePredictionPerEye = EYES.every(eye => eyes[eye.key].predictions.length === 1);
  const component12Status = !valid ? 'BLOCKED'
    : exactlyOnePredictionPerEye ? 'READY_FOR_SCREENING_ESTIMATE'
      : 'CONSISTENCY_REVIEW_REQUIRED';
  const component13Status = retestRequired ? 'RETEST_REQUIRED' : exactlyOnePredictionPerEye ? 'NOT_REQUIRED' : 'CONSISTENCY_REVIEW_REQUIRED';
  const affectedEyes = new Set(reasons.map(item => item.eye).filter(Boolean));
  if (component13Status === 'CONSISTENCY_REVIEW_REQUIRED') {
    for (const eye of EYES) if (eyes[eye.key].predictions.length > 1) affectedEyes.add(eye.designation);
  }

  return {
    schemaVersion: VALIDITY_RESULT_SCHEMA_VERSION,
    engineVersion: VALIDITY_ENGINE_VERSION,
    timestamp,
    valid,
    overallValid: valid,
    status,
    clinicalValidity: 'NOT_ASSESSED',
    technicalValidityOnly: true,
    rightEye: eyes.rightEye,
    leftEye: eyes.leftEye,
    reasons,
    recommendations: recommendationsFor(status, component12Status),
    retestRequired,
    sourceAnalysis: {
      schemaVersion: eyeAnalysis.analysisSchemaVersion,
      analysisVersion: eyeAnalysis.analysisVersion || null,
      predictionModelId: nonEmptyString(model?.id) ? model.id : null,
      predictionModelVersion: nonEmptyString(model?.version) ? model.version : null,
      captureCount: Number.isSafeInteger(inputValidity?.captureCount) ? inputValidity.captureCount : null,
    },
    component12: {
      status: component12Status,
      canPresentScreeningEstimate: valid && exactlyOnePredictionPerEye,
      clinicalValidity: 'NOT_ASSESSED',
      predictionCounts,
    },
    component13: {
      status: component13Status,
      retestRequired,
      predictionCounts,
      affectedEyes: [...affectedEyes],
    },
  };
}

function assessEye(group, expected, { model, inputValidity, policy }) {
  const reasons = [];
  if (!isRecord(group) || group.eye !== expected.eye || group.designation !== expected.designation || !Array.isArray(group.predictions)) {
    reasons.push(reason('EYE_IDENTITY_INVALID', 'INVALID', expected.designation, `${expected.designation} eye identity or prediction group is malformed.`));
    return eyeResult(expected, 'INVALID', [], reasons, { consistency: { status: 'NOT_ASSESSED' }, confidence: { status: 'NOT_ASSESSED' } });
  }
  if (group.status === 'REJECTED') {
    reasons.push(reason('EYE_RESULT_REJECTED', 'INVALID', expected.designation, `${expected.designation} prediction structure was rejected.`));
    return eyeResult(expected, 'INVALID', [], reasons, { consistency: { status: 'NOT_ASSESSED' }, confidence: { status: 'NOT_ASSESSED' } });
  }
  if (!group.predictions.length) {
    reasons.push(reason('EYE_PREDICTION_MISSING', 'RETEST', expected.designation, `${expected.designation} has no prediction to assess.`));
    return eyeResult(expected, 'RETEST_REQUIRED', [], reasons, { consistency: { status: 'INSUFFICIENT_DATA' }, confidence: { status: 'UNAVAILABLE' } });
  }
  if (Number.isSafeInteger(inputValidity?.captureCount) && group.predictions.length !== inputValidity.captureCount) {
    reasons.push(reason('CAPTURE_PREDICTION_COUNT_MISMATCH', 'RETEST', expected.designation, `${expected.designation} prediction count does not match the declared capture count.`));
  }

  const validPredictions = [];
  let hasExplicitInvalid = false;
  for (const prediction of group.predictions) {
    if (prediction?.valid !== true) {
      const invalid = prediction?.status === 'INVALID';
      hasExplicitInvalid ||= invalid;
      reasons.push(reason(invalid ? 'EYE_PREDICTION_INVALID' : 'EYE_PREDICTION_UNAVAILABLE', invalid ? 'INVALID' : 'RETEST', expected.designation,
        invalid ? `${expected.designation} has an invalid prediction.` : `${expected.designation} prediction is missing or unavailable.`));
      continue;
    }
    const error = validatePrediction(prediction, expected, model);
    if (error) {
      reasons.push(reason(error.code, 'INVALID', expected.designation, error.message));
      hasExplicitInvalid = true;
      continue;
    }
    validPredictions.push(prediction);
    if (prediction.axisStatus === 'UNAVAILABLE') {
      reasons.push(reason('AXIS_UNAVAILABLE', 'RETEST', expected.designation, `${expected.designation} Axis is unavailable; no value was inferred.`));
    }
    assessReliabilitySignals(prediction, expected, model, policy, reasons);
    assessCaptureEvidence(prediction, expected, policy, reasons);
  }

  if (inputValidity?.valid !== true) reasons.push(reason('FEATURE_INPUT_INVALID', 'INVALID', expected.designation, 'Component 8 feature validity is not confirmed.'));
  const consistency = assessConsistency(validPredictions, expected, policy, reasons);
  if (hasExplicitInvalid && validPredictions.length === 0) {
    return eyeResult(expected, 'INVALID', [], reasons, { consistency, confidence: { status: 'NOT_ASSESSED' } });
  }

  const categories = new Set(reasons.map(item => item.severity));
  const status = categories.has('INVALID') && validPredictions.length === 0 ? 'INVALID'
    : consistency.status === 'INCONSISTENT' ? 'INCONSISTENT'
      : categories.has('LOW_CONFIDENCE') ? 'LOW_CONFIDENCE'
        : categories.size > 0 ? 'RETEST_REQUIRED' : 'VALID';
  return eyeResult(expected, status, validPredictions, reasons, {
    consistency,
    confidence: confidenceSummary(validPredictions),
  });
}

function validatePrediction(prediction, expected, model) {
  if (prediction.eye !== expected.eye || prediction.designation !== expected.designation) {
    return { code: 'EYE_IDENTITY_INVALID', message: `${expected.designation} prediction is not explicitly identified as the expected anatomical eye.` };
  }
  if (!nonEmptyString(prediction.sourceCaptureId) || !nonEmptyString(prediction.sourcePredictionId)) {
    return { code: 'PREDICTION_SOURCE_MISSING', message: `${expected.designation} prediction is missing its source identity.` };
  }
  if (!Number.isFinite(prediction.sph) || !Number.isFinite(prediction.cyl)) {
    return { code: 'REFRACTION_VALUE_NONFINITE', message: `${expected.designation} SPH or CYL is missing or non-finite.` };
  }
  if (!isRecord(model?.outputDomains)) return { code: 'MODEL_OUTPUT_DOMAIN_MISSING', message: 'The model-declared output domains are unavailable.' };
  for (const parameter of ['sph', 'cyl']) {
    const domain = model.outputDomains[parameter];
    if (!withinDomain(prediction[parameter], domain)) return { code: 'REFRACTION_VALUE_OUT_OF_DOMAIN', message: `${expected.designation} ${parameter.toUpperCase()} is outside the model-declared output domain.` };
  }
  if (Number.isFinite(prediction.axis)) {
    if (!withinDomain(prediction.axis, model.outputDomains.axis)) return { code: 'AXIS_OUT_OF_DOMAIN', message: `${expected.designation} Axis is outside the model-declared output domain.` };
  } else if (!(prediction.axis === null && ['UNAVAILABLE', 'NOT_APPLICABLE'].includes(prediction.axisStatus))) {
    return { code: 'AXIS_MISSING_OR_NONFINITE', message: `${expected.designation} Axis is non-finite or lacks an explicit status.` };
  }
  if (prediction.modelId !== model.id || prediction.modelVersion !== model.version) {
    return { code: 'MODEL_VERSION_MISMATCH', message: `${expected.designation} prediction model metadata does not match the Component 10 source model.` };
  }
  if (!isRecord(prediction.units) || prediction.units.sph !== model.outputDomains.sph.unit
    || prediction.units.cyl !== model.outputDomains.cyl.unit || prediction.units.axis !== model.outputDomains.axis.unit
    || prediction.axisConvention !== model.axisConvention) {
    return { code: 'PREDICTION_UNITS_OR_AXIS_CONVENTION_INVALID', message: `${expected.designation} units or Axis convention do not match the model declaration.` };
  }
  return null;
}

function assessReliabilitySignals(prediction, expected, model, policy, reasons) {
  let evaluatedSignals = 0;
  const confidence = prediction.confidence;
  if (confidence?.status === 'AVAILABLE') {
    const minimum = policy.confidenceMinimumByKind[confidence.kind];
    const domain = model?.outputConfidenceDomain;
    if (!Number.isFinite(confidence.value) || !Number.isFinite(minimum) || domain?.kind !== confidence.kind) {
      reasons.push(reason('CONFIDENCE_POLICY_UNCONFIGURED', 'RETEST', expected.designation, `${expected.designation} model confidence has no configured model-specific threshold.`));
    } else if (minimum < domain.min || minimum > domain.max) {
      reasons.push(reason('CONFIDENCE_POLICY_OUT_OF_DOMAIN', 'INVALID', expected.designation, `${expected.designation} confidence threshold is outside the model-declared confidence scale.`));
    } else if (confidence.value < minimum) {
      reasons.push(reason('MODEL_CONFIDENCE_LOW', 'LOW_CONFIDENCE', expected.designation, `${expected.designation} model confidence is below the configured threshold.`));
      evaluatedSignals++;
    } else evaluatedSignals++;
  } else if (confidence?.status !== 'UNAVAILABLE') {
    reasons.push(reason('CONFIDENCE_STATUS_INVALID', 'INVALID', expected.designation, `${expected.designation} confidence availability state is invalid.`));
  }

  const uncertainty = prediction.uncertainty;
  if (uncertainty?.status === 'AVAILABLE') {
    const rule = policy.uncertaintyMaximumByFormat[uncertainty.format];
    const value = readUncertaintyValue(uncertainty.value, rule?.path);
    if (!rule || !Number.isFinite(value)) {
      reasons.push(reason('UNCERTAINTY_POLICY_UNCONFIGURED', 'RETEST', expected.designation, `${expected.designation} uncertainty format has no applicable configured limit.`));
    } else if (value > rule.maximum) {
      reasons.push(reason('MODEL_UNCERTAINTY_HIGH', 'LOW_CONFIDENCE', expected.designation, `${expected.designation} uncertainty exceeds the configured limit.`));
      evaluatedSignals++;
    } else evaluatedSignals++;
  } else if (uncertainty?.status !== 'UNAVAILABLE') {
    reasons.push(reason('UNCERTAINTY_STATUS_INVALID', 'INVALID', expected.designation, `${expected.designation} uncertainty availability state is invalid.`));
  }
  if (confidence?.status !== 'AVAILABLE' && uncertainty?.status !== 'AVAILABLE') {
    reasons.push(reason('RELIABILITY_EVIDENCE_UNAVAILABLE', 'RETEST', expected.designation, `${expected.designation} has neither model confidence nor uncertainty evidence.`));
  } else if (!evaluatedSignals && !reasons.some(item => item.eye === expected.designation && ['CONFIDENCE_POLICY_UNCONFIGURED', 'UNCERTAINTY_POLICY_UNCONFIGURED'].includes(item.code))) {
    reasons.push(reason('RELIABILITY_EVIDENCE_UNEVALUATED', 'RETEST', expected.designation, `${expected.designation} reliability evidence could not be evaluated.`));
  }
}

function assessCaptureEvidence(prediction, expected, policy, reasons) {
  const evidence = prediction.captureEvidence;
  if (!evidence || !isCaptureEvidence(evidence, prediction.sourceCaptureId)) {
    if (policy.requireCaptureEvidence) reasons.push(reason('CAPTURE_QUALITY_UNAVAILABLE', 'RETEST', expected.designation, `${expected.designation} image-quality and capture evidence is unavailable.`));
    return;
  }
  const quality = evidence.capturedQuality;
  assessQualityEvidence(quality, expected, 'captured frame', reasons);
  assessQualityEvidence(evidence.liveQuality, expected, 'live preview', reasons);

  if (policy.requireCaptureStability && (evidence.stability.positionStable !== true || evidence.stability.eyeTrackingStable !== true
    || !Number.isFinite(evidence.stability.stableForMs) || evidence.stability.qualitySamples === null)) {
    reasons.push(reason('CAPTURE_STABILITY_INCOMPLETE', 'RETEST', expected.designation, `${expected.designation} capture stability metadata is incomplete.`));
  }
  if (evidence.positioning.ready !== true || evidence.positioning.stable !== true || evidence.positioning.distanceStatus !== 'ACCEPTABLE') {
    reasons.push(reason('CAPTURE_POSITIONING_INVALID', 'RETEST', expected.designation, `${expected.designation} captured position was not verified.`));
  }
}

function assessQualityEvidence(quality, expected, label, reasons) {
  const qualityEye = quality?.eyes?.[expected.designation];
  if (!quality || !qualityEye) {
    reasons.push(reason('EYE_QUALITY_EVIDENCE_MISSING', 'RETEST', expected.designation, `${expected.designation} ${label} quality evidence is missing.`));
    return;
  }
  if (qualityEye.eye !== expected.eye || qualityEye.designation !== expected.designation) {
    reasons.push(reason('QUALITY_EYE_IDENTITY_INVALID', 'INVALID', expected.designation, `${expected.designation} quality evidence has a mismatched eye identity.`));
  }
  if (quality.valid !== true || quality.overallStatus !== 'GOOD' || quality.captureReady !== true
    || quality.blurState !== 'SHARP' || quality.exposureState !== 'ACCEPTABLE'
    || quality.lightingState !== 'ACCEPTABLE' || quality.glareState !== 'NO_EXCESSIVE_GLARE_DETECTED'
    || qualityEye.state !== 'GOOD') {
    reasons.push(reason('IMAGE_QUALITY_FAILED', 'RETEST', expected.designation, `${expected.designation} ${label} did not pass Component 5 image-quality checks.`));
  }
  if (qualityEye.detected !== true || qualityEye.geometryComplete !== true) {
    reasons.push(reason('EYE_LOCALIZATION_INCOMPLETE', 'RETEST', expected.designation, `${expected.designation} eye detection/localization is incomplete.`));
  }
  if (qualityEye.openness !== 'OPEN') reasons.push(reason(qualityEye.openness === 'CLOSED' || qualityEye.openness === 'PARTIALLY_CLOSED' ? 'EYE_NOT_OPEN' : 'EYE_OPENNESS_UNKNOWN', 'RETEST', expected.designation, `${expected.designation} eye openness did not pass the ${label} check.`));
  if (qualityEye.confidence?.state === 'LOW') reasons.push(reason('EYE_DETECTION_CONFIDENCE_LOW', 'LOW_CONFIDENCE', expected.designation, `${expected.designation} eye-detection confidence is below Component 5's recorded threshold.`));
  else if (qualityEye.confidence?.state !== 'SUFFICIENT' || !Number.isFinite(qualityEye.confidence?.value) || !Number.isFinite(qualityEye.confidence?.threshold)) {
    reasons.push(reason('EYE_DETECTION_CONFIDENCE_UNAVAILABLE', 'RETEST', expected.designation, `${expected.designation} eye-detection confidence is unavailable.`));
  } else if (qualityEye.confidence.value < qualityEye.confidence.threshold) {
    reasons.push(reason('EYE_DETECTION_CONFIDENCE_MISMATCH', 'INVALID', expected.designation, `${expected.designation} detection confidence does not meet its recorded Component 5 threshold.`));
  }
  if (!['VISIBLE', 'CLEAR'].includes(qualityEye.visibility?.state) || qualityEye.visibility?.geometryPresent !== true) {
    reasons.push(reason(qualityEye.visibility?.state === 'OCCLUDED' ? 'EYE_OCCLUDED' : 'EYE_VISIBILITY_UNAVAILABLE', 'RETEST', expected.designation, `${expected.designation} visibility/occlusion could not be verified as clear.`));
  }
  if (qualityEye.occlusionState !== 'CLEAR') reasons.push(reason(qualityEye.occlusionState === 'OCCLUDED' ? 'EYE_OCCLUDED' : 'EYE_OCCLUSION_UNAVAILABLE', 'RETEST', expected.designation, `${expected.designation} occlusion evidence is not clear.`));
  if (qualityEye.sharpness?.state !== 'SHARP' || !Number.isFinite(qualityEye.sharpness?.value) || !Number.isFinite(qualityEye.sharpness?.threshold)) {
    reasons.push(reason(qualityEye.sharpness?.state === 'BLURRED' ? 'IMAGE_BLUR' : 'IMAGE_SHARPNESS_UNAVAILABLE', 'RETEST', expected.designation, `${expected.designation} ${label} sharpness did not pass its recorded technical threshold.`));
  } else if (qualityEye.sharpness.value < qualityEye.sharpness.threshold) {
    reasons.push(reason('IMAGE_BLUR', 'RETEST', expected.designation, `${expected.designation} sharpness is below Component 5's recorded threshold.`));
  }
  if (qualityEye.glareState !== 'CHECKED') reasons.push(reason(qualityEye.glareState === 'EXCESSIVE' ? 'EXCESSIVE_GLARE' : 'GLARE_UNVERIFIED', 'RETEST', expected.designation, `${expected.designation} glare check did not pass.`));
  if (qualityEye.exposureState !== 'ACCEPTABLE') reasons.push(reason('EXPOSURE_UNVERIFIED', 'RETEST', expected.designation, `${expected.designation} exposure check did not pass.`));
  if (quality.motion?.state !== 'STABLE' || quality.motion.stable !== true) reasons.push(reason('CAPTURE_MOTION_UNSTABLE', 'RETEST', expected.designation, `${expected.designation} ${label} motion was not verified stable.`));
  if (quality.positioning?.state !== 'ACCEPTABLE' || quality.positioning.positioningReady !== true) reasons.push(reason('POSITIONING_UNSTABLE', 'RETEST', expected.designation, `${expected.designation} ${label} positioning was not verified acceptable.`));
}

function assessConsistency(predictions, expected, policy, reasons) {
  if (predictions.length <= 1) return { status: predictions.length === 1 ? 'SINGLE_CAPTURE' : 'INSUFFICIENT_DATA', pairwiseMaximumDeltas: null, tolerances: null };
  const tolerances = policy.consistencyTolerances;
  if (!tolerances || REFRACTION_PARAMETERS.some(parameter => !Number.isFinite(tolerances[parameter]) || tolerances[parameter] < 0)) {
    reasons.push(reason('CONSISTENCY_POLICY_UNCONFIGURED', 'RETEST', expected.designation, `${expected.designation} repeated predictions have no configured per-parameter consistency tolerances.`));
    return { status: 'UNASSESSED', pairwiseMaximumDeltas: null, tolerances: null };
  }
  const maximum = { sph: 0, cyl: 0, axis: 0 };
  for (let left = 0; left < predictions.length; left++) for (let right = left + 1; right < predictions.length; right++) {
    for (const parameter of REFRACTION_PARAMETERS) {
      const a = predictions[left][parameter], b = predictions[right][parameter];
      if (parameter === 'axis' && a === null && b === null && predictions[left].axisStatus === predictions[right].axisStatus && predictions[left].axisStatus === 'NOT_APPLICABLE') continue;
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        reasons.push(reason('CONSISTENCY_PARAMETER_UNAVAILABLE', 'RETEST', expected.designation, `${expected.designation} repeated ${parameter.toUpperCase()} measurements cannot be compared.`));
        continue;
      }
      const delta = parameter === 'axis' ? circularAxisDifference(a, b) : Math.abs(a - b);
      maximum[parameter] = Math.max(maximum[parameter], delta);
    }
  }
  const inconsistent = REFRACTION_PARAMETERS.some(parameter => maximum[parameter] > tolerances[parameter]);
  if (inconsistent) reasons.push(reason('REPEATED_PREDICTIONS_DISAGREE', 'INCONSISTENT', expected.designation, `${expected.designation} repeated predictions exceed one or more configured consistency tolerances.`));
  return { status: inconsistent ? 'INCONSISTENT' : 'CONSISTENT', pairwiseMaximumDeltas: maximum, tolerances: { ...tolerances } };
}

function confidenceSummary(predictions) {
  const available = predictions.flatMap(prediction => prediction.confidence?.status === 'AVAILABLE'
    ? [{ sourcePredictionId: prediction.sourcePredictionId, value: prediction.confidence.value, kind: prediction.confidence.kind }]
    : []);
  return { status: available.length ? 'AVAILABLE' : 'UNAVAILABLE', values: available };
}

function eyeResult(expected, status, predictions, reasons, detail) {
  return {
    eye: expected.eye,
    designation: expected.designation,
    valid: status === 'VALID',
    status,
    predictions: predictions.map(copyPrediction),
    predictionCount: predictions.length,
    confidence: detail.confidence,
    consistency: detail.consistency,
    reasons,
  };
}

function copyPrediction(prediction) {
  return {
    sourceCaptureId: prediction.sourceCaptureId,
    sourcePredictionId: prediction.sourcePredictionId,
    eye: prediction.eye,
    designation: prediction.designation,
    sph: prediction.sph,
    cyl: prediction.cyl,
    axis: prediction.axis,
    axisStatus: prediction.axisStatus,
    units: prediction.units ? { ...prediction.units } : null,
    confidence: prediction.confidence ? { ...prediction.confidence } : { status: 'UNAVAILABLE', value: null },
    uncertainty: prediction.uncertainty ? cloneJson(prediction.uncertainty) : { status: 'UNAVAILABLE', value: null },
    modelId: prediction.modelId,
    modelVersion: prediction.modelVersion,
  };
}

function invalidResult(code, message, timestamp, analysis, extraReasons = null) {
  const reasons = extraReasons || [reason(code, 'INVALID', null, message)];
  const invalidEye = expected => eyeResult(expected, 'INVALID', [], reasons.filter(item => !item.eye || item.eye === expected.designation), { consistency: { status: 'NOT_ASSESSED' }, confidence: { status: 'NOT_ASSESSED' } });
  return {
    schemaVersion: VALIDITY_RESULT_SCHEMA_VERSION,
    engineVersion: VALIDITY_ENGINE_VERSION,
    timestamp,
    valid: false,
    overallValid: false,
    status: 'INVALID',
    clinicalValidity: 'NOT_ASSESSED',
    technicalValidityOnly: true,
    rightEye: invalidEye(EYES[0]),
    leftEye: invalidEye(EYES[1]),
    reasons,
    recommendations: recommendationsFor('INVALID', 'BLOCKED'),
    retestRequired: true,
    sourceAnalysis: { schemaVersion: analysis?.analysisSchemaVersion || null, analysisVersion: analysis?.analysisVersion || null, predictionModelId: null, predictionModelVersion: null, captureCount: null },
    component12: { status: 'BLOCKED', canPresentScreeningEstimate: false, clinicalValidity: 'NOT_ASSESSED', predictionCounts: { OD: 0, OS: 0 } },
    component13: { status: 'RETEST_REQUIRED', retestRequired: true, predictionCounts: { OD: 0, OS: 0 }, affectedEyes: [] },
  };
}

function resolvePolicy(policy) {
  const value = { ...DEFAULT_VALIDITY_POLICY, ...policy };
  if (!isRecord(value.confidenceMinimumByKind) || !isRecord(value.uncertaintyMaximumByFormat)
    || (value.consistencyTolerances !== null && (!isRecord(value.consistencyTolerances)
      || REFRACTION_PARAMETERS.some(parameter => !Number.isFinite(value.consistencyTolerances[parameter]) || value.consistencyTolerances[parameter] < 0)))
    || typeof value.requireCaptureEvidence !== 'boolean' || typeof value.requireCaptureStability !== 'boolean') {
    throw new TypeError('Component 11 policy must use explicit finite confidence, uncertainty, and consistency thresholds.');
  }
  for (const threshold of Object.values(value.confidenceMinimumByKind)) if (!Number.isFinite(threshold)) throw new TypeError('Confidence thresholds must be finite numbers in the model-declared confidence scale.');
  for (const rule of Object.values(value.uncertaintyMaximumByFormat)) {
    if (!isRecord(rule) || !Number.isFinite(rule.maximum) || (rule.path !== undefined && !Array.isArray(rule.path))) throw new TypeError('Uncertainty rules require a finite maximum and optional object path.');
  }
  return value;
}

function readUncertaintyValue(value, path = undefined) {
  if (path === undefined) return Number.isFinite(value) ? value : null;
  let current = value;
  for (const key of path) {
    if (!isRecord(current) && !Array.isArray(current)) return null;
    current = current[key];
  }
  return Number.isFinite(current) ? current : null;
}

function withinDomain(value, domain) {
  return isRecord(domain) && Number.isFinite(value) && Number.isFinite(domain.min) && Number.isFinite(domain.max)
    && value >= domain.min && value <= domain.max && (value !== domain.min || domain.minInclusive === true) && (value !== domain.max || domain.maxInclusive === true);
}

function circularAxisDifference(a, b) {
  const difference = Math.abs(a - b) % 180;
  return Math.min(difference, 180 - difference);
}

function reason(code, severity, eye, message) { return { code, severity, ...(eye ? { eye } : {}), message }; }

function recommendationsFor(status, component12Status) {
  if (status === 'INVALID') return ['STOP_RESULT_FLOW', 'RECAPTURE_OR_RESTART_SCREENING'];
  if (status === 'INCONSISTENT') return ['RETEST_AFFECTED_EYE', 'DO_NOT_COMBINE_CONFLICTING_PREDICTIONS'];
  if (status === 'LOW_CONFIDENCE') return ['RETAKE_CAPTURE_OR_RETEST', 'DO_NOT_PRESENT_AS_RELIABLE'];
  if (status === 'RETEST_REQUIRED') return ['RETAKE_OR_RESTART_SCREENING', 'DO_NOT_PRESENT_AS_RELIABLE'];
  return [component12Status === 'CONSISTENCY_REVIEW_REQUIRED' ? 'SEND_TO_COMPONENT_13' : 'CONTINUE_TO_COMPONENT_12_SCREENING_RESULT'];
}

function makeTimestamp(now) {
  try {
    const time = now();
    if (Number.isFinite(time)) {
      const value = new Date(time);
      if (Number.isFinite(value.getTime())) return value.toISOString();
    }
  } catch { /* Fall back to the local clock when an injected clock is invalid. */ }
  return new Date().toISOString();
}

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function nonEmptyString(value) { return typeof value === 'string' && value.trim().length > 0; }

function cloneJson(value) {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item)]));
  return value;
}
