import {
  FEATURE_SCHEMA_VERSION,
  FEATURE_ORDER,
  FeatureExtractionError,
  toFeatureVector,
  validateFeatureBatch,
  validateFeatureVector,
} from './feature-extraction.js';
import { PREPROCESSING_VERSION } from './image-preprocessing.js';
import { isCaptureEvidence } from './capture-evidence.js';

export const PREDICTION_ENGINE_VERSION = '1.0.0';
export const PREDICTION_SCHEMA_VERSION = '1.0.0';
export const MODEL_MANIFEST_VERSION = '1.0.0';

const EYES = Object.freeze([
  Object.freeze({ key: 'rightEye', eye: 'right', designation: 'OD' }),
  Object.freeze({ key: 'leftEye', eye: 'left', designation: 'OS' }),
]);
const OUTPUT_UNITS = Object.freeze({ sph: 'D', cyl: 'D', axis: 'deg' });
const MODEL_TENSOR_TYPES = new Set(['float32', 'float16', 'int8', 'uint8']);

export class PredictionEngineError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PredictionEngineError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Validate a declarative model manifest before any runtime is initialized.
 * The manifest is supplied with a model-specific local adapter; this project
 * intentionally has no default model or runtime.
 */
export function validatePredictionModelSpec(spec) {
  if (!spec || spec.manifestVersion !== MODEL_MANIFEST_VERSION
    || !nonEmptyString(spec.modelId) || !nonEmptyString(spec.modelVersion) || !nonEmptyString(spec.runtime)) {
    throw new PredictionEngineError('MODEL_SPEC_INVALID', 'A versioned model identity and runtime are required.');
  }
  if (!spec.artifact || !nonEmptyString(spec.artifact.assetId)
    || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(spec.artifact.assetId)
    || !nonEmptyString(spec.artifact.format)
    || typeof spec.artifact.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(spec.artifact.sha256)) {
    throw new PredictionEngineError('MODEL_SPEC_INVALID', 'The local model artifact format, asset identifier, and SHA-256 integrity digest are required.');
  }

  const input = spec.input;
  if (!input || input.featureSchemaVersion !== FEATURE_SCHEMA_VERSION || !MODEL_TENSOR_TYPES.has(input.dataType)
    || !Array.isArray(input.featureOrder) || input.featureOrder.length === 0
    || new Set(input.featureOrder).size !== input.featureOrder.length
    || !['independent', 'paired'].includes(input.mode)
    || !Array.isArray(input.tensorShape) || input.tensorShape.length === 0
    || input.tensorShape.some(dimension => !Number.isSafeInteger(dimension) || dimension <= 0)) {
    throw new PredictionEngineError('MODEL_SPEC_INVALID', 'The model input schema, feature order, mode, data type, and tensor shape must be explicit.');
  }
  validateFeatureOrder(input.featureOrder);
  const vectorLength = input.featureOrder.length;
  const expectedTensorValues = vectorLength * (input.mode === 'paired' ? 2 : 1);
  if (input.tensorShape.reduce((product, dimension) => product * dimension, 1) !== expectedTensorValues) {
    throw new PredictionEngineError('MODEL_INPUT_SHAPE_INVALID', 'The declared tensor shape does not match the ordered per-eye feature count and inference mode.', {
      mode: input.mode,
      expectedValueCount: expectedTensorValues,
      tensorShape: [...input.tensorShape],
    });
  }
  if (input.mode === 'paired' && (!Array.isArray(input.pairingOrder)
    || input.pairingOrder.length !== 2 || input.pairingOrder[0] !== 'OD' || input.pairingOrder[1] !== 'OS')) {
    throw new PredictionEngineError('MODEL_SPEC_INVALID', 'Paired-eye models must declare OD then OS input order.');
  }
  validateNormalization(input.normalization, vectorLength);
  if (['int8', 'uint8'].includes(input.dataType)
    && (!nonEmptyString(input.quantizationId) || !isJsonFinite(input.quantization) || !input.quantization || Array.isArray(input.quantization)
      || Object.keys(input.quantization).length === 0)) {
    throw new PredictionEngineError('MODEL_SPEC_INVALID', 'Quantized int8/uint8 input requires an explicit, versioned quantization contract.');
  }

  const output = spec.output;
  if (!output || !nonEmptyString(output.decoderId) || !nonEmptyString(output.tensorContractId)
    || !isJsonFinite(output.tensorContract) || !output.tensorContract || Array.isArray(output.tensorContract)
    || Object.keys(output.tensorContract).length === 0 || !nonEmptyString(output.axisConvention)) {
    throw new PredictionEngineError('MODEL_SPEC_INVALID', 'An explicit raw-output tensor contract, decoder identity, and axis convention are required.');
  }
  for (const parameter of ['sph', 'cyl', 'axis']) {
    const domain = output.domains?.[parameter];
    if (!domain || !Number.isFinite(domain.min) || !Number.isFinite(domain.max) || domain.min >= domain.max
      || typeof domain.minInclusive !== 'boolean' || typeof domain.maxInclusive !== 'boolean'
      || domain.unit !== OUTPUT_UNITS[parameter]) {
      throw new PredictionEngineError('MODEL_SPEC_INVALID', `The model must declare finite ${parameter.toUpperCase()} bounds, boundary semantics, and units in ${OUTPUT_UNITS[parameter]}.`, { parameter });
    }
  }
  if (output.confidence !== undefined && (!output.confidence || !nonEmptyString(output.confidence.kind)
    || !Number.isFinite(output.confidence.min) || !Number.isFinite(output.confidence.max)
    || output.confidence.min >= output.confidence.max
    || typeof output.confidence.minInclusive !== 'boolean' || typeof output.confidence.maxInclusive !== 'boolean')) {
    throw new PredictionEngineError('MODEL_SPEC_INVALID', 'A declared confidence output needs an explicit kind and finite domain.');
  }
  if (output.uncertainty !== undefined && (!output.uncertainty || !nonEmptyString(output.uncertainty.format))) {
    throw new PredictionEngineError('MODEL_SPEC_INVALID', 'A declared uncertainty output needs an explicit format.');
  }
  return spec;
}

