export const PREPROCESSING_VERSION = '1.0.0';
export const PREPROCESSING_CONFIG = Object.freeze({
  inputWidth: null,
  inputHeight: null,
  cropStrategy: 'eye-bounds-margin',
  marginX: 0.25,
  marginY: 0.5,
  rotationStrategy: 'none',
  maximumRotationDegrees: 25,
  resizeMode: 'contain',
  interpolation: 'high',
  maxOutputPixels: 4_000_000,
  minimumEyeWidthPx: 28,
  minimumEyeHeightPx: 12,
  colorMode: 'RGB',
  layout: 'HWC',
  normalization: 'none',
  mean: null,
  std: null,
  brightness: 0,
  contrast: 1,
  noiseReduction: 'none',
  maxSourcePixels: 16_000_000,
});

export const EYE_COORDINATE_SPACE = 'normalized_camera_frame_top_left_unmirrored';

export class PreprocessingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PreprocessingError';
    this.code = code;
    this.details = details;
  }
}

export function resolvePreprocessingConfig(config = {}) {
  const value = { ...PREPROCESSING_CONFIG, ...config };
  if ((value.inputWidth === null) !== (value.inputHeight === null)
    || (value.inputWidth !== null && (!isPositiveInteger(value.inputWidth) || !isPositiveInteger(value.inputHeight)))) {
    throw new PreprocessingError('PREPROCESSING_CONFIG_INVALID', 'inputWidth and inputHeight must both be positive integers or both be null.');
  }
  if (value.cropStrategy !== 'eye-bounds-margin') throw new PreprocessingError('PREPROCESSING_CONFIG_INVALID', 'Unsupported eye crop strategy.');
  if (!['none', 'eye-corners-level'].includes(value.rotationStrategy)) throw new PreprocessingError('PREPROCESSING_CONFIG_INVALID', 'Unsupported rotation strategy.');
  if (!['contain', 'stretch'].includes(value.resizeMode)) throw new PreprocessingError('PREPROCESSING_CONFIG_INVALID', 'resizeMode must be contain or stretch.');
  if (!['low', 'medium', 'high'].includes(value.interpolation)) throw new PreprocessingError('PREPROCESSING_CONFIG_INVALID', 'Unsupported interpolation quality.');
  if (!['RGB', 'RGBA', 'GRAYSCALE'].includes(value.colorMode)) throw new PreprocessingError('PREPROCESSING_CONFIG_INVALID', 'Unsupported output color mode.');
  if (!['HWC', 'CHW'].includes(value.layout)) throw new PreprocessingError('PREPROCESSING_CONFIG_INVALID', 'Output layout must be HWC or CHW.');
  if (!['none', 'zero-to-one', 'minus-one-to-one', 'mean-std'].includes(value.normalization)) throw new PreprocessingError('PREPROCESSING_CONFIG_INVALID', 'Unsupported normalization method.');
  for (const [name, ratio] of [['marginX', value.marginX], ['marginY', value.marginY]]) {
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 2) throw new PreprocessingError('PREPROCESSING_CONFIG_INVALID', `${name} must be between 0 and 2 eye-box widths/heights.`);
  }
  if (!Number.isFinite(value.maximumRotationDegrees) || value.maximumRotationDegrees < 0 || value.maximumRotationDegrees > 45) throw new PreprocessingError('PREPROCESSING_CONFIG_INVALID', 'maximumRotationDegrees must be between 0 and 45.');
  if (!Number.isFinite(value.brightness) || value.brightness < -255 || value.brightness > 255 || !Number.isFinite(value.contrast) || value.contrast <= 0 || value.contrast > 8) throw new PreprocessingError('PREPROCESSING_CONFIG_INVALID', 'Brightness or contrast is outside the supported range.');
  if (!isPositiveInteger(value.maxSourcePixels)) throw new PreprocessingError('PREPROCESSING_CONFIG_INVALID', 'maxSourcePixels must be a positive integer.');
  if (!isPositiveInteger(value.maxOutputPixels)) throw new PreprocessingError('PREPROCESSING_CONFIG_INVALID', 'maxOutputPixels must be a positive integer.');
  if (!isPositiveInteger(value.minimumEyeWidthPx) || !isPositiveInteger(value.minimumEyeHeightPx)) throw new PreprocessingError('PREPROCESSING_CONFIG_INVALID', 'Minimum eye dimensions must be positive integers.');
  if (value.noiseReduction !== 'none') throw new PreprocessingError('PREPROCESSING_CONFIG_UNSUPPORTED', 'Noise reduction is disabled until a downstream model specifies a validated filter.');
  const channels = value.colorMode === 'RGBA' ? 4 : value.colorMode === 'RGB' ? 3 : 1;
  if (value.normalization === 'mean-std') {
    if (!Array.isArray(value.mean) || !Array.isArray(value.std) || value.mean.length !== channels || value.std.length !== channels
      || value.mean.some(item => !Number.isFinite(item) || item < 0 || item > 255)
      || value.std.some(item => !Number.isFinite(item) || item <= 0)) {
      throw new PreprocessingError('PREPROCESSING_CONFIG_INVALID', 'mean/std normalization requires one finite mean and positive standard deviation per output channel, using the 0–255 pixel domain.');
    }
  }
  return value;
}

