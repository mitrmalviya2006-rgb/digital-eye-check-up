import test from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_SCHEMA_VERSION, extractFeaturesBatch } from '../src/feature-extraction.js';
import { PREPROCESSING_VERSION } from '../src/image-preprocessing.js';
import {
  createPredictionEngine,
  MODEL_MANIFEST_VERSION,
  PREDICTION_SCHEMA_VERSION,
  validatePredictionModelSpec,
} from '../src/prediction-engine.js';
import { mountPredictionStep } from '../src/prediction-step.js';
import { analyzePredictionResult } from '../src/eye-analysis.js';
import { assessEyeValidity } from '../src/validity-engine.js';

const MODEL_FEATURES = ['eyeWidthFraction', 'eyeHeightFraction'];

function makeSpec({ mode = 'independent', confidence = undefined, uncertainty = undefined } = {}) {
  return {
    manifestVersion: MODEL_MANIFEST_VERSION,
    modelId: 'mock-refraction-fixture',
    modelVersion: 'fixture-1',
    runtime: 'mock-local-runtime',
    artifact: { assetId: 'fixture-only/mock-model', format: 'fixture-only', sha256: 'a'.repeat(64) },
    input: {
      featureSchemaVersion: FEATURE_SCHEMA_VERSION,
      featureOrder: [...MODEL_FEATURES],
      dataType: 'float32',
      tensorShape: mode === 'paired' ? [1, 2, MODEL_FEATURES.length] : [1, MODEL_FEATURES.length],
      mode,
      ...(mode === 'paired' ? { pairingOrder: ['OD', 'OS'] } : {}),
      normalization: { method: 'mean-std', mean: [.1, .05], std: [.1, .05] },
    },
    output: {
      decoderId: 'fixture-decoder-1',
      tensorContractId: 'fixture-output-heads-1',
      tensorContract: { heads: [{ name: 'mock-regression-head', shape: [1, 3], dataType: 'float32', encoding: 'fixture-only' }] },
      axisConvention: 'fixture-only-0-to-180',
      domains: {
        sph: { min: -20, max: 20, minInclusive: true, maxInclusive: true, unit: 'D' },
        cyl: { min: -20, max: 0, minInclusive: true, maxInclusive: true, unit: 'D' },
        axis: { min: 0, max: 180, minInclusive: true, maxInclusive: false, unit: 'deg' },
      },
      ...(confidence ? { confidence } : {}),
      ...(uncertainty ? { uncertainty } : {}),
    },
  };
}

function makeMetadata(spec) {
  return {
    modelId: spec.modelId,
    modelVersion: spec.modelVersion,
    runtime: spec.runtime,
    artifactFormat: spec.artifact.format,
    artifactSha256: spec.artifact.sha256,
    featureSchemaVersion: spec.input.featureSchemaVersion,
    inputMode: spec.input.mode,
    inputDataType: spec.input.dataType,
    inputFeatureOrder: [...spec.input.featureOrder],
    inputTensorShape: [...spec.input.tensorShape],
    inputNormalization: structuredClone(spec.input.normalization),
    ...(spec.input.mode === 'paired' ? { inputPairingOrder: [...spec.input.pairingOrder] } : {}),
    outputTensorContractId: spec.output.tensorContractId,
    outputDecoderId: spec.output.decoderId,
  };
}

function makeMockAdapter(spec, {
  failLoad = null,
  failInfer = null,
  metadata = makeMetadata(spec),
  decode = raw => raw,
} = {}) {
  const calls = { loads: 0, inferences: [], decodes: 0, disposals: 0 };
  return {
    calls,
    adapter: {
      local: true,
      runtime: spec.runtime,
      async load() {
        calls.loads++;
        if (failLoad) {
          const failure = failLoad(calls.loads);
          if (failure) return failure;
        }
        return { session: { fixtureSession: true }, metadata };
      },
      async infer(_session, input) {
        calls.inferences.push(input);
        if (failInfer) return failInfer(input, calls.inferences.length);
        if (input.mode === 'independent') return { eye: input.eye.eye, designation: input.eye.designation };
        return { OD: { eye: 'right', designation: 'OD' }, OS: { eye: 'left', designation: 'OS' } };
      },
      async decodeOutput(raw) {
        calls.decodes++;
        return decode(raw);
      },
      async dispose() { calls.disposals++; },
    },
  };
}

