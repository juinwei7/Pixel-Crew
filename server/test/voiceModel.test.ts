import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceModelManager, type VoiceModelState } from "../src/voice/voiceModel.js";

// start() resolves the actual download on a detached promise, so tests must
// poll rather than sleep a fixed guess — a fixed sleep is flaky under CI load.
async function waitUntilSettled(manager: VoiceModelManager, timeoutMs = 2000): Promise<VoiceModelState> {
  const deadline = Date.now() + timeoutMs;
  while (manager.getState().status === "downloading" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return manager.getState();
}

function fakeResponse(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    body: (async function* () { for (const chunk of chunks) yield chunk; })(),
  };
}

function tmpModelsDir(): string {
  return mkdtempSync(join(tmpdir(), "voice-model-test-"));
}

test("downloads, verifies checksum, and marks the model ready", async () => {
  const dir = tmpModelsDir();
  const bytes = Buffer.from("pretend-model-bytes");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const manager = new VoiceModelManager(dir, async () => fakeResponse([bytes]), sha256);

  const started = manager.start();
  assert.equal(started.status, "downloading");
  const state = await waitUntilSettled(manager);
  assert.equal(state.status, "ready");
  assert.equal(state.bytesDownloaded, bytes.length);
  assert.ok(existsSync(manager.modelPath));
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith(".")), []);
  rmSync(dir, { recursive: true, force: true });
});

test("rejects a checksum mismatch and leaves no partial file behind", async () => {
  const dir = tmpModelsDir();
  const bytes = Buffer.from("tampered-bytes");
  const manager = new VoiceModelManager(dir, async () => fakeResponse([bytes]), "0".repeat(64));

  manager.start();
  const state = await waitUntilSettled(manager);
  assert.equal(state.status, "failed");
  assert.match(state.error ?? "", /完整性驗證失敗/);
  assert.equal(existsSync(manager.modelPath), false);
  assert.deepEqual(readdirSync(dir), []);
  rmSync(dir, { recursive: true, force: true });
});

test("reports a failed download without leaving a partial file", async () => {
  const dir = tmpModelsDir();
  const manager = new VoiceModelManager(dir, async () => { throw new Error("network unavailable"); }, "irrelevant");

  manager.start();
  const state = await waitUntilSettled(manager);
  assert.equal(state.status, "failed");
  assert.match(state.error ?? "", /network unavailable/);
  assert.deepEqual(readdirSync(dir), []);
  rmSync(dir, { recursive: true, force: true });
});

test("does not start a second download while one is already running or ready", async () => {
  const dir = tmpModelsDir();
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const manager = new VoiceModelManager(dir, async () => {
    calls++;
    await blocked;
    return fakeResponse([Buffer.from("x")]);
  }, createHash("sha256").update("x").digest("hex"));

  manager.start();
  manager.start();
  assert.equal(calls, 1);
  release();
  await waitUntilSettled(manager);
  manager.start();
  assert.equal(calls, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("treats a leftover partial download from a previous run as unusable", () => {
  const dir = tmpModelsDir();
  writeFileSync(join(dir, ".ggml-medium.bin.downloading"), "half-downloaded");
  const manager = new VoiceModelManager(dir, async () => fakeResponse([]));

  assert.equal(manager.getState().status, "not_downloaded");
  assert.deepEqual(readdirSync(dir), []);
  rmSync(dir, { recursive: true, force: true });
});

test("exposes stable model metadata for the first-download UI", () => {
  const dir = tmpModelsDir();
  const manager = new VoiceModelManager(dir, async () => fakeResponse([]));

  assert.deepEqual(manager.getInfo(), {
    status: "not_downloaded",
    bytesDownloaded: 0,
    totalBytes: 1_533_763_059,
    error: null,
    name: "Whisper medium",
    fileName: "ggml-medium.bin",
  });
  rmSync(dir, { recursive: true, force: true });
});
