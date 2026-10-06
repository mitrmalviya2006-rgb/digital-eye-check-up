# Component 14 — Result History

Component 14 subscribes to Component 12's `prescription-result-ready` event. C12 attaches the actual Component 11 validity/confidence summary, Component 13 comparison/attempt summary, model/analysis versions, and per-eye validated measurements. Component 14 only checks the event's schema and eye identities; it does not perform optical calculations or change values.

## Local storage

Records are persisted in IndexedDB database `vision-screening-local`, object store `results`, database version 2. Component 16 adds the `appData` store for versioned consent/settings/session metadata while preserving existing records and indexes during the v1→v2 upgrade. Each result record includes `schemaVersion: "1.0.0"` and an IndexedDB-generated unique numeric `id`. Future record changes must use an explicit migration in `migrateRecord` and increment the database version. Unsupported/corrupted records are skipped and reported, not silently deleted.

The record contains final status, measured/created timestamps, exact OD and OS values (only when the C12 result can present them), C11 technical validity and confidence summaries, C13 consistency/retest details and retained image-free attempts, software/model versions, and reasons. Camera, video, frame, image, pixel, and feature-vector fields are filtered. Questionnaire answers and raw eye captures are not stored. No network or synchronization endpoint is used. Browser storage can still be cleared by the user/browser and may fail due to quota or privacy settings; such failures are surfaced in the UI.

## UI and actions

History is reachable from the questionnaire and C12 result screen. It shows date/time, status, OD/OS summary, validity/retest context, and attempt count. Opening a record shows both eyes, retained measurements, confidence/consistency/reasons and a complete JSON view of the stored record. Invalid, low-confidence and retest-failed records are explicitly labeled; estimates are absent. Single-record delete, clear-history, session reset, and clear-all-local-data actions are confirmed. History saving now requires the optional C1 opt-in; screening still works when storage is unavailable or the user opts out.

Each record offers `component15-report-export-request` with `{ schemaVersion, record, mode }` and is cancelable. Component 15 consumes the exact selected record for local PDF generation; no report recalculation occurs.
