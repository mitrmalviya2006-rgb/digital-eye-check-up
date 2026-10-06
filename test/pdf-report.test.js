import test from 'node:test';
import assert from 'node:assert/strict';
import { generateScreeningReport, prepareReport, createScreeningReportBlob } from '../src/pdf-report.js';

const units = { sph: 'D', cyl: 'D', axis: 'deg' };
function measurement(eye, sph, cyl, axis, attemptNumber = 1) {
  return { eye, designation: eye, attemptNumber, timestamp: '2026-10-06T10:00:00.000Z', sph, cyl, axis, axisStatus: 'AVAILABLE', units };
}
function validHistory() {
  return {
    schemaVersion: '1.0.0', id: 17, measuredAt: '2026-10-06T10:00:00.000Z', status: 'VALID', canPresent: true,
    technicalValidityOnly: true, clinicalValidity: 'NOT_ASSESSED',
    eyes: {
      OD: { eye: 'right', designation: 'OD', status: 'VALID', measurements: [measurement('OD', -1.125, -0.5, 90)] },
      OS: { eye: 'left', designation: 'OS', status: 'VALID', measurements: [measurement('OS', 2.25, 0, 180)] },
    },
    validity: { technicalValidityOnly: true, clinicalValidity: 'NOT_ASSESSED', confidence: { OD: { source: 'model' }, OS: { source: 'model' } } },
    consistency: { status: 'CONSISTENT', eyes: { OD: { status: 'CONSISTENT' }, OS: { status: 'CONSISTENT' } } },
    retest: { status: 'PASSED', retestsUsed: 1, attempts: [{ attemptNumber: 1 }, { attemptNumber: 2 }] },
    attemptCount: 2, versions: { component12: '1.0.0', modelVersion: 'model-7' }, reasons: [],
  };
}
function pdfText(generated) { return new TextDecoder('latin1').decode(generated.bytes).replaceAll('\\(', '(').replaceAll('\\)', ')').replaceAll('\\\\', '\\'); }

test('valid bilateral history creates local PDF with distinct OD/OS exact values and report metadata', () => {
  const result = generateScreeningReport(validHistory()); const text = pdfText(result);
  assert.equal(result.pageCount, 1);
  assert.match(text, /Right Eye \(OD\)/); assert.match(text, /Left Eye \(OS\)/);
  assert.match(text, /SPH -1\.125 D · CYL -0\.5 D · Axis 90°/);
  assert.match(text, /SPH \+2\.25 D · CYL \+0 D · Axis 180°/);
  assert.match(text, /Session \/ result ID: 17/); assert.match(text, /Retests used: 1/);
  assert.match(text, /not a medical diagnosis or/); assert.match(text, /prescription\. It does not replace/);
  assert.equal(result.filename, 'vision-screening-2026-10-06-17.pdf');
});

test('C12 result contract with a single attempt is consumed without changing values', () => {
  const base = validHistory();
  const result = {
    schemaVersion: '1.0.0', timestamp: base.measuredAt, status: 'VALID', canPresent: true,
    eyeStatuses: { OD: 'VALID', OS: 'VALID' },
    eyes: { OD: base.eyes.OD.measurements[0], OS: base.eyes.OS.measurements[0] },
    validity: base.validity,
  };
  const report = prepareReport(result);
  assert.equal(report.eyes.OD.measurements[0].sph, -1.125);
  assert.equal(report.eyes.OS.measurements[0].sph, 2.25);
  assert.equal(report.sessionId, 'Not assigned');
});

test('Component 15 applies the central safety gate and records safety recommendations', () => {
  const source = { ...validHistory(), medicalSafety: { status: 'SCREENING_LIMITED', engineVersion: '1.0.0', canPresentEstimate: false, reasons: [{ code: 'MODEL_UNAVAILABLE', message: 'No local model is configured.' }], warnings: [], recommendations: ['Arrange a professional eye examination.'] } };
  const report = generateScreeningReport(source);
  const text = pdfText(report);
  assert.equal(report.report.canPresent, false);
  assert.equal(report.report.eyes.OD.measurements.length, 0);
  assert.match(text, /Medical safety workflow state: SCREENING LIMITED/);
  assert.match(text, /Arrange a professional eye examination/);
  assert.doesNotMatch(text, /SPH -1\.125/);
});

