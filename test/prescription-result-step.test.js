import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatRefractionValue,
  mountPrescriptionResultStep,
  preparePrescriptionResult,
} from '../src/prescription-result-step.js';

function prediction(eye, designation, sph, cyl, axis) {
  return {
    valid: true, eye, designation, sourceCaptureId: `capture-${designation}`,
    sourcePredictionId: `prediction-${designation}`, sph, cyl, axis, axisStatus: 'AVAILABLE',
    units: { sph: 'D', cyl: 'D', axis: 'deg' },
  };
}

function group(eye, designation, refractiveValues) {
  return {
    eye, designation, status: 'VALID', valid: true, predictionCount: 1,
    predictions: [prediction(eye, designation, ...refractiveValues)],
  };
}

function validResult() {
  return {
    schemaVersion: '1.0.0', engineVersion: '1.0.0', timestamp: '2026-10-06T10:00:00.000Z',
    status: 'VALID', valid: true, overallValid: true, technicalValidityOnly: true, clinicalValidity: 'NOT_ASSESSED',
    component12: { status: 'READY_FOR_SCREENING_ESTIMATE', canPresentScreeningEstimate: true },
    rightEye: group('right', 'OD', [-1.125, -.5, 90]),
    leftEye: group('left', 'OS', [2.25, -1.125, 12.345]),
    reasons: [],
  };
}