function fixtureDecoded(raw, { sph = -1.25, cyl = -.5, axis = 90, confidence = null, uncertainty = null } = {}) {
  const result = {};
  for (const designation of ['OD', 'OS']) {
    const eye = designation === 'OD' ? 'right' : 'left';
    result[designation] = {
      eye,
      designation,
      sph,
      cyl,
      axis,
      ...(confidence === null ? {} : { confidence: { value: confidence } }),
      ...(uncertainty === null ? {} : { uncertainty }),
    };
  }
  return result;
}

function makePreprocessedEye(side, { missingOpenness = false } = {}) {
  const designation = side === 'right' ? 'OD' : 'OS';
  const centerX = side === 'right' ? .3 : .7;
  const centerY = .42;
  const eyeBox = { left: centerX - .15, top: .3, right: centerX + .15, bottom: .55 };
  const irisBox = { left: centerX - .02, top: centerY - .03, right: centerX + .02, bottom: centerY + .03 };
  const points = [
    { x: 8, y: 2 }, { x: 12, y: 6 }, { x: 8, y: 10 }, { x: 4, y: 6 },
  ];
  return {
    eye: side,
    designation,
    width: 16,
    height: 12,
    channels: 3,
    colorMode: 'RGB',
    layout: 'HWC',
    image: new Uint8Array(16 * 12 * 3).map((_, index) => 60 + index % 100),
    dataType: 'uint8',
    normalization: { method: 'none', inputRange: [0, 255], outputRange: [0, 255] },
    transform: { rotationDegrees: 0 },
    irisOutputBoundary: points,
    sourceMetadata: {
      boundingBox: eyeBox,
      orientationDegrees: 1,
      opennessRatio: missingOpenness ? null : .24,
      confidence: null,
      confidenceStatus: 'UNAVAILABLE',
      eyeCorners: {
        nasal: { x: centerX - .12, y: centerY },
        temporal: { x: centerX + .12, y: centerY },
      },
      iris: { detected: true, center: { x: centerX, y: centerY }, boundingBox: irisBox, boundary: [] },
    },
  };
}

async function makeFeatureBatch({ missingOpenness = false, id = 'capture-1' } = {}) {
  const batch = {
    preprocessingVersion: PREPROCESSING_VERSION,
    valid: true,
    timestamp: 200,
    captures: [{
      sourceCaptureId: id,
      valid: true,
      sourceDimensions: { width: 640, height: 360 },
      rightEye: makePreprocessedEye('right', { missingOpenness }),
      leftEye: makePreprocessedEye('left', { missingOpenness }),
    }],
  };
  return extractFeaturesBatch(batch, { now: () => 222, yieldToMainThread: async () => {} });
}

function passingCaptureEvidence(sourceCaptureId) {
  const makeQualityEye = (eye, designation) => ({
    eye, designation, state: 'GOOD', detected: true, geometryComplete: true, openness: 'OPEN',
    confidence: { state: 'SUFFICIENT', value: .9, threshold: .65 },
    visibility: { state: 'VISIBLE', geometryPresent: true }, occlusionState: 'CLEAR',
    sharpness: { state: 'SHARP', value: 50, threshold: 32 },
    exposureState: 'ACCEPTABLE', glareState: 'CHECKED', reasons: [],
  });
  const quality = () => ({
    schemaVersion: '1.0.0', valid: true, overallStatus: 'GOOD', captureReady: true,
    blurState: 'SHARP', exposureState: 'ACCEPTABLE', lightingState: 'ACCEPTABLE', glareState: 'NO_EXCESSIVE_GLARE_DETECTED',
    motion: { state: 'STABLE', stable: true, eyeMovementPixels: 0 },
    positioning: { state: 'ACCEPTABLE', positioningReady: true, distanceStatus: 'ACCEPTABLE' },
    eyes: { OD: makeQualityEye('right', 'OD'), OS: makeQualityEye('left', 'OS') }, reasons: [],
  });
  return {
    schemaVersion: '1.0.0', sourceCaptureId, captureIndex: 1, requiredCaptureCount: 1,
    stability: { positionStable: true, eyeTrackingStable: true, stableForMs: 900, qualitySamples: 2 },
    positioning: { status: 'READY', ready: true, stable: true, distanceStatus: 'ACCEPTABLE' },
    capturedQuality: quality(), liveQuality: quality(),
  };
}

test('default model initialization is explicitly unavailable and never performs inference', async () => {
  const engine = createPredictionEngine();
  const status = await engine.initialize();
  assert.equal(status.status, 'unavailable');
  assert.equal(status.error.code, 'MODEL_NOT_CONFIGURED');
  await assert.rejects(engine.predictBatch(null), error => error.code === 'MODEL_NOT_CONFIGURED');
  assert.equal(status.modelReady, false);
  await engine.dispose();
});

