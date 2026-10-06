import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryStore, HISTORY_SCHEMA_VERSION, HISTORY_DATABASE_VERSION, normalizeFinalResult, HistoryStorageError } from '../src/history-store.js';

function finalResult({ status = 'VALID', canPresent = true } = {}) {
  const detail = {
    schemaVersion: '1.0.0', timestamp: '2026-10-06T10:00:00.000Z', status, canPresent,
    eyeStatuses: { OD: canPresent ? 'VALID' : 'RETEST_REQUIRED', OS: canPresent ? 'VALID' : 'INVALID' },
    validity: { status: canPresent ? 'VALID' : status, engineVersion: '1.0.0', valid: canPresent, technicalValidityOnly: true, confidence: { OD: { status: 'AVAILABLE', values: [{ value: .9 }] }, OS: { status: 'UNAVAILABLE' } }, consistency: { OD: null, OS: null }, sourceAnalysis: { analysisVersion: '1.0.0', predictionModelId: 'local-model', predictionModelVersion: 'model-v3' } },
    retest: { status: canPresent ? 'PASSED' : 'FAILED', retestsUsed: 1, maxRetests: 2, consistency: { status: 'CONSISTENT', tolerances: { sph: .2, cyl: .2, axis: 5 } }, perEyeConsistency: { OD: { status: 'CONSISTENT', pairwiseMaximumDeltas: { sph: .1, cyl: 0, axis: 2 }, count: 2 }, OS: { status: 'CONSISTENT', pairwiseMaximumDeltas: { sph: 0, cyl: 0, axis: 0 }, count: 2 } }, engineVersion: '1.0.0', attempts: [{ attemptNumber: 1, timestamp: '2026-10-06T09:59:00.000Z', validityStatus: status, debugImage: 'must-not-persist' }, { attemptNumber: 2, timestamp: '2026-10-06T10:00:00.000Z', validityStatus: canPresent ? 'VALID' : 'INVALID', rawFrame: 'must-not-persist' }] },
    reasons: canPresent ? [] : [{ code: 'MAX_RETESTS_REACHED', message: 'Reliable result unavailable.' }],
  };
  if (canPresent) detail.eyes = {
    OD: { sph: -1.125, cyl: -.5, axis: 90, axisStatus: 'AVAILABLE', units: { sph: 'D', cyl: 'D', axis: 'deg' }, measurements: [{ eye: 'OD', designation: 'OD', attemptNumber: 1, timestamp: '2026-10-06T09:59:00.000Z', sph: -1.125, cyl: -.5, axis: 90, axisStatus: 'AVAILABLE', units: { sph: 'D', cyl: 'D', axis: 'deg' } }, { eye: 'OD', designation: 'OD', attemptNumber: 2, timestamp: '2026-10-06T10:00:00.000Z', sph: -1.25, cyl: -.5, axis: 92, axisStatus: 'AVAILABLE', units: { sph: 'D', cyl: 'D', axis: 'deg' } }] },
    OS: { sph: 2.25, cyl: -1.125, axis: 12.345, axisStatus: 'AVAILABLE', units: { sph: 'D', cyl: 'D', axis: 'deg' }, measurements: [{ eye: 'OS', designation: 'OS', attemptNumber: 1, timestamp: '2026-10-06T09:59:00.000Z', sph: 2.25, cyl: -1.125, axis: 12.345, axisStatus: 'AVAILABLE', units: { sph: 'D', cyl: 'D', axis: 'deg' } }] },
  };
  else detail.retest.attempts[0].rightEye = { eye: 'right', designation: 'OD', status: 'VALID', predictions: [{ valid: true, eye: 'right', designation: 'OD', sph: -1, cyl: -.5, axis: 90, units: { sph: 'D', cyl: 'D', axis: 'deg' } }] };
  return detail;
}

