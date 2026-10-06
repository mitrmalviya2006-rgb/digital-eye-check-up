import test from 'node:test';
import assert from 'node:assert/strict';
import { mountHistoryStep } from '../src/history-step.js';

class FakeNode {
  constructor() { this.children = []; this.listeners = new Map(); this.dataset = {}; this.hidden = false; this.textContent = ''; this.classList = { add() {} }; }
  addEventListener(type, handler) { const values = this.listeners.get(type) || []; values.push(handler); this.listeners.set(type, values); }
  removeEventListener(type, handler) { this.listeners.set(type, (this.listeners.get(type) || []).filter(value => value !== handler)); }
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
  focus() { this.focused = true; }
  click() { for (const handler of this.listeners.get('click') || []) void handler(); }
}
const previousDocument = globalThis.document;
test.before(() => { globalThis.document = { createElement: () => new FakeNode() }; });
test.after(() => { if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; });

function makeRoot() {
  const selectors = ['#history-title', '#history-state', '#history-record-list', '#history-clear', '#history-back', '#history-detail', '#history-detail-title', '#history-detail-content', '#history-detail-close', '#history-privacy-status', '#history-data-summary', '#history-view-data', '#history-reset-session', '#history-clear-all-data'];
  const nodes = new Map(selectors.map(selector => [selector, new FakeNode()]));
  return { nodes, events: [], innerHTML: '', querySelector(selector) { return nodes.get(selector); }, dispatchEvent(event) { this.events.push(event); for (const handler of this.listeners?.get(event.type) || []) handler(event); return !event.defaultPrevented; }, addEventListener(type, handler) { const values = this.listeners?.get(type) || []; values.push(handler); this.listeners ||= new Map(); this.listeners.set(type, values); } };
}
function validRecord() {
  const measurement = (eye, sph) => ({ eye, designation: eye, attemptNumber: 1, timestamp: '2026-10-06T10:00:00Z', sph, cyl: -.5, axis: 90, axisStatus: 'AVAILABLE', units: { sph: 'D', cyl: 'D', axis: 'deg' } });
  return { schemaVersion: '1.0.0', id: 3, measuredAt: '2026-10-06T10:00:00Z', createdAt: '2026-10-06T10:01:00Z', status: 'VALID', canPresent: true, technicalValidityOnly: true, eyes: { OD: { eye: 'right', designation: 'OD', status: 'VALID', measurements: [measurement('OD', -1.125)] }, OS: { eye: 'left', designation: 'OS', status: 'VALID', measurements: [measurement('OS', 2.25)] } }, validity: { status: 'VALID' }, consistency: { status: 'CONSISTENT' }, retest: { retestsUsed: 0 }, attemptCount: 1, attempts: [], versions: { modelId: 'local-model' }, reasons: [] };
}
function fakeStore(records = []) {
  const state = { records: [...records], deleted: [], clears: 0, fullClears: 0, reset: 0 };
  return { state,
    async list() { return { records: [...state.records], corruptedCount: 0 }; },
    async get(id) { return state.records.find(item => item.id === Number(id)) || null; },
    async delete(id) { state.deleted.push(Number(id)); state.records = state.records.filter(item => item.id !== Number(id)); },
    async clear() { state.clears++; state.records = []; },
    async clearAllData() { state.fullClears++; state.records = []; },
    resetSession() { state.reset++; },
    async getStorageAvailability() { return { available: true, backend: 'IndexedDB', localOnly: true }; },
    async getDataSummary() { return { storage: { available: true, backend: 'IndexedDB' }, resultCount: state.records.length, corruptedRecordCount: 0, consentStored: true, settingsStored: false, sessionMetadataStored: false }; },
  };
}
async function settle() { await new Promise(resolve => setTimeout(resolve, 0)); }

test('empty local history is clearly identified and does not offer clear-all', async () => {
  const root = makeRoot(); const cleanup = mountHistoryStep(root, { store: fakeStore() }); await settle();
  assert.match(root.nodes.get('#history-state').textContent, /No screening history is saved/);
  assert.equal(root.nodes.get('#history-clear').hidden, true);
  cleanup();
});