class FakeNode {
  constructor(tagName = 'div') { this.tagName = tagName; this.children = []; this.listeners = new Map(); this.classList = { add() {} }; this.hidden = false; this.textContent = ''; this.className = ''; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  addEventListener(type, handler) { const handlers = this.listeners.get(type) || []; handlers.push(handler); this.listeners.set(type, handlers); }
  removeEventListener(type, handler) { this.listeners.set(type, (this.listeners.get(type) || []).filter(current => current !== handler)); }
  click() { for (const handler of this.listeners.get('click') || []) void handler(); }
}

function fakeRoot() {
  const nodes = new Map();
  const selectors = [
    '#prescription-result-status', '#prescription-result-heading', '#prescription-result-message',
    '#prescription-result-date', '#prescription-result-eyes', '#prescription-result-reasons',
    '#prescription-result-reason-list', '#prescription-result-retest-note',
    '#prescription-result-retest', '#prescription-result-history', '#prescription-history-status', '#prescription-result-finish',
    '#prescription-result-download', '#prescription-result-preview', '#prescription-result-pdf-status',
  ];
  for (const selector of selectors) nodes.set(selector, new FakeNode());
  return {
    nodes, events: [], markup: '',
    set innerHTML(value) { this.markup = value; },
    get innerHTML() { return this.markup; },
    querySelector(selector) { return nodes.get(selector); },
    dispatchEvent(event) { this.events.push(event); return true; },
  };
}

const previousDocument = globalThis.document;
const previousCustomEvent = globalThis.CustomEvent;
test.before(() => {
  globalThis.document = { createElement: tagName => new FakeNode(tagName) };
  globalThis.CustomEvent = class extends Event { constructor(type, init = {}) { super(type, init); this.detail = init.detail; } };
});
test.after(() => {
  if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  if (previousCustomEvent === undefined) delete globalThis.CustomEvent; else globalThis.CustomEvent = previousCustomEvent;
});

test('shows both validated eyes independently and preserves values in machine-readable event', () => {
  const view = preparePrescriptionResult(validResult(), { locale: 'en-US' });
  assert.equal(view.state, 'READY');
  assert.deepEqual(view.eyes.map(eye => eye.designation), ['OD', 'OS']);
  assert.deepEqual(view.eyes.map(eye => eye.estimate.sph), [-1.125, 2.25]);
  assert.equal(view.eyes[1].estimate.axis, 12.345);
  const root = fakeRoot();
  const cleanup = mountPrescriptionResultStep(root, { validityResult: validResult() }, { locale: 'en-US' });
  const ready = root.events.find(event => event.type === 'prescription-result-ready');
  assert.equal(ready.detail.eyes.OD.sph, -1.125);
  assert.equal(ready.detail.eyes.OS.sph, 2.25);
  assert.match(root.nodes.get('#prescription-result-message').textContent, /not a medical diagnosis or prescription/);
  cleanup();
});

test('Component 12 displays only a passed C13 result and preserves every measurement by OD/OS', () => {
  const c13 = {
    status: 'PASSED', timestamp: '2026-10-06T10:05:00.000Z', presentation: { canPresent: true }, reasons: [],
    rightEye: { designation: 'OD', status: 'CONSISTENT', measurements: [
      { attemptNumber: 1, prediction: prediction('right', 'OD', -1.125, -.5, 90) },
      { attemptNumber: 2, prediction: prediction('right', 'OD', -1.25, -.5, 92) },
    ] },
    leftEye: { designation: 'OS', status: 'CONSISTENT', measurements: [
      { attemptNumber: 1, prediction: prediction('left', 'OS', 2.25, -1.125, 12.345) },
      { attemptNumber: 2, prediction: prediction('left', 'OS', 2.25, -1.125, 12.345) },
    ] },
  };
  const view = preparePrescriptionResult(validResult(), { retestResult: c13, locale: 'en-US' });
  assert.equal(view.canPresent, true);
  assert.deepEqual(view.eyes.map(eye => eye.designation), ['OD', 'OS']);
  assert.deepEqual(view.eyes[0].measurements.map(item => item.estimate.sph), [-1.125, -1.25]);
  assert.equal(view.eyes[1].measurements[0].estimate.axis, 12.345);
  const withheld = preparePrescriptionResult(validResult(), { retestResult: { ...c13, status: 'FAILED', presentation: { canPresent: false }, reasons: [{ code: 'MAX_RETESTS_REACHED', message: 'No reliable result.' }] } });
  assert.equal(withheld.canPresent, false);
  assert.equal(withheld.eyes.some(eye => 'measurements' in eye || 'estimate' in eye), false);
});

test('C12 can receive a failed C13 result after incomplete capture without fabricating Component 11 output', () => {
  const c13 = { status: 'FAILED', timestamp: '2026-10-06T10:05:00.000Z', presentation: { canPresent: false }, reasons: [{ code: 'CAPTURE_INCOMPLETE', message: 'Camera capture stopped.' }] };
  const view = preparePrescriptionResult(null, { retestResult: c13 });
  assert.equal(view.canPresent, false);
  assert.equal(view.status, 'INVALID');
  assert.equal(view.eyes.length, 2);
  assert.equal(view.reasons[0].code, 'CAPTURE_INCOMPLETE');
});

test('C12 offers a direct Component 14 history route without placing result data in a URL', () => {
  const root = fakeRoot(); const cleanup = mountPrescriptionResultStep(root, { validityResult: validResult() });
  root.nodes.get('#prescription-result-history').click();
  const event = root.events.find(item => item.type === 'component14-history-open');
  assert.equal(event.detail.sourceComponent, '12');
  assert.equal(event.detail.url, undefined);
  cleanup();
});

test('C12 report buttons dispatch the existing validated result to Component 15', () => {
  const root = fakeRoot(); const cleanup = mountPrescriptionResultStep(root, { validityResult: validResult() });
  root.nodes.get('#prescription-result-download').click();
  const download = root.events.find(event => event.type === 'component15-pdf-generate-request');
  assert.equal(download.detail.mode, 'download');
  assert.equal(download.detail.result.status, 'VALID');
  assert.equal(download.detail.result.eyes.OD.sph, -1.125);
  root.nodes.get('#prescription-result-preview').click();
  const preview = root.events.filter(event => event.type === 'component15-pdf-generate-request').at(-1);
  assert.equal(preview.detail.mode, 'preview');
  cleanup();
});

test('one-eye-valid and all uncertain/invalid statuses withhold every eye estimate', () => {
  const partial = validResult();
  partial.status = 'RETEST_REQUIRED'; partial.valid = false; partial.overallValid = false;
  partial.component12 = { status: 'BLOCKED', canPresentScreeningEstimate: false };
  partial.rightEye.status = 'VALID';
  partial.leftEye = { eye: 'left', designation: 'OS', status: 'RETEST_REQUIRED', valid: false, predictionCount: 0, predictions: [] };
  for (const status of ['RETEST_REQUIRED', 'LOW_CONFIDENCE', 'INCONSISTENT', 'INVALID']) {
    const candidate = { ...partial, status, reasons: [{ eye: 'OS', code: 'TEST_REASON', message: `C11 says ${status}` }] };
    const view = preparePrescriptionResult(candidate);
    assert.equal(view.canPresent, false);
    assert.equal(view.eyes.some(eye => 'estimate' in eye), false);
    assert.ok(view.reasons.some(reason => reason.message === `C11 says ${status}`));
  }
});

test('rejects wrong OD/OS identity or incomplete result gate into a safe error state', () => {
  const swapped = validResult();
  swapped.rightEye.designation = 'OS';
  assert.equal(preparePrescriptionResult(swapped).state, 'ERROR');
  const blocked = validResult();
  blocked.component12.canPresentScreeningEstimate = false;
  assert.equal(preparePrescriptionResult(blocked).canPresent, false);
});

test('keeps consistent repeated predictions hidden until Component 13 review', () => {
  const result = validResult();
  result.rightEye.predictions.push(prediction('right', 'OD', -1.1, -.5, 92));
  result.rightEye.predictionCount = 2;
  result.leftEye.predictions.push(prediction('left', 'OS', 2.3, -1.1, 46));
  result.leftEye.predictionCount = 2;
  result.component12 = { status: 'CONSISTENCY_REVIEW_REQUIRED', canPresentScreeningEstimate: false };
  result.component13 = { status: 'CONSISTENCY_REVIEW_REQUIRED', affectedEyes: ['OD', 'OS'] };
  const view = preparePrescriptionResult(result);
  assert.equal(view.status, 'VALID');
  assert.equal(view.canPresent, false);
  assert.deepEqual(view.affectedEyes, ['OD', 'OS']);
  assert.match(view.message, /Component 13 must review/);
  assert.equal(view.eyes.some(eye => 'estimate' in eye), false);
});

test('formats signs and Axis degrees without rounding or changing numeric precision', () => {
  assert.equal(formatRefractionValue(-1.125), '-1.125');
  assert.equal(formatRefractionValue(2.25), '+2.25');
  assert.equal(formatRefractionValue(0), '+0');
  assert.equal(formatRefractionValue(Number.NaN), 'Unavailable');
  assert.equal(`${String(12.345)}°`, '12.345°');
});

test('retest action emits the Component 13 handoff with reasons and eye mapping', () => {
  const result = validResult();
  result.status = 'INCONSISTENT'; result.valid = false; result.overallValid = false;
  result.component12 = { status: 'BLOCKED', canPresentScreeningEstimate: false };
  result.reasons = [{ eye: 'OD', code: 'REPEAT_DISAGREEMENT', message: 'Repeated OD predictions differ.' }];
  const root = fakeRoot();
  const cleanup = mountPrescriptionResultStep(root, { validityResult: result });
  root.nodes.get('#prescription-result-retest').click();
  const request = root.events.find(event => event.type === 'component13-retest-request');
  assert.equal(request.detail.sourceComponent, '12');
  assert.deepEqual(request.detail.affectedEyes, ['OD']);
  assert.equal(root.nodes.get('#prescription-result-retest-note').textContent.includes('Component 13'), true);
  cleanup();
});

test('handles empty/error state and renders accessible responsive markup', () => {
  const empty = preparePrescriptionResult(null);
  assert.equal(empty.state, 'ERROR');
  assert.equal(empty.canPresent, false);
  const root = fakeRoot();
  const cleanup = mountPrescriptionResultStep(root, { validityResult: null });
  assert.match(root.markup, /aria-live="polite"/);
  assert.match(root.markup, /aria-labelledby="prescription-result-title"/);
  assert.match(root.markup, /type="button"/);
  assert.equal(root.nodes.get('#prescription-result-eyes').children.length, 0);
  assert.equal(root.nodes.get('#prescription-result-retest').textContent, '');
  cleanup();
});
