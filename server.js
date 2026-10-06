import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createPredictionEngine } from './src/prediction-engine.js';

const execFileAsync = promisify(execFile);

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const port = Number(process.env.PORT || 4173);
const contentTypes = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.md':'text/markdown; charset=utf-8' };
const componentTests = Object.freeze({
  1: ['questionnaire.test.js'],
  2: ['camera-controller.test.js', 'device-compatibility.test.js'],
  3: ['positioning.test.js'],
  4: ['eye-localization.test.js', 'eye-analysis.test.js'],
  5: ['image-quality.test.js', 'capture-state.test.js'],
  6: ['capture-state.test.js', 'camera-controller.test.js'],
  7: ['preprocessing.test.js'],
  8: ['feature-extraction.test.js'],
  9: ['prediction-engine.test.js'],
  10: ['eye-analysis.test.js'],
  11: ['validity-engine.test.js', 'safety.test.js'],
  12: ['prescription-result-step.test.js'],
  13: ['retest-consistency.test.js', 'retest-step.test.js'],
  14: ['history-store.test.js', 'history-step.test.js'],
  15: ['pdf-report.test.js'],
  16: ['local-data-store.test.js', 'history-store.test.js'],
  17: ['device-compatibility.test.js'],
  18: ['safety.test.js'],
});

function developerModeEnabled() { return process.env.ENABLE_DEV_TEST_MODE === '1' && process.env.NODE_ENV !== 'production'; }

function json(response, statusCode, value) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}

async function readRequestJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 4096) throw new Error('Request body too large.');
  }
  return body ? JSON.parse(body) : {};
}

