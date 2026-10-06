/** Component 14: local-only browsing. Mutations are always behind an explicit confirmation. */
export function mountHistoryStep(root, { store } = {}, { onBack = () => {}, onResetSession = () => {}, onClearAllData = () => {}, confirmAction = message => globalThis.confirm?.(message) === true } = {}) {
  if (!store?.list || !store?.get || !store?.delete || !store?.clear) throw new TypeError('Component 14 requires the local history store.');
  let disposed = false;
  root.innerHTML = `<section aria-labelledby="history-title"><h2 id="history-title" tabindex="-1">Result history and privacy</h2><p class="prescription-safety">These are stored vision-screening estimates, not medical diagnoses or professional prescriptions. Historical results do not replace a comprehensive eye examination.</p><p class="notice">Saved history, consent receipts, and optional settings use this browser’s local IndexedDB when available. Questionnaire answers and the active session stay in memory and are cleared on reset or page exit. Eye images and camera frames are not stored. No cloud synchronization is configured.</p><p id="history-privacy-status" class="hint" role="status" aria-live="polite">Checking local storage availability…</p><p id="history-state" class="hint" role="status" aria-live="polite">Loading history stored on this device…</p><div class="actions"><button id="history-clear" class="secondary" type="button" hidden>Clear saved results</button><button id="history-view-data" class="secondary" type="button">View stored data summary</button><button id="history-reset-session" class="secondary" type="button">Reset current session</button><button id="history-clear-all-data" class="secondary" type="button">Clear all local test data</button><button id="history-back" class="secondary" type="button">Back</button></div><dl id="history-data-summary" class="history-metadata" hidden></dl><div id="history-record-list" class="history-record-list" aria-label="Previous screening sessions"></div><section id="history-detail" aria-labelledby="history-detail-title" hidden><h3 id="history-detail-title" tabindex="-1">Screening session details</h3><div id="history-detail-content"></div><div class="actions"><button id="history-detail-close" class="secondary" type="button">Close details</button></div></section></section>`;
  const state = root.querySelector('#history-state');
  const list = root.querySelector('#history-record-list');
  const clearButton = root.querySelector('#history-clear');
  const detail = root.querySelector('#history-detail');
  const detailContent = root.querySelector('#history-detail-content');
  const privacyStatus = root.querySelector('#history-privacy-status');
  const dataSummary = root.querySelector('#history-data-summary');
  const viewDataButton = root.querySelector('#history-view-data');
  const resetSessionButton = root.querySelector('#history-reset-session');
  const clearAllDataButton = root.querySelector('#history-clear-all-data');
  const refresh = async () => {
    if (disposed) return;
    state.textContent = 'Loading history stored on this device…';
    try {
      const { records, corruptedCount } = await store.list();
      if (disposed) return;
      renderRecords(records, list, state, clearButton, corruptedCount, { openRecord, deleteRecord, exportRecord });
    } catch {
      if (disposed) return;
      list.replaceChildren(); clearButton.hidden = true;
      state.textContent = 'Local history is unavailable. No records were transmitted; check browser storage permissions or available space.';
      state.classList?.add('is-error');
    }
  };
  const openRecord = async id => {
    state.textContent = 'Opening saved session…';
    try {
      const record = await store.get(id);
      if (!record) { state.textContent = 'That history record is no longer available.'; await refresh(); return; }
      detail.dataset.recordId = String(record.id);
      detailContent.replaceChildren(makeDetail(record, exportRecord));
      detail.hidden = false;
      state.textContent = 'Complete saved result opened.';
      root.querySelector('#history-detail-title')?.focus?.();
    } catch {
      state.textContent = 'This record could not be opened from local storage.';
      state.classList?.add('is-error');
    }
  };
  const deleteRecord = async (id, timestamp) => {
    if (!confirmAction('Delete this screening history record from this device? This cannot be undone.')) return;
    try { await store.delete(id); if (root.querySelector('#history-detail')?.dataset?.recordId === String(id)) detail.hidden = true; state.textContent = `Deleted the result recorded ${timestamp}.`; await refresh(); }
    catch { state.textContent = 'The result could not be deleted from local history.'; state.classList?.add('is-error'); }
  };
  const clearAll = async () => {
    if (!confirmAction('Clear every saved screening result from this device? This cannot be undone.')) return;
    try { await store.clear(); detail.hidden = true; detailContent.replaceChildren(); state.textContent = 'All local screening history was cleared.'; await refresh(); }
    catch { state.textContent = 'Local history could not be cleared.'; state.classList?.add('is-error'); }
  };
  const showDataSummary = async () => {
    if (!store.getDataSummary) { privacyStatus.textContent = 'Detailed local data summary is unavailable.'; return; }
    try {
      const summary = await store.getDataSummary();
      const fields = {
        'Storage status': summary.storage.available ? `${summary.storage.backend} available on this device` : 'Unavailable or restricted',
        'Saved screening results': summary.resultCount,
        'Corrupted records skipped': summary.corruptedRecordCount,
        'Consent receipt stored': summary.consentStored ? 'Yes' : 'No',
        'Application settings stored': summary.settingsStored ? 'Yes' : 'No',
        'Session metadata stored': summary.sessionMetadataStored ? 'Yes' : 'No',
        'Questionnaire answers persisted': 'No',
        'Camera images persisted': 'No',
      };
      dataSummary.replaceChildren(...Object.entries(fields).flatMap(([label, value]) => { const term = document.createElement('dt'); term.textContent = label; const desc = document.createElement('dd'); desc.textContent = String(value); return [term, desc]; }));
      dataSummary.hidden = false;
      privacyStatus.textContent = summary.storage.available ? 'The listed data is stored locally in this browser. Browser settings or private mode can still remove or restrict it.' : 'Local storage is unavailable; no data was transmitted.';
    } catch { privacyStatus.textContent = 'Stored data details are unavailable in this browser.'; }
  };
  const resetSession = async () => {
    if (!confirmAction('Reset the current in-memory screening session and questionnaire answers? Saved history will remain.')) return;
    try { if (store.resetSessionData) await store.resetSessionData(); else store.resetSession?.(); await onResetSession(); }
    catch { privacyStatus.textContent = 'The current session could not be fully reset.'; privacyStatus.classList?.add('is-error'); }
  };
  const clearAllLocalData = async () => {
    if (!confirmAction('Permanently clear all locally stored test results, consent receipts, settings, and the current session from this device? This cannot be undone.')) return;
    try { await store.clearAllData(); detail.hidden = true; detailContent.replaceChildren(); dataSummary.hidden = true; privacyStatus.textContent = 'All application data stored by this site was cleared from this browser.'; await onClearAllData(); }
    catch { privacyStatus.textContent = 'All local data could not be cleared. No remote deletion was attempted.'; privacyStatus.classList?.add('is-error'); }
  };
  const exportRecord = (record, mode = 'download') => {
    const event = new CustomEvent('component15-report-export-request', {
      bubbles: true, cancelable: true,
      detail: { schemaVersion: '1.0.0', record, mode },
    });
    root.dispatchEvent(event);
    state.textContent = event.defaultPrevented ? 'Report export was handed to Component 15.' : 'Report export is not available in this version. The history record remains saved locally.';
  };
  const closeDetails = () => { detail.hidden = true; detailContent.replaceChildren(); root.querySelector('#history-title')?.focus?.(); };
  const back = () => onBack();
  clearButton.addEventListener('click', clearAll);
  viewDataButton.addEventListener('click', showDataSummary);
  resetSessionButton.addEventListener('click', resetSession);
  clearAllDataButton.addEventListener('click', clearAllLocalData);
  root.querySelector('#history-back').addEventListener('click', back);
  root.querySelector('#history-detail-close').addEventListener('click', closeDetails);
  void store.getStorageAvailability?.().then(result => { privacyStatus.textContent = result.available ? 'Local browser storage is available for history and consent receipts; no cloud sync is configured.' : 'Local storage is unavailable or restricted; saved history may not persist.'; }).catch(() => { privacyStatus.textContent = 'Storage availability could not be checked.'; });
  void refresh();
  return () => { if (disposed) return; disposed = true; clearButton.removeEventListener('click', clearAll); viewDataButton.removeEventListener('click', showDataSummary); resetSessionButton.removeEventListener('click', resetSession); clearAllDataButton.removeEventListener('click', clearAllLocalData); root.querySelector('#history-back').removeEventListener('click', back); root.querySelector('#history-detail-close').removeEventListener('click', closeDetails); };
}

