import { SCHEMA_VERSION } from './config.js';
/** @typedef {'yes'|'no'|'not-sure'} YesNo */
export function createResult(a, safety, sessionId = crypto.randomUUID()) {
  return Object.freeze({ schemaVersion: SCHEMA_VERSION, sessionId, completedAt: new Date().toISOString(), completionStatus: 'complete', workflowAllowed: safety.status === 'SAFE_TO_SCREEN', safetyScreening: safety, age: Number(a.age), previousPrescription: { status: a.previousPrescription, right: normalizePrescription(a.right), left: normalizePrescription(a.left) }, responses: { wearsCorrection:a.wearsCorrection, lastExam:a.lastExam, blurredVision:a.blurredVision, suddenVisionChange:a.suddenVisionChange, painfulSymptoms:a.painfulSymptoms, seriousEyeInjury:a.seriousEyeInjury, pendingEyeSurgeryFollowup:a.pendingEyeSurgeryFollowup, eyeConditionHistory:a.eyeConditionHistory, steadyGaze:a.steadyGaze, historyDescription:a.historyDescription.trim() || undefined }, consent: { screening: true } });
}
function normalizePrescription(p) { return Object.fromEntries(Object.entries(p).filter(([, v]) => v !== '').map(([k,v]) => [k, Number(v)])); }
