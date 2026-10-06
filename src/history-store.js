export const HISTORY_SCHEMA_VERSION = '1.0.0';
export const HISTORY_DATABASE_NAME = 'vision-screening-local';
export const HISTORY_DATABASE_VERSION = 2;

const STATUS = new Set(['VALID', 'LOW_CONFIDENCE', 'INCONSISTENT', 'RETEST_REQUIRED', 'INVALID']);
const EYES = Object.freeze([
  Object.freeze({ key: 'OD', eye: 'right', designation: 'OD' }),
  Object.freeze({ key: 'OS', eye: 'left', designation: 'OS' }),
]);

export class HistoryStorageError extends Error {
  constructor(code, message, cause) { super(message, { cause }); this.name = 'HistoryStorageError'; this.code = code; }
}

/**
 * IndexedDB persistence adapter owned by Component 16 and used by Component 14.
 * It accepts the final C12 event contract, never re-runs C10/C11/C13, and
 * persists only structured, image-free result metadata and allowlisted app data.
 */
export function createHistoryStore({ indexedDB = globalThis.indexedDB, now = () => Date.now() } = {}) {
  let databasePromise;
  async function database() {
    if (!indexedDB?.open) throw new HistoryStorageError('STORAGE_UNAVAILABLE', 'Local browser history storage is unavailable.');
    if (!databasePromise) databasePromise = openDatabase(indexedDB);
    return databasePromise;
  }

  return Object.freeze({
    async save(finalResult) {
      const record = normalizeFinalResult(finalResult, now);
      const db = await database();
      try {
        const tx = db.transaction('results', 'readwrite');
        const completed = transactionDone(tx);
        const store = tx.objectStore('results');
        const { id: _ignored, ...withoutId } = record;
        const id = await requestValue(store.add(withoutId));
        const stored = { ...withoutId, id: Number(id) };
        store.put(stored);
        await completed;
        return clone(stored);
      } catch (error) { throw normalizeStorageError(error, 'The screening result could not be saved to local history.'); }
    },
    async list() {
      const db = await database();
      try {
        const tx = db.transaction('results', 'readonly');
        const completed = transactionDone(tx);
        const values = await requestValue(tx.objectStore('results').getAll());
        await completed;
        const records = [], corruptIds = [];
        for (const value of values || []) {
          const migrated = migrateRecord(value);
          if (migrated) records.push(migrated); else corruptIds.push(Number.isSafeInteger(value?.id) ? value.id : null);
        }
        records.sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt) || b.id - a.id);
        return { records, corruptedCount: corruptIds.length };
      } catch (error) { throw normalizeStorageError(error, 'Local screening history could not be loaded.'); }
    },
    async get(id) {
      const key = parseId(id);
      if (key === null) return null;
      const db = await database();
      try {
        const tx = db.transaction('results', 'readonly');
        const completed = transactionDone(tx);
        const value = await requestValue(tx.objectStore('results').get(key));
        await completed;
        return migrateRecord(value);
      } catch (error) { throw normalizeStorageError(error, 'The selected history record could not be opened.'); }
    },
    async delete(id) {
      const key = parseId(id);
      if (key === null) throw new HistoryStorageError('INVALID_ID', 'The selected history record ID is invalid.');
      const db = await database();
      try {
        const tx = db.transaction('results', 'readwrite');
        const completed = transactionDone(tx);
        tx.objectStore('results').delete(key);
        await completed;
      } catch (error) { throw normalizeStorageError(error, 'The selected history record could not be deleted.'); }
    },
    async clear() {
      const db = await database();
      try {
        const tx = db.transaction('results', 'readwrite');
        const completed = transactionDone(tx);
        tx.objectStore('results').clear();
        await completed;
      } catch (error) { throw normalizeStorageError(error, 'Local screening history could not be cleared.'); }
    },
    async clearAll() {
      const db = await database();
      try {
        const tx = db.transaction(['results', 'appData'], 'readwrite');
        const completed = transactionDone(tx);
        tx.objectStore('results').clear();
        tx.objectStore('appData').clear();
        await completed;
      } catch (error) { throw normalizeStorageError(error, 'Local screening data could not be cleared.'); }
    },
    async getAppData(key) {
      const db = await database();
      try {
        const tx = db.transaction('appData', 'readonly');
        const completed = transactionDone(tx);
        const value = await requestValue(tx.objectStore('appData').get(validateAppDataKey(key)));
        await completed;
        return validateAppDataEnvelope(value) ? safeClone(value.value) : null;
      } catch (error) { throw normalizeStorageError(error, 'Local application data could not be read.'); }
    },
    async putAppData(key, value, updatedAt = new Date().toISOString()) {
      const appKey = validateAppDataKey(key);
      const safeValue = sanitizeAppData(value);
      if (!safeValue.valid) throw new HistoryStorageError('APP_DATA_INVALID', 'The local application data did not match the approved schema.');
      if (!Number.isFinite(Date.parse(updatedAt))) throw new HistoryStorageError('APP_DATA_INVALID', 'A valid local data timestamp is required.');
      const db = await database();
      try {
        const tx = db.transaction('appData', 'readwrite');
        const completed = transactionDone(tx);
        tx.objectStore('appData').put({ key: appKey, schemaVersion: '1.0.0', updatedAt: new Date(updatedAt).toISOString(), value: safeValue.value });
        await completed;
      } catch (error) { throw normalizeStorageError(error, 'Local application data could not be saved.'); }
    },
    async deleteAppData(key) {
      const db = await database();
      try {
        const tx = db.transaction('appData', 'readwrite');
        const completed = transactionDone(tx);
        tx.objectStore('appData').delete(validateAppDataKey(key));
        await completed;
      } catch (error) { throw normalizeStorageError(error, 'Local application data could not be deleted.'); }
    },
    async checkAvailability() {
      try { const db = await database(); db.transaction('results', 'readonly').objectStore('results'); return { available: true, backend: 'IndexedDB', localOnly: true, schemaVersion: HISTORY_SCHEMA_VERSION }; }
      catch (error) { return { available: false, backend: null, localOnly: true, reason: error?.code || 'STORAGE_UNAVAILABLE' }; }
    },
    close() { if (databasePromise) void databasePromise.then(db => db.close?.()).catch(() => {}); databasePromise = null; },
  });
}