class FakeNames extends Array { contains(name) { return this.includes(name); } }
class FakeRequest { constructor() { this.result = undefined; this.error = null; } }
class FakeStore {
  constructor(db, tx, name, options = {}) { this.db = db; this.tx = tx; this.name = name; this.keyPath = options.keyPath; this.indexNames = new FakeNames(...(db.indexNames.get(name) || [])); }
  rows() { return this.db.stores.get(this.name); }
  createIndex(name) { const names = this.db.indexNames.get(this.name) || []; if (!names.includes(name)) names.push(name); this.db.indexNames.set(this.name, names); this.indexNames = new FakeNames(...names); }
  key(value) { return value?.[this.keyPath] ?? (this.name === 'results' ? ++this.db.lastId : undefined); }
  add(value) { const item = structuredClone(value); const id = this.key(item); if (this.keyPath && item[this.keyPath] === undefined) item[this.keyPath] = id; if (this.name === 'results') this.db.lastId = Math.max(this.db.lastId, id); return this.tx.request(id, () => this.rows().set(id, item), id); }
  put(value) { const item = structuredClone(value); const id = this.key(item); if (this.keyPath && item[this.keyPath] === undefined) item[this.keyPath] = id; if (this.name === 'results') this.db.lastId = Math.max(this.db.lastId, id); return this.tx.request(item, () => this.rows().set(id, item), id); }
  get(id) { return this.tx.request(this.rows().get(id) ? structuredClone(this.rows().get(id)) : undefined, () => {}); }
  getAll() { return this.tx.request([...this.rows().values()].map(value => structuredClone(value)), () => {}); }
  delete(id) { return this.tx.request(undefined, () => this.rows().delete(id)); }
  clear() { return this.tx.request(undefined, () => this.rows().clear()); }
}
class FakeTransaction {
  constructor(db) { this.db = db; this.pending = 0; this.completeQueued = false; }
  objectStore(name = 'results') { return new FakeStore(this.db, this, name, this.db.storeOptions.get(name)); }
  request(result, action, key) {
    const request = new FakeRequest(); this.pending++;
    queueMicrotask(() => { action(); request.result = result; request.onsuccess?.(); this.pending--; this.finishIfReady(); });
    return request;
  }
  finishIfReady() { if (this.pending || this.completeQueued) return; this.completeQueued = true; queueMicrotask(() => { if (!this.pending) this.oncomplete?.(); else this.completeQueued = false; }); }
}
class FakeDb {
  constructor() { this.version = 0; this.lastId = 0; this.indexNames = new Map(); this.stores = new Map(); this.storeOptions = new Map(); this.objectStoreNames = new FakeNames(); this.closed = false; }
  get rows() { return this.stores.get('results'); }
  createObjectStore(name, options = {}) { this.objectStoreNames.push(name); this.stores.set(name, new Map()); this.storeOptions.set(name, options); this.indexNames.set(name, []); return new FakeStore(this, new FakeTransaction(this), name, options); }
  transaction() { const tx = new FakeTransaction(this); queueMicrotask(() => tx.finishIfReady()); return tx; }
  close() { this.closed = true; }
}
class FakeIndexedDB {
  constructor({ fail = false } = {}) { this.db = new FakeDb(); this.fail = fail; }
  open(_name, version) {
    const request = new FakeRequest();
    queueMicrotask(() => {
      if (this.fail) { request.error = new Error('blocked'); request.onerror?.(); return; }
      request.result = this.db;
      if (version > this.db.version) {
        const oldVersion = this.db.version;
        request.transaction = new FakeTransaction(this.db);
        request.onupgradeneeded?.({ oldVersion, newVersion: version });
        this.db.version = version;
      }
      request.onsuccess?.();
    });
    return request;
  }
}

test('saves a valid final result preserving exact OD/OS values and stripping image/frame payloads', async () => {
  const indexedDB = new FakeIndexedDB(); const store = createHistoryStore({ indexedDB, now: () => Date.parse('2026-10-06T11:00:00Z') });
  const record = await store.save(finalResult());
  assert.equal(record.schemaVersion, HISTORY_SCHEMA_VERSION);
  assert.equal(record.id, 1);
  assert.equal(record.canPresent, true);
  assert.equal(record.eyes.OD.measurements[0].sph, -1.125);
  assert.equal(record.eyes.OS.measurements[0].axis, 12.345);
  assert.equal(record.versions.modelVersion, 'model-v3');
  assert.equal(record.retest.retestsUsed, 1);
  assert.equal(record.attemptCount, 2);
  assert.equal('debugImage' in record.attempts[0], false);
  assert.equal('rawFrame' in record.attempts[1], false);
});

test('central safety decision is retained in history and blocks presentation defensively', () => {
  const source = finalResult();
  source.medicalSafety = { status: 'SCREENING_LIMITED', engineVersion: '1.0.0', canPresentEstimate: false, reasons: [{ code: 'NO_MODEL', message: 'Local model is unavailable.' }], warnings: [], recommendations: ['Arrange an eye examination.'] };
  const normalized = normalizeFinalResult(source);
  assert.equal(normalized.canPresent, false);
  assert.equal(normalized.eyes.OD.measurements.length, 0);
  assert.equal(normalized.medicalSafety.status, 'SCREENING_LIMITED');
});

test('saves failed/retest-incomplete sessions without treating them as prescriptions', async () => {
  const store = createHistoryStore({ indexedDB: new FakeIndexedDB() });
  const record = await store.save(finalResult({ status: 'INVALID', canPresent: false }));
  assert.equal(record.status, 'INVALID');
  assert.equal(record.canPresent, false);
  assert.equal(record.eyes.OD.measurements.length, 0);
  assert.equal(record.eyes.OS.measurements.length, 0);
  assert.equal(record.retest.status, 'FAILED');
  assert.equal('sph' in record.attempts[0].rightEye.predictions[0], false);
});

test('loading, opening, and reloading keep local records persistent and return complete metadata', async () => {
  const indexedDB = new FakeIndexedDB();
  const first = createHistoryStore({ indexedDB });
  const saved = await first.save(finalResult());
  const second = createHistoryStore({ indexedDB });
  const list = await second.list();
  assert.equal(list.corruptedCount, 0);
  assert.equal(list.records.length, 1);
  assert.deepEqual(await second.get(saved.id), saved);
  assert.equal(list.records[0].consistency.eyes.OD.pairwiseMaximumDeltas.axis, 2);
});

