import { createHistoryStore, HISTORY_SCHEMA_VERSION } from './history-store.js';

export const LOCAL_DATA_SCHEMA_VERSION = '1.0.0';
export const LOCAL_DATA_STORES = Object.freeze(['results', 'appData']);
const SESSION_KEYS = new Set(['questionnaireDraft', 'questionnaireResult', 'eyeAnalysis', 'validityResult', 'retestSession', 'retestResult', 'captureMetadata', 'consentState', 'validatedResult', 'compatibilityResult', 'medicalSafetyResult']);
const SETTINGS_SCHEMA = Object.freeze({ theme: ['light', 'dark', 'system'], highContrast: 'boolean', reducedMotion: 'boolean', textScale: 'number', language: 'language' });

/**
 * Component 16 boundary. All browser persistence goes through one service;
 * Components receive its methods rather than using browser storage directly.
 */
export function createLocalDataStore({ indexedDB = globalThis.indexedDB, now = () => Date.now(), historyStore = null } = {}) {
  const persistence = historyStore || createHistoryStore({ indexedDB, now });
  let session = initialSession();

  const cloneSession = () => safeClone(session);
  const resetSession = () => { session = initialSession(); return cloneSession(); };
  const setSessionValue = (key, value) => {
    if (!SESSION_KEYS.has(key)) throw new TypeError('This session field is not approved for storage.');
    const safe = privacyClone(value);
    validateSessionValue(key, safe);
    if (JSON.stringify(safe).length > 100_000) throw new TypeError('Session data exceeds the in-memory size limit.');
    session[key] = safe;
    return safeClone(safe);
  };
  const getSessionValue = key => SESSION_KEYS.has(key) ? safeClone(session[key] ?? null) : null;
  const getSessionDraft = () => safeClone(session.questionnaireDraft);
  const updateSessionDraft = patch => {
    if (!isRecord(patch)) throw new TypeError('Questionnaire draft updates must be objects.');
    const next = { ...session.questionnaireDraft, ...privacyClone(patch) };
    session.questionnaireDraft = validateQuestionnaireDraft(next);
    return getSessionDraft();
  };
  const replaceSessionDraft = draft => { session.questionnaireDraft = validateQuestionnaireDraft(privacyClone(draft)); return getSessionDraft(); };

  return Object.freeze({
    schemaVersion: LOCAL_DATA_SCHEMA_VERSION,
    // C14's established API is retained as aliases to this central service.
    save: result => persistence.save(result),
    list: () => persistence.list(),
    get: id => persistence.get(id),
    delete: id => persistence.delete(id),
    clear: () => persistence.clear(),
    saveResult: result => persistence.save(result),
    listResults: () => persistence.list(),
    getResult: id => persistence.get(id),
    deleteResult: id => persistence.delete(id),
    clearHistory: () => persistence.clear(),
    getSessionContext: cloneSession,
    getSessionValue,
    setSessionValue,
    getSessionDraft,
    updateSessionDraft,
    replaceSessionDraft,
    resetSession,
    async resetSessionData() { resetSession(); await persistence.deleteAppData('session-metadata'); return true; },
    async saveConsentState({ screeningAccepted, saveHistory = false } = {}) {
      if (typeof screeningAccepted !== 'boolean' || typeof saveHistory !== 'boolean') throw new TypeError('Consent state must use explicit boolean choices.');
      if (!screeningAccepted && saveHistory) throw new TypeError('History-saving opt-in cannot be granted without screening consent.');
      const acceptedAt = new Date(now()).toISOString();
      const consent = { schemaVersion: LOCAL_DATA_SCHEMA_VERSION, screeningAccepted, saveHistory, acceptedAt };
      setSessionValue('consentState', consent);
      if (saveHistory) await persistence.putAppData('consent', consent, acceptedAt);
      else await persistence.deleteAppData('consent');
      return safeClone(consent);
    },
    async getConsentState() {
      const saved = await persistence.getAppData('consent');
      return validateConsent(saved) ? safeClone(saved) : null;
    },
    async saveSettings(settings) {
      const safe = validateSettings(settings);
      const updatedAt = new Date(now()).toISOString();
      await persistence.putAppData('settings', { schemaVersion: LOCAL_DATA_SCHEMA_VERSION, updatedAt, values: safe }, updatedAt);
      return safeClone(safe);
    },
    async getSettings() {
      const saved = await persistence.getAppData('settings');
      return isRecord(saved) && saved.schemaVersion === LOCAL_DATA_SCHEMA_VERSION && isRecord(saved.values) ? validateSettings(saved.values) : {};
    },
    async saveSessionMetadata(metadata) {
      const safe = validateSessionMetadata(metadata);
      const updatedAt = new Date(now()).toISOString();
      await persistence.putAppData('session-metadata', { schemaVersion: LOCAL_DATA_SCHEMA_VERSION, updatedAt, value: safe }, updatedAt);
      return safeClone(safe);
    },
    async getSessionMetadata() {
      const saved = await persistence.getAppData('session-metadata');
      return isRecord(saved) && saved.schemaVersion === LOCAL_DATA_SCHEMA_VERSION ? validateSessionMetadata(saved.value) : null;
    },
    async getStorageAvailability() { return persistence.checkAvailability(); },
    async getDataSummary() {
      const [{ records, corruptedCount }, consent, settings, metadata, availability] = await Promise.all([
        persistence.list(), persistence.getAppData('consent'), persistence.getAppData('settings'), persistence.getAppData('session-metadata'), persistence.checkAvailability(),
      ]);
      return {
        schemaVersion: LOCAL_DATA_SCHEMA_VERSION,
        storage: availability,
        resultCount: records.length,
        corruptedRecordCount: corruptedCount,
        consentStored: validateConsent(consent),
        settingsStored: isRecord(settings),
        sessionMetadataStored: isRecord(metadata),
        questionnaireAnswersPersisted: false,
        cameraImagesPersisted: false,
      };
    },
    async exportApprovedData() {
      const { records } = await persistence.list();
      // This export is explicitly requested in-app; no identifiers or raw captures are added.
      return Object.freeze({ schemaVersion: LOCAL_DATA_SCHEMA_VERSION, exportedAt: new Date(now()).toISOString(), results: safeClone(records) });
    },
    async clearAllData() {
      await persistence.clearAll();
      resetSession();
      return { cleared: true, scope: 'all-local-application-data' };
    },
    async deleteStoredConsent() { await persistence.deleteAppData('consent'); return true; },
    async close() { persistence.close(); resetSession(); },
  });
}

