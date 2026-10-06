import { POSITIONING_CONFIG } from './positioning-config.js';

export const EYE_LOCALIZATION_SCHEMA_VERSION = '1.0.0';

/**
 * Localize both anatomical eyes from the connection graphs exported by the
 * pinned MediaPipe FaceLandmarker runtime. Coordinates are normalized in the
 * unmirrored camera-frame coordinate system (origin top-left).
 */
export function localizeEyes(detection, { positioningReady = true, timestamp, config = POSITIONING_CONFIG.eyeTracking } = {}) {
  const dimensions = detection?.videoDimensions;
  const frameWidth = dimensions?.width;
  const frameHeight = dimensions?.height;
  const at = Number.isFinite(timestamp) ? timestamp : detection?.timestamp ?? null;
  if (!positioningReady) return inactiveResult('POSITIONING_REQUIRED', at, frameWidth, frameHeight, 'Positioning must be acceptable before eye localization runs.');
  if (!detection?.landmarks) return inactiveResult('NO_FACE', at, frameWidth, frameHeight, 'No current face landmarks are available.');
  if (!validDimensions(frameWidth, frameHeight) || !Array.isArray(detection.landmarks) || !detection.eyeTopology) {
    return inactiveResult('INVALID_LANDMARKS', at, frameWidth, frameHeight, 'The model did not provide usable eye landmark definitions or frame dimensions.');
  }

  const points = detection.landmarks;
  const leftEye = localizeOne({
    eye: 'left', designation: 'OS', points, dimensions,
    contourConnections: detection.eyeTopology.leftEye, config,
    irisConnections: detection.eyeTopology.leftIris,
  });
  const rightEye = localizeOne({
    eye: 'right', designation: 'OD', points, dimensions,
    contourConnections: detection.eyeTopology.rightEye, config,
    irisConnections: detection.eyeTopology.rightIris,
  });
  const bothEyesGeometryValid = leftEye.validity.geometryState === 'VALID' && rightEye.validity.geometryState === 'VALID';
  return {
    schemaVersion: EYE_LOCALIZATION_SCHEMA_VERSION,
    timestamp: at,
    frameWidth,
    frameHeight,
    coordinateSpace: 'normalized_camera_frame_top_left_unmirrored',
    analysisStatus: bothEyesGeometryValid ? 'DETECTED' : 'PARTIAL_OR_INVALID',
    leftEye,
    rightEye,
    bothEyesDetected: leftEye.detected && rightEye.detected,
    bothEyesGeometryValid,
    bothEyesValid: false,
    trackingStable: false,
    visibilityAssessment: 'UNAVAILABLE',
    visibilityNote: 'Face Landmarker does not return per-eye visibility, occlusion, or landmark confidence scores. Geometric validity is not an image-quality or clinical-validity judgment.',
  };
}

