import { createHash } from "node:crypto";
import { createWriteStream, existsSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDirectorySync, protectFileSync } from "../platform/fileProtection.js";
import { t } from "../i18n.js";

// 選擇依據：見 LOCAL-VOICE-INPUT-SPEC.md §10 本機驗證記錄——`small`（465MB，符合原訂
// 0.5–1GB 目標）會把「Claude」「Codex」聽成別的詞，這兩個詞是本產品的核心操作對象，
// 錯誤不可接受；`medium` 加上 initial_prompt 才能穩定聽對。因此改用 `medium`，超出原預算，
// 已在 spec 記錄取捨，不是隨手放大。
export const VOICE_MODEL_FILENAME = "ggml-medium.bin";
export const VOICE_MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin";
// 2026-09-01 下載後以 `shasum -a 256` 實測核對，與 Hugging Face 回應的 x-linked-etag 一致。
export const VOICE_MODEL_SHA256 = "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208";
export const VOICE_MODEL_EXPECTED_BYTES = 1_533_763_059;

export type VoiceModelStatus = "not_downloaded" | "downloading" | "ready" | "failed";

export type VoiceModelState = {
  status: VoiceModelStatus;
  bytesDownloaded: number;
  totalBytes: number;
  error: string | null;
};

type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array> | null;
}>;

export class VoiceModelManager {
  private state: VoiceModelState;
  private readonly finalPath: string;
  private readonly tmpPath: string;

  constructor(
    modelsDir: string,
    private readonly fetcher: FetchLike = fetch as unknown as FetchLike,
    private readonly expectedSha256: string = VOICE_MODEL_SHA256,
  ) {
    ensurePrivateDirectorySync(modelsDir);
    this.finalPath = join(modelsDir, VOICE_MODEL_FILENAME);
    this.tmpPath = join(modelsDir, `.${VOICE_MODEL_FILENAME}.downloading`);
    // 上一輪下載到一半就被中斷（例如服務重啟）留下的暫存檔，絕不能被當成可用模型。
    if (existsSync(this.tmpPath)) {
      try { unlinkSync(this.tmpPath); } catch { /* 盡力清除即可 */ }
    }
    this.state = existsSync(this.finalPath)
      ? { status: "ready", bytesDownloaded: VOICE_MODEL_EXPECTED_BYTES, totalBytes: VOICE_MODEL_EXPECTED_BYTES, error: null }
      : { status: "not_downloaded", bytesDownloaded: 0, totalBytes: VOICE_MODEL_EXPECTED_BYTES, error: null };
  }

  get modelPath(): string {
    return this.finalPath;
  }

  getState(): VoiceModelState {
    return this.state;
  }

  start(): VoiceModelState {
    if (this.state.status === "downloading" || this.state.status === "ready") return this.state;
    this.state = { status: "downloading", bytesDownloaded: 0, totalBytes: VOICE_MODEL_EXPECTED_BYTES, error: null };
    void this.run();
    return this.state;
  }

  private async run(): Promise<void> {
    try {
      const response = await this.fetcher(VOICE_MODEL_URL);
      if (!response.ok || !response.body) {
        throw new Error(t("模型下載連線失敗（HTTP {status}）", { status: response.status }));
      }
      const totalBytes = Number(response.headers.get("content-length")) || VOICE_MODEL_EXPECTED_BYTES;
      const hash = createHash("sha256");
      let bytesDownloaded = 0;
      const file = createWriteStream(this.tmpPath, { mode: 0o600 });
      for await (const chunk of response.body) {
        hash.update(chunk);
        bytesDownloaded += chunk.length;
        this.state = { status: "downloading", bytesDownloaded, totalBytes, error: null };
        await new Promise<void>((resolve, reject) => {
          file.write(chunk, (error) => (error ? reject(error) : resolve()));
        });
      }
      await new Promise<void>((resolve, reject) => {
        file.close((error) => (error ? reject(error) : resolve()));
      });
      const digest = hash.digest("hex");
      if (digest !== this.expectedSha256) {
        throw new Error(t("模型檔完整性驗證失敗，已刪除不完整檔案"));
      }
      renameSync(this.tmpPath, this.finalPath);
      protectFileSync(this.finalPath);
      this.state = { status: "ready", bytesDownloaded, totalBytes, error: null };
    } catch (error) {
      try { if (existsSync(this.tmpPath)) unlinkSync(this.tmpPath); } catch { /* 盡力清除即可 */ }
      this.state = {
        status: "failed",
        bytesDownloaded: 0,
        totalBytes: VOICE_MODEL_EXPECTED_BYTES,
        error: (error as Error).message || t("模型下載失敗"),
      };
    }
  }
}
