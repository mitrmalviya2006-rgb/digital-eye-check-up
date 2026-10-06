# Component 17 — Device Compatibility Layer

`src/device-compatibility.js` is the shared capability assessment service. Component 2's existing camera setup requests a check before permission and supplies the active `CameraController` snapshot after the user starts the preview. Components 3–6 consume its local processing plan, and Component 9 uses its model-runtime assessment. Component 16 stores the latest bounded summary in session memory only; device IDs, camera labels, frames, and image data are not stored.

## Evidence and outcomes

- Browser compatibility is decided from secure-context state and required API presence (media capture, workers, transferable image bitmaps, animation frames, WebAssembly, and 2D canvas). User-agent information is displayed as a label only and never gates functionality.
- Camera permission is queried without prompting when the Permissions API allows it. A real camera, rear-facing mode, torch, resolution, frame-rate ranges, and advanced controls are marked unknown until the active media track exposes them.
- `SUPPORTED`, `LIMITED`, and `UNSUPPORTED` distinguish missing required APIs or denied/unavailable camera access from optional hardware support. Torch, rear camera, WebGL/WebGPU, orientation, and storage limits are surfaced with recommendations; optional features are never faked.
- Requested camera constraints are built only from `getSupportedConstraints()`. Resolution and frame-rate requests are ideals, not medical quality cutoffs. If the preview is below the requested dimensions, the app reports a limitation but does not invent a model-specific minimum.
- Captures remain at native camera resolution. Low reported core-count/device-memory hints only slow positioning and quality sampling. They are advisory browser hints, not a benchmark or suitability determination.
- A model backend is selected only when a supplied local model manifest names a runtime and that exact runtime is available. This repository currently has no trained Component 9 model, so its compatibility outcome is unavailable and there is no backend fallback.

Compatibility is technical capability reporting only. It cannot establish clinical suitability, image validity, or prediction accuracy. Browser permission behavior, secure-origin requirements, hardware capabilities, and storage availability vary by browser and may change at runtime.