/**
 * A model adapter must load the model locally, verify its embedded metadata,
 * run inference, decode its documented output, and dispose runtime resources.
 * No network loader or third-party runtime is bundled by this boundary.
 */
export function createPredictionEngine({ modelSpec = null, adapter = null, now = () => Date.now(), monotonicNow = defaultMonotonicNow } = {}) {
  return new PredictionEngine({ modelSpec, adapter, now, monotonicNow });
}

class PredictionEngine {
  constructor({ modelSpec, adapter, now, monotonicNow }) {
    this.modelSpec = modelSpec ? freezeManifest(structuredClone(modelSpec)) : null;
    this.adapter = adapter;
    this.now = now;
    this.monotonicNow = monotonicNow;
    this.status = 'idle';
    this.error = null;
    this.session = null;
    this.loadPromise = null;
    this.loadController = null;
    this.disposed = false;
    this.predictionRequests = new WeakMap();
    this.activePredictions = new Set();
    this.abortControllers = new Set();
    this.predictionSequence = 0;
  }

  getSnapshot() {
    return {
      engineVersion: PREDICTION_ENGINE_VERSION,
      status: this.status,
      modelReady: this.status === 'ready',
      model: this.modelSpec ? {
        id: this.modelSpec.modelId,
        version: this.modelSpec.modelVersion,
        runtime: this.modelSpec.runtime,
        artifactFormat: this.modelSpec.artifact?.format || null,
      } : null,
      error: this.error ? { ...this.error, details: { ...this.error.details } } : null,
    };
  }

