import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VoiceEngineBusyError,
  VoiceEngineUnavailableError,
  VoiceTranscriber,
  VoiceTranscriptionError,
  normalizeToTraditional,
  resolveWhisperBinary,
} from "../src/voice/voiceTranscribe.js";
import type { VoiceEngine } from "../src/voice/voiceEngineServer.js";

test("normalizeToTraditional converts simplified characters to Taiwan-standard traditional", () => {
  assert.equal(normalizeToTraditional("确认没有regression"), "確認沒有regression");
});

test("resolveWhisperBinary finds a binary on PATH and returns null otherwise", () => {
  const dir = mkdtempSync(join(tmpdir(), "whisper-bin-test-"));
  const binPath = join(dir, "whisper-server");
  writeFileSync(binPath, "#!/bin/sh\n");
  chmodSync(binPath, 0o755);

  const found = resolveWhisperBinary(["whisper-server"], "darwin", { PATH: dir });
  assert.equal(found, binPath);

  const missing = resolveWhisperBinary(["whisper-server"], "darwin", { PATH: "" });
  assert.equal(missing, null);
});

function fakeEngine(overrides: Partial<VoiceEngine> = {}): VoiceEngine {
  return {
    available: true,
    baseUrl: "http://127.0.0.1:8793",
    ensureStarted: async () => {},
    ...overrides,
  };
}

test("rejects transcription when the engine binary is unavailable", async () => {
  const transcriber = new VoiceTranscriber(fakeEngine({ available: false }));
  await assert.rejects(() => transcriber.transcribe(Buffer.from("wav")), VoiceEngineUnavailableError);
});

test("rejects a second concurrent transcription instead of queueing it", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const fetcher = (async () => {
    await blocked;
    return new Response("你好", { status: 200 });
  }) as typeof fetch;
  const transcriber = new VoiceTranscriber(fakeEngine(), fetcher);

  const first = transcriber.transcribe(Buffer.from("wav"));
  await assert.rejects(() => transcriber.transcribe(Buffer.from("wav")), VoiceEngineBusyError);
  release();
  assert.equal(await first, "你好");
});

test("surfaces a clear error when the engine responds with a failure status", async () => {
  const fetcher = (async () => new Response("boom", { status: 500 })) as typeof fetch;
  const transcriber = new VoiceTranscriber(fakeEngine(), fetcher);
  await assert.rejects(() => transcriber.transcribe(Buffer.from("wav")), VoiceTranscriptionError);
});

test("normalizes the engine's transcript to traditional Chinese before returning it", async () => {
  const fetcher = (async () => new Response("这是测试")) as typeof fetch;
  const transcriber = new VoiceTranscriber(fakeEngine(), fetcher);
  assert.equal(await transcriber.transcribe(Buffer.from("wav")), "這是測試");
});
