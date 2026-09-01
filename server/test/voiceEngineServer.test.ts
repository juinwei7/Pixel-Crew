import assert from "node:assert/strict";
import test from "node:test";
import { VoiceEngineServer } from "../src/voice/voiceEngineServer.js";

test("reports unavailable when no whisper-server binary was resolved", async () => {
  const engine = new VoiceEngineServer(null, 8793, () => "/dev/null");
  assert.equal(engine.available, false);
  await assert.rejects(() => engine.ensureStarted(), /找不到本機語音轉寫引擎/);
});

test("exposes a loopback-only base URL for the configured port", () => {
  const engine = new VoiceEngineServer("whisper-server", 8793, () => "/dev/null");
  assert.equal(engine.baseUrl, "http://127.0.0.1:8793");
});

test("becomes available when a verified local installer supplies whisper-server", () => {
  const engine = new VoiceEngineServer(null, 8793, () => "/dev/null");
  engine.setExecutable("C:\\Users\\test\\AppData\\Local\\Pixel Crew\\voice-engines\\whisper-cpp\\whisper-server.exe");
  assert.equal(engine.available, true);
});
