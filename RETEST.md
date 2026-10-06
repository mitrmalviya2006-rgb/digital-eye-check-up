# Component 13 — Retest & consistency

Component 13 is a local orchestration layer around the existing capture and analysis pipeline. A C11 `eye-validity-complete` result is recorded as an image-free attempt with explicit OD/right and OS/left entries. Invalid attempts remain in the session record; a valid eye can be retained independently even when the other eye failed. A terminal C6 automatic-capture error can also be recorded, but it adds no prediction values.

The state path for a requested retry is `RETEST_AGAIN → PREPARING → CAPTURING → ANALYZING → COMPARING`, then `PASSED`, `RETEST_AGAIN`, or `FAILED`. C13 returns the user to existing C2 camera setup; the normal C3–C9 flow runs again, followed by C10 and C11. Camera/model code is not duplicated. A retry requires camera setup and capture consent through the existing components.

`RETEST_POLICY` is in `src/config.js`. `maxRetests: 2` is a configurable operational safety cap, not a medical limit. `consistencyTolerances` defaults to `null`. No SPH/CYL/Axis comparison can pass for repeated readings until finite, documented thresholds are configured for each parameter. Axis comparison uses circular difference modulo 180 degrees. A prior C11 `INCONSISTENT` bundle is excluded from the post-retest comparison; at least two new valid readings are required, and the new readings are compared pairwise. In all other cases, valid eye-level measurements from earlier attempts remain eligible for that eye's comparison. Unsupported/invalid attempts never become measurements.

Each attempt is retained separately. There is no averaging, selection, clamping, or modification. `PASSED` means only that the applicable technical checks passed; it does not mean clinical validity. When the retry cap is reached, C13 returns `FAILED`, blocks C12 estimates, and recommends professional assessment.

The result includes `schemaVersion`, `engineVersion`, `status`, attempts, separate `rightEye`/`leftEye` comparison records and measurement arrays, tolerances, reasons, recommendation, timestamp, and an explicit `presentation` gate. C12 receives the C11 source and C13 result; it displays every measurement only when the C13 gate passes. The `prescription-result-ready` event contains per-eye measurements and technical summaries for C14 history and a future C15 report. It includes no images or raw frames. `component13-retest-result-ready` exposes the machine-readable C13 outcome to other local components.

## Current technical limitation

The current repository's Component 4 has no per-eye confidence or occlusion evidence, so Component 5/6 remain fail-closed. Component 9 also has no trained refractive prediction model or local ML runtime. A genuine end-to-end retest therefore cannot yet produce a valid refractive estimate. C13 reports those unavailable gates and never creates substitute measurements. C14 history and C15 PDF generation are not implemented in this project yet.
