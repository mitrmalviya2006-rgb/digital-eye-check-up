/**
 * Capability-driven camera lifecycle for downstream screening steps.
 * @typedef {'idle'|'requesting_permission'|'initializing'|'ready'|'switching_camera'|'stopping'|'permission_denied'|'unsupported'|'error'} CameraStatus
 */
const DEFAULT_CONFIG = Object.freeze({ width: 1280, height: 720, frameRate: 24, metadataTimeoutMs: 8000 });
const CONTROL_NAMES = Object.freeze({ zoom: 'zoom', exposureCompensation: 'exposureCompensation', focusDistance: 'focusDistance', focusMode: 'focusMode', whiteBalanceMode: 'whiteBalanceMode' });

export function describeCameraError(error, secure = globalThis.isSecureContext !== false) {
  const name = error?.name || '';
  if (!secure || name === 'SecurityError') return 'Camera access requires a secure page (HTTPS or localhost). Open this screening from a secure connection.';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'Camera permission was denied or blocked. Allow camera access in your browser settings, then try again.';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'No usable camera was found. Connect or enable a camera, then try again.';
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'The camera could not be opened. It may be in use by another app; close other camera apps and retry.';
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') return 'This camera cannot meet the requested settings. Try another available camera.';
  return 'The camera could not be started. Check browser permissions and camera availability, then retry.';
}

export class CameraController {
  constructor({ video, mediaDevices = globalThis.navigator?.mediaDevices, secureContext = globalThis.isSecureContext !== false, config = {}, onStateChange = () => {} }) {
    this.video = video;
    this.mediaDevices = mediaDevices;
    this.secureContext = secureContext;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.onStateChange = onStateChange;
    this.stream = null;
    this.status = 'idle';
    this.error = null;
    this.errorCode = null;
    this.previewReady = false;
    this.actualResolution = null;
    this.capabilities = {};
    this.settings = {};
    this.torchSupported = false;
    this.torchEnabled = false;
    this.devices = [];
    this.activeDeviceId = null;
    this.activeFacingMode = null;
    this.facingModeFallback = false;
    this.startPromise = null;
    this.generation = 0;
    this.trackEnded = null;
  }

  getSnapshot() {
    return { status: this.status, error: this.error, errorCode: this.errorCode, previewReady: this.previewReady, actualResolution: this.actualResolution && { ...this.actualResolution }, capabilities: { ...this.capabilities }, settings: { ...this.settings }, torchSupported: this.torchSupported, torchEnabled: this.torchEnabled, cameras: this.devices.map(({ deviceId, label }) => ({ deviceId, label })), deviceSelectionSupported: this.config.cameraSelectionSupported !== false, activeDeviceId: this.activeDeviceId, activeCameraLabel: this.devices.find(d=>d.deviceId===this.activeDeviceId)?.label || null, activeFacingMode:this.activeFacingMode, facingModeFallback:this.facingModeFallback };
  }

  #publish(status = this.status, error = null, errorCode = null) { this.status = status; this.error = error; this.errorCode = errorCode; this.onStateChange(this.getSnapshot()); }