test('history opens a complete record and displays OD/OS independently', async () => {
  const root = makeRoot(); const cleanup = mountHistoryStep(root, { store: fakeStore([validRecord()]) }); await settle();
  const card = root.nodes.get('#history-record-list').children[0];
  assert.match(card.children[2].textContent, /OD: -1\.125/);
  const actions = card.children[4]; actions.children[0].click(); await settle();
  const detail = root.nodes.get('#history-detail');
  assert.equal(detail.hidden, false);
  assert.equal(detail.dataset.recordId, '3');
  const serialized = root.nodes.get('#history-detail-content').children[0].children.at(-1).children[1].textContent;
  assert.match(serialized, /"designation": "OD"/);
  assert.match(serialized, /"designation": "OS"/);
  assert.match(root.nodes.get('#history-detail-content').children[0].children[0].textContent, /not a diagnosis/i);
  cleanup();
});

test('individual deletion and clear-all require confirmation before mutating storage', async () => {
  const store = fakeStore([validRecord(), { ...validRecord(), id: 4 }]); const root = makeRoot();
  let allow = false;
  const cleanup = mountHistoryStep(root, { store }, { confirmAction: () => allow }); await settle();
  root.nodes.get('#history-record-list').children[0].children[4].children[2].click(); await settle();
  assert.deepEqual(store.state.deleted, []);
  allow = true;
  root.nodes.get('#history-record-list').children[0].children[4].children[2].click(); await settle();
  assert.equal(store.state.deleted.length, 1);
  root.nodes.get('#history-clear').click(); await settle();
  assert.equal(store.state.clears, 1);
  assert.equal(root.nodes.get('#history-record-list').children.length, 0);
  cleanup();
});

test('history export uses the Component 15 event contract without sending URLs', async () => {
  const root = makeRoot(); const record = validRecord();
  root.addEventListener('component15-report-export-request', event => { assert.deepEqual(event.detail.record, record); event.preventDefault(); });
  const cleanup = mountHistoryStep(root, { store: fakeStore([record]) }); await settle();
  root.nodes.get('#history-record-list').children[0].children[4].children[1].click();
  assert.equal(root.events.at(-1).type, 'component15-report-export-request');
  assert.equal(root.events.at(-1).detail.schemaVersion, '1.0.0');
  assert.equal(root.nodes.get('#history-state').textContent, 'Report export was handed to Component 15.');
  cleanup();
});

test('opened history record can request a local PDF preview for that exact record', async () => {
  const root = makeRoot(); const record = validRecord();
  root.addEventListener('component15-report-export-request', event => { assert.equal(event.detail.record.id, record.id); assert.equal(event.detail.mode, 'preview'); event.preventDefault(); });
  const cleanup = mountHistoryStep(root, { store: fakeStore([record]) }); await settle();
  root.nodes.get('#history-record-list').children[0].children[4].children[0].click(); await settle();
  root.nodes.get('#history-detail-content').children[0].children[4].children[0].click();
  assert.equal(root.events.at(-1).type, 'component15-report-export-request');
  cleanup();
});

test('privacy controls show the stored-data summary and require confirmation for reset and complete deletion', async () => {
  const store = fakeStore([validRecord()]); const root = makeRoot(); let allow = false; let resets = 0; let clears = 0;
  const cleanup = mountHistoryStep(root, { store }, { confirmAction: () => allow, onResetSession: () => { resets++; }, onClearAllData: () => { clears++; } }); await settle();
  root.nodes.get('#history-view-data').click(); await settle();
  assert.equal(root.nodes.get('#history-data-summary').hidden, false);
  assert.match(root.nodes.get('#history-data-summary').children.map(child => child.textContent).join(' '), /Questionnaire answers persisted.*No/);
  root.nodes.get('#history-reset-session').click(); await settle(); assert.equal(resets, 0);
  allow = true; root.nodes.get('#history-reset-session').click(); await settle(); assert.equal(resets, 1);
  root.nodes.get('#history-clear-all-data').click(); await settle(); assert.equal(clears, 1); assert.equal(store.state.fullClears, 1);
  cleanup();
});
