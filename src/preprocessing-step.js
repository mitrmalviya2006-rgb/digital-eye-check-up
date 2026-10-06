import {
  EYE_COORDINATE_SPACE,
  PREPROCESSING_VERSION,
  PreprocessingError,
  computeEyeCrop,
  computeEyeRotation,
  computeOutputTransform,
  processRgbaPixels,
  resolvePreprocessingConfig,
  validateCaptureForPreprocessing,
} from './image-preprocessing.js';
import { summarizeCaptureEvidence } from './capture-evidence.js';

export async function preprocessCapture(capture, {
  config = {},
  decodeImage = globalThis.createImageBitmap,
  createCanvas = () => document.createElement('canvas'),
  now = () => Date.now(),
  onBitmap = () => {},
  shouldContinue = () => true,
} = {}) {
  const settings = validateCaptureForPreprocessing(capture, config);
  if (typeof decodeImage !== 'function') throw new PreprocessingError('IMAGE_DECODER_UNAVAILABLE', 'This browser cannot decode the validated PNG image for local preprocessing.');
  let bitmap = null, canvas = null;
  try {
    if (!shouldContinue()) throw new PreprocessingError('PREPROCESSING_CANCELLED', 'Preprocessing was cancelled before image decoding.');
    bitmap = await decodeImage(capture.image);
    onBitmap(bitmap);
    if (!shouldContinue()) throw new PreprocessingError('PREPROCESSING_CANCELLED', 'Preprocessing was cancelled while decoding the captured image.');
    if (!bitmap || bitmap.width !== capture.width || bitmap.height !== capture.height) throw new PreprocessingError('CAPTURE_DECODE_INVALID', 'The decoded image dimensions do not match the validated capture.');
    canvas = createCanvas();
    if (!canvas) throw new PreprocessingError('PREPROCESSING_CANVAS_UNAVAILABLE', 'A local image-processing canvas is unavailable.');
    const eyes = {};
    for (const [key, expectedSide, expectedDesignation] of [['rightEye', 'right', 'OD'], ['leftEye', 'left', 'OS']]) {
      if (!shouldContinue()) throw new PreprocessingError('PREPROCESSING_CANCELLED', 'Preprocessing was cancelled before both eye regions were validated.');
      const eye = capture[key === 'leftEye' ? 'leftEyeDetection' : 'rightEyeDetection'];
      const cropRegion = computeEyeCrop(eye, bitmap.width, bitmap.height, settings);
      const rotationDegrees = computeEyeRotation(eye, bitmap.width, bitmap.height, settings.rotationStrategy, settings.maximumRotationDegrees);
      const geometry = computeOutputTransform(cropRegion, rotationDegrees, settings);
      const outputIrisBounds = transformBox(eye.iris.boundingBox, bitmap.width, bitmap.height, geometry.sourceToOutput);
      const irisOutputBoundary = Array.isArray(eye.iris.boundary)
        ? eye.iris.boundary.map(point => transformPoint(point, bitmap.width, bitmap.height, geometry.sourceToOutput))
        : [];
      if (outputIrisBounds.left < 0 || outputIrisBounds.top < 0 || outputIrisBounds.right > geometry.width || outputIrisBounds.bottom > geometry.height) {
        throw new PreprocessingError('PREPROCESSING_OUTPUT_INVALID', 'The iris region would fall outside the transformed eye image.', { eye: expectedSide });
      }
      if (geometry.width * geometry.height > settings.maxOutputPixels) throw new PreprocessingError('PREPROCESSING_OUTPUT_TOO_LARGE', 'The configured eye output exceeds the pixel safety limit.', { eye: expectedSide });
      canvas.width = geometry.width;
      canvas.height = geometry.height;
      const context = canvas.getContext('2d', { alpha: true, willReadFrequently: true });
      if (!context?.setTransform || !context?.drawImage || !context?.getImageData) throw new PreprocessingError('PREPROCESSING_CANVAS_UNAVAILABLE', 'The browser image-processing canvas is incomplete.');
      context.clearRect(0, 0, geometry.width, geometry.height);
      context.imageSmoothingEnabled = settings.interpolation !== 'low';
      context.imageSmoothingQuality = settings.interpolation;
      context.setTransform(...geometry.sourceToOutput);
      context.drawImage(bitmap,
        cropRegion.x, cropRegion.y, cropRegion.width, cropRegion.height,
        cropRegion.x, cropRegion.y, cropRegion.width, cropRegion.height);
      let rgba;
      try { rgba = context.getImageData(0, 0, geometry.width, geometry.height)?.data; }
      catch { throw new PreprocessingError('PREPROCESSING_PIXELS_INVALID', 'The browser could not read the extracted eye region.', { eye: expectedSide }); }
      const tensor = processRgbaPixels(rgba, geometry.width, geometry.height, settings);
      validateTensor(tensor, geometry.width, geometry.height, settings);
      eyes[key] = {
        eye: expectedSide,
        designation: expectedDesignation,
        coordinateSpace: EYE_COORDINATE_SPACE,
        image: tensor.image,
        width: geometry.width,
        height: geometry.height,
        channels: tensor.channels,
        colorMode: tensor.colorMode,
        layout: tensor.layout,
        dataType: tensor.dataType,
        cropRegion: { ...cropRegion, sourceWidth: bitmap.width, sourceHeight: bitmap.height },
        irisOutputBounds: outputIrisBounds,
        irisOutputBoundary,
        transform: {
          strategy: settings.rotationStrategy,
          rotationDegrees,
          sourceToOutput: [...geometry.sourceToOutput],
          outputContentRegion: geometry.contentRegion,
          resizeMode: geometry.resizeMode,
          interpolation: geometry.interpolation,
          paddingValue: 0,
          marginClippedAtImageBoundary: cropRegion.marginClipped,
        },
        normalization: tensor.normalization,
        photometric: tensor.photometric,
        noiseReduction: tensor.noiseReduction,
        sourceMetadata: {
          boundingBox: { ...eye.boundingBox },
          eyeCorners: {
            nasal: eye.eyeCorners?.nasal ? { ...eye.eyeCorners.nasal } : null,
            temporal: eye.eyeCorners?.temporal ? { ...eye.eyeCorners.temporal } : null,
          },
          orientationDegrees: Number.isFinite(eye.orientationDegrees) ? eye.orientationDegrees : null,
          openness: eye.openness || 'UNKNOWN',
          opennessRatio: Number.isFinite(eye.opennessRatio) ? eye.opennessRatio : null,
          confidence: Number.isFinite(eye.confidence) ? eye.confidence : null,
          confidenceStatus: eye.confidenceStatus || 'UNAVAILABLE',
          iris: {
            detected: eye.irisDetected,
            center: eye.iris.center ? { ...eye.iris.center } : null,
            boundingBox: { ...eye.iris.boundingBox },
            boundary: Array.isArray(eye.iris.boundary) ? eye.iris.boundary.map(point => ({ x: point.x, y: point.y })) : [],
          },
        },
      };
    }
    if (!shouldContinue()) throw new PreprocessingError('PREPROCESSING_CANCELLED', 'Preprocessing was cancelled before output validation.');
    if (!validTensorPair(eyes)) throw new PreprocessingError('PREPROCESSING_OUTPUT_INVALID', 'Both eye outputs must be present and valid.');
    return {
      preprocessingVersion: PREPROCESSING_VERSION,
      sourceCaptureId: capture.captureId,
      timestamp: now(),
      valid: true,
      sourceDimensions: { width: capture.width, height: capture.height },
      config: describeConfig(settings),
      captureEvidence: summarizeCaptureEvidence(capture),
      rightEye: eyes.rightEye,
      leftEye: eyes.leftEye,
    };
  } catch (error) {
    if (error instanceof PreprocessingError) throw error;
    throw new PreprocessingError('PREPROCESSING_FAILED', 'The captured eye image could not be safely preprocessed.');
  } finally {
    try { bitmap?.close?.(); } catch { /* Releasing a failed decode is best-effort. */ }
    try { onBitmap(null); } catch {}
    if (canvas) {
      try { canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height); } catch {}
      canvas.width = 0; canvas.height = 0;
    }
  }
}

