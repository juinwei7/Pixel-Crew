// 自動循環（autopilot）開關的重啟持久化 —— 以前只存記憶體，server 一重啟（更新、
// 當機、重開機）開關就歸零，使用者得重新打開。現在存 {dataDir}/autopilot-state.json
// （跟 app-settings 同樣的檔案式 JSON，不動資料庫 schema），開機時還原。
// 安全註記：這個檔案只在 server 端的資料目錄，內容只有開關與步數，沒有任何秘密，
// 也完全不經過瀏覽器（不用 cookie / localStorage）。
import fs from "node:fs";
import path from "node:path";
import { clampAutopilotSteps, AUTOPILOT_MAX_MINUTES } from "./autopilot.js";

export type PersistedAutopilotState = {
  stepsRemaining: number;
  deadlineAt: number | null;
  autoResolve: boolean;
};

/** 逐條驗證還原內容：steps 夾回合法範圍、deadline 非數字一律 null（上限 24h 後）、
 *  壞掉的條目整條丟棄——重啟還原絕不能把護欄架空。 */
export function normalizeAutopilotStates(raw: unknown): Record<string, PersistedAutopilotState> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, PersistedAutopilotState> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || typeof key !== "string" || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.stepsRemaining !== "number" || !Number.isFinite(entry.stepsRemaining) || entry.stepsRemaining < 1) continue;
    const deadlineAt = typeof entry.deadlineAt === "number" && Number.isFinite(entry.deadlineAt)
      ? Math.min(entry.deadlineAt, Date.now() + AUTOPILOT_MAX_MINUTES * 60_000)
      : null;
    out[key] = {
      stepsRemaining: clampAutopilotSteps(entry.stepsRemaining),
      deadlineAt,
      autoResolve: entry.autoResolve === true,
    };
  }
  return out;
}

export class AutopilotStateStore {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "autopilot-state.json");
  }

  load(): Record<string, PersistedAutopilotState> {
    try {
      return normalizeAutopilotStates(JSON.parse(fs.readFileSync(this.file, "utf8")));
    } catch {
      return {}; // 檔案不存在或壞掉 → 當成全關，跟舊行為一致
    }
  }

  save(states: Record<string, PersistedAutopilotState>): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(states, null, 2));
    } catch (error) {
      // 寫不進去只影響「重啟後記憶」，不影響進行中的循環——記 log 就好，別把循環炸掉。
      console.error("[autopilot] 無法保存自動循環狀態:", error);
    }
  }
}