/** Validate Component 6's explicit usability marker and binocular metadata. */
export function validateCaptureForPreprocessing(capture, config = PREPROCESSING_CONFIG) {
  const settings = resolvePreprocessingConfig(config);
  if (!capture || typeof capture !== 'object') throw new PreprocessingError('CAPTURE_MISSING', 'No Component 6 capture was provided.');
  if (capture.valid !== true || capture.validationStatus !== 'VALIDATED' || capture.validation?.component !== '6' || capture.validation?.valid !== true) {
    throw new PreprocessingError('CAPTURE_NOT_VALIDATED', 'Component 6 did not mark this image as validated and usable.');
  }
  if (typeof capture.captureId !== 'string' || capture.captureId.length === 0) throw new PreprocessingError('CAPTURE_METADATA_INVALID', 'The capture ID is missing.');
  if (!capture.image || capture.image.type !== 'image/png' || !Number.isFinite(capture.image.size) || capture.image.size <= 0) throw new PreprocessingError('CAPTURE_FORMAT_UNSUPPORTED', 'A non-empty Component 6 PNG image is required.');
  if (!isPositiveInteger(capture.width) || !isPositiveInteger(capture.height) || capture.width * capture.height > settings.maxSourcePixels) throw new PreprocessingError('CAPTURE_DIMENSIONS_INVALID', 'The capture dimensions are invalid or exceed the configured pixel limit.');
  if (capture.qualityResult?.valid !== true || capture.qualityResult?.overallStatus !== 'GOOD') throw new PreprocessingError('CAPTURE_QUALITY_INVALID', 'The captured image does not carry a passing Component 6 image-quality result.');
  validateEyeMetadata(capture.leftEyeDetection, 'left', 'OS', settings.rotationStrategy);
  validateEyeMetadata(capture.rightEyeDetection, 'right', 'OD', settings.rotationStrategy);
  return settings;
}

export function computeEyeCrop(eye, sourceWidth, sourceHeight, config = PREPROCESSING_CONFIG) {
  const settings = resolvePreprocessingConfig(config);
  if (!isPositiveInteger(sourceWidth) || !isPositiveInteger(sourceHeight)) throw new PreprocessingError('CAPTURE_DIMENSIONS_INVALID', 'Source dimensions must be positive integers.');
  if (!['left', 'right'].includes(eye?.eye) || eye?.designation !== (eye.eye === 'left' ? 'OS' : 'OD')) throw new PreprocessingError('EYE_METADATA_INVALID', 'Eye side and anatomical designation do not match.');
  validateEyeMetadata(eye, eye?.eye, eye?.designation, settings.rotationStrategy);
  const box = eye.boundingBox;
  const left = Math.floor(box.left * sourceWidth), top = Math.floor(box.top * sourceHeight);
  const right = Math.ceil(box.right * sourceWidth), bottom = Math.ceil(box.bottom * sourceHeight);
  const eyeWidth = right - left, eyeHeight = bottom - top;
  if (eyeWidth < settings.minimumEyeWidthPx || eyeHeight < settings.minimumEyeHeightPx) {
    throw new PreprocessingError('EYE_REGION_TOO_SMALL', 'The detected eye region is smaller than the minimum safe crop dimensions.', { eye: eye?.eye, width: eyeWidth, height: eyeHeight });
  }
  const marginX = Math.ceil(eyeWidth * settings.marginX), marginY = Math.ceil(eyeHeight * settings.marginY);
  const requestedLeft = left - marginX, requestedTop = top - marginY;
  const requestedRight = right + marginX, requestedBottom = bottom + marginY;
  const x = Math.max(0, requestedLeft), y = Math.max(0, requestedTop);
  const cropRight = Math.min(sourceWidth, requestedRight), cropBottom = Math.min(sourceHeight, requestedBottom);
  const width = cropRight - x, height = cropBottom - y;
  if (!(width > 0 && height > 0) || left < x || top < y || right > cropRight || bottom > cropBottom) {
    throw new PreprocessingError('EYE_CROP_UNSAFE', 'The complete eye region does not fit inside the captured frame.', { eye: eye?.eye });
  }
  const irisBox = eye.iris.boundingBox;
  const irisPixels = { left: irisBox.left * sourceWidth, top: irisBox.top * sourceHeight, right: irisBox.right * sourceWidth, bottom: irisBox.bottom * sourceHeight };
  if (irisPixels.left < x || irisPixels.top < y || irisPixels.right > cropRight || irisPixels.bottom > cropBottom) {
    throw new PreprocessingError('EYE_CROP_UNSAFE', 'The iris boundary would be cut off by the proposed eye crop.', { eye: eye?.eye });
  }
  return {
    x, y, width, height,
    normalized: { left: x / sourceWidth, top: y / sourceHeight, right: cropRight / sourceWidth, bottom: cropBottom / sourceHeight },
    eyeBounds: { x: left, y: top, width: eyeWidth, height: eyeHeight },
    marginClipped: requestedLeft < 0 || requestedTop < 0 || requestedRight > sourceWidth || requestedBottom > sourceHeight,
  };
}

