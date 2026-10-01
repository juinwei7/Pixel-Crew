// 自我進化引擎 · Stage 3 跨重啟自裝狀態機（純核心）。
//
// 為什麼要跨重啟：冷安裝會殺掉引擎自己的進程，所以「裝→驗四件套→不健康就回滾」無法在同一
// 進程內同步完成。解法：裝之前落一張 pending marker（期望檢查、回滾點），重啟後開機解析器讀它——
// 健康就清除＋報成功（並可接 Stage 4 再武裝）；不健康就自動回滾＋報 owner。決策純函式、IO 注入。
import fs from "node:fs";
import path from "node:path";
import { evaluatePostInstall, type PostInstallChecks, type PostInstallResult } from "./selfEvolveInstall.js";

export type PendingSelfInstall = {
  firedAt: number;
  reason: string;
  changedFiles: string[];
  /** 已 staged 的新安裝器路徑。 */
  stagedExe: string;
  /** 已知良好的回滾安裝器路徑（＝裝前的現役版本）。 */
  rollbackExe: string;
  /** 裝前現役 exe 的 mtime(ms)，用來判斷 swap 有沒有真的發生。 */
  prevExeMtimeMs: number;
};

function boundedStr(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

export function normalizePendingSelfInstall(raw: unknown): PendingSelfInstall | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const stagedExe = boundedStr(r.stagedExe, 1024);
  const rollbackExe = boundedStr(r.rollbackExe, 1024);
  if (!stagedExe || !rollbackExe) return null; // 沒有安裝器/回滾點的 marker 無意義，丟棄
  const firedAt = typeof r.firedAt === "number" && Number.isFinite(r.firedAt) ? r.firedAt : 0;
  const prevExeMtimeMs = typeof r.prevExeMtimeMs === "number" && Number.isFinite(r.prevExeMtimeMs) ? r.prevExeMtimeMs : 0;
  const changedFiles = Array.isArray(r.changedFiles)
    ? r.changedFiles.map((f) => boundedStr(f, 1024)).filter(Boolean).slice(0, 200)
    : [];
  return { firedAt, reason: boundedStr(r.reason, 500), changedFiles, stagedExe, rollbackExe, prevExeMtimeMs };
}

export type BootResolution =
  | { action: "none" }
  | { action: "confirm_ok"; result: PostInstallResult }
  | { action: "rollback"; result: PostInstallResult };

/**
 * 開機解析：有 marker 代表上一輪剛自裝完、正在等這次重啟驗收。
 * 健康(四件套全過) → confirm_ok（清 marker、報成功）；任一不過 → rollback（還原、報 owner）。
 */
export function evaluateBootResolution(marker: PendingSelfInstall | null, checks: PostInstallChecks): BootResolution {
  if (!marker) return { action: "none" };
  const result = evaluatePostInstall(checks);
  return result.healthy ? { action: "confirm_ok", result } : { action: "rollback", result };
}

export class PendingSelfInstallStore {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "self-install-pending.json");
  }

  read(): PendingSelfInstall | null {
    try {
      return normalizePendingSelfInstall(JSON.parse(fs.readFileSync(this.file, "utf8")));
    } catch {
      return null;
    }
  }

  write(marker: PendingSelfInstall): void {
    fs.writeFileSync(this.file, JSON.stringify(marker, null, 2));
  }

  clear(): void {
    try { fs.rmSync(this.file, { force: true }); } catch { /* ignore */ }
  }
}