function initialSession() {
  return {
    schemaVersion: LOCAL_DATA_SCHEMA_VERSION,
    questionnaireDraft: { age: '', previousPrescription: '', right: { sph: '', cyl: '', axis: '' }, left: { sph: '', cyl: '', axis: '' }, wearsCorrection: '', lastExam: '', blurredVision: '', suddenVisionChange: '', painfulSymptoms: '', seriousEyeInjury: '', pendingEyeSurgeryFollowup: '', eyeConditionHistory: '', steadyGaze: '', historyDescription: '', requiredConsent: false, saveHistory: false },
    questionnaireResult: null, validityResult: null, retestSession: null, retestResult: null, captureMetadata: null, compatibilityResult: null, medicalSafetyResult: null,
  };
}

function validateQuestionnaireDraft(draft) {
  const strings = ['age', 'previousPrescription', 'wearsCorrection', 'lastExam', 'blurredVision', 'suddenVisionChange', 'painfulSymptoms', 'seriousEyeInjury', 'pendingEyeSurgeryFollowup', 'eyeConditionHistory', 'steadyGaze', 'historyDescription'];
  const allowed = new Set([...strings, 'right', 'left', 'requiredConsent', 'saveHistory']);
  if (Object.keys(draft).some(key => !allowed.has(key)) || !isRecord(draft.right) || !isRecord(draft.left)
    || typeof draft.requiredConsent !== 'boolean' || typeof draft.saveHistory !== 'boolean') throw new TypeError('Questionnaire data did not match its approved in-memory schema.');
  for (const key of strings) if (typeof draft[key] !== 'string' || draft[key].length > (key === 'historyDescription' ? 500 : 160)) throw new TypeError('A questionnaire field did not match its bounded text schema.');
  for (const eye of ['right', 'left']) if (Object.keys(draft[eye]).some(key => !['sph', 'cyl', 'axis'].includes(key)) || ['sph', 'cyl', 'axis'].some(key => typeof draft[eye][key] !== 'string' || draft[eye][key].length > 24)) throw new TypeError('An optional previous-prescription field did not match its bounded schema.');
  return privacyClone(draft);
}
function validateSessionValue(key, value) {
  if (value === null) return;
  if (!isRecord(value)) throw new TypeError('Session data must be a structured record.');
  if (key === 'questionnaireDraft') { validateQuestionnaireDraft(value); return; }
  if (key === 'consentState' && validateConsent(value)) return;
  if (key === 'captureMetadata') {
    if (Object.keys(value).some(field => !['captureIndex', 'timestamp', 'status'].includes(field))
      || value.captureIndex !== null && !Number.isSafeInteger(value.captureIndex)
      || typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))
      || !['CAPTURED', 'COMPLETE'].includes(value.status)) throw new TypeError('Capture session metadata failed validation.');
    return;
  }
  if (key === 'questionnaireResult' && (value.completionStatus !== 'complete' || typeof value.sessionId !== 'string' || typeof value.workflowAllowed !== 'boolean')) throw new TypeError('Questionnaire session result failed validation.');
  if (key === 'validatedResult' && (value.schemaVersion !== '1.0.0' || !['VALID', 'LOW_CONFIDENCE', 'INCONSISTENT', 'RETEST_REQUIRED', 'INVALID'].includes(value.status) || typeof value.canPresent !== 'boolean')) throw new TypeError('Final validated screening result failed validation.');
  if (key === 'compatibilityResult' && (value.schemaVersion !== '1.0.0' || !['SUPPORTED', 'LIMITED', 'UNSUPPORTED'].includes(value.status) || typeof value.supported !== 'boolean' || !isRecord(value.required) || !isRecord(value.camera) || !isRecord(value.compute))) throw new TypeError('Device compatibility result failed validation.');
  if (key === 'medicalSafetyResult') {
    const issueList = entries => Array.isArray(entries) && entries.length <= 64 && entries.every(item => isRecord(item) && typeof item.code === 'string' && item.code.length <= 120 && typeof item.message === 'string' && item.message.length <= 1000);
    if (value.schemaVersion !== '1.0.0' || value.engineVersion !== '1.0.0'
      || !['SAFE_TO_SCREEN', 'REQUIRES_RETEST', 'SCREENING_LIMITED', 'STOP_AND_SEEK_CARE'].includes(value.status)
      || typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))
      || typeof value.canContinue !== 'boolean' || typeof value.canPresentEstimate !== 'boolean'
      || value.technicalValidityOnly !== true || value.clinicalDiagnosis !== 'NOT_PROVIDED'
      || !issueList(value.reasons) || !issueList(value.warnings)
      || !Array.isArray(value.recommendations) || value.recommendations.length > 64 || value.recommendations.some(item => typeof item !== 'string' || item.length > 1000)) {
      throw new TypeError('Medical safety result failed validation.');
    }
    return;
  }
  if (key === 'retestSession' && (!Array.isArray(value.attempts) || typeof value.state !== 'string')) throw new TypeError('Retest session state failed validation.');
  if (key === 'retestResult' && typeof value.status !== 'string') throw new TypeError('Retest result failed validation.');
  if (key === 'validityResult' && typeof value.schemaVersion !== 'string' && typeof value.status !== 'string') throw new TypeError('Validity result failed validation.');
}
function validateConsent(value) { return isRecord(value) && value.schemaVersion === LOCAL_DATA_SCHEMA_VERSION && typeof value.screeningAccepted === 'boolean' && typeof value.saveHistory === 'boolean' && Number.isFinite(Date.parse(value.acceptedAt)); }
function validateSettings(value) {
  if (!isRecord(value) || Object.keys(value).length > Object.keys(SETTINGS_SCHEMA).length) throw new TypeError('Settings must be a bounded object.');
  for (const [key, item] of Object.entries(value)) {
    const schema = SETTINGS_SCHEMA[key];
    if (!schema) throw new TypeError('A setting key is not approved for persistent storage.');
    const valid = Array.isArray(schema) ? schema.includes(item)
      : schema === 'boolean' ? typeof item === 'boolean'
        : schema === 'number' ? Number.isFinite(item) && item >= .8 && item <= 1.5
          : schema === 'language' ? typeof item === 'string' && /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(item) : false;
    if (!valid) throw new TypeError(`The ${key} setting value is invalid.`);
  }
  return { ...value };
}
function validateSessionMetadata(value) {
  if (!isRecord(value) || Object.keys(value).some(key => !['sessionId', 'startedAt', 'completedAt', 'lastComponent', 'attemptCount'].includes(key))) throw new TypeError('Session metadata contains fields that are not approved for persistence.');
  const result = {};
  for (const key of ['sessionId', 'lastComponent']) if (value[key] !== undefined) {
    if (typeof value[key] !== 'string' || value[key].length > 120
      || key === 'sessionId' && !/^[a-fA-F0-9-]{16,64}$/.test(value[key])
      || key === 'lastComponent' && !/^\d{1,2}$/.test(value[key])) throw new TypeError('Session metadata text is invalid.');
    result[key] = value[key];
  }
  for (const key of ['startedAt', 'completedAt']) if (value[key] !== undefined) {
    if (typeof value[key] !== 'string' || !Number.isFinite(Date.parse(value[key]))) throw new TypeError('Session metadata timestamp is invalid.');
    result[key] = new Date(value[key]).toISOString();
  }
  if (value.attemptCount !== undefined) {
    if (!Number.isSafeInteger(value.attemptCount) || value.attemptCount < 0) throw new TypeError('Session attempt count is invalid.');
    result.attemptCount = value.attemptCount;
  }
  return result;
}
function privacyClone(value, seen = new WeakSet()) {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(item => privacyClone(item, seen));
  if (!isRecord(value) || seen.has(value)) return null;
  seen.add(value);
  const output = Object.fromEntries(Object.entries(value).filter(([key]) => !/(^image$|debug.?image|image.?data|image.?blob|raw.?image|eye.?image|blob.?data|pixel.?data|^pixels$|feature.?vector|raw.?frame|^frame$|^frames$|frame.?data|bitmap|dataurl|video|framebuffer|arraybuffer|typed.?array|device.?id|camera.?label|camera.?object|mediastream|track)/i.test(key)).map(([key, item]) => [key, privacyClone(item, seen)]));
  seen.delete(value);
  return output;
}
function safeClone(value) { return globalThis.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value)); }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
