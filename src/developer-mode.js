import { CameraController } from './camera-controller.js';
import { createDeviceCompatibilityLayer } from './device-compatibility.js';
import { createLocalDataStore } from './local-data-store.js';

const names = ['Questionnaire & Consent', 'Camera & Flash', 'Guided Positioning', 'Eye Detection', 'Image Quality', 'Auto Capture', 'Preprocessing', 'Feature Extraction', 'AI Prediction', 'OD/OS Analysis', 'Confidence & Validity', 'Result Screen', 'Retest & Consistency', 'Result History', 'PDF Report', 'Privacy & Local Data', 'Device Compatibility', 'Medical Safety'];
const components = new Map(names.map((name, index) => [index + 1, { component: index + 1, name, status: 'NOT_TESTABLE', automatedStatus: 'NOT RUN', executionMs: null, dependencies: 'No test run yet.', error: null, lastTestAt: null }]));
const app = document.querySelector('#application-frame');
const testSelect = document.querySelector('#component-select');
const testStatus = document.querySelector('#test-run-status');
const componentTable = document.querySelector('#component-results');
const errorsNode = document.querySelector('#test-errors');
const pipelineState = document.querySelector('#pipeline-state');
const journeyStatus = document.querySelector('#journey-status');
const hardwareStatus = document.querySelector('#hardware-status');
const hardwareDetails = document.querySelector('#hardware-details');
const reportSummary = document.querySelector('#report-summary');
const localStore = createLocalDataStore();
const compatibility = createDeviceCompatibilityLayer({ localDataStore: localStore });
let lastAutomationReport = null;
let journeyReport = null;
let cameraReport = null;
let cameraController = null;
let running = false;

for (let id = 1; id <= 18; id++) {
  const option = document.createElement('option');
  option.value = String(id);
  option.textContent = `Component ${id} — ${names[id - 1]}`;
  testSelect.append(option);
}

function setStatus(node, title, message, level = 'notice') {
  node.className = `positioning-status ${level === 'FAIL' ? 'is-error' : level === 'PASS' ? 'is-ready' : ''}`;
  node.replaceChildren();
  const strong = document.createElement('strong');
  strong.textContent = title;
  const span = document.createElement('span');
  span.textContent = message;
  node.append(strong, span);
}

function fillDl(node, entries) {
  node.replaceChildren(...entries.flatMap(([key, value]) => {
    const term = document.createElement('dt'); term.textContent = key;
    const description = document.createElement('dd'); description.textContent = value == null ? 'Not available' : String(value);
    return [term, description];
  }));
  node.hidden = false;
}

function renderComponents() {
  componentTable.replaceChildren(...[...components.values()].map(item => {
    const row = document.createElement('tr');
    const values = [
      `Component ${item.component} · ${item.name}`,
      item.status,
      item.automatedStatus,
      item.executionMs == null ? '—' : `${item.executionMs} ms`,
      item.error || item.dependencies,
    ];
    for (let index = 0; index < values.length; index++) {
      const cell = document.createElement('td'); cell.textContent = values[index];
      if (index === 1) cell.dataset.status = item.status.toLowerCase().replaceAll(' ', '-');
      row.append(cell);
    }
    const actionCell = document.createElement('td');
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = 'Run';
    button.setAttribute('aria-label', `Run Component ${item.component} tests`);
    button.disabled = running;
    button.addEventListener('click', () => void runTests({ component: item.component }));
    actionCell.append(button); row.append(actionCell);
    return row;
  }));
}

function updateReportSummary() {
  const report = combinedReport();
  const counts = Object.fromEntries(['PASS', 'FAIL', 'WARNING', 'NOT_TESTABLE'].map(status => [status, report.components.filter(item => item.status === status).length]));
  reportSummary.textContent = `Overall ${report.overallStatus} · PASS ${counts.PASS} · FAIL ${counts.FAIL} · WARNING ${counts.WARNING} · NOT TESTABLE ${counts.NOT_TESTABLE}. Export contains the latest unit/integration run plus any browser journey and camera results.`;
  document.querySelector('#export-json').disabled = !lastAutomationReport && !journeyReport && !cameraReport;
  document.querySelector('#export-markdown').disabled = !lastAutomationReport && !journeyReport && !cameraReport;
  document.querySelector('#rerun-failed').disabled = running || !lastAutomationReport?.failedFiles?.length;
}