test('non-presentable, low-confidence, inconsistent, and incomplete results never disclose eye values', () => {
  for (const status of ['LOW_CONFIDENCE', 'INCONSISTENT', 'RETEST_REQUIRED', 'INVALID']) {
    const source = { ...validHistory(), status, canPresent: false, reasons: [{ code: 'NOT_RELIABLE', message: 'Repeat capture required.' }] };
    const text = pdfText(generateScreeningReport(source));
    assert.match(text, new RegExp(`Overall technical status: ${status.replaceAll('_', ' ')}`));
    assert.match(text, /Estimate withheld/);
    assert.doesNotMatch(text, /SPH -1\.125/);
    assert.match(text, /NOT_RELIABLE: Repeat capture required/);
  }
});

test('one-eye data on an invalid/incomplete session is labeled and withheld, not promoted', () => {
  const source = { ...validHistory(), status: 'RETEST_REQUIRED', canPresent: false };
  source.eyes.OS = { eye: 'left', designation: 'OS', status: 'INVALID', measurements: [] };
  const report = prepareReport(source);
  assert.equal(report.eyes.OD.measurements.length, 0);
  assert.equal(report.eyes.OS.status, 'INVALID');
});

test('multiple consistent measurements are all preserved rather than averaged', () => {
  const source = validHistory();
  source.eyes.OD.measurements.push(measurement('OD', -1.25, -0.5, 90, 2));
  const generated = generateScreeningReport(source); const text = pdfText(generated);
  assert.match(text, /Attempt 1: SPH -1\.125/);
  assert.match(text, /Attempt 2: SPH -1\.25/);
  assert.doesNotMatch(text, /SPH -1\.1875/);
});

test('long recorded reasons paginate without clipping and each page has a footer', () => {
  const source = validHistory();
  source.reasons = Array.from({ length: 35 }, (_, i) => ({ code: `CHECK_${i}`, message: 'A recorded technical review reason with enough details to verify that long report text wraps onto another line without clipping.' }));
  const generated = generateScreeningReport(source); const text = pdfText(generated);
  assert.ok(generated.pageCount > 1);
  for (let page = 1; page <= generated.pageCount; page++) assert.match(text, new RegExp(`Page ${page} of ${generated.pageCount}`));
  assert.match(text, /IMPORTANT LIMITATIONS|Important limitations/);
});

test('optional metadata may be absent and records remain reportable', () => {
  const source = validHistory(); delete source.retest; delete source.consistency; delete source.validity; delete source.versions; delete source.reasons; delete source.attemptCount;
  const report = prepareReport(source);
  assert.equal(report.confidence, null); assert.equal(report.consistency, null); assert.equal(report.attempts, null);
  assert.equal(generateScreeningReport(source).pageCount, 1);
});

test('schema, missing values, and bad dates fail cleanly for the UI to announce', () => {
  assert.throws(() => generateScreeningReport({ ...validHistory(), schemaVersion: '99' }), /schema/);
  assert.throws(() => generateScreeningReport({ ...validHistory(), measuredAt: 'not a date' }), /date/);
  const unmarked = validHistory(); unmarked.technicalValidityOnly = false; unmarked.validity.technicalValidityOnly = false;
  assert.throws(() => generateScreeningReport(unmarked), /technical-only/);
  const malformed = validHistory(); malformed.eyes.OS.measurements[0].sph = Number.NaN;
  assert.throws(() => generateScreeningReport(malformed), /missing a structurally valid OS/);
  assert.throws(() => generateScreeningReport(null), /supported/);
});

test('history record data is not mutated and browser Blob uses PDF MIME type', () => {
  const record = validHistory(); const before = structuredClone(record);
  const generated = createScreeningReportBlob(record);
  assert.deepEqual(record, before);
  assert.equal(generated.blob.type, 'application/pdf');
  assert.ok(generated.blob.size > 100);
});