export async function preprocessCaptureBatch(captures, options = {}) {
  if (!Array.isArray(captures) || captures.length === 0) throw new PreprocessingError('CAPTURE_BATCH_EMPTY', 'No validated captures were supplied.');
  const results = [];
  for (const capture of captures) {
    if (options.shouldContinue && !options.shouldContinue()) throw new PreprocessingError('PREPROCESSING_CANCELLED', 'The capture batch was cancelled before all images were processed.');
    results.push(await preprocessCapture(capture, options));
  }
  return { preprocessingVersion: PREPROCESSING_VERSION, timestamp: (options.now || (() => Date.now()))(), valid: true, captures: results };
}

export function mountImagePreprocessingStep(root, { captures } = {}, { config = {}, onExit = () => {}, ...processingOptions } = {}) {
  root.innerHTML = `<section aria-labelledby="preprocessing-title"><h2 id="preprocessing-title" tabindex="-1">Preparing eye images</h2><p>Validated images are being separated into anatomical right-eye (OD) and left-eye (OS) regions for the next processing step.</p><aside class="notice preprocessing-disclosure"><strong>Local processing</strong><p>Images are decoded and cropped on this device. The original captures and temporary buffers are not saved or uploaded. No prescription values or medical interpretation are generated here.</p></aside><div id="preprocessing-status" class="positioning-status" role="status" aria-live="polite" aria-atomic="true"><strong id="preprocessing-heading">Preparing images…</strong><span id="preprocessing-detail">The validated camera image is being checked and separated.</span></div><ul id="preprocessing-summary" class="preprocessing-summary"></ul><p id="preprocessing-error" class="error" role="alert"></p><div class="actions"><button id="preprocessing-stop" class="secondary" type="button">Stop screening</button></div><p class="hint">The machine-readable output is emitted through <code>eye-preprocessing-ready</code> and <code>eye-preprocessing-complete</code> for Component 8.</p></section>`;
  const heading = root.querySelector('#preprocessing-heading');
  const detail = root.querySelector('#preprocessing-detail');
  const summary = root.querySelector('#preprocessing-summary');
  const errorElement = root.querySelector('#preprocessing-error');
  const stopButton = root.querySelector('#preprocessing-stop');
  const canvas = document.createElement('canvas');
  let disposed = false, generation = 0, activeBitmap = null, processedBatch = null;
  let sourceCaptures = Array.isArray(captures) ? [...captures] : [];
  const captureIds = sourceCaptures.map(capture => capture?.captureId).filter(Boolean);

  async function process() {
    const currentGeneration = ++generation;
    try {
      const batch = await preprocessCaptureBatch(sourceCaptures, {
        ...processingOptions,
        config,
        createCanvas: processingOptions.createCanvas || (() => canvas),
        onBitmap: bitmap => { activeBitmap = bitmap; },
        shouldContinue: () => !disposed && currentGeneration === generation,
      });
      if (disposed || currentGeneration !== generation) return;
      processedBatch = batch;
      heading.textContent = 'Eye images are ready.';
      detail.textContent = 'Both anatomical eye crops passed preprocessing checks. No prediction or prescription was produced.';
      summary.replaceChildren(...batch.captures.flatMap(result => [
        makeSummaryItem(`Capture ${result.sourceCaptureId}: right eye OD ${result.rightEye.width} × ${result.rightEye.height} pixels`),
        makeSummaryItem(`Capture ${result.sourceCaptureId}: left eye OS ${result.leftEye.width} × ${result.leftEye.height} pixels`),
      ]));
      root.dispatchEvent(new CustomEvent('eye-preprocessing-ready', { bubbles: true, detail: batch }));
      root.dispatchEvent(new CustomEvent('eye-preprocessing-complete', { bubbles: true, detail: batch }));
    } catch (error) {
      if (disposed || currentGeneration !== generation) return;
      const result = {
        preprocessingVersion: PREPROCESSING_VERSION,
        sourceCaptureIds: captureIds,
        timestamp: Date.now(),
        valid: false,
        error: { code: error?.code || 'PREPROCESSING_FAILED', message: error?.message || 'Preprocessing failed.', details: error?.details || {} },
      };
      heading.textContent = 'The eye images could not be prepared.';
      detail.textContent = 'No image was passed to the next component. Stop screening and restart if needed.';
      errorElement.textContent = result.error.message;
      root.dispatchEvent(new CustomEvent('eye-preprocessing-error', { bubbles: true, detail: result }));
    }
  }

  async function cleanup() {
    if (disposed) return;
    disposed = true; generation++;
    root.removeEventListener('eye-capture-cancelled', onCaptureCancelled);
    stopButton.removeEventListener('click', stop);
    window.removeEventListener('pagehide', pageHide);
    try { activeBitmap?.close?.(); } catch {}
    activeBitmap = null; processedBatch = null; sourceCaptures = [];
    try { canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height); } catch {}
    canvas.width = 0; canvas.height = 0;
  }
  async function stop() { await cleanup(); onExit(); }
  function onCaptureCancelled(event) {
    const cancelledIds = event.detail?.captureIds || [];
    if (cancelledIds.some(id => captureIds.includes(id))) {
      generation++;
      try { activeBitmap?.close?.(); } catch {}
      activeBitmap = null; processedBatch = null; sourceCaptures = [];
      try { canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height); } catch {}
      canvas.width = 0; canvas.height = 0;
      heading.textContent = 'Preprocessing was cancelled.';
      detail.textContent = 'The captured images were withdrawn and will not be passed downstream.';
    }
  }
  const pageHide = () => { void cleanup(); };
  root.addEventListener('eye-capture-cancelled', onCaptureCancelled);
  stopButton.addEventListener('click', stop);
  window.addEventListener('pagehide', pageHide, { once: true });
  void process();
  return cleanup;
}

