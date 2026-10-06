# Component 18 — Medical Safety Layer

`src/safety.js` is the shared, versioned boundary for proceeding with this
vision-screening/refractive-error-estimation tool. Its decisions are technical
workflow states, not clinical triage or disease assessments.

## Decision rules

- `STOP_AND_SEEK_CARE`: Component 1 reports `yes` to a sudden vision change,
  eye pain/significant redness/unusual light sensitivity, a serious eye injury
  that has not been assessed, or follow-up after eye surgery that is still
  needed. The app does not infer a diagnosis or add a time window to these
  answers.
- `REQUIRES_RETEST`: the existing Component 5 quality result is not valid,
  Component 6 reports incomplete capture, Component 9 reports invalid output,
  Component 11 reports invalid/low-confidence/inconsistent/retest-required, or
  Component 13 requests another attempt. The configured technical checks are
  passed through; this layer does not add numeric clinical cutoffs.
- `SCREENING_LIMITED`: Component 17 reports a missing required capability, no
  configured local prediction model, or Component 13 reaches its configured
  retry limit. The user is not offered a confirmed estimate.
- `SAFE_TO_SCREEN`: none of the above conditions is present. This alone does
  not certify device suitability, model accuracy, clinical validity, or the
  presence/absence of an eye condition.

There are **no new numerical confidence, blur, resolution, symptom-duration,
or clinical-refraction thresholds** in Component 18. Existing Component 11,
Component 13, Component 5, and Component 17 system/model policies remain the
source for their respective technical checks. Missing model policy values are
not guessed.

## Wiring and privacy

Component 1 invokes the same engine before allowing the camera route. Component
17 compatibility and Component 5 quality checks update its Component 16
in-memory session snapshot. Component 9 errors and Component 11/13 decisions
are consumed by the app router. Component 12 requires both the existing result
gate and an explicit `SAFE_TO_SCREEN` decision before exposing any estimates;
the result and retest screens use the shared status copy. Safety data is not
written to persistent history separately, and this layer does not retain eye
images, camera frames, or personal details.

The only medical action is plain-language advice to stop routine screening and
contact an eye-care professional or urgent medical service when a listed
self-reported warning sign is selected. It does not diagnose or promise
accuracy. A professional eye examination may still be required.
