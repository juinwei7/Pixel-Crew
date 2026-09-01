import fs from "node:fs";
import path from "node:path";

/** 全域功能開關（⚙ 功能選單）。檔案存 {dataDir}/app-settings.json，
 *  跟 workerExtras 一樣走檔案式 JSON，不動資料庫 schema。 */
export interface AppSettings {
  /** CTX 高水位自動換腦（brainSwapHook） */
  brainSwapEnabled: boolean;
  /** 撞訂閱用量上限後，重置時刻一到自動叫 NPC 繼續（limitResumeHook） */
  limitResumeEnabled: boolean;
  /** 僅留在本機的產品品質／效能診斷；可隨時關閉，不會自動上傳。 */
  diagnosticsEnabled: boolean;
  /** server 端訊息語言（web 🌐 切換時同步過來；瀏覽器 UI 語言仍以 localStorage 為準） */
  lang: "zh" | "en";
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  brainSwapEnabled: true,
  limitResumeEnabled: true,
  diagnosticsEnabled: true,
  lang: "zh",
};

export function normalizeAppSettings(raw: unknown): AppSettings {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    brainSwapEnabled: typeof source.brainSwapEnabled === "boolean" ? source.brainSwapEnabled : DEFAULT_APP_SETTINGS.brainSwapEnabled,
    limitResumeEnabled: typeof source.limitResumeEnabled === "boolean" ? source.limitResumeEnabled : DEFAULT_APP_SETTINGS.limitResumeEnabled,
    diagnosticsEnabled: typeof source.diagnosticsEnabled === "boolean" ? source.diagnosticsEnabled : DEFAULT_APP_SETTINGS.diagnosticsEnabled,
    lang: source.lang === "en" ? "en" : DEFAULT_APP_SETTINGS.lang,
  };
}

export class AppSettingsStore {
  private readonly file: string;
  private settings: AppSettings;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "app-settings.json");
    let raw: unknown = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      // 檔案不存在或壞掉 → 用預設值，第一次 update 時會重寫
    }
    this.settings = normalizeAppSettings(raw);
  }

  get(): AppSettings {
    return { ...this.settings };
  }

  update(patch: Partial<AppSettings>): AppSettings {
    this.settings = normalizeAppSettings({ ...this.settings, ...patch });
    fs.writeFileSync(this.file, JSON.stringify(this.settings, null, 2));
    return this.get();
  }
}
