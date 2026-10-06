# Component 11 — Confidence and validity

Component 11 consumes the versioned, eye-separated Component 10 result. It decides technical screening eligibility only; it does not diagnose disease, establish clinical accuracy, or convert an estimate into a prescription.

## Data flow and privacy

Component 6's quality, positioning, and stability metadata is reduced to an image-free evidence summary in Component 7. Components 8, 9, and 10 validate and carry that summary forward with the originating capture ID. No image, pixel buffer, crop, or feature vector is copied into the Component 11 result. Each eye's predictions remain independent and retain their source capture and prediction IDs. Component 11 never swaps eyes, changes values, or averages predictions.

Component 10 dispatches `eye-analysis-complete`; the application passes its detail to `mountValidityStep`. Component 11 then emits:

- `eye-validity-complete`: the full versioned result, including `rightEye`, `leftEye`, reasons, recommendations, and Component 12/13 gates.
- `eye-consistency-assessment`: the eye records, reasons, source analysis, and Component 13 decision for the retest/consistency flow.

Component 12 can consume `result.component12`; it must not display estimates unless `canPresentScreeningEstimate` is true. Component 13 can consume `result.component13` and the consistency event; it must preserve affected-eye/source-capture identity and must not average conflicting values. These are handoff contracts only: Components 12 and 13 do not yet exist in this repository.

## Decisions

- `VALID`: both eyes pass value, model reliability, captured/live quality, localization, visibility, and stability checks. With one prediction per eye, Component 12 is `READY_FOR_SCREENING_ESTIMATE`. With repeated measurements, Component 12 is blocked pending Component 13 consistency review even when the configured pairwise checks pass.
- `LOW_CONFIDENCE`: a configured model-confidence or Component 5 eye-detection threshold is not met.
- `INCONSISTENT`: repeated valid estimates for an eye exceed a configured SPH/CYL/Axis tolerance. Original values are preserved and no averaging occurs.
- `RETEST_REQUIRED`: evidence is unavailable, incomplete, unconfigured, or poor; one or both eyes may need recapture. An unaffected valid eye remains separately represented.
- `INVALID`: Component 10 rejected structure, required metadata contradicts its declaration, or both eyes have only explicitly invalid estimates.

The result includes `schemaVersion`, `engineVersion`, `timestamp`, `valid`, `status`, independent eye summaries, machine-readable reason codes, recommendations, `clinicalValidity: "NOT_ASSESSED"`, and `component12`/`component13` handoffs.

## Threshold policy

`src/config.js` exports `VALIDITY_POLICY`, passed by the application to Component 11. It intentionally has no model-confidence cutoffs, uncertainty limits, or consistency tolerances. Populate these only from the actual model/system specification and validated deployment requirements:

- `confidenceMinimumByKind`: minimum score keyed by the model-declared confidence `kind` and expressed on that model's declared confidence scale.
- `uncertaintyMaximumByFormat`: maximum keyed by the model-declared uncertainty `format`; an optional `path` selects a numeric field when the uncertainty value is structured.
- `consistencyTolerances`: pairwise maximum absolute difference for `sph` and `cyl` in diopters and circular difference for `axis` in degrees.
- `requireCaptureEvidence` and `requireCaptureStability`: fail-closed gates; both are enabled by default.

An available confidence or uncertainty value without a matching configured cutoff does not pass. If both reliability signals are absent, the result needs a retest. Repeated predictions without all three configured consistency tolerances need Component 13/retest review. Image-quality checks consume Component 5's recorded decision and thresholds; Component 11 adds no image-quality cutoff. Do not copy example thresholds from tests into production policy.

## Current model limitation

There is no trained local SPH/CYL/Axis model in this project. Component 9 therefore emits `UNAVAILABLE` and no refractive values or confidence. Also, Component 4 currently lacks the per-eye confidence/visibility evidence required by Component 5, so the capture pipeline is fail-closed. Component 11 is integrated and tested against explicit model contracts, but it cannot produce a valid real-world estimate until the real local model, documented reliability semantics/cutoffs, and upstream eye-quality signals are supplied.