function validateTensor(tensor, width, height, config) {
  const expected = width * height * tensor.channels;
  if (!tensor.image || tensor.image.length !== expected) throw new PreprocessingError('PREPROCESSING_OUTPUT_INVALID', 'The preprocessed image has an unexpected tensor size.');
  if (tensor.image.some(value => !Number.isFinite(value))) throw new PreprocessingError('PREPROCESSING_OUTPUT_INVALID', 'The preprocessed image contains a non-finite value.');
  if (tensor.colorMode !== config.colorMode || tensor.layout !== config.layout) throw new PreprocessingError('PREPROCESSING_OUTPUT_INVALID', 'Output color or tensor layout does not match configuration.');
}

function validTensorPair(eyes) {
  return eyes.rightEye?.eye === 'right' && eyes.rightEye?.designation === 'OD' && eyes.leftEye?.eye === 'left' && eyes.leftEye?.designation === 'OS'
    && eyes.rightEye.image?.length > 0 && eyes.leftEye.image?.length > 0;
}

function describeConfig(settings) {
  return {
    ...settings,
    normalization: settings.normalization,
    mean: settings.mean ? [...settings.mean] : null,
    std: settings.std ? [...settings.std] : null,
  };
}

function makeSummaryItem(text) { const item = document.createElement('li'); item.textContent = text; return item; }

function transformBox(box, sourceWidth, sourceHeight, matrix) {
  const points = [
    [box.left * sourceWidth, box.top * sourceHeight],
    [box.right * sourceWidth, box.top * sourceHeight],
    [box.left * sourceWidth, box.bottom * sourceHeight],
    [box.right * sourceWidth, box.bottom * sourceHeight],
  ].map(([x, y]) => ({ x: matrix[0] * x + matrix[2] * y + matrix[4], y: matrix[1] * x + matrix[3] * y + matrix[5] }));
  return {
    left: Math.min(...points.map(point => point.x)), top: Math.min(...points.map(point => point.y)),
    right: Math.max(...points.map(point => point.x)), bottom: Math.max(...points.map(point => point.y)),
  };
}

function transformPoint(point, sourceWidth, sourceHeight, matrix) {
  const x = point.x * sourceWidth, y = point.y * sourceHeight;
  return { x: matrix[0] * x + matrix[2] * y + matrix[4], y: matrix[1] * x + matrix[3] * y + matrix[5] };
}