  async initialize() {
    if (this.disposed) throw new PredictionEngineError('ENGINE_DISPOSED', 'The prediction engine has already been disposed.');
    if (this.status === 'ready') return this.getSnapshot();
    if (this.loadPromise) return this.loadPromise;
    if (this.status === 'error') return this.getSnapshot();
    if (!this.modelSpec && !this.adapter) {
      this.status = 'unavailable';
      this.error = errorRecord('MODEL_NOT_CONFIGURED', 'No trained prediction model is configured.');
      return this.getSnapshot();
    }
    if (!this.modelSpec || !this.adapter) {
      this.status = 'error';
      this.error = errorRecord('MODEL_CONFIGURATION_INCOMPLETE', 'A model manifest and local runtime adapter must be configured together.');
      return this.getSnapshot();
    }

    this.status = 'loading';
    this.error = null;
    this.loadController = new AbortController();
    this.loadPromise = this.loadModel(this.loadController.signal);
    return this.loadPromise;
  }

  async retry({ reinitialize = false } = {}) {
    if (this.disposed) throw new PredictionEngineError('ENGINE_DISPOSED', 'The prediction engine has already been disposed.');
    if (this.status === 'loading') return this.loadPromise;
    if (this.status === 'ready' && !reinitialize) return this.getSnapshot();
    if (reinitialize && this.session) {
      for (const controller of this.abortControllers) controller.abort();
      if (this.activePredictions.size) await Promise.allSettled([...this.activePredictions]);
      const previousSession = this.session;
      this.session = null;
      await safelyDispose(this.adapter, previousSession);
    }
    this.loadPromise = null;
    this.loadController = null;
    this.error = null;
    this.status = 'idle';
    return this.initialize();
  }

  async predictBatch(featureBatch, { signal } = {}) {
    if (this.disposed) throw new PredictionEngineError('ENGINE_DISPOSED', 'The prediction engine has already been disposed.');
    if (!this.modelSpec || !this.adapter) {
      const snapshot = await this.initialize();
      const error = snapshot.error || errorRecord('MODEL_NOT_READY', 'The prediction model is not ready.');
      throw new PredictionEngineError(error.code, error.message, error.details);
    }
    if (!featureBatch || typeof featureBatch !== 'object') {
      throw new PredictionEngineError('INVALID_INPUT', 'A Component 8 feature batch is required.');
    }
    validatePredictionModelSpec(this.modelSpec);
    const cached = this.predictionRequests.get(featureBatch);
    if (cached) return cached;
    const prepared = prepareFeatureBatch(featureBatch, this.modelSpec);
    const snapshot = await this.initialize();
    if (snapshot.status !== 'ready') {
      const error = snapshot.error || errorRecord('MODEL_NOT_READY', 'The prediction model is not ready.');
      throw new PredictionEngineError(error.code, error.message, error.details);
    }
    const cachedAfterInitialization = this.predictionRequests.get(featureBatch);
    if (cachedAfterInitialization) return cachedAfterInitialization;
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', relayAbort, { once: true });
    this.abortControllers.add(controller);
    const request = this.inferBatch(prepared, featureBatch, controller.signal);
    this.activePredictions.add(request);
    this.predictionRequests.set(featureBatch, request);
    try {
      return await request;
    } catch (error) {
      this.predictionRequests.delete(featureBatch);
      throw error;
    } finally {
      signal?.removeEventListener('abort', relayAbort);
      this.abortControllers.delete(controller);
      this.activePredictions.delete(request);
    }
  }

  async loadModel(signal) {
    let loaded = null;
    let loadedDisposed = false;
    try {
      validatePredictionModelSpec(this.modelSpec);
      validateAdapter(this.adapter, this.modelSpec);
      loaded = await this.adapter.load(this.modelSpec, { signal });
      if (!loaded || !loaded.session) throw new PredictionEngineError('MODEL_LOAD_FAILED', 'The local adapter did not return a model session.');
      validateLoadedMetadata(loaded.metadata, this.modelSpec);
      if (this.disposed || signal?.aborted) {
        await safelyDispose(this.adapter, loaded.session);
        loadedDisposed = true;
        throw new PredictionEngineError('MODEL_LOAD_CANCELLED', 'Model loading was cancelled before the runtime became ready.');
      }
      this.session = loaded.session;
      this.status = 'ready';
      this.error = null;
    } catch (error) {
      if (loaded?.session && loaded.session !== this.session && !loadedDisposed) await safelyDispose(this.adapter, loaded.session);
      const normalized = signal?.aborted
        ? new PredictionEngineError('MODEL_LOAD_CANCELLED', 'Model loading was cancelled before the runtime became ready.')
        : normalizeError(error, 'MODEL_LOAD_FAILED', 'The local prediction model could not be loaded or verified.');
      this.status = this.disposed ? 'disposed' : 'error';
      this.error = errorRecord(normalized.code, normalized.message, normalized.details);
    } finally {
      this.loadPromise = null;
      this.loadController = null;
    }
    return this.getSnapshot();
  }