  async startCamera({ deviceId } = {}) {
    if (this.status === 'ready' && this.stream) return this.getSnapshot();
    if (this.startPromise) return this.startPromise;
    const generation = ++this.generation;
    this.startPromise = this.#start(deviceId, generation).finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async #start(deviceId, generation) {
    this.previewReady = false; this.actualResolution = null; this.capabilities = {}; this.settings = {}; this.torchSupported = false; this.torchEnabled = false; this.facingModeFallback = false; this.errorCode = null;
    if (!this.secureContext) { this.#publish('unsupported', describeCameraError({ name: 'SecurityError' }, false), 'SECURE_CONTEXT_REQUIRED'); return this.getSnapshot(); }
    if (!this.mediaDevices?.getUserMedia || !this.video) { this.#publish('unsupported', 'This browser does not provide camera access needed for a live preview. Try a current browser on HTTPS or localhost.', 'CAMERA_API_UNAVAILABLE'); return this.getSnapshot(); }
    this.#publish('requesting_permission');
    let stream;
    try {
      const defaultConstraints = { facingMode: { ideal: 'environment' }, width: { ideal: this.config.width }, height: { ideal: this.config.height }, frameRate: { ideal: this.config.frameRate, max: 30 } };
      const supportedConstraints = this.config.videoConstraints ?? defaultConstraints;
      const video = deviceId ? { ...supportedConstraints, deviceId: { exact: deviceId } } : { ...supportedConstraints };
      try { stream = await this.mediaDevices.getUserMedia({ audio: false, video }); }
      catch (firstError) {
        if (generation !== this.generation) return this.getSnapshot();
        if (firstError?.name !== 'OverconstrainedError' || deviceId) throw firstError;
        // Retry once with browser-default camera selection and ideal size only.
        this.facingModeFallback = true;
        const fallbackConstraints = { ...supportedConstraints };
        delete fallbackConstraints.facingMode;
        stream = await this.mediaDevices.getUserMedia({ audio:false, video:fallbackConstraints });
      }
      if (generation !== this.generation) { stopTracks(stream); return this.getSnapshot(); }
      this.stream = stream; this.#publish('initializing');
      this.video.muted = true; this.video.playsInline = true; this.video.autoplay = true; this.video.srcObject = stream;
      await this.#waitForPreview();
      if (generation !== this.generation) { stopTracks(stream); return this.getSnapshot(); }
      const track = stream.getVideoTracks?.()[0] || stream.getTracks?.().find(t => t.kind === 'video');
      if (!track) throw new Error('Camera stream did not contain a video track.');
      this.activeDeviceId = track.getSettings?.().deviceId || deviceId || null;
      this.activeFacingMode = track.getSettings?.().facingMode || null;
      this.actualResolution = { width: this.video.videoWidth, height: this.video.videoHeight };
      try { this.capabilities = track.getCapabilities?.() || {}; } catch { this.capabilities = {}; }
      try { this.settings = track.getSettings?.() || {}; } catch { this.settings = {}; }
      this.torchSupported = this.capabilities.torch === true;
      this.trackEnded = () => { if (generation === this.generation && this.stream === stream) { stopTracks(stream); this.stream=null; this.#detach(); this.previewReady=false; this.#publish('error', 'The camera stopped unexpectedly. Restart it to continue.'); } };
      track.addEventListener?.('ended', this.trackEnded, { once: true });
      await this.#refreshDevices();
      if (generation !== this.generation) { stopTracks(stream); return this.getSnapshot(); }
      this.previewReady = true; this.#publish('ready');
    } catch (error) {
      if (generation !== this.generation) return this.getSnapshot();
      if (stream) stopTracks(stream);
      if (this.stream === stream) this.stream = null;
      this.#detach();
      this.previewReady = false;
      const status = error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError' ? 'permission_denied' : (error?.message?.includes('metadata') || error?.name === 'NotReadableError' || error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError' ? 'error' : 'error');
      await this.#refreshDevices();
      if (generation !== this.generation) return this.getSnapshot();
      this.#publish(status, error?.message?.includes('metadata') ? 'The camera opened, but its live preview did not become ready. Retry or choose another camera.' : error?.message?.includes('playback') ? 'The camera opened, but the browser blocked live preview playback. Retry or check browser playback settings.' : describeCameraError(error, this.secureContext), error?.name || 'CAMERA_START_FAILED');
    }
    return this.getSnapshot();
  }

  async #waitForPreview() {
    if (this.video.videoWidth > 0 && this.video.videoHeight > 0) { try { await this.video.play?.(); return; } catch { throw new Error('Video preview playback was blocked.'); } }
    await new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => { clearTimeout(timer); this.video.removeEventListener?.('loadedmetadata', ready); this.video.removeEventListener?.('error', failed); };
      const ready = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('Video preview failed to load.')); };
      this.video.addEventListener?.('loadedmetadata', ready, { once: true }); this.video.addEventListener?.('error', failed, { once: true });
      timer = setTimeout(() => { cleanup(); reject(new Error('metadata timeout')); }, this.config.metadataTimeoutMs);
      if (this.video.videoWidth > 0 && this.video.videoHeight > 0) ready();
    });
    try { await this.video.play?.(); } catch { throw new Error('Video preview playback was blocked. Tap retry to start the preview.'); }
  }

  async #refreshDevices() {
    if (!this.mediaDevices?.enumerateDevices) return;
    try { this.devices = (await this.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput' && d.deviceId).map((d,index) => ({ deviceId: d.deviceId, label: d.label || `Camera ${index + 1}` })); }
    catch { this.devices = []; }
  }

  async switchCamera(deviceId) {
    if (this.config.cameraSelectionSupported === false) throw new Error('This browser does not report support for selecting a camera by device ID.');
    if (!deviceId || deviceId === this.activeDeviceId) return this.getSnapshot();
    this.#publish('switching_camera');
    await this.#releaseStream(false);
    return this.startCamera({ deviceId });
  }

  async setTorch(enabled) {
    const track = this.#track();
    if (!track || !this.torchSupported || typeof track.applyConstraints !== 'function') throw new Error('Torch control is not available for this camera.');
    try {
      await track.applyConstraints({ advanced: [{ torch: Boolean(enabled) }] });
      this.torchEnabled = Boolean(enabled); this.settings = track.getSettings?.() || this.settings; this.#publish('ready');
      return this.torchEnabled;
    } catch { throw new Error('The camera rejected the torch change. Its current torch state is unchanged.'); }
  }

  async applyCameraSettings(requested) {
    const track = this.#track();
    if (!track || typeof track.applyConstraints !== 'function') throw new Error('Camera controls are unavailable until the preview is ready.');
    const advanced = {};
    for (const [name, value] of Object.entries(requested)) {
      const key = CONTROL_NAMES[name]; const capability = key && this.capabilities[key];
      if (capability === undefined) throw new Error(`${name} is not supported by this camera.`);
      if (Array.isArray(capability)) { if (!capability.includes(value)) throw new Error(`Choose a supported ${name} option.`); }
      else if (typeof capability === 'object') { if (!Number.isFinite(Number(value)) || Number(value) < capability.min || Number(value) > capability.max) throw new Error(`${name} must be within the camera's supported range.`); }
      else if (typeof capability === 'boolean' && typeof value !== 'boolean') throw new Error(`${name} must be a supported on/off value.`);
      advanced[key] = value;
    }
    try { await track.applyConstraints({ advanced: [advanced] }); this.settings = track.getSettings?.() || this.settings; this.#publish('ready'); return { applied: { ...requested }, settings: { ...this.settings } }; }
    catch { throw new Error('The camera rejected these settings. The previous camera settings remain active.'); }
  }

  getCapabilities() { return { ...this.capabilities }; }
  getCurrentSettings() { return { ...this.settings }; }
  async withVideoFrame(callback) { if (!this.previewReady || !this.video.videoWidth) throw new Error('Live camera frames are unavailable until the preview is ready.'); return callback(this.video); }
  async captureFrame() { if (!this.previewReady || !this.video.videoWidth) throw new Error('A frame cannot be captured until the preview is ready.'); if (!globalThis.createImageBitmap) throw new Error('This browser cannot create a frame handoff.'); return globalThis.createImageBitmap(this.video); }

  async stopCamera() { ++this.generation; this.#publish('stopping'); await this.#releaseStream(true); this.#publish('idle'); return this.getSnapshot(); }
  async #releaseStream(clearStatus) {
    const stream = this.stream; const track = this.#track();
    if (track && this.torchEnabled && this.torchSupported) { try { await track.applyConstraints({ advanced: [{ torch: false }] }); } catch { /* Track shutdown still releases resources. */ } }
    if (track && this.trackEnded) track.removeEventListener?.('ended', this.trackEnded);
    if (stream) stopTracks(stream);
    this.stream = null; this.#detach(); this.previewReady = false; this.actualResolution = null; this.capabilities = {}; this.settings = {}; this.torchSupported = false; this.torchEnabled = false; this.activeDeviceId = null; this.activeFacingMode = null; this.trackEnded = null;
    if (clearStatus) this.error = null;
  }
  #track() { return this.stream?.getVideoTracks?.()[0] || this.stream?.getTracks?.().find(t => t.kind === 'video') || null; }
  #detach() { if (this.video) { this.video.pause?.(); this.video.srcObject = null; } }
}

function stopTracks(stream) { for (const track of stream?.getTracks?.() || []) { try { track.stop(); } catch { /* Continue stopping other tracks. */ } } }
