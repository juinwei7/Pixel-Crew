import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceEngineInstaller, powerShellExtractionCommand, type VoiceEngineRelease } from "../src/voice/voiceEngineInstaller.js";

function tmpEnginesDir(): string {
  return mkdtempSync(join(tmpdir(), "voice-engine-installer-test-"));
}

function releaseFor(bytes: Buffer): VoiceEngineRelease {
  return {
    name: "whisper.cpp test",
    url: "https://github.com/ggml-org/whisper.cpp/releases/download/test/whisper-bin-x64.zip",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    executable: "Release/whisper-server.exe",
  };
}

function response(bytes: Buffer, advertisedSize = bytes.length) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => name.toLowerCase() === "content-length" ? String(advertisedSize) : null },
    body: (async function* () { yield bytes; })(),
  };
}

async function waitForDone(installer: VoiceEngineInstaller): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (installer.getInfo().status !== "downloading") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("installer did not finish");
}

test("Windows x64 installer verifies, extracts, and activates whisper-server without changing PATH", async () => {
  const dir = tmpEnginesDir();
  const bytes = Buffer.from("verified-whisper-release");
  let installed = "";
  const installer = new VoiceEngineInstaller(
    dir,
    (path) => { installed = path; },
    async () => response(bytes),
    async (_archive, destination) => {
      mkdirSync(join(destination, "Release"));
      writeFileSync(join(destination, "Release", "whisper-server.exe"), "binary");
    },
    "win32", "x64", releaseFor(bytes),
  );

  assert.equal(installer.getInfo().status, "not_installed");
  assert.equal(installer.start().status, "downloading");
  await waitForDone(installer);

  assert.equal(installer.getInfo().status, "ready");
  assert.equal(installed, join(dir, "whisper-cpp", "Release", "whisper-server.exe"));
  assert.ok(existsSync(installed));
  assert.deepEqual(readdirSync(dir), ["whisper-cpp"]);
  rmSync(dir, { recursive: true, force: true });
});

test("PowerShell extraction command preserves paths containing spaces and apostrophes", () => {
  const command = Buffer.from(
    powerShellExtractionCommand("C:\\Users\\Jane O'Connor\\engine.zip", "C:\\Users\\Jane O'Connor\\staging"),
    "base64",
  ).toString("utf16le");
  assert.match(command, /\$ErrorActionPreference = 'Stop'/);
  assert.match(command, /C:\\Users\\Jane O''Connor\\engine\.zip/);
  assert.match(command, /C:\\Users\\Jane O''Connor\\staging/);
  assert.doesNotMatch(command, /\$args/);
});

test("rejects a tampered engine archive and removes all temporary files", async () => {
  const dir = tmpEnginesDir();
  const expected = Buffer.from("official-release");
  const installer = new VoiceEngineInstaller(
    dir, () => { assert.fail("tampered archive must not activate an engine"); },
    async () => response(Buffer.from("tampered"), expected.length),
    async () => { assert.fail("tampered archive must not be extracted"); },
    "win32", "x64", releaseFor(expected),
  );

  installer.start();
  await waitForDone(installer);
  assert.equal(installer.getInfo().status, "failed");
  assert.match(installer.getInfo().error ?? "", /完整性驗證失敗/);
  assert.deepEqual(readdirSync(dir), []);
  rmSync(dir, { recursive: true, force: true });
});

test("does not offer automatic engine installation outside Windows x64", () => {
  const dir = tmpEnginesDir();
  const installer = new VoiceEngineInstaller(dir, () => {}, async () => response(Buffer.alloc(0)), async () => {}, "darwin", "arm64", releaseFor(Buffer.alloc(0)));
  assert.deepEqual(installer.getInfo(), {
    status: "not_supported", supported: false, name: "whisper.cpp test", bytesDownloaded: 0, totalBytes: 0, error: null,
  });
  rmSync(dir, { recursive: true, force: true });
});