  async inferBatch(prepared, sourceBatch, signal) {
    throwIfAborted(signal);
    const started = this.monotonicNow();
    const predictedCaptures = [];
    try {
      for (const capture of prepared.captures) {
        throwIfAborted(signal);
        let rawOutput;
        if (this.modelSpec.input.mode === 'independent') {
          rawOutput = {};
          for (const pair of EYES) {
            throwIfAborted(signal);
            const vector = capture[pair.key];
            rawOutput[pair.designation] = await this.adapter.infer(this.session, {
              mode: 'independent',
              eye: { eye: pair.eye, designation: pair.designation },
              values: Float32Array.from(vector.values),
              featureOrder: [...vector.featureOrder],
              dataType: vector.dataType,
              tensorDataType: this.modelSpec.input.dataType,
              quantizationId: this.modelSpec.input.quantizationId || null,
              quantization: this.modelSpec.input.quantization ? structuredClone(this.modelSpec.input.quantization) : null,
              tensorShape: [...this.modelSpec.input.tensorShape],
            }, { signal });
          }
        } else {
          rawOutput = await this.adapter.infer(this.session, {
            mode: 'paired',
            pairingOrder: [...this.modelSpec.input.pairingOrder],
            eyes: {
              OD: Float32Array.from(capture.rightEye.values),
              OS: Float32Array.from(capture.leftEye.values),
            },
            featureOrder: [...this.modelSpec.input.featureOrder],
            dataType: 'float32',
            tensorDataType: this.modelSpec.input.dataType,
            quantizationId: this.modelSpec.input.quantizationId || null,
            quantization: this.modelSpec.input.quantization ? structuredClone(this.modelSpec.input.quantization) : null,
            tensorShape: [...this.modelSpec.input.tensorShape],
          }, { signal });
        }
        throwIfAborted(signal);
        const decoded = await this.adapter.decodeOutput(rawOutput, this.modelSpec);
        predictedCaptures.push({
          sourceCaptureId: capture.sourceCaptureId,
          rightEye: makePredictionEye(decoded?.OD, EYES[0], this.modelSpec.output),
          leftEye: makePredictionEye(decoded?.OS, EYES[1], this.modelSpec.output),
          ...(capture.captureEvidence ? { captureEvidence: structuredClone(capture.captureEvidence) } : {}),
        });
      }
    } catch (error) {
      if (error instanceof PredictionEngineError) throw error;
      if (signal?.aborted) throw new PredictionEngineError('INFERENCE_CANCELLED', 'Prediction was cancelled before a complete result was produced.');
      throw normalizeError(error, 'INFERENCE_FAILED', 'The local model could not complete inference.');
    }

    const ended = this.monotonicNow();
    const elapsed = Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : null;
    const predictionBatchId = `prediction-${++this.predictionSequence}`;
    predictedCaptures.forEach(capture => { capture.predictionId = `${predictionBatchId}:${capture.sourceCaptureId}`; });
    return {
      predictionSchemaVersion: PREDICTION_SCHEMA_VERSION,
      predictionEngineVersion: PREDICTION_ENGINE_VERSION,
      predictionBatchId,
      model: {
        id: this.modelSpec.modelId,
        version: this.modelSpec.modelVersion,
        runtime: this.modelSpec.runtime,
        artifactFormat: this.modelSpec.artifact.format,
        artifactSha256: this.modelSpec.artifact.sha256,
        manifestVersion: this.modelSpec.manifestVersion,
        decoderId: this.modelSpec.output.decoderId,
        inputDataType: this.modelSpec.input.dataType,
        inputTensorShape: [...this.modelSpec.input.tensorShape],
        axisConvention: this.modelSpec.output.axisConvention,
        outputDomains: structuredClone(this.modelSpec.output.domains),
        outputConfidenceDomain: this.modelSpec.output.confidence ? structuredClone(this.modelSpec.output.confidence) : null,
        outputUncertaintyFormat: this.modelSpec.output.uncertainty?.format || null,
      },
      inferenceTimestamp: this.now(),
      inferenceTimeMs: elapsed,
      inputValidity: {
        valid: true,
        featureSchemaVersion: sourceBatch.featureSchemaVersion,
        sourcePreprocessingVersion: sourceBatch.sourcePreprocessingVersion,
        captureCount: prepared.captures.length,
      },
      outputValidity: { valid: true },
      clinicalValidity: 'NOT_ASSESSED',
      component11ReliabilityAssessmentRequired: true,
      valid: true,
      captures: predictedCaptures,
    };
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.loadController?.abort();
    for (const controller of this.abortControllers) controller.abort();
    const inFlightLoad = this.loadPromise;
    if (inFlightLoad) await inFlightLoad;
    if (this.activePredictions.size) await Promise.allSettled([...this.activePredictions]);
    const session = this.session;
    this.session = null;
    this.status = 'disposed';
    this.predictionRequests = new WeakMap();
    if (session) await safelyDispose(this.adapter, session);
  }
}

