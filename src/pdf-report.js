/** Component 15: local-only, text-based PDF generation from C12/C14 records. */
export const REPORT_SCHEMA_VERSION = '1.0.0';
const PAGE = Object.freeze({ width: 595.28, height: 841.89, left: 52, right: 52, top: 60, bottom: 54, line: 15 });

/** Create a PDF without changing or recalculating any screening measurements. */
export function generateScreeningReport(source) {
  const report = prepareReport(source);
  const pages = paginate(reportLines(report));
  const bytes = serializePdf(pages);
  return Object.freeze({
    schemaVersion: REPORT_SCHEMA_VERSION,
    bytes,
    pageCount: pages.length,
    filename: reportFilename(report),
    report,
  });
}

export function createScreeningReportBlob(source, options) {
  const generated = generateScreeningReport(source, options);
  return Object.freeze({ ...generated, blob: new Blob([generated.bytes], { type: 'application/pdf' }) });
}

/** Values are exposed only for an explicitly VALID and presentable result. */
export function prepareReport(source) {
  if (!isRecord(source) || !['VALID', 'LOW_CONFIDENCE', 'INCONSISTENT', 'RETEST_REQUIRED', 'INVALID'].includes(source.status)) {
    throw new TypeError('Component 15 requires a supported, versioned Component 12 or 14 screening result.');
  }
  if (source.schemaVersion !== '1.0.0') throw new TypeError('The screening result schema is not supported by this report version.');
  if (!(source.technicalValidityOnly === true || source.validity?.technicalValidityOnly === true)
    || !(source.clinicalValidity === 'NOT_ASSESSED' || source.validity?.clinicalValidity === 'NOT_ASSESSED')) {
    throw new TypeError('The screening result is missing the technical-only and non-diagnostic validity markers.');
  }
  const measuredAt = source.timestamp || source.measuredAt;
  if (typeof measuredAt !== 'string' || !Number.isFinite(Date.parse(measuredAt))) throw new TypeError('The screening result has no valid measurement date.');
  const safety = isRecord(source.medicalSafety) ? source.medicalSafety : null;
  const safetyAllowsPresentation = !safety || safety.status === 'SAFE_TO_SCREEN' && safety.canPresentEstimate === true;
  const canPresent = source.status === 'VALID' && source.canPresent === true && safetyAllowsPresentation;
  const eyes = {};
  for (const designation of ['OD', 'OS']) {
    const eye = source.eyes?.[designation];
    const status = safeText(eye?.status || source.eyeStatuses?.[designation] || source.status, 80);
    const measurements = canPresent && status === 'VALID' ? extractMeasurements(eye, designation) : [];
    // A malformed “valid” record fails closed and cannot disclose unvalidated values.
    if (canPresent && status === 'VALID' && measurements.length === 0) throw new TypeError(`The VALID result is missing a structurally valid ${designation} estimate.`);
    eyes[designation] = Object.freeze({ status, measurements: Object.freeze(measurements) });
  }
  const consistency = source.consistency || source.retest?.consistency || source.validity?.consistency || null;
  const confidence = source.validity?.confidence || null;
  const retest = source.retest || null;
  return Object.freeze({
    schemaVersion: REPORT_SCHEMA_VERSION,
    sessionId: identifierText(source.id ?? source.resultId ?? source.sessionId) || 'Not assigned',
    measuredAt: new Date(measuredAt).toISOString(),
    status: source.status,
    canPresent,
    eyes: Object.freeze(eyes),
    reasons: Object.freeze(normalizeReasons(source.reasons)),
    medicalSafety: safety ? Object.freeze({
      status: safeText(safety.status, 80),
      engineVersion: safeText(safety.engineVersion, 80),
      reasons: Object.freeze(normalizeReasons(safety.reasons)),
      warnings: Object.freeze(normalizeReasons(safety.warnings)),
      recommendations: Object.freeze(Array.isArray(safety.recommendations) ? safety.recommendations.map(value => safeText(value, 1000)).filter(Boolean) : []),
    }) : null,
    confidence: confidence ? safeJson(confidence) : null,
    consistency: consistency ? safeJson(consistency) : null,
    attempts: nonNegativeInteger(source.attemptCount ?? retest?.attempts?.length),
    retests: nonNegativeInteger(retest?.retestsUsed),
    modelVersion: safeText(source.versions?.modelVersion || source.validity?.sourceAnalysis?.predictionModelVersion || '', 120) || 'Not available',
    softwareVersion: safeText(source.versions?.component12 || source.validity?.engineVersion || '', 120) || 'Not available',
  });
}