test('deletes one confirmed record and clear removes all remaining records', async () => {
  const store = createHistoryStore({ indexedDB: new FakeIndexedDB() });
  const one = await store.save(finalResult());
  await store.save(finalResult({ status: 'RETEST_REQUIRED', canPresent: false }));
  await store.delete(one.id);
  assert.equal((await store.list()).records.length, 1);
  await store.clear();
  assert.equal((await store.list()).records.length, 0);
});

test('corrupt records are skipped but not silently deleted', async () => {
  const indexedDB = new FakeIndexedDB(); const store = createHistoryStore({ indexedDB });
  await store.save(finalResult());
  indexedDB.db.rows.set(50, { id: 50, schemaVersion: '0.0.0', status: 'BOGUS' });
  const listed = await store.list();
  assert.equal(listed.records.length, 1);
  assert.equal(listed.corruptedCount, 1);
  assert.equal(indexedDB.db.rows.has(50), true);
});

test('legacy database upgrades add the central app-data store while preserving result indexes', async () => {
  const indexedDB = new FakeIndexedDB(); const store = createHistoryStore({ indexedDB });
  await store.list();
  assert.equal(indexedDB.db.version, HISTORY_DATABASE_VERSION);
  assert.equal(indexedDB.db.objectStoreNames.contains('results'), true);
  assert.equal(indexedDB.db.objectStoreNames.contains('appData'), true);
  assert.deepEqual(indexedDB.db.indexNames.get('results'), ['measuredAt', 'status']);
});

test('v1-to-v2 upgrade preserves existing result rows and creates the privacy data store', async () => {
  const indexedDB = new FakeIndexedDB();
  const db = indexedDB.db;
  db.version = 1;
  const oldResults = db.createObjectStore('results', { keyPath: 'id', autoIncrement: true });
  oldResults.createIndex('measuredAt', 'measuredAt'); oldResults.createIndex('status', 'status');
  const legacy = { ...normalizeFinalResult(finalResult()), id: 24 };
  db.rows.set(24, legacy); db.lastId = 24;
  const store = createHistoryStore({ indexedDB });
  assert.equal((await store.get(24)).eyes.OS.measurements[0].axis, 12.345);
  assert.equal(db.version, 2);
  assert.equal(db.objectStoreNames.contains('appData'), true);
  assert.equal(db.rows.has(24), true);
});

test('unavailable storage and malformed final envelopes report clean errors', async () => {
  const unavailable = createHistoryStore({ indexedDB: null });
  await assert.rejects(() => unavailable.list(), error => error instanceof HistoryStorageError && error.code === 'STORAGE_UNAVAILABLE');
  await assert.rejects(() => createHistoryStore({ indexedDB: new FakeIndexedDB() }).save({ status: 'VALID' }), error => error.code === 'RESULT_SCHEMA_INVALID');
  await assert.rejects(() => createHistoryStore({ indexedDB: new FakeIndexedDB({ fail: true }) }).list(), error => error.code === 'STORAGE_ERROR');
});

test('valid result persistence rejects swapped eye identities and bad numeric/axis fields', () => {
  const swapped = finalResult(); swapped.eyes.OS.measurements[0].designation = 'OD'; swapped.eyes.OS.measurements[0].eye = 'OD';
  assert.throws(() => normalizeFinalResult(swapped), error => error.code === 'RESULT_MEASUREMENT_INVALID' || error.code === 'RESULT_EYE_SWAPPED');
  const invalid = finalResult(); invalid.eyes.OD.measurements[0].sph = Number.NaN;
  assert.throws(() => normalizeFinalResult(invalid), error => error.code === 'RESULT_MEASUREMENT_INVALID');
});

test('central app-data envelopes are versioned, image-filtered, and corrupted entries are ignored', async () => {
  const indexedDB = new FakeIndexedDB(); const store = createHistoryStore({ indexedDB });
  await store.putAppData('settings', { theme: 'light', imageBlob: 'must-not-persist', rawFrame: [1, 2, 3] });
  assert.deepEqual(await store.getAppData('settings'), { theme: 'light' });
  const persisted = indexedDB.db.stores.get('appData').get('settings');
  assert.equal(persisted.schemaVersion, '1.0.0');
  indexedDB.db.stores.get('appData').set('consent', { key: 'consent', schemaVersion: '0.0.0', updatedAt: 'bad', value: { screeningAccepted: true } });
  assert.equal(await store.getAppData('consent'), null);
  assert.equal(indexedDB.db.stores.get('appData').has('consent'), true);
});

test('database clear-all removes both final results and approved application records', async () => {
  const store = createHistoryStore({ indexedDB: new FakeIndexedDB() });
  await store.save(finalResult());
  await store.putAppData('consent', { schemaVersion: '1.0.0', screeningAccepted: true, saveHistory: true, acceptedAt: '2026-10-06T10:00:00Z' });
  await store.clearAll();
  assert.equal((await store.list()).records.length, 0);
  assert.equal(await store.getAppData('consent'), null);
});