export function normalizeFinalResult(result, now = () => Date.now()) {
  if (!isRecord(result) || result.schemaVersion !== '1.0.0'
    || typeof result.timestamp !== 'string' || !Number.isFinite(Date.parse(result.timestamp))
    || !STATUS.has(result.status) || typeof result.canPresent !== 'boolean') {
    throw new HistoryStorageError('RESULT_SCHEMA_INVALID', 'The final Component 12 result is missing required versioned session fields.');
  }
  const medicalSafety = normalizeMedicalSafety(result.medicalSafety);
  const safetyAllowsPresentation = result.medicalSafety == null || medicalSafety?.status === 'SAFE_TO_SCREEN' && medicalSafety.canPresentEstimate === true;
  const canPresent = result.status === 'VALID' && result.canPresent === true && safetyAllowsPresentation;
  const eyes = Object.fromEntries(EYES.map(eye => {
    const status = safeStatus(result.eyeStatuses?.[eye.designation]);
    const measurements = canPresent ? normalizeMeasurements(result.eyes?.[eye.designation], eye) : [];
    if (canPresent && measurements.length === 0) throw new HistoryStorageError('RESULT_EYE_INVALID', `The final ${eye.designation} result does not contain validated measurements.`);
    return [eye.designation, { eye: eye.eye, designation: eye.designation, status, measurements }];
  }));
  let createdAt;
  try { const supplied = new Date(now()); createdAt = Number.isFinite(supplied.getTime()) ? supplied.toISOString() : new Date().toISOString(); }
  catch { createdAt = new Date().toISOString(); }
  const validity = isRecord(result.validity) ? safeClone(result.validity) : { status: 'NOT_PRODUCED', valid: false, technicalValidityOnly: true };
  const retest = isRecord(result.retest) ? safeClone(result.retest) : null;
  const attempts = Array.isArray(retest?.attempts) ? safeClone(retest.attempts) : [];
  if (!canPresent) redactAttemptRefractions(attempts);
  const versions = {
    component12: result.schemaVersion,
    component10: safeString(validity.sourceAnalysis?.analysisVersion),
    component11: safeString(validity.engineVersion),
    modelId: safeString(validity.sourceAnalysis?.predictionModelId),
    modelVersion: safeString(validity.sourceAnalysis?.predictionModelVersion),
    component13: safeString(retest?.engineVersion),
  };
  const reasons = Array.isArray(result.reasons) ? safeClone(result.reasons) : [];
  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    measuredAt: new Date(result.timestamp).toISOString(),
    createdAt,
    status: result.status,
    canPresent,
    technicalValidityOnly: true,
    clinicalValidity: 'NOT_ASSESSED',
    ...(medicalSafety ? { medicalSafety } : {}),
    eyes,
    validity,
    consistency: retest ? { ...retest.consistency, eyes: safeClone(retest.perEyeConsistency || {}) } : { status: null, eyes: { OD: validity.consistency?.OD || null, OS: validity.consistency?.OS || null } },
    retest: retest ? { status: safeString(retest.status), retestsUsed: safeCount(retest.retestsUsed), maxRetests: safeCount(retest.maxRetests) } : { status: null, retestsUsed: 0, maxRetests: 0 },
    attemptCount: Array.isArray(retest?.attempts) ? retest.attempts.length : null,
    attempts,
    versions,
    reasons,
  };
}