function prepareFeatureBatch(batch, spec) {
  try {
    validateFeatureBatch(batch);
  } catch (error) {
    throw new PredictionEngineError('INVALID_INPUT', 'Component 8 output does not match its versioned binocular feature-batch contract.', {
      sourceCode: error?.code || 'FEATURE_BATCH_INVALID',
    });
  }
  if (batch.sourcePreprocessingVersion !== PREPROCESSING_VERSION) {
    throw new PredictionEngineError('PREPROCESSING_VERSION_MISMATCH', 'Component 8 features were not produced by the supported preprocessing schema.', {
      expected: PREPROCESSING_VERSION,
      received: batch.sourcePreprocessingVersion ?? null,
    });
  }

  const captures = batch.captures.map(capture => {
    if (typeof capture.sourceCaptureId !== 'string' || !capture.sourceCaptureId) {
      throw new PredictionEngineError('INVALID_INPUT', 'Every feature record must retain its source capture identity.');
    }
    if (capture.captureEvidence !== undefined && !isCaptureEvidence(capture.captureEvidence, capture.sourceCaptureId)) {
      throw new PredictionEngineError('INVALID_INPUT', 'Component 8 capture-quality evidence is invalid or does not match the source capture.');
    }
    const vectors = {};
    for (const pair of EYES) {
      const eye = capture[pair.key];
      if (eye.eye !== pair.eye || eye.designation !== pair.designation || eye.sourceCaptureId !== capture.sourceCaptureId) {
        throw new PredictionEngineError('EYE_IDENTITY_MISMATCH', 'Component 8 eye identity does not match its anatomical OD/OS slot.', { designation: pair.designation });
      }
      if (eye.sourceMetadata?.preprocessingVersion !== PREPROCESSING_VERSION) {
        throw new PredictionEngineError('PREPROCESSING_VERSION_MISMATCH', `The ${pair.designation} eye feature set has an unsupported preprocessing version.`, { designation: pair.designation });
      }
      try {
        const vector = toFeatureVector(eye, {
          featureOrder: spec.input.featureOrder,
          normalization: spec.input.normalization,
        });
        validateFeatureVector(vector, { expectedFeatureOrder: spec.input.featureOrder });
        if (vector.values.length !== spec.input.featureOrder.length
          || vector.dataType !== 'float32'
          || vector.values.some(value => !Number.isFinite(value))) {
          throw new PredictionEngineError('INVALID_INPUT', `The ${pair.designation} feature tensor has invalid values or data type.`, { designation: pair.designation });
        }
        vectors[pair.key] = vector;
      } catch (error) {
        if (error instanceof PredictionEngineError) throw error;
        if (error instanceof FeatureExtractionError && error.code === 'FEATURE_VECTOR_INCOMPLETE') {
          throw new PredictionEngineError('MISSING_FEATURE', `Required Component 8 features are missing for ${pair.designation}.`, {
            designation: pair.designation,
            missingFeatureNames: error.details?.missingFeatureNames || [],
          });
        }
        throw new PredictionEngineError('INVALID_INPUT', `The ${pair.designation} feature vector failed schema validation.`, {
          designation: pair.designation,
          sourceCode: error?.code || 'FEATURE_VECTOR_INVALID',
        });
      }
    }
    return { sourceCaptureId: capture.sourceCaptureId, ...(capture.captureEvidence ? { captureEvidence: structuredClone(capture.captureEvidence) } : {}), ...vectors };
  });
  return { captures };
}