function mergeStatus(id, patch) { components.set(id, { ...components.get(id), ...patch }); }

async function runTests(selection) {
  if (running) return;
  running = true; renderComponents();
  const request = selection?.files ? { files: selection.files } : { component: selection?.component ?? 'all' };
  setStatus(testStatus, 'Running project tests…', `Starting ${request.component === 'all' ? 'the full' : 'the selected'} Node.js built-in test suite. No browser camera permission is requested.`);
  try {
    const response = await fetch('/__dev-tests/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), cache: 'no-store' });
    const report = await response.json();
    if (!response.ok) throw new Error(report.error || `Test endpoint returned ${response.status}.`);
    lastAutomationReport = report;
    for (const result of report.components) mergeStatus(result.component, result);
    const failedFiles = report.failedFiles || [];
    const critical = report.criticalIssues || [];
    setStatus(testStatus,
      report.summary.failed ? 'Automated tests failed' : 'Automated tests completed',
      `${report.summary.passed}/${report.summary.tests} passed · ${report.summary.failed} failed · ${report.durationMs} ms. ${critical.join(' ')}`,
      report.summary.failed ? 'FAIL' : 'PASS');
    errorsNode.textContent = report.rawFailureOutput || 'No automated test failures.';
    document.querySelector('#run-metadata').hidden = false;
    fillDl(document.querySelector('#run-metadata'), [
      ['Last test time', report.testedAt], ['Runtime', report.runtime], ['Duration', `${report.durationMs} ms`],
      ['Tests', `${report.summary.passed} passed · ${report.summary.failed} failed · ${report.summary.skipped} skipped`],
      ['AI model', `${report.aiModel.status}: ${report.aiModel.detail}`], ['Camera', report.camera.status], ['Storage', report.storage.status], ['PDF', report.pdf.status],
    ]);
    document.querySelector('#rerun-failed').disabled = running || !failedFiles.length;
  } catch (error) {
    setStatus(testStatus, 'Test run could not complete', error.message, 'FAIL');
    errorsNode.textContent = error.stack || error.message;
  } finally {
    running = false; renderComponents(); updateReportSummary();
  }
}

function setAnswer(frameDocument, field, value) {
  const control = frameDocument.querySelector(`[name="${CSS.escape(field)}"]${field === 'age' ? '' : `[value="${CSS.escape(value)}"]`}`);
  if (!control) throw new Error(`The real application questionnaire is missing ${field}.`);
  if (control.type === 'radio') control.checked = true;
  else control.value = value;
  control.dispatchEvent(new Event('input', { bubbles: true }));
  control.dispatchEvent(new Event('change', { bubbles: true }));
}

function waitFor(read, timeoutMs = 12000) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try { const value = read(); if (value) return resolve(value); }
      catch (error) { return reject(error); }
      if (performance.now() - started >= timeoutMs) return reject(new Error('Timed out waiting for the real application to reach its next UI state.'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

async function runJourney() {
  if (running) return;
  running = true; document.querySelector('#run-journey').disabled = true;
  journeyReport = { status: 'RUNNING', startedAt: new Date().toISOString(), components: {}, issues: [] };
  setStatus(journeyStatus, 'Starting isolated journey…', 'Opening the actual application and entering minimal, non-sensitive test answers.');
  app.hidden = false; app.src = '/';
  try {
    await new Promise((resolve, reject) => { app.onload = resolve; app.onerror = () => reject(new Error('The real application iframe could not be loaded.')); });
    const doc = app.contentDocument;
    await waitFor(() => doc?.querySelector('#questionnaire'));
    setAnswer(doc, 'age', '25');
    for (const [field, value] of Object.entries({ previousPrescription: 'no', wearsCorrection: 'no', lastExam: 'within-year', blurredVision: 'no', suddenVisionChange: 'no', painfulSymptoms: 'no', seriousEyeInjury: 'no', pendingEyeSurgeryFollowup: 'no', eyeConditionHistory: 'no', steadyGaze: 'no' })) setAnswer(doc, field, value);
    const consent = doc.querySelector('[name="requiredConsent"]');
    if (!consent) throw new Error('Required C1 screening consent control was not found.');
    consent.checked = true; consent.dispatchEvent(new Event('change', { bubbles: true }));
    const saveHistory = doc.querySelector('[name="saveHistory"]');
    if (saveHistory) { saveHistory.checked = false; saveHistory.dispatchEvent(new Event('change', { bubbles: true })); }
    doc.querySelector('#questionnaire').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => doc.querySelector('#device-compatibility')
      && doc.querySelector('#compatibility-heading')?.textContent?.trim() !== 'Checking browser and device support…'
      && doc.querySelector('#compatibility-safety .medical-safety-state'));
    const reachedCompatibility = Boolean(doc.querySelector('#device-compatibility'));
    const compatibilityHeading = doc.querySelector('#compatibility-heading')?.textContent?.trim() || 'Not reached';
    const safetyHeading = doc.querySelector('#compatibility-safety h2')?.textContent?.trim() || doc.querySelector('#app .medical-safety-state h2')?.textContent?.trim() || 'Not reported';
    const compatibilityText = doc.querySelector('#compatibility-summary')?.textContent || '';
    journeyReport.browserDevice = { browser: compatibilityText.split(' · ')[0] || 'Not reported', deviceModel: 'Not inferred by the application' };
    const modelUnavailable = /prediction model.*not configured|no trained prediction model/i.test(`${compatibilityText} ${doc.querySelector('#compatibility-items')?.textContent || ''} ${doc.querySelector('#compatibility-safety')?.textContent || ''}`);
    journeyReport.components[1] = { status: reachedCompatibility ? 'PASS' : 'FAIL', detail: reachedCompatibility ? 'Real C1 form validation and consent routed to the existing C2/C17 page.' : 'The app did not reach the compatibility page.' };
    journeyReport.components[17] = { status: reachedCompatibility ? 'PASS' : 'NOT_TESTABLE', detail: `Actual browser preflight: ${compatibilityHeading}. ${compatibilityText}` };
    journeyReport.components[18] = { status: reachedCompatibility && safetyHeading !== 'Not reported' ? 'PASS' : 'NOT_TESTABLE', detail: `Central C18 state: ${safetyHeading}. It must block progression when the current model/device cannot safely produce a result.` };
    journeyReport.components[2] = { status: 'NOT_TESTABLE', detail: 'This journey intentionally does not request camera permission; use the real camera test below.' };
    journeyReport.components[9] = { status: modelUnavailable ? 'NOT_TESTABLE' : 'WARNING', detail: modelUnavailable ? 'No configured trained local prediction model. No inference or values were generated.' : 'Preflight completed, but this journey did not run an inference.' };
    for (const id of [3,4,5,6,7,8,10,11,12,13,14,15,16]) journeyReport.components[id] = { status: 'NOT_TESTABLE', detail: modelUnavailable ? 'Upstream real model is unavailable, so this stage was not entered by the application.' : 'Full downstream journey was not exercised by this preflight-only browser run.' };
    journeyReport.status = reachedCompatibility && modelUnavailable ? 'WARNING' : reachedCompatibility ? 'NOT_TESTABLE' : 'FAIL';
    journeyReport.finishedAt = new Date().toISOString();
    journeyReport.pipeline = { title: doc.querySelector('#page-title')?.textContent?.trim(), compatibility: compatibilityHeading, safety: safetyHeading, cameraPermissionRequested: false, historyOptIn: false, predictionValuesGenerated: false };
    journeyReport.issues = modelUnavailable ? ['Full E2E stops at the real compatibility/safety gate because Component 9 has no trained local model.'] : ['The app preflight did not confirm the missing model; manual AI dependency verification is still required.'];
    setStatus(journeyStatus, journeyReport.status === 'WARNING' ? 'Journey safely stopped at the current dependency boundary' : journeyReport.status === 'FAIL' ? 'Journey failed' : 'Journey incomplete', `C1 ${journeyReport.components[1].status} · C17 ${compatibilityHeading} · C18 ${safetyHeading} · C9 ${journeyReport.components[9].status}. ${journeyReport.issues.join(' ')}`, journeyReport.status === 'FAIL' ? 'FAIL' : 'WARNING');
    fillDl(pipelineState, Object.entries(journeyReport.pipeline));
    for (const [idText, result] of Object.entries(journeyReport.components)) {
      const id = Number(idText);
      mergeStatus(id, { status: result.status, error: result.status === 'FAIL' ? result.detail : null, dependencies: result.detail, lastTestAt: journeyReport.finishedAt });
    }
  } catch (error) {
    journeyReport.status = 'FAIL'; journeyReport.finishedAt = new Date().toISOString(); journeyReport.issues = [error.message];
    setStatus(journeyStatus, 'Journey failed', error.message, 'FAIL');
    errorsNode.textContent = `${errorsNode.textContent}\n\nBrowser journey error: ${error.stack || error.message}`;
  } finally {
    running = false; document.querySelector('#run-journey').disabled = false; renderComponents(); updateReportSummary();
  }
}

function clearJourney() {
  app.onload = null; app.onerror = null; app.removeAttribute('src'); app.hidden = true;
  journeyReport = null; pipelineState.hidden = true; pipelineState.replaceChildren();
  setStatus(journeyStatus, 'Not run', 'The isolated application frame was closed. No saved test results were created or removed.');
  renderComponents(); updateReportSummary();
}

async function runRealCamera() {
  if (cameraController || running) return;
  cameraReport = { status: 'RUNNING', startedAt: new Date().toISOString(), components: {} };
  const video = document.querySelector('#hardware-preview');
  const startButton = document.querySelector('#run-camera');
  const stopButton = document.querySelector('#stop-camera');
  startButton.disabled = true;
  setStatus(hardwareStatus, 'Checking actual browser capabilities…', 'No camera permission has been requested yet.');
  hardwareDetails.hidden = true;
  try {
    const before = await compatibility.assess();
    if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      cameraReport.status = 'NOT_TESTABLE';
      cameraReport.components[2] = { status: 'NOT_TESTABLE', detail: 'Camera permission API or secure context is unavailable.' };
      cameraReport.components[17] = { status: 'WARNING', detail: `${before.browser.family}; ${before.recommendations.join(' ')}` };
      setStatus(hardwareStatus, 'Camera is not testable here', `${before.browser.family}. ${before.recommendations.join(' ')}`, 'WARNING');
      return;
    }
    video.hidden = false;
    cameraController = new CameraController({
      video,
      config: {
        videoConstraints: compatibility.cameraConfiguration(),
        cameraSelectionSupported: before.configuration.cameraSelectionSupported,
        width: 1280, height: 720, frameRate: 24,
      },
      onStateChange: snapshot => setStatus(hardwareStatus, `Camera: ${snapshot.status}`, snapshot.error || (snapshot.previewReady ? 'Actual browser camera preview is live.' : 'Waiting for camera permission and preview metadata.'), snapshot.error ? 'FAIL' : snapshot.previewReady ? 'PASS' : 'WARNING'),
    });
    stopButton.disabled = false;
    const snapshot = await cameraController.startCamera();
    cameraReport.camera = { status: snapshot.previewReady ? 'PASS' : 'FAIL', snapshot };
    if (!snapshot.previewReady) {
      cameraReport.status = 'FAIL';
      cameraReport.components[2] = { status: 'FAIL', detail: snapshot.error || 'Camera did not produce a ready preview.' };
      setStatus(hardwareStatus, `Camera failed: ${snapshot.status}`, snapshot.error || 'The actual camera did not start.', 'FAIL');
      return;
    }
    const after = await compatibility.assess({ cameraSnapshot: snapshot });
    const rearStatus = snapshot.activeFacingMode === 'environment' ? 'PASS' : snapshot.activeFacingMode ? 'WARNING' : 'NOT_TESTABLE';
    const torchStatus = snapshot.torchSupported ? 'PASS' : 'WARNING';
    const storage = await localStore.getStorageAvailability();
    cameraReport.status = 'PASS';
    cameraReport.components[2] = { status: 'PASS', detail: 'Component 2 CameraController opened a real local camera stream and released it when stopped.' };
    cameraReport.components[17] = { status: after.status === 'UNSUPPORTED' ? 'FAIL' : 'PASS', detail: `${after.browser.family}; actual resolution ${snapshot.actualResolution?.width} × ${snapshot.actualResolution?.height}; camera status ${after.camera.availability}.` };
    cameraReport.hardware = {
      rearCamera: { status: rearStatus, activeFacingMode: snapshot.activeFacingMode || null, fallback: snapshot.facingModeFallback },
      torch: { status: torchStatus, supported: snapshot.torchSupported === true },
      resolution: snapshot.actualResolution,
      frameRate: snapshot.settings?.frameRate ?? null,
      cameraStatus: after.camera.availability,
      orientation: { type: screen.orientation?.type || null, angle: Number.isFinite(screen.orientation?.angle) ? screen.orientation.angle : null },
      storage,
      compatibility: after.status,
      note: 'A reported resolution is factual only; no clinical or model adequacy threshold is inferred. Torch is capability-detected but not activated by this test.',
    };
    fillDl(hardwareDetails, [
      ['Browser', after.browser.family], ['Camera', after.camera.availability], ['Facing mode', snapshot.activeFacingMode || 'Not reported'],
      ['Rear-facing', rearStatus], ['Resolution', `${snapshot.actualResolution?.width ?? '?'} × ${snapshot.actualResolution?.height ?? '?'}`],
      ['Frame rate', snapshot.settings?.frameRate ?? 'Not reported'], ['Torch support', snapshot.torchSupported ? 'Reported by track (not activated)' : 'Not supported/reported'],
      ['Focus controls', Object.keys(snapshot.capabilities || {}).filter(key => key.toLowerCase().includes('focus')).join(', ') || 'Not reported'],
      ['Orientation', `${cameraReport.hardware.orientation.type || 'Not reported'} (${cameraReport.hardware.orientation.angle ?? 'unknown'}°)`],
      ['Local storage', storage.available ? `${storage.backend} available` : 'Unavailable or restricted'], ['Compatibility', after.status],
    ]);
    setStatus(hardwareStatus, 'Actual camera test passed', 'A real preview and track settings were observed. Torch/rear-camera limitations are reported separately; no image was captured or saved.', 'PASS');
  } catch (error) {
    cameraReport.status = 'FAIL'; cameraReport.error = error.message;
    cameraReport.components[2] = { status: 'FAIL', detail: error.message };
    setStatus(hardwareStatus, 'Actual camera test failed', `${error.name || 'Error'}: ${error.message}. Check permission, secure context, camera availability, or whether another app is using it.`, 'FAIL');
  } finally {
    cameraReport.finishedAt = new Date().toISOString();
    startButton.disabled = false;
    if (!cameraController) stopButton.disabled = true;
    renderComponents(); updateReportSummary();
  }
}

async function stopRealCamera() {
  if (!cameraController) return;
  await cameraController.stopCamera();
  cameraController = null;
  document.querySelector('#hardware-preview').srcObject = null;
  document.querySelector('#stop-camera').disabled = true;
  cameraReport && (cameraReport.stoppedAt = new Date().toISOString());
  setStatus(hardwareStatus, 'Camera stopped and tracks released', 'The actual local media stream was stopped; no image or frame was saved.', 'PASS');
  updateReportSummary();
}

function combinedReport() {
  const list = [...components.values()];
  const failures = list.filter(item => item.status === 'FAIL').length;
  return {
    schemaVersion: '1.0.0', generatedAt: new Date().toISOString(),
    overallStatus: failures ? 'FAIL' : journeyReport?.status === 'WARNING' || lastAutomationReport?.overallStatus === 'WARNING' || cameraReport?.status === 'PASS' ? 'WARNING' : 'NOT_TESTABLE',
    summary: { passed: list.filter(item => item.status === 'PASS').length, failed: failures, warnings: list.filter(item => item.status === 'WARNING').length, notTestable: list.filter(item => item.status === 'NOT_TESTABLE').length },
    components: list,
    browserDevice: journeyReport?.browserDevice || (cameraReport?.hardware ? { browser: cameraReport.hardware.browser, deviceModel: 'Not inferred by the application' } : { browser: 'Not measured', deviceModel: 'Not inferred by the application' }),
    unitIntegration: lastAutomationReport,
    browserJourney: journeyReport,
    realDeviceCheck: cameraReport,
    criticalIssues: [...new Set([...(lastAutomationReport?.criticalIssues || []), ...(journeyReport?.issues || []), ...(cameraReport?.error ? [cameraReport.error] : [])])],
  };
}

function downloadReport(kind) {
  const report = combinedReport();
  const content = kind === 'json' ? JSON.stringify(report, null, 2) : toMarkdown(report);
  const blob = new Blob([content], { type: kind === 'json' ? 'application/json' : 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `vision-screening-component-19-report.${kind === 'json' ? 'json' : 'md'}`; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function toMarkdown(report) {
  const rows = report.components.map(item => `| ${item.component} | ${item.name} | ${item.status} | ${item.automatedStatus} | ${item.error || item.detail || item.dependencies} |`).join('\n');
  return `# Component 19 Validation Report\n\n- Overall: ${report.overallStatus}\n- Generated: ${report.generatedAt}\n- PASS: ${report.summary.passed} · FAIL: ${report.summary.failed} · WARNING: ${report.summary.warnings} · NOT TESTABLE: ${report.summary.notTestable}\n- Browser: ${report.browserDevice.browser}\n- Device model: ${report.browserDevice.deviceModel}\n- AI model: ${report.unitIntegration?.aiModel?.status || 'NOT TESTABLE'}\n- Camera: ${report.realDeviceCheck?.status || report.unitIntegration?.camera?.status || 'NOT TESTED'}\n\n| Component | Name | Status | Automated | Details |\n|---:|---|---|---|---|\n${rows}\n\n## Critical issues\n${report.criticalIssues.map(item => `- ${item}`).join('\n') || '- None recorded'}\n`;
}

document.querySelector('#run-all').addEventListener('click', () => void runTests({ component: 'all' }));
document.querySelector('#run-one').addEventListener('click', () => void runTests({ component: Number(testSelect.value) }));
document.querySelector('#rerun-failed').addEventListener('click', () => void runTests({ files: lastAutomationReport?.failedFiles || [] }));
document.querySelector('#clear-run').addEventListener('click', () => {
  lastAutomationReport = null; journeyReport = null; cameraReport = null;
  for (const [id, item] of components) mergeStatus(id, { status: 'NOT_TESTABLE', automatedStatus: 'NOT RUN', executionMs: null, dependencies: 'No test run yet.', error: null, lastTestAt: null });
  errorsNode.textContent = 'No errors have been reported.';
  document.querySelector('#run-metadata').hidden = true;
  setStatus(testStatus, 'Developer test session cleared', 'Only this dashboard’s report state was cleared. Existing application history and local data were not touched.');
  clearJourney(); renderComponents(); updateReportSummary();
});
document.querySelector('#clear-journey').addEventListener('click', clearJourney);
document.querySelector('#run-journey').addEventListener('click', () => void runJourney());
document.querySelector('#run-camera').addEventListener('click', () => void runRealCamera());
document.querySelector('#stop-camera').addEventListener('click', () => void stopRealCamera());
document.querySelector('#export-json').addEventListener('click', () => downloadReport('json'));
document.querySelector('#export-markdown').addEventListener('click', () => downloadReport('md'));

const localSession = location.hostname === '127.0.0.1' || location.hostname === 'localhost';
document.querySelector('#developer-security').textContent = localSession
  ? 'Developer test endpoint is available on this local origin. Camera access remains opt-in and runs through the actual Component 2 controller.'
  : 'This dashboard is intended for localhost only. Do not expose developer mode on a public or production server.';

renderComponents(); updateReportSummary();
window.addEventListener('pagehide', () => {
  void cameraController?.stopCamera();
  app.onload = null; app.onerror = null; app.removeAttribute('src');
  void localStore.close();
}, { once: true });
