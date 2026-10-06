# Component 9 — prediction engine boundary

Component 9 consumes the versioned in-memory output of Component 8 and provides the `eye-prediction-complete`, `eye-prediction-unavailable`, and `eye-prediction-error` events. It does not consume camera frames, image crops, questionnaire answers, or prior prescriptions. It makes no disease diagnosis and does not declare its predictions clinically valid.

## Current model status

There is no trained refractive-error model, model artifact, model-specific calibration, output head specification, or inference runtime in this repository. The MediaPipe task used by Components 3–4 is a face-landmark model, not an SPH/CYL/Axis model. The project has no ML package dependencies or server inference path. Therefore the default engine has no model configured and returns `MODEL_NOT_CONFIGURED`; it emits no prediction-complete event and no numerical refractive values. This is intentional, not a simulated prediction.

The current end-to-end capture path also remains fail-closed: Component 4 does not report the per-eye confidence/visibility required by Component 5, so Components 5–6 cannot authorize a capture in normal operation.

## Model adapter contract

`createPredictionEngine({ modelSpec, adapter })` is the explicit injection point for a future, real model. No URL, backend, framework, or external inference API is built in. The adapter must identify itself as local (`local: true`) and have a `runtime` matching the manifest. It implements:

- `load(modelSpec, { signal })` — lazily load one local artifact and return `{ session, metadata }` after verifying its declared SHA-256 digest and inspecting the artifact's embedded identity and I/O contract; honor cancellation during loading.
- `infer(session, input, { signal })` — run one inference and release all temporary runtime tensors/buffers it owns.
- `decodeOutput(rawOutput, modelSpec)` — implement the model's documented output decoding, de-normalization, quantization, class/bin mapping, probability handling, or circular-axis decoding. It returns `OD` and `OS` decoded records, each explicitly tagged with its anatomical `eye` and `designation`.
- `dispose(session)` — release model/runtime resources when the step is unmounted. The engine caches one initialized session per engine instance and reuses it; repeated calls with the same Component 8 batch are deduplicated.

The manifest must state its version, model ID/version, local artifact identifier, format, SHA-256 digest, runtime, Component 8 feature schema, ordered feature subset, exact model tensor dtype and dimensions, independent or paired eye mode, paired order when applicable, explicit feature normalization, raw-output tensor contract ID/specification, decoder ID, axis convention, and finite output domains with units and inclusive/exclusive bounds. The engine supplies normalized features as float32; the local adapter must perform any explicitly declared float16 conversion or int8/uint8 quantization exactly as specified. Quantized inputs require a versioned quantization contract, which is checked against loaded artifact metadata. Confidence and uncertainty are optional, but if present must also be declared. The loader's returned artifact metadata is checked against the manifest—including artifact digest, input normalization, tensor dtype, quantization, and output tensor contract—before inference. No generic SPH/CYL/Axis decoder or axis transformation is assumed: the adapter's decoder must use the actual training specification and produce canonical diopters and degrees before the engine validates the declared output domains. Values are rejected, never silently clamped.

The current Component 8 schema is `1.0.0`, with 15 named measurements. The manifest may select a known subset if that is what the trained model expects; missing selected features are rejected rather than imputed. Component 7's preprocessing schema must be `1.0.0`; any additional model-specific image preprocessing is not inferred by Component 9.

## Prediction and downstream contract

On success, `eye-prediction-complete.detail` is versioned and contains model identity, timestamp, elapsed inference time, input/output validity, a prediction-batch ID, and one record per source capture with its own prediction ID. Each capture contains independent `rightEye` (`right`/`OD`) and `leftEye` (`left`/`OS`) results with SPH, CYL, Axis, units, the declared axis convention, and explicit confidence/uncertainty availability. Model output domains and confidence/uncertainty declarations are included so Component 10 can independently validate the emitted values. `clinicalValidity` remains `NOT_ASSESSED`; `component11ReliabilityAssessmentRequired` is true. The UI does not show prescription values before a future Component 11 review.

Component 10 consumes each capture's OD/OS pair from this event and emits an independently grouped, versioned handoff. Component 11 receives the C10 eye records and source model/input/output metadata, including actual confidence or uncertainty only when the decoder provides declared values. Failure events contain structured errors, retryability, and source capture IDs only, not raw images or feature arrays. The app routes non-retryable errors to C10, while keeping retryable runtime/model errors in C9 for its existing retry control. No result is persisted or uploaded. See [EYE-ANALYSIS.md](./EYE-ANALYSIS.md).

## Verification boundary

Automated tests use an explicitly marked mock local adapter only to exercise loading, tensor routing, eye identity, decoding/validation, confidence, caching, and cleanup. Those fixtures are not a trained model and provide no accuracy evidence. Until a real, appropriately validated model and its artifact/runtime contract are supplied, production SPH/CYL/Axis prediction remains unavailable.