test('validates explicit manifest, ordered subset, normalization, eye mode, and tensor dimensions', () => {
  assert.equal(validatePredictionModelSpec(makeSpec()).modelVersion, 'fixture-1');
  assert.throws(() => validatePredictionModelSpec({ ...makeSpec(), input: { ...makeSpec().input, tensorShape: [2, 2] } }), error => error.code === 'MODEL_INPUT_SHAPE_INVALID');
  const missingPairOrder = makeSpec({ mode: 'paired' });
  delete missingPairOrder.input.pairingOrder;
  assert.throws(() => validatePredictionModelSpec(missingPairOrder), error => error.code === 'MODEL_SPEC_INVALID');
  const badFeature = makeSpec(); badFeature.input.featureOrder = ['pupilDiameterPx'];
  assert.throws(() => validatePredictionModelSpec(badFeature), error => error.code === 'MODEL_SPEC_INVALID');
  const badNorm = makeSpec(); badNorm.input.normalization.std = [1, 0];
  assert.throws(() => validatePredictionModelSpec(badNorm), error => error.code === 'MODEL_SPEC_INVALID');
  const badArtifact = makeSpec(); badArtifact.artifact.sha256 = 'not-a-digest';
  assert.throws(() => validatePredictionModelSpec(badArtifact), error => error.code === 'MODEL_SPEC_INVALID');
  const remoteAsset = makeSpec(); remoteAsset.artifact.assetId = 'https://example.invalid/model.onnx';
  assert.throws(() => validatePredictionModelSpec(remoteAsset), error => error.code === 'MODEL_SPEC_INVALID');
});

test('loads once, verifies metadata, predicts OD and OS, and produces the Component 10/11 contract', async () => {
  const spec = makeSpec();
  const { adapter, calls } = makeMockAdapter(spec, { decode: raw => fixtureDecoded(raw) });
  let time = 0;
  const engine = createPredictionEngine({ modelSpec: spec, adapter, now: () => 1234, monotonicNow: () => time += 4 });
  const status = await engine.initialize();
  assert.equal(status.status, 'ready');
  const features = await makeFeatureBatch();
  const result = await engine.predictBatch(features);
  assert.equal(result.predictionSchemaVersion, PREDICTION_SCHEMA_VERSION);
  assert.equal(result.model.version, 'fixture-1');
  assert.deepEqual(result.model.outputDomains, spec.output.domains);
  assert.equal(result.model.axisConvention, spec.output.axisConvention);
  assert.equal(result.predictionBatchId, 'prediction-1');
  assert.equal(result.inputValidity.valid, true);
  assert.equal(result.outputValidity.valid, true);
  assert.equal(result.clinicalValidity, 'NOT_ASSESSED');
  assert.equal(result.component11ReliabilityAssessmentRequired, true);
  assert.equal(result.captures.length, 1);
  assert.equal(result.captures[0].rightEye.eye, 'right');
  assert.equal(result.captures[0].rightEye.designation, 'OD');
  assert.equal(result.captures[0].leftEye.eye, 'left');
  assert.equal(result.captures[0].leftEye.designation, 'OS');
  assert.equal(result.captures[0].rightEye.confidence.status, 'UNAVAILABLE');
  assert.equal(result.captures[0].rightEye.uncertainty.status, 'UNAVAILABLE');
  assert.equal(result.inferenceTimestamp, 1234);
  assert.equal(result.inferenceTimeMs, 4);
  assert.equal(calls.loads, 1);
  assert.deepEqual(calls.inferences.map(input => input.eye.designation), ['OD', 'OS']);
  assert.ok(calls.inferences.every(input => input.values instanceof Float32Array && input.tensorShape.join(',') === '1,2'));
  const original = features.captures[0];
  assert.ok(Math.abs(calls.inferences[0].values[0] - (original.rightEye.features.eyeWidthFraction.value - .1) / .1) < 1e-5);
  assert.ok(Math.abs(calls.inferences[1].values[0] - (original.leftEye.features.eyeWidthFraction.value - .1) / .1) < 1e-5);
  assert.equal(result.captures[0].rightEye.designation, 'OD');
  assert.equal(result.captures[0].leftEye.designation, 'OS');
  assert.equal(result.captures[0].rightEye.axisConvention, 'fixture-only-0-to-180');
  assert.equal(result.captures[0].predictionId, 'prediction-1:capture-1');
  const analysis = analyzePredictionResult(result);
  assert.equal(analysis.analysisStatus, 'ANALYZED');
  assert.equal(analysis.rightEye.predictions[0].sourcePredictionId, result.captures[0].predictionId);
  assert.equal(analysis.leftEye.predictions[0].modelVersion, result.model.version);
  await engine.predictBatch(await makeFeatureBatch({ id: 'capture-2' }));
  assert.equal(calls.loads, 1, 'one initialized model session is reused across capture batches');
  assert.equal(calls.inferences.length, 4);
  await engine.dispose();
  assert.equal(calls.disposals, 1);
});