function extractMeasurements(eye, designation) {
  if (!isRecord(eye)) return [];
  const sourceMeasurements = Array.isArray(eye.measurements) ? eye.measurements
    : Number.isFinite(eye.sph) || Number.isFinite(eye.cyl) || Number.isFinite(eye.axis) || eye.axis === null ? [eye] : [];
  return sourceMeasurements.map((item, index) => {
    // C12 direct result uses `estimate`, history uses normalized flat measurement fields.
    const value = isRecord(item?.estimate) ? item.estimate : item;
    if (!isRecord(value) || !Number.isFinite(value.sph) || !Number.isFinite(value.cyl)
      || !(Number.isFinite(value.axis) && value.axisStatus === 'AVAILABLE' || value.axis === null && value.axisStatus === 'NOT_APPLICABLE')
      || value.units?.sph !== 'D' || value.units?.cyl !== 'D' || value.units?.axis !== 'deg') return null;
    if (item?.designation && item.designation !== designation || item?.eye && item.eye !== designation) return null;
    return Object.freeze({
      attemptNumber: nonNegativeInteger(item?.attemptNumber) ?? index + 1,
      sph: value.sph,
      cyl: value.cyl,
      axis: value.axis,
      axisStatus: value.axisStatus,
    });
  }).filter(Boolean);
}

function reportLines(report) {
  const lines = [
    { text: 'VISION SCREENING REPORT', style: 'title' },
    { text: 'Refractive-error estimation · Component 15', style: 'subtitle' },
    { text: `Measurement date and time: ${formatDate(report.measuredAt)}`, style: 'body' },
    { text: `Session / result ID: ${report.sessionId}`, style: 'body' },
    { text: `Overall technical status: ${report.status.replaceAll('_', ' ')}`, style: report.canPresent ? 'good' : 'alert' },
    { text: 'Technical screening status only; clinical validity has not been assessed.', style: 'small' },
    { text: 'Right Eye (OD)', style: 'heading' },
    ...eyeLines(report.eyes.OD, report.canPresent),
    { text: 'Left Eye (OS)', style: 'heading' },
    ...eyeLines(report.eyes.OS, report.canPresent),
    { text: 'Session details', style: 'heading' },
    { text: `Attempts recorded: ${report.attempts ?? 'Not available'}`, style: 'body' },
    { text: `Retests used: ${report.retests ?? 'Not available'}`, style: 'body' },
    { text: `Model version: ${report.modelVersion}`, style: 'body' },
    { text: `Software / result schema: ${report.softwareVersion}`, style: 'body' },
  ];
  if (report.confidence) lines.push({ text: `Confidence metadata (as recorded): ${JSON.stringify(report.confidence)}`, style: 'small' });
  if (report.consistency) lines.push({ text: `Consistency metadata (as recorded): ${JSON.stringify(report.consistency)}`, style: 'small' });
  lines.push({ text: 'Recorded reasons', style: 'heading' });
  if (report.reasons.length) for (const reason of report.reasons) lines.push({ text: `• ${reason}`, style: 'body' });
  else lines.push({ text: 'No reason details were provided by the result pipeline.', style: 'small' });
  if (report.medicalSafety) {
    lines.push({ text: `Medical safety workflow state: ${report.medicalSafety.status.replaceAll('_', ' ')}`, style: report.medicalSafety.status === 'SAFE_TO_SCREEN' ? 'small' : 'alert' });
    for (const reason of report.medicalSafety.reasons) lines.push({ text: `Safety reason: ${reason}`, style: 'body' });
    for (const warning of report.medicalSafety.warnings) lines.push({ text: `Safety note: ${warning}`, style: 'body' });
    for (const recommendation of report.medicalSafety.recommendations) lines.push({ text: `Recommendation: ${recommendation}`, style: 'small' });
  }
  lines.push(
    { text: 'Important limitations', style: 'heading' },
    { text: 'This is a vision screening and refractive-error estimation report, not a medical diagnosis or prescription. It does not replace a professional eye examination. Screening estimates may be incomplete or unreliable; seek assessment from a qualified eye-care professional, especially for symptoms, concerns, or decisions about corrective lenses.', style: 'body' },
    { text: 'No raw eye photographs or camera frames are included. This report was generated locally by this browser from the saved application result.', style: 'small' },
  );
  return lines;
}

function eyeLines(eye, canPresent) {
  if (!canPresent) return [
    { text: `Technical status: ${eye.status.replaceAll('_', ' ')}`, style: 'body' },
    { text: 'Estimate withheld because this session is not marked VALID and presentable.', style: 'alert' },
  ];
  return [
    { text: `Technical status: ${eye.status.replaceAll('_', ' ')}`, style: 'body' },
    ...eye.measurements.map((measurement, index) => ({
      text: `${measurement.attemptNumber ? `Attempt ${measurement.attemptNumber}` : `Measurement ${index + 1}`}: SPH ${signed(measurement.sph)} D · CYL ${signed(measurement.cyl)} D · Axis ${measurement.axisStatus === 'NOT_APPLICABLE' ? 'Not applicable' : `${String(measurement.axis)}°`}`,
      style: 'value',
    })),
  ];
}

