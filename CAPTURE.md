# Component 6: automatic eye-photo capture

Component 6 mounts only after Component 5 emits `image-quality-ready` for a valid result. It reuses the same camera/video element, Component 3 positioning detector, Component 4 eye-result accessor, and Component 5 quality stream. It does not open a camera or run another detector. A new, explicit assent is required before automatic frame extraction.

## Eligibility and timing

`src/capture-state.js` is the pure prerequisite gate and deterministic state machine. Capture requires an active preview; a fresh, face-detected, acceptable-distance, ready and stable Component 3 result; fresh stable Component 4 geometry for both anatomical eyes; verified left/OS and right/OD identities in the unmirrored camera coordinate space; both eyes open with iris geometry; and a fresh Component 5 `valid: true`, `overallStatus: "GOOD"`, capture-ready result. Sharpness, exposure/lighting, glare, motion, per-eye confidence, and occlusion/visibility checks must all pass. Missing confidence or visibility is not inferred from geometry or pixel heuristics.

The defaults require at least 900 ms of continuous eligibility and two distinct quality-result timestamps before a capture can begin. Any failed prerequisite resets the stability window. The existing C3 stable flag, C4 tracker stability, and C5 motion result are used rather than implementing parallel detection or movement metrics. Only one extraction/validation can be active at once.

## Frame capture and validation

`src/capture-image.js` draws the intrinsic pixels of the existing video element to a reusable canvas and encodes them as a lossless PNG Blob. CSS mirroring affects display only; the source frame and eye coordinates remain in the unmirrored camera coordinate system. The source must be at least 640×360 in either orientation and no larger than the configured 16-megapixel safety limit. No upscaling is performed.

For post-capture checks, the PNG Blob is decoded back and its dimensions verified before a temporary reduced canvas copy (capped at 480 pixels on its long side) is analyzed. Component 5's image-quality analyzer runs over those decoded pixels with the corresponding eye and positioning measurements. The frame is emitted only if this captured-image check passes and the current upstream results remain eligible after extraction. Both temporary canvases are reset after each attempt and the decoded bitmap is closed; the validated full-resolution PNG remains in memory for the downstream handoff.

## Retry and downstream contract

Failures are retried automatically up to three attempts per requested image, with a 500 ms backoff and a fresh stability window. After the limit, the UI offers a restart action. `requiredCaptureCount` defaults to one and is configurable; the same rules apply independently to each requested frame. Unchecking capture assent or unmounting invalidates any in-flight extraction so it cannot emit a frame. Previously emitted but still-retained records are cleared and a local `eye-capture-cancelled` event tells a downstream consumer to discard them.

Each validated image is emitted in `eye-capture-ready` as a `schemaVersion: "1.0.0"` record from `src/capture-contract.js`: a validated PNG `image` Blob, MIME type, dimensions, wall-clock and monotonic timestamps, capture ID/index, unmirrored anatomical left/OS and right/OD detection metadata including eye corners, eyelid openness ratio, and iris boundary/bounds, positioning summary, captured-frame and live quality results, and stability metadata. When the requested count is met, `eye-capture-complete` carries the validated records. If assent is withdrawn or the session ends before downstream use, `eye-capture-cancelled` identifies already-emitted records that should be discarded. No image data is written to storage, logged, or uploaded. Component 7 consumes the completion event and Component 8 consumes its preprocessed batch; Component 9 is not implemented here.

## Current upstream limitation and verification scope

The current Component 4 Face Landmarker does not supply per-eye confidence or visibility/occlusion scores. Component 5 therefore correctly reports `UNKNOWN`/`valid: false` for the current model, and Component 6 does not mount or capture in that state. The capture gate is intentionally not weakened to make the UI appear operational; trusted confidence and occlusion evidence must be added upstream before automatic capture can become eligible.

Tests use synthetic state and mocked canvas interfaces to check gates, timing, retries, output metadata, and extraction behavior. They do not establish camera-specific image quality or clinical validity. A physical-device browser test and calibration remain necessary.
