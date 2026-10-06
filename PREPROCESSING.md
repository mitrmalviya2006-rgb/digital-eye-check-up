# Component 7: eye image preprocessing

Component 7 consumes the `eye-capture-complete` batch from Component 6. It never opens the camera or performs another capture. Each PNG is decoded once, right/OD and left/OS crops are processed sequentially, and one bubbling `eye-preprocessing-ready` event plus `eye-preprocessing-complete` event carries the resulting batch for Component 8. Any invalid input fails the whole batch; `eye-preprocessing-error` carries a structured code and message, and no partial output is emitted.

## Capture and eye validation

Before decoding, Component 7 requires Component 6's `valid: true`, `validationStatus: "VALIDATED"`, and `validation.component: "6"` markers; a non-empty PNG Blob; matching positive dimensions within the configured pixel limit; a passing captured-image quality result; and detected, correctly designated, unmirrored left/OS and right/OD eye metadata. Each eye needs a finite normalized bounding box and detected iris bounds. The decoded bitmap dimensions must exactly match the capture record.

Component 6's record now preserves the eye coordinate space, iris center/bounds, eye corners, and anatomical side/designation. Crops use each eye's normalized bounding box plus configurable horizontal and vertical margins (defaults: 25% and 50% of the eye box dimensions). The margin is clipped at the image boundary only when the complete eye and iris regions remain inside the crop. It never sorts or relabels eyes by screen x-coordinate, so mirrored preview presentation cannot swap OD and OS.

To align with Component 5's existing minimum-size gate, the default crop validation rejects eye boxes under 28 × 12 source pixels; these minimums are configurable. After any configured affine transform, Component 7 also verifies that the mapped iris bounds remain within the output image.

## Geometry and model configuration

The default rotation strategy is `none`, avoiding an unrequested geometric change when no model has specified one. `eye-corners-level` is available as an opt-in strategy: it estimates the eye line from Component 6's nasal/temporal landmarks, rotates that line to horizontal, and rejects missing or excessive angles (default maximum correction 25°). The crop and source-to-output affine matrix are included with each eye result.

There is no Component 9 model in this repository, so its input dimensions and normalization requirements are not guessed. Component 8 now consumes this output for descriptive feature measurements; it does not impose model-specific image tensor requirements. By default, crops retain their geometry-derived native dimensions, return RGB, HWC `Uint8Array` values in the unchanged 0–255 range, and do not resize or normalize. A future consumer can configure both `inputWidth` and `inputHeight`, `colorMode` (`RGB`, `RGBA`, `GRAYSCALE`), `layout` (`HWC`, `CHW`), interpolation, aspect-preserving `contain` or explicit `stretch`, and normalization (`none`, `zero-to-one`, `minus-one-to-one`, or configured `mean-std`). Mean/std vectors are supplied per channel in the original 0–255 pixel domain; none are embedded as defaults.

Exposure/contrast defaults to identity (`brightness: 0`, `contrast: 1`). An explicit deterministic linear adjustment is configurable, but no histogram equalization, automatic repair, sharpening, or hallucination-prone enhancement is applied. Noise reduction defaults to `none`; other filters are rejected until a downstream model specifies a validated method. Any transparent padding created by an opt-in rotation/resize reads as zero when converted to RGB; RGBA retains the alpha channel.

## Output and resource lifetime

Each batch item has `preprocessingVersion`, `sourceCaptureId`, timestamp, source dimensions, effective configuration, `valid: true`, and separate `rightEye`/`leftEye` records. Each eye includes a typed pixel array, dimensions, channel count, color mode, layout, data type, crop region, source-to-output transform, normalization and photometric metadata, and original eye/iris geometry including the transformed iris-boundary polygon. The captured PNG is not duplicated into the output. The decoded `ImageBitmap` is closed and the single reusable temporary canvas is cleared after each capture. Stopping, cancelling, or leaving the page releases the retained output from the component.

## Limits

The current Component 4 model has no per-eye confidence or visibility/occlusion signal, so Component 5 and Component 6 correctly remain fail-closed and normally do not produce captures for Component 7. Tests use constructed validated capture records and mocked canvas/bitmap APIs to exercise this interface; they do not validate clinical relevance, camera calibration, or downstream model accuracy. Canvas interpolation and color management can vary slightly between browsers. Component 8/9 model-specific configuration must be filled in when those models exist.
