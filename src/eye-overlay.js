/** Convert normalized source-camera points to the displayed video element's box. */
export function mapVideoPoint(point, container, intrinsic, objectFit = 'contain', mirrored = false) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !container?.width || !container?.height || !intrinsic?.width || !intrinsic?.height) return null;
  const sx = container.width / intrinsic.width, sy = container.height / intrinsic.height;
  const scale = objectFit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
  const renderedWidth = intrinsic.width * scale, renderedHeight = intrinsic.height * scale;
  const offsetX = (container.width - renderedWidth) / 2, offsetY = (container.height - renderedHeight) / 2;
  const x = mirrored ? 1 - point.x : point.x;
  return { x: offsetX + x * renderedWidth, y: offsetY + point.y * renderedHeight, offsetX, offsetY, renderedWidth, renderedHeight };
}

export function mapVideoBounds(bounds, container, intrinsic, objectFit = 'contain', mirrored = false) {
  if (!bounds) return null;
  const a = mapVideoPoint({ x: bounds.left, y: bounds.top }, container, intrinsic, objectFit, mirrored);
  const b = mapVideoPoint({ x: bounds.right, y: bounds.bottom }, container, intrinsic, objectFit, mirrored);
  if (!a || !b) return null;
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y), offsetX: a.offsetX, offsetY: a.offsetY, renderedWidth: a.renderedWidth, renderedHeight: a.renderedHeight };
}

/** Development-only drawing; callers must gate it off on production hosts. */
export function drawEyeOverlay(canvas, result, container, intrinsic, { objectFit = 'contain', mirrored = false } = {}) {
  const context = canvas?.getContext?.('2d');
  if (!context) return false;
  const dpr = globalThis.devicePixelRatio || 1;
  const width = Math.round(container.width * dpr), height = Math.round(container.height * dpr);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  canvas.style.width = `${container.width}px`; canvas.style.height = `${container.height}px`;
  context.setTransform(dpr, 0, 0, dpr, 0, 0); context.clearRect(0, 0, container.width, container.height);
  if (!result) return true;
  for (const eye of [result.leftEye, result.rightEye]) {
    if (!eye?.detected || !eye.boundingBox) continue;
    const color = eye.validity?.geometryState === 'VALID' ? '#55e3a1' : '#ffbf69';
    const box = mapVideoBounds(eye.boundingBox, container, intrinsic, objectFit, mirrored);
    if (box) { context.strokeStyle = color; context.lineWidth = 2; context.strokeRect(box.x, box.y, box.width, box.height); }
    const mapPoints = points => (points || []).map(point => mapVideoPoint(point, container, intrinsic, objectFit, mirrored)).filter(Boolean);
    const contour = mapPoints(eye.landmarks?.contour);
    context.fillStyle = color;
    for (const point of contour) { context.beginPath(); context.arc(point.x, point.y, 2.1, 0, Math.PI * 2); context.fill(); }
    drawPolyline(context, mapPoints(eye.landmarks?.eyelids?.upper), color);
    drawPolyline(context, mapPoints(eye.landmarks?.eyelids?.lower), color);
    const iris = mapPoints(eye.iris?.boundary);
    if (iris.length >= 3) { drawPolyline(context, [...iris, iris[0]], '#72c7ff'); }
    const center = eye.iris?.center && mapVideoPoint(eye.iris.center, container, intrinsic, objectFit, mirrored);
    if (center) { context.fillStyle = '#72c7ff'; context.beginPath(); context.arc(center.x, center.y, 3.5, 0, Math.PI * 2); context.fill(); }
    const labelPoint = box && { x: box.x, y: Math.max(16, box.y - 6) };
    if (labelPoint) { context.fillStyle = color; context.font = '600 14px system-ui'; context.fillText(`${eye.designation} · ${eye.validity?.state || 'UNKNOWN'}`, labelPoint.x, labelPoint.y); }
  }
  return true;
}

function drawPolyline(context, points, color) {
  if (points.length < 2) return;
  context.strokeStyle = color; context.lineWidth = 1.5; context.beginPath(); context.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) context.lineTo(point.x, point.y);
  context.stroke();
}
