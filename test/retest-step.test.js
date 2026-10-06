import test from 'node:test';
import assert from 'node:assert/strict';
import { mountRetestStep } from '../src/retest-step.js';

class FakeNode {
  constructor() { this.listeners = new Map(); this.children = []; this.hidden = false; this.textContent = ''; }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  removeEventListener(type) { this.listeners.delete(type); }
  replaceChildren(...children) { this.children = children; }
  focus() { this.focused = true; }
  click() { this.listeners.get('click')?.(); }
}
const previousDocument = globalThis.document;
test.before(() => { globalThis.document = { createElement: () => new FakeNode() }; });
test.after(() => { if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; });
function root() {
  const nodes = new Map(['#retest-title', '#retest-reasons', '#retest-start', '#retest-exit'].map(key => [key, new FakeNode()]));
  return { nodes, markup: '', set innerHTML(value) { this.markup = value; }, querySelector(key) { return nodes.get(key); } };
}
const result = { status: 'RETEST_AGAIN', retestsUsed: 1, maxRetests: 2, attempts: [{}, {}], reasons: [{ eye: 'OD', code: 'IMAGE_QUALITY_FAILED', message: 'Please retake.' }], recommendation: 'A new measurement is needed.' };

test('retest instructions expose the original reason, attempt count, and route to capture callback', () => {
  const view = root(); let started = 0; let exited = 0;
  const cleanup = mountRetestStep(view, { result }, { onStart: () => started++, onExit: () => exited++ });
  assert.match(view.markup, /existing camera, positioning, capture, preprocessing, and prediction steps/);
  assert.equal(view.nodes.get('#retest-reasons').children[0].textContent, 'OD: IMAGE_QUALITY_FAILED — Please retake.');
  assert.equal(view.nodes.get('#retest-start').hidden, false);
  view.nodes.get('#retest-start').click();
  assert.equal(started, 1);
  view.nodes.get('#retest-exit').click();
  assert.equal(exited, 1);
  cleanup();
});

test('FAILED state stops retry loop and hides capture action', () => {
  const view = root();
  mountRetestStep(view, { result: { ...result, status: 'FAILED', reasons: [] } });
  assert.equal(view.nodes.get('#retest-start').hidden, true);
  assert.match(view.markup, /professional eye examination/);
});
