# Component 8: optical feature extraction

Component 8 consumes `eye-preprocessing-complete` from Component 7. It reuses its typed pixel arrays and transformed iris-boundary landmarks; it does not reopen the camera, recapture, decode an image, run another detector, or infer SPH/CYL/Axis. The batch result is emitted locally through `eye-features-ready` and `eye-features-complete`; a malformed input emits `eye-feature-error` and no partial batch.

## What exists in this project

There is no Component 9 prediction engine, trained refractive-error model, or model feature specification in the repository. The schema below is a versioned set of descriptive candidate measurements, not a validated predictor input. Every vector has `modelReady: false`. Future model code must explicitly choose its supported features and supply any required normalization values before using `toFeatureVector`.

Component 8 reads only the current Component 7 image outputs and eye metadata. Questionnaire answers, prior prescription entries, and any future prediction values are not read or included.

## Measurements and fixed order

The fixed `FEATURE_ORDER` is:

1. `eyeWidthFraction` — eye bounding-box width divided by original source-frame width.
2. `eyeHeightFraction` — eye bounding-box height divided by original source-frame height.
3. `eyeAspectRatio` — eye bounding-box width/height in source pixels.
4. `eyeCornerDistanceFractionOfFrameDiagonal` — nasal/temporal eye-corner distance divided by source-frame diagonal.
5. `eyeOpennessRatio` — the existing Component 4 mean eyelid gap divided by eye-corner distance.
6. `eyeOrientationDegrees` — the existing Component 4 eye-corner-line orientation in the unmirrored frame.
7. `irisWidthFraction` — iris-boundary box width divided by original source-frame width.
8. `irisHeightFraction` — iris-boundary box height divided by original source-frame height.
9. `irisAspectRatio` — iris-boundary box width/height in source pixels.
10. `irisToEyeWidthRatio` — iris-boundary box width divided by eye-box width.
11. `irisToEyeHeightRatio` — iris-boundary box height divided by eye-box height.
12. `irisCenterOffsetXWithinEye` — estimated iris-center horizontal offset divided by eye-box width.
13. `irisCenterOffsetYWithinEye` — estimated iris-center vertical offset divided by eye-box height.
14. `irisRegionMeanEncodedLuma` — mean of Rec. 709 weighted encoded RGB values inside the transformed Component 4 iris-boundary polygon.
15. `irisRegionStdDevEncodedLuma` — population standard deviation of the same samples.

The first thirteen are derived from Component 4's normalized camera-frame metadata. Pixel statistics sample the polygon-masked iris-enclosed region from Component 7's already-normalized image, converting supported channel layouts/color modes back into the declared 0–255 pixel domain for measurement. The luminance-like values are encoded RGB intensity descriptors, not calibrated radiometric measurements. The iris enclosure can include pupil pixels and reflections; the current application has no pupil mask, so these statistics must not be described as iris-tissue-only values.

Both eyes are processed separately in fixed `rightEye`/OD and `leftEye`/OS slots. A feature record carries its value, validity, status (`ESTIMATED`, `MEASURED`, or `UNAVAILABLE`), unit, method description, source, and confidence metadata. Component 4's model currently supplies no per-eye confidence, so geometry confidence remains `null` / `UNAVAILABLE`; no percentage is fabricated. Anatomical eye identity is preserved independently of mirrored display position.

## Missing data and pupil limits

Missing openness/orientation metadata or an unavailable transformed iris polygon produces `{ value: null, valid: false, status: "UNAVAILABLE" }`; no zero substitute is used. Missing or impossible required eye/iris geometry, malformed channels, non-finite pixels, invalid ranges, and mismatched OD/OS identity reject the batch with a structured error. Pupil diameter, center, iris ratio, and eccentricity are explicitly unavailable because no pupil boundary detector exists. Pixel thresholds are not used to guess a pupil.

Component 7 and Component 4 preserve the source iris-boundary points through their affine transform so Component 8 can mask its pixel statistics without a second decode. The extractor validates typed-array size/layout and the declared normalization, and yields between captures to leave the browser event loop responsive. It retains no second image buffer.

## Feature-vector adapter

`toFeatureVector(featureSet, { featureOrder, normalization })` maps named, valid features to a `Float32Array` in the caller-supplied order. The default is the documented `FEATURE_ORDER`; custom orders must be unique known names. Missing entries cause a structured error. Normalization defaults to identity; optional mean/std normalization requires one finite mean and positive standard deviation per selected feature. No default means, scaling, imputation, or clinical interpretation is embedded. The result includes names/order, corresponding units, eye designation, data type, normalization, schema version, validity, and `modelReady: false`.

## Privacy and limits

All extraction is local and in-memory. Images and biometric feature values are not uploaded, logged, or persisted. Stopping the feature step or leaving the page releases retained feature references. These measurements are not clinically validated, do not predict refractive error, and are not a diagnosis. As with Components 5–7, the current missing confidence/visibility evidence also means the upstream capture path remains intentionally fail-closed; tests exercise this interface with generated fixtures rather than real capture sessions.
