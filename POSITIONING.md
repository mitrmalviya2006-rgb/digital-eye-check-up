# Component 3: guided positioning

Component 3 borrows Component 2's existing video element and camera interface. It does not call `getUserMedia`, open another stream, or capture a still photo. The face landmarker runs in a dedicated worker at a maximum of five fresh frames per second. It runs only after the user checks the service-metrics disclosure and selects **Start guidance**. The worker is stopped on exit, page leave, camera loss, or after the user continues from READY.

## Detection and privacy

The implementation uses MediaPipe Face Landmarker 1.0.1 with its face landmark and transformation-matrix outputs. The browser downloads the JS/WASM runtime from jsDelivr and the model from Google Cloud Storage. The model processes frames on-device; frames and landmarks are not sent to either asset host. MediaPipe separately reports performance and usage metrics to Google. The UI explains that behavior and requires the user's explicit agreement before loading the service. If the asset hosts are unavailable, positioning reports an error and offers retry; it never fabricates a face or READY result.

No frame, landmark, or positioning record is persisted or logged. The latest 478-point result stays in memory long enough for the next component to reuse it, then is released with the step/worker.

## Measurements and rules

`src/positioning-config.js` centralizes adjustable thresholds. Face size is an image-space proxy: the diagonal of the normalized face box in source pixels divided by the source frame diagonal. Below 0.19 means `TOO_FAR`, above 0.52 means `TOO_CLOSE`; these are starting framing thresholds, not physical distance and not centimeters. Horizontal centering uses normalized face-box center. Eye level uses the midpoint of MediaPipe eye landmarks; iris centers are compared with each eye's corners for a coarse look-toward-phone check. Head yaw, pitch, and roll are estimated from the model's 4×4 facial transformation matrix; if iris landmarks or that matrix are missing or invalid, READY is prohibited.

The evaluator exponentially smooths measurements (alpha 0.38), requires two consecutive frames before ordinary instruction changes, and requires ten samples spanning at least 1.8 seconds with low center, size, pose, and gaze variation before reporting stable. A lost face or corrective condition immediately prevents READY. READY is also revoked if fresh results stop arriving. The 5 Hz worker loop allows one frame in flight and performs model inference off the UI thread.

The overlay maps normalized source-video bounds into the rendered preview using its actual intrinsic dimensions, CSS container size, and `object-fit` letterbox/crop offsets. Component 2's preview is not mirrored; a `mirroredPreview` option is available if a later camera UI mirrors it. Video resize, container resize, and orientation changes trigger redraws.

## Handoff to Component 4

The root emits `positioning-update` with machine-readable state as measurements arrive. After stable READY and user Continue, it emits `positioning-ready` with the final positioning state, `latestDetection()` (normalized landmarks, transformation matrix, runtime eye-topology definitions, source dimensions, and timestamp), the still-running `positioningDetector`, and a controlled Component 2 camera interface (`getSnapshot`, `withVideoFrame`, `captureFrame`, `stopCamera`). Component 4 subscribes to that same worker and stream rather than opening another camera, model, or face-detection loop. Component 3 itself does not capture an image. See [EYE-LOCALIZATION.md](./EYE-LOCALIZATION.md) for Component 4's output and limitations.

The model and thresholds have not been validated for screening accuracy, specific phone models, or demographic performance. Browser support, model download access, and worker/GPU/CPU performance vary. The guidance only checks approximate framing and pose; it is not a vision measurement or diagnosis.