function renderRecords(records, container, state, clearButton, corruptedCount, actions) {
  container.replaceChildren();
  clearButton.hidden = records.length === 0;
  if (records.length === 0) state.textContent = corruptedCount ? `No readable history records were found. ${corruptedCount} damaged record${corruptedCount === 1 ? ' was' : 's were'} skipped; nothing was deleted.` : 'No screening history is saved on this device yet.';
  else state.textContent = `Showing ${records.length} saved screening session${records.length === 1 ? '' : 's'} on this device.${corruptedCount ? ` ${corruptedCount} damaged record${corruptedCount === 1 ? ' was' : 's were'} skipped and left untouched.` : ''}`;
  container.replaceChildren(...records.map(record => makeSummaryCard(record, actions)));
}

function makeSummaryCard(record, actions) {
  const card = document.createElement('article'); card.className = 'history-record';
  const title = document.createElement('h3'); title.textContent = formatDate(record.measuredAt);
  const status = document.createElement('p'); status.className = `history-status ${record.canPresent ? 'is-valid' : 'is-incomplete'}`;
  const safetyStatus = record.medicalSafety?.status && record.medicalSafety.status !== 'SAFE_TO_SCREEN' ? ` · ${record.medicalSafety.status.replaceAll('_', ' ')}` : '';
  status.textContent = `${record.status.replaceAll('_', ' ')}${safetyStatus}${record.retest?.retestsUsed ? ` · ${record.retest.retestsUsed} retest${record.retest.retestsUsed === 1 ? '' : 's'}` : ''}`;
  const summary = document.createElement('p'); summary.className = 'history-eye-summary'; summary.textContent = record.canPresent ? `OD: ${shortMeasurement(record.eyes.OD.measurements[0])} · OS: ${shortMeasurement(record.eyes.OS.measurements[0])}` : `OD: ${record.eyes.OD.status} · OS: ${record.eyes.OS.status} · Estimates withheld`;
  const id = document.createElement('p'); id.className = 'hint'; id.textContent = `Local result ID ${record.id} · ${record.attemptCount ?? 'Attempt count unavailable'} attempt${record.attemptCount === 1 ? '' : 's'}`;
  const actionsNode = document.createElement('div'); actionsNode.className = 'actions';
  const open = button('Open result', 'secondary', () => void actions.openRecord(record.id));
  const exportButton = button('Download PDF report', 'secondary', () => actions.exportRecord(record, 'download'));
  const remove = button('Delete result', 'secondary', () => void actions.deleteRecord(record.id, formatDate(record.measuredAt)));
  actionsNode.append(open, exportButton, remove);
  card.append(title, status, summary, id, actionsNode);
  return card;
}