test('carries C6 quality evidence through C7–C10 into the Component 11 gate', async () => {
  const confidence = { kind: 'probability', min: 0, max: 1, minInclusive: true, maxInclusive: true };
  const spec = makeSpec({ confidence });
  const { adapter } = makeMockAdapter(spec, { decode: raw => fixtureDecoded(raw, { confidence: .87 }) });
  const engine = createPredictionEngine({ modelSpec: spec, adapter, now: () => 1234, monotonicNow: () => 0 });
  const features = await makeFeatureBatch();
  features.captures[0].captureEvidence = passingCaptureEvidence('capture-1');
  const prediction = await engine.predictBatch(features);
  const organized = analyzePredictionResult(prediction);
  const validity = assessEyeValidity(organized, {
    policy: {
      confidenceMinimumByKind: { probability: .7 },
      uncertaintyMaximumByFormat: {},
      consistencyTolerances: { sph: .5, cyl: .5, axis: 15 },
    },
  });
  assert.equal(prediction.captures[0].captureEvidence.sourceCaptureId, 'capture-1');
  assert.equal(organized.rightEye.predictions[0].captureEvidence.sourceCaptureId, 'capture-1');
  assert.equal(validity.status, 'VALID');
  assert.equal(validity.rightEye.designation, 'OD');
  assert.equal(validity.leftEye.designation, 'OS');
  await engine.dispose();
});

test('paired-eye models receive the manifest-declared OD then OS layout and exact shape', async () => {
  const spec = makeSpec({ mode: 'paired' });
  const { adapter, calls } = makeMockAdapter(spec, { decode: raw => fixtureDecoded(raw) });
  const engine = createPredictionEngine({ modelSpec: spec, adapter });
  const result = await engine.predictBatch(await makeFeatureBatch());
  assert.equal(calls.inferences.length, 1);
  const [input] = calls.inferences;
  assert.deepEqual(input.pairingOrder, ['OD', 'OS']);
  assert.equal(input.eyes.OD.length, MODEL_FEATURES.length);
  assert.equal(input.eyes.OS.length, MODEL_FEATURES.length);
  assert.deepEqual(input.tensorShape, [1, 2, MODEL_FEATURES.length]);
  assert.equal(result.captures[0].rightEye.designation, 'OD');
  assert.equal(result.captures[0].leftEye.designation, 'OS');
  await engine.dispose();
});

test('quantized model manifests pass an explicit target dtype and quantization contract to the local adapter', async () => {
  const spec = makeSpec();
  spec.input.dataType = 'int8';
  spec.input.quantizationId = 'fixture-affine-int8-v1';
  spec.input.quantization = { scheme: 'affine', scale: [.05, .1], zeroPoint: [0, 0], rounding: 'nearest-even', outOfRange: 'reject' };
  const metadata = {
    ...makeMetadata(spec),
    inputQuantizationId: spec.input.quantizationId,
    inputQuantization: structuredClone(spec.input.quantization),
  };
  const { adapter, calls } = makeMockAdapter(spec, { metadata, decode: raw => fixtureDecoded(raw) });
  const engine = createPredictionEngine({ modelSpec: spec, adapter });
  const result = await engine.predictBatch(await makeFeatureBatch());
  assert.equal(result.model.inputDataType, 'int8');
  assert.ok(calls.inferences.every(input => input.values instanceof Float32Array));
  assert.ok(calls.inferences.every(input => input.tensorDataType === 'int8'));
  assert.deepEqual(calls.inferences[0].quantization, spec.input.quantization);
  await engine.dispose();

  const missingQuantization = makeSpec();
  missingQuantization.input.dataType = 'uint8';
  assert.throws(() => validatePredictionModelSpec(missingQuantization), error => error.code === 'MODEL_SPEC_INVALID');
});

