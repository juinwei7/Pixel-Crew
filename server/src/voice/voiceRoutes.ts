import type { Express } from "express";
import multer from "multer";
import { VoiceEngineBusyError, VoiceEngineUnavailableError, VoiceTranscriber, VoiceTranscriptionError } from "./voiceTranscribe.js";
import { VoiceModelManager } from "./voiceModel.js";
import { VoiceEngineInstaller } from "./voiceEngineInstaller.js";
import { t } from "../i18n.js";

// 30 秒、16kHz、16-bit、單聲道 WAV ≈ 0.96 MB；留邊界給稍長的錄音與 WAV 標頭。
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

function matchesWavSignature(data: Buffer): boolean {
  return data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WAVE";
}

export function registerVoiceRoutes(input: {
  app: Express;
  modelManager: VoiceModelManager;
  transcriber: VoiceTranscriber;
  engineInstaller: VoiceEngineInstaller;
}): void {
  const { app, modelManager, transcriber, engineInstaller } = input;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AUDIO_BYTES } });

  app.get("/api/voice/status", (_req, res) => {
    res.json({ engineAvailable: transcriber.engineAvailable, engineInstaller: engineInstaller.getInfo(), model: modelManager.getInfo() });
  });

  app.post("/api/voice/engine/install", (_req, res) => {
    if (!engineInstaller.supported) { res.status(409).json({ error: t("此裝置不支援自動安裝語音轉寫引擎") }); return; }
    res.json({ engineInstaller: engineInstaller.start() });
  });

  app.post("/api/voice/model/download", (_req, res) => {
    modelManager.start();
    res.json({ model: modelManager.getInfo() });
  });

  app.post("/api/voice/transcribe", upload.single("audio"), async (req, res) => {
    if (!transcriber.engineAvailable) {
      res.status(503).json({ error: t("找不到本機語音轉寫引擎") });
      return;
    }
    if (modelManager.getState().status !== "ready") {
      res.status(409).json({ error: t("語音模型尚未下載完成") });
      return;
    }
    if (!req.file || !matchesWavSignature(req.file.buffer)) {
      res.status(400).json({ error: t("錄音資料格式不正確") });
      return;
    }
    try {
      const text = await transcriber.transcribe(req.file.buffer);
      if (!text) {
        res.status(422).json({ error: t("沒有偵測到語音，可重試") });
        return;
      }
      res.json({ text });
    } catch (error) {
      if (error instanceof VoiceEngineBusyError) {
        res.status(409).json({ error: error.message });
        return;
      }
      if (error instanceof VoiceEngineUnavailableError) {
        res.status(503).json({ error: error.message });
        return;
      }
      if (error instanceof VoiceTranscriptionError) {
        res.status(500).json({ error: error.message });
        return;
      }
      res.status(500).json({ error: t("語音轉寫失敗，請重試") });
    }
  });
}