export function computeEyeRotation(eye, sourceWidth, sourceHeight, strategy = 'none', maximumDegrees = PREPROCESSING_CONFIG.maximumRotationDegrees) {
  if (strategy === 'none') return 0;
  if (strategy !== 'eye-corners-level') throw new PreprocessingError('PREPROCESSING_CONFIG_INVALID', 'Unsupported rotation strategy.');
  const nasal = eye?.eyeCorners?.nasal, temporal = eye?.eyeCorners?.temporal;
  if (!validPoint(nasal) || !validPoint(temporal)) throw new PreprocessingError('EYE_ALIGNMENT_UNAVAILABLE', 'Eye-corner landmarks required for alignment are missing.', { eye: eye?.eye });
  const dx = (temporal.x - nasal.x) * sourceWidth, dy = (temporal.y - nasal.y) * sourceHeight;
  if (Math.hypot(dx, dy) < 1) throw new PreprocessingError('EYE_ALIGNMENT_UNAVAILABLE', 'Eye-corner landmarks are too close to estimate orientation.', { eye: eye?.eye });
  let angle = Math.atan2(dy, dx) * 180 / Math.PI;
  while (angle > 90) angle -= 180;
  while (angle < -90) angle += 180;
  const rotationDegrees = -angle;
  if (Math.abs(rotationDegrees) > maximumDegrees) throw new PreprocessingError('EYE_ALIGNMENT_OUT_OF_RANGE', 'Eye orientation exceeds the configured safe correction range.', { eye: eye?.eye, rotationDegrees });
  return rotationDegrees;
}

export function computeOutputTransform(crop, rotationDegrees, config = PREPROCESSING_CONFIG) {
  const settings = resolvePreprocessingConfig(config);
  const radians = rotationDegrees * Math.PI / 180;
  const cosine = Math.cos(radians), sine = Math.sin(radians);
  const nativeWidth = Math.max(1, Math.ceil(crop.width * Math.abs(cosine) + crop.height * Math.abs(sine)));
  const nativeHeight = Math.max(1, Math.ceil(crop.width * Math.abs(sine) + crop.height * Math.abs(cosine)));
  const width = settings.inputWidth ?? nativeWidth, height = settings.inputHeight ?? nativeHeight;
  let scaleX, scaleY;
  if (settings.inputWidth === null) scaleX = scaleY = 1;
  else if (settings.resizeMode === 'stretch') { scaleX = width / nativeWidth; scaleY = height / nativeHeight; }
  else scaleX = scaleY = Math.min(width / nativeWidth, height / nativeHeight);
  const a = scaleX * cosine, b = scaleY * sine, c = -scaleX * sine, d = scaleY * cosine;
  const centerX = crop.x + crop.width / 2, centerY = crop.y + crop.height / 2;
  const transform = [a, b, c, d, width / 2 - a * centerX - c * centerY, height / 2 - b * centerX - d * centerY];
  const contentWidth = nativeWidth * scaleX, contentHeight = nativeHeight * scaleY;
  return {
    width, height, nativeWidth, nativeHeight, rotationDegrees,
    sourceToOutput: transform,
    contentRegion: { x: (width - contentWidth) / 2, y: (height - contentHeight) / 2, width: contentWidth, height: contentHeight },
    resizeMode: settings.inputWidth === null ? 'none' : settings.resizeMode,
    interpolation: settings.interpolation,
  };
}

