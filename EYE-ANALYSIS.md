# Component 10 — Left/right eye analysis

Component 10 consumes the versioned in-memory `eye-prediction-complete`, `eye-prediction-unavailable`, or `eye-prediction-error` result from Component 9. Its pure data boundary is `analyzePredictionResult()` in `src/eye-analysis.js`; it does not call a model, inspect an image, or start capture.

## Eye identity and validation

The C10 handoff always has separate `rightEye` (`eye: "right"`, `designation: "OD"`) and `leftEye` (`eye: "left"`, `designation: "OS"`) groups. Each successful prediction retains SPH, CYL, Axis, units, the exact declared Axis convention, confidence/uncertainty availability, model ID/version, source capture ID, and C9 prediction ID. Values are finite-checked against the model's emitted output domains, including boundary semantics. C10 preserves decoded numbers; it never rounds, clamps, converts conventions, fills values, or averages frames.

OD/OS labels must match the named C9 eye slots. Swapped/duplicate identity, invalid units, domains, confidence/uncertainty, model metadata, timestamps, or capture identity rejects the batch. Rejected output contains no eye values and includes a structured `structuralValidationErrors` entry. An absent named eye slot becomes an explicit `MISSING` prediction with no values; a correctly identified per-eye failure may be marked `MISSING`, `NOT_DETECTED`, `INVALID`, `ERROR`, or `UNAVAILABLE`, also with no values. The other eye's valid result is retained as a partial result. This does not infer anatomical identity from array order or copy one eye into the other.

## Downstream handoff

The versioned output includes:

- `rightEye` and `leftEye` groups with explicit identity, group status, validity, and one `predictions` entry per source capture.
- `overallValid` / `valid`, which are false for partial, unavailable, or rejected results.
- `sourcePrediction` with model identity/version, inference metadata, input/output validity, and C9 schema/engine/batch IDs.
- `component11ReliabilityAssessmentRequired: true`, `component11InputCompatible: true`, `clinicalValidity: "NOT_ASSESSED"`, and any structural validation errors.

Component 11 can assess each eye and each frame independently. Component 12 can consume the stable `rightEye.predictions` and `leftEye.predictions` collections without understanding C9 internals. C10 does not select a preferred frame, reduce multiple values to one, approve reliability, or expose prescription values in its UI. An eventual display must wait for Component 11.

The app advances to C10 after C9 success, model-unavailable results, or non-retryable errors. A retryable C9 runtime error remains in C9 so its existing retry control is still available. C10 failure normalization is tested against C9 error events.

## Privacy and current limitations

Only model/result metadata and eye estimates already returned by C9 are organized in memory. C10 does not retain or log image data and does not contact a service. Stopping screening discards the in-memory handoff.

This repository has no trained refractive model, so its configured end-to-end route produces the explicit unavailable state; no SPH/CYL/Axis estimate is generated. The existing capture path also remains blocked because Components 4–5 do not provide the required per-eye confidence/visibility evidence. See [PREDICTION.md](./PREDICTION.md) and [PRIVACY.md](./PRIVACY.md).
