import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalDataStore, LOCAL_DATA_SCHEMA_VERSION } from '../src/local-data-store.js';
import { generateScreeningReport } from '../src/pdf-report.js';
import { canStartCameraStep, clearQuestionnaireSession, configureSessionDataStore, getQuestionnaireResult, setQuestionnaireResult } from '../src/session.js';

function memoryPersistence() {
  const results = new Map(); const appData = new Map(); let nextId = 1;
  return {
    results, appData,
    async save(record) { const saved = { ...structuredClone(record), id: nextId++ }; results.set(saved.id, saved); return saved; },
    async list() { return { records: [...results.values()].map(value => structuredClone(value)), corruptedCount: 0 }; },
    async get(id) { return structuredClone(results.get(Number(id)) || null); },
    async delete(id) { results.delete(Number(id)); },
    async clear() { results.clear(); },
    async clearAll() { results.clear(); appData.clear(); },
    async getAppData(key) { return structuredClone(appData.get(key)?.value || null); },
    async putAppData(key, value) { appData.set(key, structuredClone({ key, schemaVersion: '1.0.0', updatedAt: '2026-10-06T10:00:00.000Z', value })); },
    async deleteAppData(key) { appData.delete(key); },
    async checkAvailability() { return { available: true, backend: 'IndexedDB', localOnly: true }; },
    async close() {},
  };
}
function finalResult() {
  const measurement = (designation, eye, sph) => ({ eye, designation, attemptNumber: 1, timestamp: '2026-10-06T10:00:00.000Z', sph, cyl: -.5, axis: 90, axisStatus: 'AVAILABLE', units: { sph: 'D', cyl: 'D', axis: 'deg' } });
  return { schemaVersion: '1.0.0', timestamp: '2026-10-06T10:00:00.000Z', status: 'VALID', canPresent: true, technicalValidityOnly: true, clinicalValidity: 'NOT_ASSESSED', eyeStatuses: { OD: 'VALID', OS: 'VALID' }, validity: { technicalValidityOnly: true }, eyes: { OD: { measurements: [measurement('OD', 'OD', -1)] }, OS: { measurements: [measurement('OS', 'OS', 1)] } }, reasons: [] };
}

test('central service uses a versioned local result/history and app-data contract', async () => {
  const persistence = memoryPersistence(); const store = createLocalDataStore({ historyStore: persistence });
  assert.equal(store.schemaVersion, LOCAL_DATA_SCHEMA_VERSION);
  const saved = await store.saveResult(finalResult());
  assert.equal((await store.listResults()).records[0].eyes.OS.measurements[0].sph, 1);
  await store.deleteResult(saved.id);
  assert.equal((await store.listResults()).records.length, 0);
});

test('questionnaire and pipeline state are validated in memory and reset without persistence', () => {
  const store = createLocalDataStore({ historyStore: memoryPersistence() });
  store.updateSessionDraft({ age: '30', saveHistory: true });
  store.setSessionValue('retestResult', { status: 'RETEST_REQUIRED', imageBlob: 'never-retained' });
  assert.equal(store.getSessionDraft().age, '30');
  assert.equal(store.getSessionValue('retestResult').imageBlob, undefined);
  assert.throws(() => store.setSessionValue('arbitrary', { value: 1 }), /not approved/);
  store.resetSession();
  assert.equal(store.getSessionDraft().age, '');
  assert.equal(store.getSessionValue('retestResult'), null);
});

test('privacy consent is explicit, persisted only with history opt-in, and survives service recreation', async () => {
  const persistence = memoryPersistence();
  const first = createLocalDataStore({ historyStore: persistence, now: () => Date.parse('2026-10-06T10:00:00Z') });
  await first.saveConsentState({ screeningAccepted: true, saveHistory: false });
  assert.equal(await createLocalDataStore({ historyStore: persistence }).getConsentState(), null);
  const consent = await first.saveConsentState({ screeningAccepted: true, saveHistory: true });
  assert.equal(consent.schemaVersion, LOCAL_DATA_SCHEMA_VERSION);
  assert.equal((await createLocalDataStore({ historyStore: persistence }).getConsentState()).saveHistory, true);
  await assert.rejects(() => first.saveConsentState({ screeningAccepted: 'yes', saveHistory: false }), /explicit boolean/);
});

test('settings and session metadata reject personal, image, and malformed payloads', async () => {
  const store = createLocalDataStore({ historyStore: memoryPersistence() });
  await store.saveSettings({ theme: 'light', reducedMotion: true });
  assert.deepEqual(await store.getSettings(), { theme: 'light', reducedMotion: true });
  await assert.rejects(() => store.saveSettings({ cameraLabel: 'front camera' }), /not approved/);
  await assert.rejects(() => store.saveSessionMetadata({ imageBlob: 'bad' }), /not approved/);
  await store.saveSessionMetadata({ sessionId: 'a3b4c5d6-e7f8-4012-9234-abcdef012345', startedAt: '2026-10-06T10:00:00Z', attemptCount: 2 });
  assert.deepEqual(await store.getSessionMetadata(), { sessionId: 'a3b4c5d6-e7f8-4012-9234-abcdef012345', startedAt: '2026-10-06T10:00:00.000Z', attemptCount: 2 });
});

test('storage restriction degrades gracefully and reports local availability', async () => {
  const store = createLocalDataStore({ indexedDB: null });
  assert.equal((await store.getStorageAvailability()).available, false);
  await assert.rejects(() => store.saveConsentState({ screeningAccepted: true, saveHistory: true }));
  assert.equal(store.getSessionDraft().age, '');
});

test('complete deletion removes history, consent, settings, and session state', async () => {
  const persistence = memoryPersistence(); const store = createLocalDataStore({ historyStore: persistence });
  await store.saveConsentState({ screeningAccepted: true, saveHistory: true });
  await store.saveSettings({ theme: 'light' });
  store.updateSessionDraft({ age: '25' });
  await store.saveResult(finalResult());
  await store.clearAllData();
  assert.equal(persistence.results.size, 0); assert.equal(persistence.appData.size, 0);
  assert.equal(store.getSessionDraft().age, '');
});

test('C14 aliases and C15 approved export share records without a second store or recalculation', async () => {
  const store = createLocalDataStore({ historyStore: memoryPersistence() });
  await store.save(finalResult());
  const exportData = await store.exportApprovedData();
  assert.equal(exportData.results[0].eyes.OD.measurements[0].sph, -1);
  const report = generateScreeningReport(exportData.results[0]);
  assert.equal(report.report.eyes.OS.measurements[0].sph, 1);
  assert.equal(report.report.sessionId, String(exportData.results[0].id));
});

test('data summary accurately declares no questionnaire or camera-image persistence', async () => {
  const store = createLocalDataStore({ historyStore: memoryPersistence() });
  const summary = await store.getDataSummary();
  assert.equal(summary.questionnaireAnswersPersisted, false);
  assert.equal(summary.cameraImagesPersisted, false);
  assert.equal(summary.storage.localOnly, true);
});

test('Component 1 consent gate reads the in-memory result through Component 16', () => {
  const store = createLocalDataStore({ historyStore: memoryPersistence() });
  configureSessionDataStore(store);
  setQuestionnaireResult({ sessionId: 'local-session', completionStatus: 'complete', workflowAllowed: true, consent: { screening: true } });
  assert.equal(getQuestionnaireResult().sessionId, 'local-session');
  assert.equal(canStartCameraStep(), true);
  clearQuestionnaireSession();
  assert.equal(canStartCameraStep(), false);
});
