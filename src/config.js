export const ELIGIBILITY = Object.freeze({ minimumAge: 18, maximumAge: 120 });
export const SCHEMA_VERSION = '1.0.0';
// Binary self-reports route out of routine screening; these are not diagnoses.
export const URGENT_RESPONSES = Object.freeze({
  suddenVisionChange: 'yes',
  painfulSymptoms: 'yes',
  seriousEyeInjury: 'yes',
  pendingEyeSurgeryFollowup: 'yes',
});

// Leave unsupported thresholds unset. Populate only from the deployed model's
// specification and validated screening-system requirements.
export const VALIDITY_POLICY = Object.freeze({
  confidenceMinimumByKind: Object.freeze({}),
  uncertaintyMaximumByFormat: Object.freeze({}),
  consistencyTolerances: null,
  requireCaptureEvidence: true,
  requireCaptureStability: true,
});

// Retries are a bounded technical recovery mechanism, not a clinical limit.
// Repeated estimates remain separate unless model-specific tolerances are set.
export const RETEST_POLICY = Object.freeze({
  maxRetests: 2,
  consistencyTolerances: VALIDITY_POLICY.consistencyTolerances,
});