function localizeOne({ eye, designation, points, dimensions, contourConnections, irisConnections, config }) {
  const contourIndices = connectionIndices(contourConnections);
  const irisIndices = connectionIndices(irisConnections);
  if (contourIndices.length < 8 || irisIndices.length < 4) return unavailableEye(eye, designation, 'INVALID', 'The runtime eye topology is incomplete.');
  if (contourIndices.some(index => !validImagePoint(points[index]))) return unavailableEye(eye, designation, 'INVALID', 'One or more eye contour landmarks are missing or outside the camera frame.');

  const contour = contourIndices.map(index => landmarkRecord(index, points[index], dimensions));
  const graph = adjacencyFromConnections(contourConnections, contourIndices);
  const ordered = orderEyeArcs(contourIndices, points, graph);
  if (!ordered) return unavailableEye(eye, designation, 'INVALID', 'The eye contour topology could not be resolved.');
  const { firstCorner, secondCorner, upperArc, lowerArc } = ordered;
  const eyeWidthPx = distancePx(points[firstCorner], points[secondCorner], dimensions);
  const box = boundsFromRecords(contour, dimensions);
  if (!Number.isFinite(eyeWidthPx) || eyeWidthPx < Math.min(dimensions.width, dimensions.height) * 0.012 || !box) {
    return unavailableEye(eye, designation, 'INVALID', 'The detected eye geometry is too small or malformed to use.');
  }

  if (irisIndices.some(index => !validImagePoint(points[index]))) {
    const partial = eyeGeometryWithoutIris({ eye, designation, contour, ordered, box, dimensions, points, config });
    partial.validity = { state: 'DETECTED', reason: 'Eye contour is present, but the model iris boundary is incomplete; downstream iris-dependent use is not valid.' };
    return partial;
  }

  const irisBoundary = irisIndices.map(index => landmarkRecord(index, points[index], dimensions));
  const iris = makeIris(irisBoundary, dimensions);
  const center = centerFromRecords(contour, dimensions);
  const openness = measureOpenness(upperArc, lowerArc, points, dimensions, config);
  const faceMidpoint = faceHorizontalMidpoint(points);
  const c1 = landmarkRecord(firstCorner, points[firstCorner], dimensions);
  const c2 = landmarkRecord(secondCorner, points[secondCorner], dimensions);
  const nasal = Math.abs(points[firstCorner].x - faceMidpoint) <= Math.abs(points[secondCorner].x - faceMidpoint) ? c1 : c2;
  const temporal = nasal === c1 ? c2 : c1;
  const angleDegrees = Math.atan2((points[secondCorner].y - points[firstCorner].y) * dimensions.height, (points[secondCorner].x - points[firstCorner].x) * dimensions.width) * 180 / Math.PI;

  return {
    eye,
    designation,
    detected: true,
    confidence: null,
    confidenceStatus: 'UNAVAILABLE',
    boundingBox: box,
    center,
    landmarks: {
      contour,
      eyeCorners: { nasal, temporal, method: 'nasal/temporal role estimated by proximity to the face horizontal midpoint' },
      eyelids: { upper: upperArc.map(index => landmarkRecord(index, points[index], dimensions)), lower: lowerArc.map(index => landmarkRecord(index, points[index], dimensions)) },
    },
    iris,
    pupil: { detected: false, center: null, status: 'UNAVAILABLE', reason: 'The selected Face Landmarker model does not provide pupil landmarks; no pupil detector is enabled.' },
    eyelid: { opennessRatio: openness.ratio, state: openness.state, method: 'mean vertical eyelid gap divided by eye-corner distance', thresholds: { closedMax: POSITIONING_CONFIG.eyeTracking.closedOpennessRatio, openMin: POSITIONING_CONFIG.eyeTracking.openOpennessRatio } },
    orientation: { angleDegrees, method: 'estimated from the eye-corner line in camera-frame pixels' },
    visibility: { state: 'UNAVAILABLE', reason: 'No per-eye visibility or occlusion score is provided by this model.' },
    validity: { state: 'DETECTED', geometryState: 'VALID', scope: 'landmark-geometry-only', reason: 'Per-eye confidence and occlusion are unavailable, so this output is not fully valid for capture or screening without downstream quality assessment.' },
    tracking: { state: 'DETECTED', missedFrames: 0, lastSeenAt: null },
  };
}

function eyeGeometryWithoutIris({ eye, designation, contour, ordered, box, dimensions, points, config }) {
  const center = centerFromRecords(contour, dimensions);
  const openness = measureOpenness(ordered.upperArc, ordered.lowerArc, points, dimensions, config);
  const first = landmarkRecord(ordered.firstCorner, points[ordered.firstCorner], dimensions);
  const second = landmarkRecord(ordered.secondCorner, points[ordered.secondCorner], dimensions);
  const faceMidpoint = faceHorizontalMidpoint(points);
  const nasal = Math.abs(points[ordered.firstCorner].x - faceMidpoint) <= Math.abs(points[ordered.secondCorner].x - faceMidpoint) ? first : second;
  const angleDegrees = Math.atan2((second.y - first.y) * dimensions.height, (second.x - first.x) * dimensions.width) * 180 / Math.PI;
  return {
    eye, designation, detected: true, confidence: null, confidenceStatus: 'UNAVAILABLE', boundingBox: box, center,
    landmarks: { contour, eyeCorners: { nasal, temporal: nasal === first ? second : first, method: 'nasal/temporal role estimated by proximity to the face horizontal midpoint' }, eyelids: { upper: ordered.upperArc.map(index => landmarkRecord(index, points[index], dimensions)), lower: ordered.lowerArc.map(index => landmarkRecord(index, points[index], dimensions)) } },
    iris: { detected: false, center: null, boundary: [], status: 'NOT_DETECTED', reason: 'The model iris boundary landmarks are incomplete.' },
    pupil: { detected: false, center: null, status: 'UNAVAILABLE', reason: 'The selected model does not provide pupil landmarks.' },
    eyelid: { opennessRatio: openness.ratio, state: openness.state, method: 'mean vertical eyelid gap divided by eye-corner distance', thresholds: { closedMax: POSITIONING_CONFIG.eyeTracking.closedOpennessRatio, openMin: POSITIONING_CONFIG.eyeTracking.openOpennessRatio } },
    orientation: { angleDegrees, method: 'estimated from the eye-corner line in camera-frame pixels' },
    visibility: { state: 'UNAVAILABLE', reason: 'No per-eye visibility or occlusion score is provided by this model.' },
    validity: { state: 'DETECTED', geometryState: 'PARTIAL', scope: 'eye-contour-only', reason: 'Iris landmarks are incomplete, so the full eye geometry is partial.' },
    tracking: { state: 'DETECTED', missedFrames: 0, lastSeenAt: null },
  };
}