function validateAdapter(adapter, spec) {
  if (adapter?.local !== true) throw new PredictionEngineError('UNSUPPORTED_RUNTIME', 'Only an explicitly local, on-device inference adapter is supported.');
  if (adapter.runtime !== spec.runtime) throw new PredictionEngineError('UNSUPPORTED_RUNTIME', 'The configured adapter runtime does not match the model manifest.', { expected: spec.runtime, received: adapter.runtime ?? null });
  for (const method of ['load', 'infer', 'decodeOutput', 'dispose']) {
    if (typeof adapter[method] !== 'function') throw new PredictionEngineError('MODEL_ADAPTER_INVALID', `The local model adapter must implement ${method}().`, { method });
  }
}

function validateLoadedMetadata(metadata, spec) {
  const input = spec.input;
  const compatible = metadata
    && metadata.modelId === spec.modelId
    && metadata.modelVersion === spec.modelVersion
    && metadata.runtime === spec.runtime
    && metadata.artifactFormat === spec.artifact.format
    && typeof metadata.artifactSha256 === 'string'
    && metadata.artifactSha256.toLowerCase() === spec.artifact.sha256.toLowerCase()
    && metadata.featureSchemaVersion === input.featureSchemaVersion
    && metadata.inputMode === input.mode
    && metadata.inputDataType === input.dataType
    && sameArray(metadata.inputFeatureOrder, input.featureOrder)
    && sameArray(metadata.inputTensorShape, input.tensorShape)
    && stableJsonStringify(metadata.inputNormalization) === stableJsonStringify(input.normalization)
    && (input.quantizationId === undefined || metadata.inputQuantizationId === input.quantizationId)
    && (input.quantization === undefined || stableJsonStringify(metadata.inputQuantization) === stableJsonStringify(input.quantization))
    && (input.mode !== 'paired' || sameArray(metadata.inputPairingOrder, input.pairingOrder))
    && metadata.outputTensorContractId === spec.output.tensorContractId
    && metadata.outputDecoderId === spec.output.decoderId;
  if (!compatible) {
    throw new PredictionEngineError('MODEL_VERSION_MISMATCH', 'Loaded model metadata does not match the declared version, feature contract, shape, runtime, or output decoder.');
  }
}