test('rejects Component 8 schema, preprocessing, eye identity, missing features, NaN and Infinity before inference', async () => {
  const spec = makeSpec();
  const { adapter, calls } = makeMockAdapter(spec, { decode: raw => fixtureDecoded(raw) });
  const engine = createPredictionEngine({ modelSpec: spec, adapter });
  const good = await makeFeatureBatch();

  const wrongVersion = structuredClone(good);
  wrongVersion.sourcePreprocessingVersion = '9.9.9';
  await assert.rejects(engine.predictBatch(wrongVersion), error => error.code === 'PREPROCESSING_VERSION_MISMATCH');

  const wrongSchema = structuredClone(good);
  wrongSchema.featureSchemaVersion = '2.0.0';
  await assert.rejects(engine.predictBatch(wrongSchema), error => error.code === 'INVALID_INPUT');

  const wrongEye = structuredClone(good);
  wrongEye.captures[0].rightEye.designation = 'OS';
  await assert.rejects(engine.predictBatch(wrongEye), error => error.code === 'INVALID_INPUT');

  const partial = await makeFeatureBatch({ missingOpenness: true });
  const needsOpenness = makeSpec();
  needsOpenness.input.featureOrder = ['eyeWidthFraction', 'eyeOpennessRatio'];
  needsOpenness.input.normalization = { method: 'none' };
  const { adapter: missingAdapter, calls: missingCalls } = makeMockAdapter(needsOpenness, { decode: raw => fixtureDecoded(raw) });
  const missingEngine = createPredictionEngine({ modelSpec: needsOpenness, adapter: missingAdapter });
  await assert.rejects(missingEngine.predictBatch(partial), error => error.code === 'MISSING_FEATURE' && error.details.designation === 'OD');
  assert.equal(missingCalls.inferences.length, 0);
  assert.equal(missingCalls.loads, 0, 'missing selected features are rejected before model loading');

  for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const invalid = structuredClone(good);
    invalid.captures[0].rightEye.features.eyeWidthFraction.value = value;
    await assert.rejects(engine.predictBatch(invalid), error => error.code === 'INVALID_INPUT');
  }
  assert.equal(calls.inferences.length, 0);
  assert.equal(calls.loads, 0, 'malformed Component 8 batches are rejected before model loading');
  await engine.dispose();
  await missingEngine.dispose();
});

test('rejects incompatible runtime adapters and loaded artifact metadata before inference', async () => {
  const spec = makeSpec();
  const { adapter, calls } = makeMockAdapter(spec, { metadata: { ...makeMetadata(spec), modelVersion: 'other-version' }, decode: raw => fixtureDecoded(raw) });
  const engine = createPredictionEngine({ modelSpec: spec, adapter });
  const status = await engine.initialize();
  assert.equal(status.status, 'error');
  assert.equal(status.error.code, 'MODEL_VERSION_MISMATCH');
  assert.equal(calls.inferences.length, 0);
  await assert.rejects(engine.predictBatch(await makeFeatureBatch()), error => error.code === 'MODEL_VERSION_MISMATCH');
  await engine.dispose();

  const remote = makeMockAdapter(spec).adapter;
  remote.local = false;
  const unsupported = createPredictionEngine({ modelSpec: spec, adapter: remote });
  assert.equal((await unsupported.initialize()).error.code, 'UNSUPPORTED_RUNTIME');
  await unsupported.dispose();

  const wrongRuntime = makeMockAdapter(spec).adapter;
  wrongRuntime.runtime = 'unmatched-runtime';
  const runtimeMismatch = createPredictionEngine({ modelSpec: spec, adapter: wrongRuntime });
  assert.equal((await runtimeMismatch.initialize()).error.code, 'UNSUPPORTED_RUNTIME');
  await runtimeMismatch.dispose();
});

test('handles model load failure and retry with one verified session', async () => {
  const spec = makeSpec();
  const { adapter, calls } = makeMockAdapter(spec, {
    failLoad: count => count === 1 ? Promise.reject(new Error('temporary load failure')) : null,
    decode: raw => fixtureDecoded(raw),
  });
  const engine = createPredictionEngine({ modelSpec: spec, adapter });
  const failed = await engine.initialize();
  assert.equal(failed.status, 'error');
  assert.equal(failed.error.code, 'MODEL_LOAD_FAILED');
  const retried = await engine.retry();
  assert.equal(retried.status, 'ready');
  assert.equal(calls.loads, 2);
  await engine.predictBatch(await makeFeatureBatch());
  assert.equal(calls.loads, 2);
  await engine.dispose();
  assert.equal(calls.disposals, 1);
});