function orderEyeArcs(indices, points, graph) {
  const corners = [...indices].sort((a, b) => points[a].x - points[b].x);
  const firstCorner = corners[0], secondCorner = corners.at(-1);
  if (firstCorner === secondCorner || points[secondCorner].x - points[firstCorner].x < 0.004) return null;
  const neighbors = graph.get(firstCorner) || [];
  if (neighbors.length !== 2) return null;
  const arcs = neighbors.map(next => traceArc(firstCorner, next, secondCorner, graph, indices.length + 1));
  if (arcs.some(path => !path || path.length < 3) || arcs[0].at(-1) !== arcs[1].at(-1)) return null;
  const meanY = path => path.reduce((sum, index) => sum + points[index].y, 0) / path.length;
  const [upperArc, lowerArc] = meanY(arcs[0]) <= meanY(arcs[1]) ? arcs : [arcs[1], arcs[0]];
  return { firstCorner, secondCorner, upperArc, lowerArc };
}

function traceArc(start, next, end, graph, limit) {
  const path = [start, next];
  let previous = start, current = next;
  while (current !== end && path.length <= limit) {
    const candidates = (graph.get(current) || []).filter(index => index !== previous);
    if (!candidates.length) return null;
    const following = candidates.find(index => index === end) ?? candidates[0];
    if (path.includes(following)) return null;
    path.push(following); previous = current; current = following;
  }
  return current === end ? path : null;
}

function measureOpenness(upper, lower, points, dimensions, config) {
  if (!upper?.length || !lower?.length) return { ratio: null, state: 'UNCERTAIN' };
  const left = points[upper[0]].x <= points[upper.at(-1)].x ? points[upper[0]] : points[upper.at(-1)];
  const right = points[upper[0]].x <= points[upper.at(-1)].x ? points[upper.at(-1)] : points[upper[0]];
  const width = distancePx(left, right, dimensions);
  if (!(width > 0)) return { ratio: null, state: 'UNCERTAIN' };
  const x1 = points[upper[0]].x <= points[upper.at(-1)].x ? points[upper[0]].x : points[upper.at(-1)].x;
  const x2 = points[upper[0]].x <= points[upper.at(-1)].x ? points[upper.at(-1)].x : points[upper[0]].x;
  const gaps = [0.25, 0.5, 0.75].map(fraction => {
    const x = x1 + (x2 - x1) * fraction;
    const upperY = interpolateArcY(upper, points, x);
    const lowerY = interpolateArcY(lower, points, x);
    return upperY === null || lowerY === null ? null : Math.abs(lowerY - upperY) * dimensions.height;
  }).filter(Number.isFinite);
  if (!gaps.length) return { ratio: null, state: 'UNCERTAIN' };
  const ratio = gaps.reduce((sum, value) => sum + value, 0) / gaps.length / width;
  return { ratio, state: ratio <= config.closedOpennessRatio ? 'CLOSED' : ratio >= config.openOpennessRatio ? 'OPEN' : 'PARTIALLY_CLOSED' };
}

function interpolateArcY(path, points, targetX) {
  const hits = [];
  for (let i = 1; i < path.length; i++) {
    const a = points[path[i - 1]], b = points[path[i]];
    if (targetX < Math.min(a.x, b.x) || targetX > Math.max(a.x, b.x)) continue;
    if (Math.abs(b.x - a.x) < 1e-9) { hits.push((a.y + b.y) / 2); continue; }
    const fraction = (targetX - a.x) / (b.x - a.x);
    hits.push(a.y + (b.y - a.y) * fraction);
  }
  if (hits.length) return hits.reduce((sum, value) => sum + value, 0) / hits.length;
  const nearest = path.reduce((best, index) => Math.abs(points[index].x - targetX) < Math.abs(points[best].x - targetX) ? index : best, path[0]);
  return points[nearest]?.y ?? null;
}

function makeIris(boundary, dimensions) {
  const centerX = boundary.reduce((sum, point) => sum + point.x, 0) / boundary.length;
  const centerY = boundary.reduce((sum, point) => sum + point.y, 0) / boundary.length;
  const orderedBoundary = [...boundary].sort((a, b) => Math.atan2((a.y - centerY) * dimensions.height, (a.x - centerX) * dimensions.width) - Math.atan2((b.y - centerY) * dimensions.height, (b.x - centerX) * dimensions.width));
  const xs = boundary.map(point => point.x), ys = boundary.map(point => point.y);
  return {
    detected: true,
    source: 'mediapipe_face_landmarker_boundary_landmarks',
    boundary: orderedBoundary,
    boundingBox: normalizedBounds(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), dimensions),
    center: { x: centerX, y: centerY, pixel: { x: centerX * dimensions.width, y: centerY * dimensions.height }, method: 'estimated as the mean of model-provided iris boundary points' },
    centerType: 'ESTIMATED_FROM_BOUNDARY',
  };
}

