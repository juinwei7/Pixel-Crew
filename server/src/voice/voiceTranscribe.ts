import { Converter } from "opencc-js";
import { resolveExecutable } from "../platform/processes.js";
import type { VoiceEngine } from "./voiceEngineServer.js";
import { t } from "../i18n.js";

// 固定領域詞彙提示：見 LOCAL-VOICE-INPUT-SPEC.md §10——沒有提示時 whisper 常把
// 「Claude」聽成 clock/Cloud、「Codex」聽成 call dex；帶這段提示後兩者穩定聽對，
// 也附帶讓輸出腳本穩定變成繁體（即便如此，下面仍跑一次 OpenCC 正規化，不依賴這個副作用）。
export const VOICE_DOMAIN_PROMPT =
  "以下是關於 Pixel Crew、Claude Code、Codex、pull request、review comment、race condition、" +
  "WebSocket、npm run check、commit message 的技術對話。";

const WHISPER_SERVER_CANDIDATES = ["whisper-server"];
const s2twp = Converter({ from: "cn", to: "twp" });

export class VoiceEngineUnavailableError extends Error {}
export class VoiceEngineBusyError extends Error {}
export class VoiceTranscriptionError extends Error {}

export function resolveWhisperBinary(
  candidates: string[] = WHISPER_SERVER_CANDIDATES,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  for (const candidate of candidates) {
    const resolved = resolveExecutable(candidate, platform, env);
    if (resolved !== candidate) return resolved;
  }
  return null;
}

export function normalizeToTraditional(text: string): string {
  return s2twp(text);
}

type FetchLike = typeof fetch;

export class VoiceTranscriber {
  private busy = false;

  constructor(
    private readonly engine: VoiceEngine,
    private readonly fetcher: FetchLike = fetch,
    private readonly requestTimeoutMs = 15_000,
  ) {}

  get engineAvailable(): boolean {
    return this.engine.available;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  async transcribe(wavBuffer: Buffer): Promise<string> {
    if (!this.engine.available) throw new VoiceEngineUnavailableError(t("找不到本機語音轉寫引擎"));
    if (this.busy) throw new VoiceEngineBusyError(t("目前已有語音轉寫在處理中，請稍候"));
    this.busy = true;
    try {
      await this.engine.ensureStarted();
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(wavBuffer)], { type: "audio/wav" }), "recording.wav");
      form.append("language", "zh");
      form.append("prompt", VOICE_DOMAIN_PROMPT);
      form.append("response_format", "text");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      let response: Response;
      try {
        response = await this.fetcher(`${this.engine.baseUrl}/inference`, {
          method: "POST",
          body: form,
          signal: controller.signal,
        });
      } catch (error) {
        throw new VoiceTranscriptionError((error as Error).message || t("語音轉寫失敗"));
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) throw new VoiceTranscriptionError(t("語音轉寫失敗（引擎回應 {status}）", { status: response.status }));
      const raw = (await response.text()).trim();
      return normalizeToTraditional(raw);
    } finally {
      this.busy = false;
    }
  }
}
