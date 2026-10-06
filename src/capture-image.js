/** Extract a real, unmirrored camera frame and a reduced copy for validation. */
export async function extractCaptureImage(video, {
  captureCanvas,
  validationCanvas,
  minLongSide = 640,
  minShortSide = 360,
  maxCapturePixels = 16_000_000,
  maxValidationSide = 480,
  decodeImage = globalThis.createImageBitmap,
} = {}) {
  const clearCanvas = canvas => {
    if (!canvas) return;
    try { canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height); } catch { /* Reset dimensions below even if clearing is unavailable. */ }
    canvas.width = 0;
    canvas.height = 0;
  };

  try {
    if (!video || video.readyState < 2) throw new Error('FRAME_EXTRACTION_FAILED');
    const width = video.videoWidth, height = video.videoHeight;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error('INVALID_VIDEO_DIMENSIONS');
    const longSide = Math.max(width, height), shortSide = Math.min(width, height);
    if (longSide < minLongSide || shortSide < minShortSide) throw new Error('INSUFFICIENT_CAPTURE_RESOLUTION');
    if (width * height > maxCapturePixels) throw new Error('CAPTURE_RESOLUTION_TOO_LARGE');
    if (!captureCanvas || !validationCanvas) throw new Error('FRAME_EXTRACTION_FAILED');

    captureCanvas.width = width;
    captureCanvas.height = height;
    const captureContext = captureCanvas.getContext('2d', { alpha: false, willReadFrequently: false });
    if (!captureContext) throw new Error('FRAME_EXTRACTION_FAILED');
    captureContext.drawImage(video, 0, 0, width, height);
    const blob = await canvasToPng(captureCanvas);
    if (!blob || blob.size === 0 || blob.type !== 'image/png') throw new Error('CAPTURE_IMAGE_INVALID');
    if (typeof decodeImage !== 'function') throw new Error('CAPTURE_IMAGE_INVALID');
    const decoded = await decodeImage(blob);
    if (!decoded || decoded.width !== width || decoded.height !== height) {
      decoded?.close?.();
      throw new Error('CAPTURE_IMAGE_INVALID');
    }

    try {
      const scale = Math.min(1, maxValidationSide / longSide);
      const sampleWidth = Math.max(1, Math.round(width * scale));
      const sampleHeight = Math.max(1, Math.round(height * scale));
      validationCanvas.width = sampleWidth;
      validationCanvas.height = sampleHeight;
      const validationContext = validationCanvas.getContext('2d', { willReadFrequently: true });
      if (!validationContext) throw new Error('FRAME_EXTRACTION_FAILED');
      validationContext.drawImage(decoded, 0, 0, sampleWidth, sampleHeight);
      const pixels = validationContext.getImageData(0, 0, sampleWidth, sampleHeight)?.data;
      if (!pixels || pixels.length !== sampleWidth * sampleHeight * 4) throw new Error('CAPTURE_IMAGE_INVALID');
      return { blob, width, height, pixels, sampleWidth, sampleHeight };
    } finally { decoded.close?.(); }
  } finally {
    clearCanvas(captureCanvas);
    clearCanvas(validationCanvas);
  }
}

function canvasToPng(canvas) {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob !== 'function') { reject(new Error('FRAME_EXTRACTION_FAILED')); return; }
    try { canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('CAPTURE_IMAGE_INVALID')), 'image/png'); }
    catch { reject(new Error('FRAME_EXTRACTION_FAILED')); }
  });
}