function makeDetail(record, exportRecord) {
  const fragment = document.createElement('div');
  const disclaimer = document.createElement('p'); disclaimer.className = 'prescription-safety'; disclaimer.textContent = 'Screening history only—not a diagnosis or a confirmed prescription.';
  const eyeGrid = document.createElement('div'); eyeGrid.className = 'result-eye-grid';
  eyeGrid.append(makeEyeDetail(record.eyes.OD, record.canPresent), makeEyeDetail(record.eyes.OS, record.canPresent));
  const meta = document.createElement('dl'); meta.className = 'history-metadata';
  addTerm(meta, 'Overall technical status', record.status);
  addTerm(meta, 'Medical safety workflow', record.medicalSafety?.status || 'Not recorded');
  addTerm(meta, 'Validity status', record.validity?.status || 'Unavailable');
  addTerm(meta, 'C13 consistency', record.consistency?.status || 'Unavailable');
  addTerm(meta, 'Retests used', record.retest?.retestsUsed ?? 'Unavailable');
  addTerm(meta, 'Attempts retained', record.attemptCount ?? 'Unavailable');
  addTerm(meta, 'Model', [record.versions?.modelId, record.versions?.modelVersion].filter(Boolean).join(' · ') || 'Unavailable');
  const reasons = document.createElement('section');
  const reasonTitle = document.createElement('h4'); reasonTitle.textContent = 'Validity and retest reasons';
  const reasonList = document.createElement('ul');
  reasonList.replaceChildren(...(record.reasons || []).map(reason => { const item = document.createElement('li'); item.textContent = `${reason.eye ? `${reason.eye}: ` : ''}${reason.code || 'REASON'} — ${reason.message || ''}`; return item; }));
  for (const reason of record.medicalSafety?.reasons || []) { const item = document.createElement('li'); item.textContent = `Safety · ${reason.code}: ${reason.message}`; reasonList.append(item); }
  for (const warning of record.medicalSafety?.warnings || []) { const item = document.createElement('li'); item.textContent = `Safety note · ${warning.code}: ${warning.message}`; reasonList.append(item); }
  reasons.append(reasonTitle, reasonList);
  const technical = document.createElement('details');
  const summary = document.createElement('summary'); summary.textContent = 'Complete stored technical record';
  const pre = document.createElement('pre'); pre.className = 'history-json'; pre.textContent = JSON.stringify(record, null, 2);
  technical.append(summary, pre);
  const reportActions = document.createElement('div'); reportActions.className = 'actions';
  reportActions.append(button('Preview PDF report', 'secondary', () => exportRecord(record, 'preview')));
  fragment.append(disclaimer, eyeGrid, meta, reasons, reportActions, technical);
  return fragment;
}

