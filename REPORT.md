# Component 15 — PDF Screening Report

Component 15 creates a local, text-only PDF from the existing Component 12 final-result event or a Component 14 IndexedDB history record. It is a read-only consumer: it does not re-run validation, recalculate measurements, combine repeat values, or include camera images.

## Integration and safety

- Component 12 offers **Download PDF report** and **Preview PDF report** actions. It emits `component15-pdf-generate-request` with the existing versioned result payload.
- Component 14 offers download from a history card and preview from the opened record. It emits `component15-report-export-request` with the exact selected record.
- The app resolves a saved C12 record ID when available; otherwise the PDF identifies the session ID as not assigned. C14 reports use their existing local record ID.
- Measurements are included only when the overall result is `VALID` and `canPresent` is true, each eye is individually `VALID`, and SPH/CYL/Axis plus units meet the existing result contract. Every provided measurement is kept separate; no value is rounded or averaged.
- Uncertain, inconsistent, failed, and incomplete statuses include their recorded reasons and withhold refraction values.
- Generation uses a small built-in PDF 1.4 text/vector writer and the browser `Blob`/object-URL APIs; no remote PDF service or runtime dependency is used.
- Reports include technical status, date/time, OD and OS, attempts/retests, available confidence/consistency and model metadata, and screening limitations. No questionnaire detail is currently approved/persisted by Components 12–14 for this report, so none is added.

## Limits

This is a vision-screening/refractive-error estimation report, not a diagnosis, professional prescription, or substitute for a professional eye examination. Browser PDF preview behavior varies; download remains available as a fallback. PDF creation/storage is local to the browser and does not transmit report data.
