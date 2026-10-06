# Component 16 — Privacy & Local Data Layer

`src/local-data-store.js` is the application data boundary. Components should call this service instead of opening IndexedDB or adding `localStorage` keys. Component 14 receives the central service's history-compatible methods; Component 15 reads its selected C12/C14 record; Component 17 can call `getStorageAvailability()`.

## Storage contract

- IndexedDB database: `vision-screening-local`.
- Database version 2. Existing version-1 `results` records and indexes are preserved; the upgrade creates `appData` for consent receipts and explicitly approved settings/session metadata.
- Result records retain the existing C14 `schemaVersion: 1.0.0` and are validated by the existing OD/OS result contract. C16 does not recalculate or alter values.
- App-data envelopes have schema version `1.0.0`. Approved keys are `consent`, `settings`, and `session-metadata`; the data service allowlists fields and bounds serialized sizes.
- Questionnaire drafts, the C1 result object, C10/C11 results, C13 state, and capture metadata are held through the central service in memory and cleared on reset/page exit. Raw images, frames, pixels, feature vectors, and camera objects are filtered or rejected from persisted app data.
- C1's opt-in controls history persistence. Only when the user opts in is a minimal timestamped receipt stored with the history choice. If they opt out, the consent choice remains in memory for the active session and any prior consent receipt is removed. If storage is unavailable, restricted, or full, the UI reports that history may not persist; screening remains local and can continue.

## Controls and limitations

The history/privacy screen offers a stored-data summary, confirmed per-result deletion, clear-results, reset-current-session, and confirmed clear-all-local-data actions. Clear-all removes both IndexedDB stores and the current in-memory session. No sync/cloud service is configured. Data is not encrypted by this browser layer; it remains subject to the device account, browser profile, private-mode behavior, quota, and browser eviction. This implementation does not claim a legal or regulatory certification.