function paginate(lines) {
  const pages = [[]];
  let y = PAGE.height - PAGE.top;
  for (const line of lines) {
    const fontSize = line.style === 'title' ? 18 : line.style === 'heading' ? 13 : line.style === 'subtitle' ? 10 : line.style === 'small' ? 8.5 : 10;
    const maxChars = Math.max(34, Math.floor((PAGE.width - PAGE.left - PAGE.right) / (fontSize * 0.51)));
    const wrapped = wrapText(line.text, maxChars);
    const height = wrapped.length * PAGE.line + (line.style === 'heading' ? 4 : 1);
    if (y - height < PAGE.bottom) { pages.push([]); y = PAGE.height - PAGE.top; }
    for (const text of wrapped) { pages.at(-1).push({ text, style: line.style, y }); y -= PAGE.line; }
    y -= line.style === 'heading' ? 4 : 1;
  }
  return pages;
}

function serializePdf(pages) {
  const objects = [];
  const add = value => (objects.push(value), objects.length);
  const catalogId = add('');
  const pagesId = add('');
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const pageRefs = [];
  for (let index = 0; index < pages.length; index++) {
    const content = pageContent(pages[index], index + 1, pages.length);
    const contentId = add(`<< /Length ${latin1(content).length} >>\nstream\n${content}\nendstream`);
    const pageId = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageRefs.push(`${pageId} 0 R`);
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pages.length} >>`;
  let document = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(latin1(document).length);
    document += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = latin1(document).length;
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) document += `${String(offset).padStart(10, '0')} 00000 n \n`;
  document += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return latin1(document);
}

function pageContent(lines, pageNumber, pageCount) {
  let output = '';
  for (const line of lines) {
    const style = line.style;
    const size = style === 'title' ? 18 : style === 'heading' ? 13 : style === 'subtitle' ? 10 : style === 'small' ? 8.5 : 10;
    const color = style === 'alert' ? '0.55 0.20 0.05' : style === 'good' ? '0.05 0.35 0.25' : '0.10 0.16 0.18';
    output += `BT ${color} rg /F1 ${size} Tf 1 0 0 1 ${PAGE.left} ${line.y.toFixed(2)} Tm (${pdfString(line.text)}) Tj ET\n`;
    if (style === 'heading') output += `0.03 0.45 0.48 RG 0.8 w ${PAGE.left} ${(line.y - 4).toFixed(2)} m ${PAGE.width - PAGE.right} ${(line.y - 4).toFixed(2)} l S\n`;
  }
  output += `BT 0.35 0.40 0.42 rg /F1 8 Tf 1 0 0 1 ${PAGE.left} 28 Tm (Vision screening report · Page ${pageNumber} of ${pageCount}) Tj ET\n`;
  return output;
}

function wrapText(value, maxChars) {
  const words = String(value).replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\xFF]/g, '?').match(/\S+/g) || [''];
  const output = []; let line = '';
  for (const word of words) {
    if (!line) { line = word; continue; }
    if (`${line} ${word}`.length <= maxChars) line += ` ${word}`;
    else { output.push(line); line = word; }
    while (line.length > maxChars) { output.push(line.slice(0, maxChars)); line = line.slice(maxChars); }
  }
  if (line || !output.length) output.push(line);
  return output;
}
function pdfString(value) { return value.replace(/([\\()])/g, '\\$1').replace(/[\r\n]/g, ' '); }
function latin1(value) { const output = new Uint8Array(value.length); for (let i = 0; i < value.length; i++) output[i] = value.charCodeAt(i) & 0xff; return output; }
function signed(value) { return value > 0 || Object.is(value, 0) ? `+${String(value)}` : String(value); }
function formatDate(value) { try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); } catch { return value; } }
function normalizeReasons(reasons) { return (Array.isArray(reasons) ? reasons : []).map(reason => isRecord(reason) ? [reason.eye, reason.code, reason.message].filter(Boolean).map(value => safeText(value, 1000)).filter(Boolean).join(': ') : safeText(reason, 1000)).filter(Boolean); }
function safeText(value, limit) { return typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').slice(0, limit) : ''; }
function identifierText(value) { return typeof value === 'string' ? safeText(value, 120) : Number.isSafeInteger(value) && value > 0 ? String(value) : ''; }
function safeJson(value) { try { return JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'number' && !Number.isFinite(item) ? null : item).slice(0, 1600)); } catch { return null; } }
function nonNegativeInteger(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function reportFilename(report) { const date = report.measuredAt.slice(0, 10); const id = report.sessionId === 'Not assigned' ? 'screening' : report.sessionId.replace(/[^a-z0-9_-]/gi, '-').slice(0, 36); return `vision-screening-${date}-${id}.pdf`; }
