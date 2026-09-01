import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_SPEECH_RMS,
  VOICE_TARGET_SAMPLE_RATE,
  computeRms,
  encodeWavPcm16,
  hasAudibleSpeech,
  linearResample,
  mixToMono,
  resampleToMono16k,
} from "../src/voiceRecording";

test("mixToMono averages stereo channels and passes mono through untouched", () => {
  const mono = new Float32Array([0.5, -0.5]);
  assert.deepEqual(mixToMono([mono]), mono);

  const left = new Float32Array([1, 0]);
  const right = new Float32Array([0, 1]);
  assert.deepEqual(Array.from(mixToMono([left, right])), [0.5, 0.5]);
});

test("linearResample preserves values at matching rates and halves length when downsampling by 2x", () => {
  const samples = new Float32Array([0, 1, 2, 3]);
  assert.deepEqual(linearResample(samples, 16_000, 16_000), samples);
  const resampled = linearResample(samples, 32_000, 16_000);
  assert.equal(resampled.length, 2);
});

test("resampleToMono16k combines mixdown and resampling", () => {
  const left = new Float32Array([1, 1, 1, 1]);
  const right = new Float32Array([-1, -1, -1, -1]);
  const result = resampleToMono16k([left, right], 32_000);
  assert.equal(result.length, 2);
  for (const value of result) assert.equal(value, 0);
});

test("encodeWavPcm16 produces a valid RIFF/WAVE header sized for the sample data", () => {
  const samples = new Float32Array([0, 1, -1, 0.5]);
  const buffer = encodeWavPcm16(samples, VOICE_TARGET_SAMPLE_RATE);
  const view = new DataView(buffer);
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...Array.from({ length }, (_, i) => view.getUint8(offset + i)));

  assert.equal(ascii(0, 4), "RIFF");
  assert.equal(ascii(8, 4), "WAVE");
  assert.equal(ascii(12, 4), "fmt ");
  assert.equal(view.getUint16(20, true), 1); // PCM
  assert.equal(view.getUint16(22, true), 1); // mono
  assert.equal(view.getUint32(24, true), VOICE_TARGET_SAMPLE_RATE);
  assert.equal(view.getUint16(34, true), 16); // bits per sample
  assert.equal(buffer.byteLength, 44 + samples.length * 2);

  // full-scale positive/negative samples must hit the int16 extremes without wrapping
  assert.equal(view.getInt16(44 + 1 * 2, true), 0x7fff);
  assert.equal(view.getInt16(44 + 2 * 2, true), -0x8000);
});

test("computeRms measures silence as zero and a full-scale tone near its peak amplitude", () => {
  assert.equal(computeRms(new Float32Array(100)), 0);
  const tone = new Float32Array(100).fill(1);
  assert.equal(computeRms(tone), 1);
});

test("hasAudibleSpeech rejects silence and near-silence noise, accepts real speech-level volume", () => {
  assert.equal(hasAudibleSpeech(new Float32Array(1000)), false);
  const tinyNoise = Float32Array.from({ length: 1000 }, () => (Math.random() - 0.5) * 0.001);
  assert.equal(hasAudibleSpeech(tinyNoise), false);
  const speechLike = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 10) * 0.2);
  assert.equal(hasAudibleSpeech(speechLike), true);
  assert.equal(hasAudibleSpeech(new Float32Array([MIN_SPEECH_RMS * 1.5])), true);
  assert.equal(hasAudibleSpeech(new Float32Array([MIN_SPEECH_RMS * 0.5])), false);
});