test('returns decoded SPH/CYL/Axis only when finite and within declared domains; never clamps', async () => {
  for (const invalidOutput of [
    { sph: Number.NaN, cyl: -.5, axis: 90 },
    { sph: -1, cyl: -.5, axis: 181 },
    { sph: -1, cyl: -.5, axis: 180 },
    { sph: -1, cyl: .1, axis: 90 },
  ]) {
    const spec = makeSpec();
    const { adapter } = makeMockAdapter(spec, { decode: raw => fixtureDecoded(raw, invalidOutput) });
    const engine = createPredictionEngine({ modelSpec: spec, adapter });
    await assert.rejects(engine.predictBatch(await makeFeatureBatch()), error => error.code === 'INVALID_MODEL_OUTPUT');
    await engine.dispose();
  }
  const spec = makeSpec();
  const { adapter } = makeMockAdapter(spec, { decode: raw => fixtureDecoded(raw) });
  const engine = createPredictionEngine({ modelSpec: spec, adapter });
  const result = await engine.predictBatch(await makeFeatureBatch());
  assert.equal(result.captures[0].rightEye.sph, -1.25);
  assert.equal(result.captures[0].rightEye.cyl, -.5);
  assert.equal(result.captures[0].rightEye.axis, 90);
  assert.equal(result.captures[0].rightEye.units.axis, 'deg');
  await engine.dispose();
});

test('preserves declared confidence and uncertainty, and reports them unavailable when absent', async () => {
  const plainSpec = makeSpec();
  const plain = makeMockAdapter(plainSpec, { decode: raw => fixtureDecoded(raw) });
  const plainEngine = createPredictionEngine({ modelSpec: plainSpec, adapter: plain.adapter });
  const without = await plainEngine.predictBatch(await makeFeatureBatch());
  assert.deepEqual(without.captures[0].rightEye.confidence, { value: null, status: 'UNAVAILABLE', reason: 'The model does not declare a confidence output.' });
  assert.equal(without.captures[0].rightEye.uncertainty.status, 'UNAVAILABLE');
  await plainEngine.dispose();

  const confidenceSpec = { kind: 'probability', min: 0, max: 1, minInclusive: true, maxInclusive: true };
  const spec = makeSpec({ confidence: confidenceSpec, uncertainty: { format: 'fixture-interval' } });
  const adapter = makeMockAdapter(spec, {
    decode: raw => fixtureDecoded(raw, { confidence: .87, uncertainty: { interval: [-1.5, -.5], unit: 'fixture' } }),
  });
  const engine = createPredictionEngine({ modelSpec: spec, adapter: adapter.adapter });
  const result = await engine.predictBatch(await makeFeatureBatch());
  assert.deepEqual(result.captures[0].leftEye.confidence, { value: .87, status: 'AVAILABLE', kind: 'probability' });
  assert.deepEqual(result.captures[0].leftEye.uncertainty, { value: { interval: [-1.5, -.5], unit: 'fixture' }, status: 'AVAILABLE', format: 'fixture-interval' });
  await engine.dispose();

  const invalidConfidenceSpec = makeSpec({ confidence: confidenceSpec });
  const invalidConfidenceAdapter = makeMockAdapter(invalidConfidenceSpec, { decode: raw => fixtureDecoded(raw, { confidence: 1.5 }) });
  const invalidConfidenceEngine = createPredictionEngine({ modelSpec: invalidConfidenceSpec, adapter: invalidConfidenceAdapter.adapter });
  await assert.rejects(invalidConfidenceEngine.predictBatch(await makeFeatureBatch()), error => error.code === 'INVALID_MODEL_OUTPUT');
  await invalidConfidenceEngine.dispose();
});

