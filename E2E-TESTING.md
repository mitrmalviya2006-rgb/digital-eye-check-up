# Component 19 — End-to-end validation

## Start the opt-in local test mode (PowerShell)

```powershell
$env:ENABLE_DEV_TEST_MODE = '1'
node server.js
```

Then open `http://127.0.0.1:4173/__dev-tests`. The route is absent unless
`ENABLE_DEV_TEST_MODE=1` and `NODE_ENV` is not `production`. The main screening
page has no developer controls. Do not enable this route on a public server.

## What the dashboard actually tests

- **Run all / selected component tests:** invokes the existing Node built-in
  `node --test` files, which call the real modules from `src/`. It includes
  negative cases and contract/integration fixtures; a fixture test is not
  evidence that hardware or a trained model works.
- **Attempt app journey:** loads the real application in a temporary same-origin
  frame, fills a non-sensitive C1 test questionnaire with consent accepted and
  history saving off, then follows the actual C2/C17 compatibility and C18
  safety gates. It never clicks Start Camera, creates prescription values, or
  stores results. Downstream stages are NOT TESTABLE when the configured model
  is absent.
- **Test actual camera:** after a separate explicit click, runs C17 capability
  checks and Component 2 `CameraController` against the actual browser camera.
  It records the track-reported facing mode, resolution, optional torch support,
  orientation, and storage status, then stops the stream when requested. It
  never turns on the torch or saves a frame. Reported dimensions are not a
  clinical adequacy claim.
- **Clear developer test session:** clears only dashboard report state and its
  isolated frame. It does not erase application history or browser storage.
- **Export:** downloads a JSON report or a readable Markdown report with per-
  component status, timing, dependencies, failures, model/camera state, and
  limitations.

## Status meanings

- `PASS`: the stated check actually ran and passed.
- `FAIL`: a check ran and failed; its error is included.
- `WARNING`: automated contract checks passed, but a real hardware/manual path
  was not exercised or a supported optional capability is absent.
- `NOT TESTABLE`: a required real dependency is unavailable or the stage could
  not be reached; no success is implied.

Run `node --test` for the existing automated suite and `node --run check` for
syntax checks. This project has no bundler or production build script. A full
camera-to-model-to-result E2E run requires a target browser/device, user-granted
camera permission, the relevant positioning/eye-detection runtime artifacts,
and a trained, locally configured Component 9 model/adapter with its verified
input and output contract. No model or synthetic prescription is supplied by
Component 19.
