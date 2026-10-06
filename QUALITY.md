# Component 5: image quality

Component 5 mounts after Component 4 reports stable two-eye geometry. It moves the existing video element into its new view, listens for Component 4's `eye-localization-update` events, samples that same video at 750 ms intervals, and uses the existing Component 3 positioning snapshot. It does not request camera access, capture a still photo, open another stream, load another vision model, or perform another face/eye detector pass.

Before pixel sampling starts, the user gives a separate assent. A canvas copy is downscaled so its longest side is at most 480 pixels. Only one sample can be processed at a time. The sample stays in memory and the canvas is cleared when the component is stopped or unmounted. The output contains measurements and reasons, not pixel data. No files, network requests, storage, or pixel logging are introduced by this component.

## Deterministic checks

`src/image-quality.js` exports `analyzeImageQuality(frame, context)` and `IMAGE_QUALITY_CONFIG`. Configuration defaults are engineering starting points, not thresholds validated across cameras or for clinical use.

- Basic validation checks source/sample dimensions and the exact RGBA buffer length. Minimum source dimensions are 640×360 in either orientation (long side 640, short side 360). Each eye region must be at least 28×12 source pixels and remain inside a 2% edge margin.
- Sharpness uses the variance of a four-neighbor Laplacian over each eye bounding box. The default minimum is 32 at the checker’s 480-pixel maximum sample size. It is an image-texture heuristic; noise and device processing can affect it.
- Each eye is measured independently for luminance mean, median, 10th/90th percentiles, clipped-shadow fraction, and clipped-highlight fraction. Underexposure defaults to median luminance below 42; overexposure defaults to median above 222 or at least 12% pixels at luminance 250+. Severe shadow defaults to at least 28% at luminance 14 or below. Uneven lighting is flagged when left/right eye-region means differ by more than 48 levels on an 8-bit luminance scale.
- Glare is a heuristic over clipped-bright pixels in each eye box and (when Component 4 supplies iris-boundary points) the iris bounding region. The eye-box thresholds reject at least 12% clipped pixels or a connected bright component covering at least 5.5% of the box (and six pixels). The iris-specific thresholds reject at least 25% clipped pixels or a connected component covering at least 20% of the iris region (and six pixels). Small isolated highlights are not rejected. This does not identify spectacle lenses or prove that a pupil/iris is unobscured.
- Closed or partially closed eyes use Component 4's normalized eyelid state. Eye bounds, geometry/iris completeness, distance, positioning freshness/stability, and face crop are checked from the existing Components 3–4 outputs. Motion uses C3 positioning stability, C4 tracking stability, plus normalized inter-sample eye-center displacement; a displacement greater than 2% of the source-frame diagonal is rejected. Low sharpness is the motion-blur proxy; no second optical-flow tracker is run.
- Numeric per-eye confidence is compared with a configurable 0.65 threshold only if a future model provides it. Occlusion accepts explicit `VISIBLE`/`CLEAR` or rejects explicit `OCCLUDED`; unknown/missing evidence remains unknown. No confidence or visibility score is inferred from sharpness or geometry.

There is no weighted aggregate score. A single retake-level reason forces `overallStatus: "RETAKE"`; absent essential measurements produce `"UNKNOWN"`; only when every required check is explicitly acceptable is status `"GOOD"` and `valid: true`.

## Downstream result

Every analyzed sample emits a bubbling `image-quality-update` event on the app root with `detail.result`:

```js
{
  schemaVersion: '1.0.0',
  timestamp,
  valid: false,
  overallStatus: 'GOOD' | 'RETAKE' | 'UNKNOWN',
  technicalUsable: Boolean,
  captureReady: Boolean,
  image, leftEye, rightEye, blur, exposure, lighting,
  glare, motion, positioning, eyeVisibility, occlusion, detectionConfidence,
  reasons: [{ code, severity, eye? }],
  feedback: [/* user-facing suggestions */]
}
```

Component 6 must gate capture on `result.valid === true` (equivalently `captureReady`), not `technicalUsable`. Every retake decision includes one or more machine-readable reason codes. `image-quality-ready` fires only on a transition into `valid === true`; `image-quality-update` continues with each fresh sample.

### Current-model limitation

Component 4's current Face Landmarker result exposes complete eye geometry but explicitly sets per-eye `confidence` to `null` and `visibility.state` to `UNAVAILABLE`. Component 5 consequently reports `EYE_CONFIDENCE_UNAVAILABLE` and `EYE_OCCLUSION_UNVERIFIED`, returns `overallStatus: "UNKNOWN"`, and does not authorize automatic capture, even if all measurable pixel and positioning checks pass. This is intentional fail-closed behavior; Component 6 cannot become capture-ready with the current model until trusted per-eye confidence and occlusion/visibility evidence is added. Do not remove this gate by treating geometry or pixel heuristics as a confidence score.

## Validation limits

Tests use synthetic RGBA images and mocked Component 3/4 values. They verify deterministic behavior and interface semantics, not physical-device compatibility, medical suitability, prescription accuracy, or clinical image-quality thresholds. Browser canvas color management, HDR, camera sharpening/noise reduction, and video resolution can change these measurements; real-device calibration remains necessary.