function makePredictionEye(output, expected, spec) {
  if (!output || output.eye !== expected.eye || output.designation !== expected.designation) {
    throw new PredictionEngineError('INVALID_MODEL_OUTPUT', `Decoded output is missing the expected ${expected.designation} eye identity.`, { designation: expected.designation });
  }
  for (const parameter of ['sph', 'cyl', 'axis']) {
    const value = output[parameter], domain = spec.domains[parameter];
    if (!Number.isFinite(value) || value < domain.min || value > domain.max
      || value === domain.min && !domain.minInclusive || value === domain.max && !domain.maxInclusive) {
      throw new PredictionEngineError('INVALID_MODEL_OUTPUT', `Decoded ${expected.designation} ${parameter.toUpperCase()} is non-finite or outside the model-declared domain.`, {
        designation: expected.designation,
        parameter,
        domain: { min: domain.min, max: domain.max, minInclusive: domain.minInclusive, maxInclusive: domain.maxInclusive, unit: domain.unit },
      });
    }
  }

  let confidence = { value: null, status: 'UNAVAILABLE', reason: 'The model does not declare a confidence output.' };
  if (output.confidence !== undefined && output.confidence !== null) {
    if (!spec.confidence || !Number.isFinite(output.confidence.value)
      || output.confidence.value < spec.confidence.min || output.confidence.value > spec.confidence.max
      || output.confidence.value === spec.confidence.min && !spec.confidence.minInclusive
      || output.confidence.value === spec.confidence.max && !spec.confidence.maxInclusive) {
      throw new PredictionEngineError('INVALID_MODEL_OUTPUT', `Decoded ${expected.designation} confidence does not match the declared model contract.`, { designation: expected.designation });
    }
    confidence = { value: output.confidence.value, status: 'AVAILABLE', kind: spec.confidence.kind };
  }

  let uncertainty = { value: null, status: 'UNAVAILABLE', reason: 'The model does not declare an uncertainty output.' };
  if (output.uncertainty !== undefined && output.uncertainty !== null) {
    if (!spec.uncertainty || !isJsonFinite(output.uncertainty)) {
      throw new PredictionEngineError('INVALID_MODEL_OUTPUT', `Decoded ${expected.designation} uncertainty does not match the declared model contract.`, { designation: expected.designation });
    }
    uncertainty = { value: cloneJson(output.uncertainty), status: 'AVAILABLE', format: spec.uncertainty.format };
  }

  return {
    eye: expected.eye,
    designation: expected.designation,
    sph: output.sph,
    cyl: output.cyl,
    axis: output.axis,
    units: { sph: spec.domains.sph.unit, cyl: spec.domains.cyl.unit, axis: spec.domains.axis.unit },
    axisConvention: spec.axisConvention,
    confidence,
    uncertainty,
    valid: true,
  };
}

function validateFeatureOrder(order) {
  const known = new Set(FEATURE_ORDER);
  if (order.some(name => typeof name !== 'string' || !known.has(name))) {
    throw new PredictionEngineError('MODEL_SPEC_INVALID', 'The model feature order contains an unknown Component 8 feature.');
  }
}

function validateNormalization(normalization, length) {
  if (normalization?.method === 'none') return;
  if (normalization?.method !== 'mean-std' || !Array.isArray(normalization.mean) || !Array.isArray(normalization.std)
    || normalization.mean.length !== length || normalization.std.length !== length
    || normalization.mean.some(value => !Number.isFinite(value))
    || normalization.std.some(value => !Number.isFinite(value) || value <= 0)) {
    throw new PredictionEngineError('MODEL_SPEC_INVALID', 'Model normalization must be explicitly none or provide one finite mean and positive standard deviation per ordered feature.');
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new PredictionEngineError('INFERENCE_CANCELLED', 'Prediction was cancelled before a complete result was produced.');
}

function normalizeError(error, fallbackCode, fallbackMessage) {
  if (error instanceof PredictionEngineError) return error;
  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
  if (/out of memory|memory allocation|allocation failed/.test(message)) {
    return new PredictionEngineError('RUNTIME_MEMORY_ERROR', 'The local inference runtime ran out of memory.');
  }
  return new PredictionEngineError(fallbackCode, fallbackMessage, {
    sourceCode: nonEmptyString(error?.code) ? error.code : undefined,
  });
}

function errorRecord(code, message, details = {}) { return { code, message, details }; }
function nonEmptyString(value) { return typeof value === 'string' && value.trim().length > 0; }
function sameArray(left, right) { return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]); }
function stableJsonStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function defaultMonotonicNow() { return globalThis.performance?.now?.() ?? Date.now(); }

async function safelyDispose(adapter, session) {
  if (typeof adapter?.dispose !== 'function') return;
  try { await adapter.dispose(session); } catch { /* Cleanup must not replace the original inference/load result. */ }
}

function isJsonFinite(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every(item => isJsonFinite(item, ancestors))
    : Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(item => isJsonFinite(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function cloneJson(value) {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item)]));
  return value;
}

function freezeManifest(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freezeManifest);
  return Object.freeze(value);
}
