/** In-memory integration boundary. Data is discarded on refresh/exit. */
let localDataStore = null;
export function configureSessionDataStore(store) {
  if (!store?.getSessionValue || !store?.setSessionValue) throw new TypeError('Component 16 local session access is required.');
  localDataStore = store;
}
export function setQuestionnaireResult(result) {
  if (!localDataStore) throw new Error('Component 16 local session service has not been configured.');
  localDataStore.setSessionValue('questionnaireResult', result);
}
export function getQuestionnaireResult() { return localDataStore?.getSessionValue('questionnaireResult') || null; }
export function canStartCameraStep() {
  const result = getQuestionnaireResult();
  return result?.completionStatus === 'complete' && result.workflowAllowed && result.consent.screening;
}
export function clearQuestionnaireSession() {
  if (localDataStore) localDataStore.setSessionValue('questionnaireResult', null);
}