function redactAttemptRefractions(attempts) {
  for (const attempt of attempts) for (const side of ['rightEye', 'leftEye']) {
    for (const prediction of Array.isArray(attempt?.[side]?.predictions) ? attempt[side].predictions : []) {
      delete prediction.sph; delete prediction.cyl; delete prediction.axis; delete prediction.units;
    }
  }
}

function normalizeMeasurements(eyeResult, expected) {
  if (!isRecord(eyeResult) || !Array.isArray(eyeResult.measurements)) return [];
  return eyeResult.measurements.map(item => {
    const units = item?.units;
    const axisValid = Number.isFinite(item?.axis) && item.axisStatus === 'AVAILABLE'
      || item?.axis === null && item.axisStatus === 'NOT_APPLICABLE';
    if (item?.eye !== expected.designation || item?.designation !== expected.designation) throw new HistoryStorageError('RESULT_EYE_SWAPPED', 'Right/left measurement identity did not match its result group.');
    if (!Number.isFinite(item?.sph) || !Number.isFinite(item?.cyl) || !axisValid
      || !isRecord(units) || units.sph !== 'D' || units.cyl !== 'D' || units.axis !== 'deg') {
      throw new HistoryStorageError('RESULT_MEASUREMENT_INVALID', `The final ${expected.designation} measurement failed structural checks.`);
    }
    return {
      attemptNumber: safeCount(item.attemptNumber),
      timestamp: typeof item.timestamp === 'string' && Number.isFinite(Date.parse(item.timestamp)) ? new Date(item.timestamp).toISOString() : null,
      sph: item.sph, cyl: item.cyl, axis: item.axis, axisStatus: item.axisStatus,
      units: { sph: 'D', cyl: 'D', axis: 'deg' },
    };
  });
}

function migrateRecord(record) {
  if (!isRecord(record)) return null;
  if (record.schemaVersion === HISTORY_SCHEMA_VERSION && validStoredRecord(record)) return safeClone(record);
  // Future persisted schema changes belong here as explicit record migrations.
  return null;
}
function validStoredRecord(record) {
  if (!Number.isSafeInteger(record.id) || record.id < 1 || !STATUS.has(record.status)
    || !Number.isFinite(Date.parse(record.measuredAt)) || !Number.isFinite(Date.parse(record.createdAt))
    || typeof record.canPresent !== 'boolean' || record.technicalValidityOnly !== true || !isRecord(record.eyes)) return false;
  for (const expected of EYES) {
    const eye = record.eyes[expected.designation];
    if (!isRecord(eye) || eye.eye !== expected.eye || eye.designation !== expected.designation || !STATUS.has(eye.status) || !Array.isArray(eye.measurements)) return false;
    if (record.canPresent && !eye.measurements.length) return false;
    if (!eye.measurements.every(item => isRecord(item)
      && Number.isFinite(item.sph) && Number.isFinite(item.cyl)
      && (Number.isFinite(item.axis) && item.axisStatus === 'AVAILABLE' || item.axis === null && item.axisStatus === 'NOT_APPLICABLE')
      && isRecord(item.units) && item.units.sph === 'D' && item.units.cyl === 'D' && item.units.axis === 'deg'
      && (item.attemptNumber === null || Number.isSafeInteger(item.attemptNumber) && item.attemptNumber >= 0)
      && (item.timestamp === null || Number.isFinite(Date.parse(item.timestamp))))) return false;
  }
  if (!record.canPresent && EYES.some(expected => record.eyes[expected.designation].measurements.length)) return false;
  if (record.medicalSafety !== undefined && !normalizeMedicalSafety(record.medicalSafety)) return false;
  return true;
}