function makeEyeDetail(eye, canPresent) {
  const card = document.createElement('article'); card.className = 'result-eye-card';
  const title = document.createElement('h4'); title.textContent = eye.designation === 'OD' ? 'Right Eye (OD)' : 'Left Eye (OS)';
  const status = document.createElement('p'); status.textContent = `Status: ${eye.status}.`;
  card.append(title, status);
  if (canPresent) for (const measurement of eye.measurements) {
    const heading = document.createElement('h5'); heading.textContent = `Measurement${measurement.attemptNumber === null ? '' : ` ${measurement.attemptNumber}`}`;
    const values = document.createElement('dl'); values.className = 'result-values';
    addTerm(values, 'SPH', `${signed(measurement.sph)} D`); addTerm(values, 'CYL', `${signed(measurement.cyl)} D`);
    addTerm(values, 'Axis', measurement.axisStatus === 'NOT_APPLICABLE' ? 'Not applicable' : `${measurement.axis}°`);
    card.append(heading, values);
  } else {
    const withheld = document.createElement('p'); withheld.className = 'result-estimate-hidden'; withheld.textContent = 'No confirmed estimate is stored for this eye.'; card.append(withheld);
  }
  return card;
}

function button(label, className, action) { const node = document.createElement('button'); node.type = 'button'; node.className = className; node.textContent = label; node.addEventListener('click', action); return node; }
function addTerm(list, label, value) { const term = document.createElement('dt'); term.textContent = label; const description = document.createElement('dd'); description.textContent = String(value); list.append(term, description); }
function signed(value) { return value > 0 || Object.is(value, 0) ? `+${String(value)}` : String(value); }
function shortMeasurement(measurement) { return `${signed(measurement.sph)} / ${signed(measurement.cyl)} / ${measurement.axisStatus === 'NOT_APPLICABLE' ? 'N/A' : `${measurement.axis}°`}`; }
function formatDate(timestamp) { const date = new Date(timestamp); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date) : 'Date unavailable'; }