function boundsFromRecords(records, dimensions) {
  const xs = records.map(point => point.x), ys = records.map(point => point.y);
  return normalizedBounds(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), dimensions);
}
function normalizedBounds(left, top, right, bottom, dimensions) {
  return { left, top, right, bottom, width: right - left, height: bottom - top, coordinateSpace: 'normalized_camera_frame_top_left_unmirrored', pixel: { left: left * dimensions.width, top: top * dimensions.height, right: right * dimensions.width, bottom: bottom * dimensions.height, width: (right - left) * dimensions.width, height: (bottom - top) * dimensions.height } };
}
function centerFromRecords(records, dimensions) {
  const x = records.reduce((sum, point) => sum + point.x, 0) / records.length;
  const y = records.reduce((sum, point) => sum + point.y, 0) / records.length;
  return { x, y, pixel: { x: x * dimensions.width, y: y * dimensions.height } };
}
function landmarkRecord(index, point, dimensions) {
  return { index, x: point.x, y: point.y, ...(Number.isFinite(point.z) ? { z: point.z } : {}), pixel: { x: point.x * dimensions.width, y: point.y * dimensions.height } };
}
function connectionIndices(connections) {
  if (!Array.isArray(connections)) return [];
  return [...new Set(connections.flatMap(edge => [edge?.start, edge?.end]).filter(Number.isInteger))];
}
function adjacencyFromConnections(connections, indices) {
  const graph = new Map(indices.map(index => [index, new Set()]));
  for (const edge of connections || []) {
    if (graph.has(edge?.start) && graph.has(edge?.end)) { graph.get(edge.start).add(edge.end); graph.get(edge.end).add(edge.start); }
  }
  return new Map([...graph].map(([index, neighbors]) => [index, [...neighbors]]));
}
function faceHorizontalMidpoint(points) {
  const xs = points.map(point => point?.x).filter(value => Number.isFinite(value) && value >= 0 && value <= 1);
  return xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0.5;
}
function validImagePoint(point) { return Number.isFinite(point?.x) && Number.isFinite(point?.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1; }
function validDimensions(width, height) { return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0; }
function distancePx(a, b, dimensions) { return Math.hypot((a.x - b.x) * dimensions.width, (a.y - b.y) * dimensions.height); }

function unavailableEye(eye, designation, state, reason) {
  return {
    eye, designation, detected: false, confidence: null, confidenceStatus: 'UNAVAILABLE', boundingBox: null, center: null,
    landmarks: { contour: [], eyeCorners: null, eyelids: { upper: [], lower: [] } },
    iris: { detected: false, center: null, boundary: [], status: state === 'NOT_DETECTED' ? 'NOT_DETECTED' : 'UNAVAILABLE', reason },
    pupil: { detected: false, center: null, status: 'UNAVAILABLE', reason: 'The selected model does not provide pupil landmarks.' },
    eyelid: { opennessRatio: null, state: 'UNCERTAIN', method: 'unavailable' }, orientation: null,
    visibility: { state: 'UNAVAILABLE', reason: 'No per-eye visibility or occlusion score is provided by this model.' },
    validity: { state, geometryState: state === 'INVALID' ? 'INVALID' : state, reason }, tracking: { state, missedFrames: 0, lastSeenAt: null },
  };
}

function inactiveResult(status, timestamp, frameWidth, frameHeight, reason) {
  const state = status === 'NO_FACE' ? 'NOT_DETECTED' : 'INVALID';
  return {
    schemaVersion: EYE_LOCALIZATION_SCHEMA_VERSION, timestamp, frameWidth: frameWidth ?? null, frameHeight: frameHeight ?? null,
    coordinateSpace: 'normalized_camera_frame_top_left_unmirrored', analysisStatus: status,
    leftEye: unavailableEye('left', 'OS', state, reason), rightEye: unavailableEye('right', 'OD', state, reason),
    bothEyesDetected: false, bothEyesGeometryValid: false, bothEyesValid: false, trackingStable: false, visibilityAssessment: 'UNAVAILABLE',
    visibilityNote: 'Face Landmarker does not return per-eye visibility, occlusion, or landmark confidence scores.',
  };
}