function normalizeMedicalSafety(value) {
  if (value == null) return null;
  if (!isRecord(value) || !['SAFE_TO_SCREEN', 'REQUIRES_RETEST', 'SCREENING_LIMITED', 'STOP_AND_SEEK_CARE'].includes(value.status)
    || typeof value.canPresentEstimate !== 'boolean' || typeof value.engineVersion !== 'string') {
    throw new HistoryStorageError('RESULT_SAFETY_INVALID', 'The Component 18 safety decision did not match its supported schema.');
  }
  const collect = entries => (Array.isArray(entries) ? entries : []).slice(0, 64).filter(item => isRecord(item) && typeof item.code === 'string' && typeof item.message === 'string')
    .map(item => ({ code: safeString(item.code).slice(0, 120), message: safeString(item.message).slice(0, 1000) }));
  return {
    status: value.status,
    engineVersion: safeString(value.engineVersion).slice(0, 80),
    canPresentEstimate: value.canPresentEstimate,
    reasons: collect(value.reasons),
    warnings: collect(value.warnings),
    recommendations: (Array.isArray(value.recommendations) ? value.recommendations : []).slice(0, 64).map(item => safeString(item).slice(0, 1000)),
  };
}

function openDatabase(indexedDB) {
  return new Promise((resolve, reject) => {
    let request;
    try { request = indexedDB.open(HISTORY_DATABASE_NAME, HISTORY_DATABASE_VERSION); }
    catch (error) { reject(normalizeStorageError(error, 'Local history database could not be opened.')); return; }
    request.onupgradeneeded = event => {
      try {
        const db = request.result;
        const store = db.objectStoreNames.contains('results')
          ? request.transaction.objectStore('results')
          : db.createObjectStore('results', { keyPath: 'id', autoIncrement: true });
        if (!store.indexNames.contains('measuredAt')) store.createIndex('measuredAt', 'measuredAt', { unique: false });
        if (!store.indexNames.contains('status')) store.createIndex('status', 'status', { unique: false });
        if (!db.objectStoreNames.contains('appData')) db.createObjectStore('appData', { keyPath: 'key' });
        // `oldVersion` is deliberately explicit: future versions add a migration here.
        void event.oldVersion;
      } catch (error) { reject(normalizeStorageError(error, 'Local history schema could not be upgraded.')); }
    };
    request.onerror = () => reject(normalizeStorageError(request.error, 'Local history database could not be opened.'));
    request.onblocked = () => reject(new HistoryStorageError('STORAGE_BLOCKED', 'Local history upgrade is blocked by another open tab.'));
    request.onsuccess = () => resolve(request.result);
  });
}

function requestValue(request) {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error || new Error('IndexedDB request failed.')); });
}
function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted.'));
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed.'));
  });
}
function normalizeStorageError(error, message) {
  if (error instanceof HistoryStorageError) return error;
  const code = error?.name === 'QuotaExceededError' ? 'STORAGE_FULL' : error?.name === 'AbortError' ? 'STORAGE_ABORTED' : 'STORAGE_ERROR';
  return new HistoryStorageError(code, message, error);
}
function parseId(value) { const id = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN; return Number.isSafeInteger(id) && id > 0 ? id : null; }
function safeCount(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function safeStatus(value) { return ['VALID', 'LOW_CONFIDENCE', 'INCONSISTENT', 'RETEST_REQUIRED', 'INVALID'].includes(value) ? value : 'RETEST_REQUIRED'; }
function safeString(value) { return typeof value === 'string' && value.length <= 160 ? value : null; }
function validateAppDataKey(key) {
  if (!['consent', 'settings', 'session-metadata'].includes(key)) throw new HistoryStorageError('APP_DATA_KEY_INVALID', 'The requested local application data key is not allowed.');
  return key;
}
function validateAppDataEnvelope(value) { return isRecord(value) && value.schemaVersion === '1.0.0' && Number.isFinite(Date.parse(value.updatedAt)) && isRecord(value.value) && ['consent', 'settings', 'session-metadata'].includes(value.key); }
function sanitizeAppData(value) {
  if (!isRecord(value)) return { valid: false };
  const safe = safeClone(value);
  if (!isRecord(safe) || Object.keys(safe).length > 40) return { valid: false };
  const json = JSON.stringify(safe);
  if (json.length > 12_000) return { valid: false };
  return { valid: true, value: safe };
}
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function clone(value) { return globalThis.structuredClone ? structuredClone(value) : safeClone(value); }
function safeClone(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(item => safeClone(item, seen));
  if (!isRecord(value) || seen.has(value)) return null;
  seen.add(value);
  const result = Object.fromEntries(Object.entries(value).filter(([key]) => !/(^image$|debug.?image|image.?data|image.?blob|raw.?image|eye.?image|blob.?data|pixel.?data|^pixels$|feature.?vector|raw.?frame|^frame$|^frames$|frame.?data|bitmap|dataurl|video|framebuffer|arraybuffer|typed.?array|device.?id|camera.?label|camera.?object|mediastream|track)/i.test(key)).map(([key, item]) => [key, safeClone(item, seen)]));
  seen.delete(value);
  return result;
}