test('detects eye swaps, runtime inference failures, invalid uncertainty, and memory errors', async () => {
  const spec = makeSpec();
  const swapped = makeMockAdapter(spec, { decode: () => ({
    OD: { eye: 'left', designation: 'OS', sph: -1, cyl: -.5, axis: 90 },
    OS: { eye: 'right', designation: 'OD', sph: -1, cyl: -.5, axis: 90 },
  }) });
  const swappedEngine = createPredictionEngine({ modelSpec: spec, adapter: swapped.adapter });
  await assert.rejects(swappedEngine.predictBatch(await makeFeatureBatch()), error => error.code === 'INVALID_MODEL_OUTPUT');
  await swappedEngine.dispose();

  const failed = makeMockAdapter(spec, { failInfer: () => Promise.reject(new Error('inference fixture failed')) });
  const failedEngine = createPredictionEngine({ modelSpec: spec, adapter: failed.adapter });
  await assert.rejects(failedEngine.predictBatch(await makeFeatureBatch()), error => error.code === 'INFERENCE_FAILED');
  await failedEngine.dispose();

  const memory = makeMockAdapter(spec, { failInfer: () => Promise.reject(new Error('out of memory')) });
  const memoryEngine = createPredictionEngine({ modelSpec: spec, adapter: memory.adapter });
  await assert.rejects(memoryEngine.predictBatch(await makeFeatureBatch()), error => error.code === 'RUNTIME_MEMORY_ERROR');
  assert.equal((await memoryEngine.retry({ reinitialize: true })).status, 'ready');
  assert.equal(memory.calls.loads, 2);
  assert.equal(memory.calls.disposals, 1);
  await memoryEngine.dispose();
  assert.equal(memory.calls.disposals, 2);

  const uncertaintySpec = makeSpec({ uncertainty: { format: 'fixture' } });
  const invalidUncertainty = makeMockAdapter(uncertaintySpec, { decode: raw => fixtureDecoded(raw, { uncertainty: { variance: Number.POSITIVE_INFINITY } }) });
  const uncertaintyEngine = createPredictionEngine({ modelSpec: uncertaintySpec, adapter: invalidUncertainty.adapter });
  await assert.rejects(uncertaintyEngine.predictBatch(await makeFeatureBatch()), error => error.code === 'INVALID_MODEL_OUTPUT');
  await uncertaintyEngine.dispose();
});

test('deduplicates concurrent and repeated inference for the same feature-batch object', async () => {
  const spec = makeSpec();
  const { adapter, calls } = makeMockAdapter(spec, { decode: raw => fixtureDecoded(raw) });
  const engine = createPredictionEngine({ modelSpec: spec, adapter });
  const batch = await makeFeatureBatch();
  const [first, concurrent] = await Promise.all([engine.predictBatch(batch), engine.predictBatch(batch)]);
  assert.equal(first, concurrent);
  const repeated = await engine.predictBatch(batch);
  assert.equal(repeated, first);
  assert.equal(calls.inferences.length, 2);
  assert.equal(calls.loads, 1);
  await engine.dispose();
});

test('engine disposal aborts in-flight inference and releases the model only after the runtime settles', async () => {
  const spec = makeSpec();
  const { adapter, calls } = makeMockAdapter(spec, { decode: raw => fixtureDecoded(raw) });
  adapter.infer = (_session, input, { signal }) => {
    calls.inferences.push(input);
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('adapter observed cancellation')), { once: true });
    });
  };
  const engine = createPredictionEngine({ modelSpec: spec, adapter });
  const pending = engine.predictBatch(await makeFeatureBatch());
  for (let i = 0; i < 12 && calls.inferences.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls.inferences.length, 1);
  await engine.dispose();
  await assert.rejects(pending, error => error.code === 'INFERENCE_CANCELLED');
  assert.equal(calls.disposals, 1);
  assert.equal(engine.getSnapshot().status, 'disposed');
});

test('engine disposal cancels a pending local model load before it becomes ready', async () => {
  const spec = makeSpec();
  const { adapter, calls } = makeMockAdapter(spec);
  adapter.load = (_modelSpec, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('loader observed cancellation')), { once: true });
  });
  const engine = createPredictionEngine({ modelSpec: spec, adapter });
  const loading = engine.initialize();
  await new Promise(resolve => setTimeout(resolve, 0));
  await engine.dispose();
  const state = await loading;
  assert.equal(state.status, 'disposed');
  assert.equal(state.error.code, 'MODEL_LOAD_CANCELLED');
  assert.equal(calls.disposals, 0);
});

