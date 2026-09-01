import assert from "node:assert/strict";
import test from "node:test";
import { pollPhaseForVoiceStatus, type VoiceStatusResponse } from "../src/hooks/useVoiceInput";

function status(overrides: Partial<VoiceStatusResponse> = {}): VoiceStatusResponse {
  return {
    engineAvailable: true,
    engineInstaller: { status: "ready", supported: true, name: "whisper.cpp", bytesDownloaded: 1, totalBytes: 1, error: null },
    model: { status: "not_downloaded", bytesDownloaded: 0, totalBytes: 10, error: null, name: "Whisper medium", fileName: "ggml-medium.bin" },
    ...overrides,
  };
}

test("model download takes priority over the ready engine", () => {
  const current = status({
    model: { status: "downloading", bytesDownloaded: 5, totalBytes: 10, error: null, name: "Whisper medium", fileName: "ggml-medium.bin" },
  });

  assert.equal(pollPhaseForVoiceStatus(current), "downloading");
});

test("voice polling maps each terminal and active download state", () => {
  assert.equal(pollPhaseForVoiceStatus(status({ engineInstaller: { status: "downloading", supported: true, name: "whisper.cpp", bytesDownloaded: 1, totalBytes: 2, error: null } })), "installing-engine");
  assert.equal(pollPhaseForVoiceStatus(status({ model: { status: "ready", bytesDownloaded: 10, totalBytes: 10, error: null, name: "Whisper medium", fileName: "ggml-medium.bin" } })), "idle");
  assert.equal(pollPhaseForVoiceStatus(status({ model: { status: "failed", bytesDownloaded: 0, totalBytes: 10, error: "checksum", name: "Whisper medium", fileName: "ggml-medium.bin" } })), "error");
  assert.equal(pollPhaseForVoiceStatus(status()), "confirm-download");
});