/** Convert RGBA canvas bytes to the configured deterministic model tensor. */
export function processRgbaPixels(rgba, width, height, config = PREPROCESSING_CONFIG) {
  const settings = resolvePreprocessingConfig(config);
  if (!isPositiveInteger(width) || !isPositiveInteger(height) || !rgba || rgba.length !== width * height * 4) throw new PreprocessingError('PREPROCESSING_PIXELS_INVALID', 'The eye crop pixel buffer is malformed.');
  const channels = settings.colorMode === 'RGBA' ? 4 : settings.colorMode === 'RGB' ? 3 : 1;
  if (settings.normalization === 'mean-std' && settings.mean.length !== channels) throw new PreprocessingError('PREPROCESSING_CONFIG_INVALID', 'mean/std channel count does not match colorMode.');
  const pixelCount = width * height;
  const interleaved = new Uint8Array(pixelCount * channels);
  const contrastCenter = 127.5;
  for (let index = 0; index < pixelCount; index++) {
    const offset = index * 4;
    const source = [rgba[offset], rgba[offset + 1], rgba[offset + 2], rgba[offset + 3]];
    if (source.some(value => !Number.isFinite(value))) throw new PreprocessingError('PREPROCESSING_PIXELS_INVALID', 'Non-finite pixel values were found.');
    for (let channel = 0; channel < 3; channel++) source[channel] = clamp((source[channel] - contrastCenter) * settings.contrast + contrastCenter + settings.brightness, 0, 255);
    const values = settings.colorMode === 'RGBA' ? source.map(value => Math.round(value))
      : settings.colorMode === 'RGB' ? source.slice(0, 3).map(value => Math.round(value))
        : [Math.round(clamp(0.2126 * source[0] + 0.7152 * source[1] + 0.0722 * source[2], 0, 255))];
    for (let channel = 0; channel < channels; channel++) interleaved[index * channels + channel] = values[channel];
  }

  let data, dataType;
  if (settings.normalization === 'none') { data = interleaved; dataType = 'uint8'; }
  else {
    data = new Float32Array(interleaved.length); dataType = 'float32';
    for (let index = 0; index < interleaved.length; index++) {
      const channel = index % channels, value = interleaved[index];
      data[index] = settings.normalization === 'zero-to-one' ? value / 255
        : settings.normalization === 'minus-one-to-one' ? value / 127.5 - 1
          : (value - settings.mean[channel]) / settings.std[channel];
      if (!Number.isFinite(data[index])) throw new PreprocessingError('PREPROCESSING_OUTPUT_INVALID', 'Normalization produced a non-finite value.');
    }
  }

  if (settings.layout === 'CHW' && channels > 1) {
    const planar = dataType === 'uint8' ? new Uint8Array(data.length) : new Float32Array(data.length);
    for (let pixel = 0; pixel < pixelCount; pixel++) for (let channel = 0; channel < channels; channel++) planar[channel * pixelCount + pixel] = data[pixel * channels + channel];
    data = planar;
  }
  const normalization = settings.normalization === 'mean-std'
    ? { method: settings.normalization, inputRange: [0, 255], mean: [...settings.mean], std: [...settings.std] }
    : { method: settings.normalization, inputRange: [0, 255], outputRange: settings.normalization === 'none' ? [0, 255] : settings.normalization === 'zero-to-one' ? [0, 1] : [-1, 1] };
  return { image: data, dataType, channels, colorMode: settings.colorMode, layout: settings.layout, normalization, photometric: { brightness: settings.brightness, contrast: settings.contrast }, noiseReduction: settings.noiseReduction };
}

function validateEyeMetadata(eye, expectedSide, expectedDesignation, rotationStrategy) {
  if (!eye || eye.detected !== true || eye.eye !== expectedSide || eye.designation !== expectedDesignation) throw new PreprocessingError('EYE_METADATA_INVALID', `Expected the detected ${expectedSide}/${expectedDesignation} eye metadata.`, { eye: expectedSide });
  if (eye.coordinateSpace !== EYE_COORDINATE_SPACE) throw new PreprocessingError('EYE_COORDINATES_INVALID', 'Eye coordinates must use the unmirrored camera-frame coordinate space.', { eye: expectedSide });
  if (!validBox(eye.boundingBox)) throw new PreprocessingError('EYE_METADATA_INVALID', 'A valid normalized eye bounding box is required.', { eye: expectedSide });
  const irisBox = eye.iris?.boundingBox;
  if (eye.irisDetected !== true || eye.iris?.detected !== true || !validBox(irisBox)) throw new PreprocessingError('EYE_METADATA_INVALID', 'Detected iris metadata and a valid iris boundary box are required.', { eye: expectedSide });
  if (rotationStrategy === 'eye-corners-level' && (!validPoint(eye.eyeCorners?.nasal) || !validPoint(eye.eyeCorners?.temporal))) throw new PreprocessingError('EYE_ALIGNMENT_UNAVAILABLE', 'Eye-corner landmarks required for alignment are missing.', { eye: expectedSide });
}

function validBox(box) {
  return Boolean(box && ['left', 'top', 'right', 'bottom'].every(key => Number.isFinite(box[key]))
    && box.left >= 0 && box.top >= 0 && box.right <= 1 && box.bottom <= 1 && box.right > box.left && box.bottom > box.top);
}
function validPoint(point) { return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1); }
function isPositiveInteger(value) { return Number.isInteger(value) && value > 0; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