test('prediction step offers retry for a transient inference failure and then emits one complete result', async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousCustomEvent = globalThis.CustomEvent;
  class FakeNode {
    constructor() {
      this.listeners = new Map(); this.textContent = ''; this.innerHTML = ''; this.children = [];
      this.classList = { add() {}, remove() {}, toggle() {} };
    }
    addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list); }
    removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(value => value !== fn)); }
    dispatchEvent(event) { for (const listener of this.listeners.get(event.type) || []) listener(event); return true; }
    replaceChildren(...nodes) { this.children = nodes; }
  }
  const selectors = ['#prediction-heading', '#prediction-detail', '#prediction-summary', '#prediction-error', '#prediction-retry', '#prediction-stop'];
  const nodes = new Map(selectors.map(selector => [selector, new FakeNode()]));
  const root = new FakeNode(); root.querySelector = selector => nodes.get(selector); root.events = [];
  root.dispatchEvent = event => { root.events.push(event); return true; };
  globalThis.document = { createElement: () => new FakeNode() };
  globalThis.window = new FakeNode();
  globalThis.CustomEvent = class extends Event { constructor(type, init = {}) { super(type, init); this.detail = init.detail; } };
  const spec = makeSpec();
  const { adapter, calls } = makeMockAdapter(spec, {
    failInfer: (_input, index) => { if (index === 1) throw new Error('temporary runtime failure'); },
    decode: raw => fixtureDecoded(raw),
  });
  const engine = createPredictionEngine({ modelSpec: spec, adapter });
  try {
    const cleanup = mountPredictionStep(root, { featureBatch: await makeFeatureBatch() }, { engine });
    for (let i = 0; i < 12 && !root.events.some(event => event.type === 'eye-prediction-error'); i++) await new Promise(resolve => setTimeout(resolve, 0));
    const failed = root.events.find(event => event.type === 'eye-prediction-error');
    assert.ok(failed);
    assert.equal(failed.detail.retryable, true);
    await new Promise(resolve => setTimeout(resolve, 0));
    nodes.get('#prediction-retry').dispatchEvent(new Event('click'));
    for (let i = 0; i < 12 && !root.events.some(event => event.type === 'eye-prediction-complete'); i++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(root.events.some(event => event.type === 'eye-prediction-complete'), root.events.map(event => `${event.type}:${event.detail?.error?.code || ''}`).join(', '));
    assert.equal(calls.loads, 1, 'retry reuses the compatible initialized model session');
    assert.equal(calls.inferences.length, 3, 'the first right-eye inference failed; retry ran both eyes');
    await cleanup();
  } finally {
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousCustomEvent === undefined) delete globalThis.CustomEvent; else globalThis.CustomEvent = previousCustomEvent;
  }
});

test('Component 8 completion integrates into the Component 9 UI as unavailable without a model', async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousCustomEvent = globalThis.CustomEvent;
  class FakeNode {
    constructor() {
      this.listeners = new Map(); this.textContent = ''; this.innerHTML = ''; this.children = [];
      this.classList = { add() {}, remove() {}, toggle() {} };
    }
    addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list); }
    removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(value => value !== fn)); }
    dispatchEvent(event) { for (const listener of this.listeners.get(event.type) || []) listener(event); return true; }
    replaceChildren(...nodes) { this.children = nodes; }
  }
  const selectors = ['#prediction-heading', '#prediction-detail', '#prediction-summary', '#prediction-error', '#prediction-retry', '#prediction-stop'];
  const nodes = new Map(selectors.map(selector => [selector, new FakeNode()]));
  const root = new FakeNode(); root.querySelector = selector => nodes.get(selector); root.events = [];
  root.dispatchEvent = event => { root.events.push(event); return true; };
  globalThis.document = { createElement: () => new FakeNode() };
  globalThis.window = new FakeNode();
  globalThis.CustomEvent = class extends Event { constructor(type, init = {}) { super(type, init); this.detail = init.detail; } };
  try {
    const cleanup = mountPredictionStep(root, { featureBatch: await makeFeatureBatch() });
    for (let i = 0; i < 12 && !root.events.some(event => event.type === 'eye-prediction-unavailable'); i++) await new Promise(resolve => setTimeout(resolve, 0));
    const unavailable = root.events.find(event => event.type === 'eye-prediction-unavailable');
    assert.ok(unavailable);
    assert.equal(unavailable.detail.error.code, 'MODEL_NOT_CONFIGURED');
    assert.equal(unavailable.detail.retryable, false);
    assert.equal(unavailable.detail.modelReady, false);
    assert.equal(unavailable.detail.valid, false);
    assert.equal(unavailable.detail.inputValidity.valid, true, 'the valid C8 batch is distinct from unavailable model/output validity');
    assert.equal(root.events.some(event => event.type === 'eye-prediction-complete'), false);
    assert.match(nodes.get('#prediction-detail').textContent, /No SPH, CYL, Axis/);
    await cleanup();
  } finally {
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousCustomEvent === undefined) delete globalThis.CustomEvent; else globalThis.CustomEvent = previousCustomEvent;
  }
});