async function runDeveloperTests(request) {
  const body = await readRequestJson(request);
  let files;
  if (body.component === 'all' || body.component === undefined) {
    files = [...new Set(Object.values(componentTests).flat())];
  } else if (Array.isArray(body.files)) {
    const allowed = new Set(Object.values(componentTests).flat());
    files = [...new Set(body.files.filter(file => allowed.has(file)))];
    if (!files.length) throw new Error('No recognized failed test files were provided.');
  } else {
    const id = Number(body.component);
    if (!Number.isInteger(id) || !componentTests[id]) throw new Error('Choose a component between 1 and 18, or all.');
    files = componentTests[id];
  }
  const startedAt = Date.now();
  const outputs = [], fileResults = [];
  for (const file of files) {
    let stdout = '', stderr = '', exitCode = 0;
    try {
      const result = await execFileAsync(process.execPath, ['--test', '--test-reporter=tap', `test/${file}`], { cwd: root, windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
      stdout = result.stdout || ''; stderr = result.stderr || '';
    } catch (error) {
      stdout = error.stdout || ''; stderr = error.stderr || ''; exitCode = Number.isInteger(error.code) ? error.code : 1;
    }
    const fileSummary = parseTap(stdout);
    if (exitCode && !fileSummary.failed) fileSummary.failed = Math.max(1, fileSummary.tests - fileSummary.passed);
    fileResults.push({ file, ...fileSummary, status: fileSummary.failed ? 'FAIL' : 'PASS' });
    outputs.push(`## ${file}\n${stdout}${stderr ? `\n${stderr}` : ''}`);
  }
  const stdout = outputs.join('\n');
  const summary = fileResults.reduce((total, item) => ({ tests: total.tests + item.tests, passed: total.passed + item.passed, failed: total.failed + item.failed, skipped: total.skipped + item.skipped, todo: total.todo + item.todo, durationMs: total.durationMs + item.durationMs }), { tests: 0, passed: 0, failed: 0, skipped: 0, todo: 0, durationMs: 0 });
  const failedTests = [...stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]);
  const failedFiles = fileResults.filter(item => item.status === 'FAIL').map(item => item.file);
  const modelStatus = await inspectModelStatus();
  const selectedIds = Object.entries(componentTests).filter(([, assigned]) => assigned.some(file => files.includes(file))).map(([id]) => Number(id));
  const componentStatuses = selectedIds.map(id => {
    const physical = [2, 3, 4, 5, 6, 7, 8].includes(id);
    const modelDependent = [3, 4, 8, 9].includes(id);
    const unavailableModel = id === 9 && modelStatus !== 'READY';
    const componentStatus = summary.failed || id === 9 && modelStatus === 'LOAD_FAILED' ? 'FAIL' : unavailableModel ? 'NOT_TESTABLE' : physical ? 'WARNING' : 'PASS';
    return {
      component: id,
      name: componentName(id),
      status: componentStatus,
      automatedStatus: summary.failed ? 'FAIL' : 'PASS',
      executionMs: fileResults.filter(item => componentTests[id].includes(item.file)).reduce((total, item) => total + item.durationMs, 0),
      dependencies: unavailableModel ? 'No configured trained refractive-error model.' : physical ? 'Unit/contract tests passed; physical browser/hardware path was not exercised by Node tests.' : modelDependent ? 'Model/hardware runtime is not exercised by contract tests.' : 'Project-local component modules and Node built-in test fixtures.',
      error: summary.failed ? failedTests.join('; ') || stderr.slice(-3000) : id === 9 && modelStatus === 'LOAD_FAILED' ? 'The real Component 9 model failed to initialize.' : null,
      lastTestAt: new Date(startedAt).toISOString(),
    };
  });
  const report = {
    schemaVersion: '1.0.0',
    overallStatus: summary.failed || modelStatus === 'LOAD_FAILED' ? 'FAIL' : 'WARNING',
    testedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    runtime: `Node.js ${process.version}`,
    browserDevice: 'Not measured by the Node test runner.',
    summary,
    components: componentStatuses,
    testFiles: files,
    fileResults,
    failedTests,
    failedFiles,
    aiModel: { status: modelStatus, detail: modelStatus === 'NOT_CONFIGURED' ? 'The real Component 9 PredictionEngine returned MODEL_NOT_CONFIGURED. It requires a trained local model manifest, model artifact, compatible runtime adapter, and verified feature/output contract.' : modelStatus === 'READY' ? 'The local engine initialized. Inference is still not considered validated until the real feature batch and expected output contract are exercised.' : 'The real Component 9 engine did not reach a testable ready state.' },
    camera: { status: 'NOT_TESTABLE', detail: 'Node contract tests do not request the user’s camera. Use the explicit live camera preflight in the developer dashboard.' },
    storage: { status: summary.failed ? 'CHECKED_WITH_TEST_FIXTURES' : 'PASS', detail: 'IndexedDB data-layer behavior is covered by the project test suite; browser-specific quota/private-mode behavior requires a real browser check.' },
    pdf: { status: summary.failed ? 'FAIL' : 'PASS', detail: 'Local PDF output and withholding rules are covered by Component 15 tests.' },
    criticalIssues: [ ...(modelStatus === 'NOT_CONFIGURED' ? ['No trained local refractive-error model is configured; end-to-end prediction and result stages cannot run.'] : []), 'Camera and eye-detection hardware were not accessed by the automated Node run.' ],
    recommendedFixes: [ ...(modelStatus === 'NOT_CONFIGURED' ? ['Configure and validate a real local Component 9 model before attempting full screening.'] : []), 'Run the browser journey and live camera checks on each target browser/device with explicit user permission.' ],
    rawFailureOutput: summary.failed ? stdout.slice(-12000) : '',
  };
  report.markdown = markdownReport(report);
  return report;
}

function parseTap(output) {
  const count = label => Number(output.match(new RegExp(`^# ${label} (\\d+)$`, 'm'))?.[1] || 0);
  const durationMs = Number(output.match(/^# duration_ms ([\d.]+)$/m)?.[1] || 0);
  return { tests: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped'), todo: count('todo'), durationMs };
}

async function inspectModelStatus() {
  const engine = createPredictionEngine();
  try {
    const snapshot = await engine.initialize();
    return snapshot?.modelReady ? 'READY' : snapshot?.status === 'unavailable' ? 'NOT_CONFIGURED' : 'NOT_TESTABLE';
  } catch (error) {
    return error?.code === 'MODEL_NOT_CONFIGURED' ? 'NOT_CONFIGURED' : 'LOAD_FAILED';
  } finally { await engine.dispose?.(); }
}

function componentName(id) { return ['Questionnaire & Consent','Camera & Flash','Guided Positioning','Eye Detection','Image Quality','Auto Capture','Preprocessing','Feature Extraction','AI Prediction','OD/OS Analysis','Confidence & Validity','Result Screen','Retest & Consistency','Result History','PDF Report','Privacy & Local Data','Device Compatibility','Medical Safety'][id - 1]; }

function markdownReport(report) {
  const rows = report.components.map(item => `| ${item.component} | ${item.name} | ${item.status} | ${item.automatedStatus} | ${item.error || item.dependencies} |`).join('\n');
  return `# Component 19 Test Report\n\n- Overall: ${report.overallStatus}\n- Tested: ${report.testedAt}\n- Runtime: ${report.runtime}\n- Duration: ${report.durationMs} ms\n- Tests: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped\n- Browser/device: ${report.browserDevice}\n- AI model: ${report.aiModel.status} — ${report.aiModel.detail}\n- Camera: ${report.camera.status} — ${report.camera.detail}\n- Storage: ${report.storage.status}\n- PDF: ${report.pdf.status}\n\n| Component | Name | Status | Automated | Details |\n|---:|---|---|---|---|\n${rows}\n\n## Critical issues\n${report.criticalIssues.map(item => `- ${item}`).join('\n') || '- None'}\n\n## Recommended fixes\n${report.recommendedFixes.map(item => `- ${item}`).join('\n') || '- None'}\n`;
}

createServer((request,response)=>{
  let pathname;
  try { pathname=decodeURIComponent(new URL(request.url,'http://localhost').pathname); }
  catch { response.writeHead(400).end('Bad request'); return; }
  if (pathname === '/__dev-tests' || pathname === '/__dev-tests/') {
    if (!developerModeEnabled()) { response.writeHead(404).end('Not found'); return; }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    createReadStream(resolve(root, 'test/developer-mode.html')).pipe(response); return;
  }
  if (pathname === '/__dev-tests/run') {
    if (!developerModeEnabled()) { json(response, 404, { error: 'Not found' }); return; }
    if (request.method !== 'POST') { json(response, 405, { error: 'Use POST to start a test run.' }); return; }
    void runDeveloperTests(request).then(report => json(response, 200, report)).catch(error => json(response, 400, { error: error.message || 'Tests could not be started.' }));
    return;
  }
  if (pathname.startsWith('/test/developer-mode') && !developerModeEnabled()) { response.writeHead(404).end('Not found'); return; }
  const relative=pathname==='/'?'index.html':pathname.replace(/^\/+/, '');
  const target=resolve(root,relative);
  if (target!==root && !target.startsWith(`${root}${sep}`)) { response.writeHead(403).end('Forbidden'); return; }
  if (!existsSync(target) || !statSync(target).isFile()) { response.writeHead(404).end('Not found'); return; }
  response.writeHead(200,{ 'Content-Type':contentTypes[extname(target)] || 'application/octet-stream', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer' });
  createReadStream(target).pipe(response);
}).listen(port,'127.0.0.1',()=>process.stdout.write(`Vision screening app: http://127.0.0.1:${port}\n`));
