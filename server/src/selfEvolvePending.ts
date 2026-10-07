// 自我進化引擎 · Stage 3 跨重啟自裝狀態機（純核心）。
//
// 為什麼要跨重啟：冷安裝會殺掉引擎自己的進程，所以「裝→驗四件套→不健康就回滾」無法在同一
// 進程內同步完成。解法：裝之前落一張 pending marker（期望檢查、回滾點），重啟後開機解析器讀它——
// 健康就清除＋報成功（並可接 Stage 4 再武裝）；不健康就自動回滾＋報 owner。決策純函式、IO 注入。
import fs from "node:fs";
import path from "node:path";
import { evaluatePostInstall, type PostInstallChecks, type PostInstallResult } from "./selfEvolveInstall.js";

export type PendingSelfInstall = {
  /** pc-selfrebuild 交棒給 pc-selfinstall 的時間（epoch ms）；開機驗收只認這之後的安裝 log。 */
  firedAt: number;
  reason: string;
  changedFiles: string[];
  /** 已 staged 的新安裝器路徑。 */
  stagedExe: string;
  /** 已知良好的回滾安裝器路徑（＝裝前的現役版本）。 */
  rollbackExe: string;
  /** 裝前現役 exe 的 mtime(ms)，用來判斷 swap 有沒有真的發生。 */
  prevExeMtimeMs: number;
  /** 新版安裝器的 SHA-256——開機晉升回滾點前驗「staged 還是當初那支新版」，防回滾後誤晉升污染回滾點。 */
  stagedSha256?: string;
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
  const stagedSha256 = boundedStr(r.stagedSha256, 128);
  return { firedAt, reason: boundedStr(r.reason, 500), changedFiles, stagedExe, rollbackExe, prevExeMtimeMs, ...(stagedSha256 ? { stagedSha256 } : {}) };
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

export type TimestampedLogLine = { at: number; message: string };

/**
 * 解析 pc-selfrebuild／pc-selfinstall 的 log：每行是「{Get-Date -Format o} 訊息」，時間戳帶時區
 * （例：2026-10-07T10:40:36.1234567+08:00），可直接換成 epoch ms 跟 marker 比。沒有時間戳的行
 * （例如被導進 log 的 npm 輸出）略過。
 */
export function parseTimestampedLog(text: string): TimestampedLogLine[] {
  const out: TimestampedLogLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d{4}-\d{2}-\d{2}T\S+) (.*)$/.exec(line);
    if (!m) continue;
    const at = Date.parse(m[1]);
    if (Number.isFinite(at)) out.push({ at, message: m[2] });
  }
  return out;
}

export type SelfInstallVerdict = {
  /** pending＝pc-selfinstall 還沒對這次安裝下結論（換入／健康輪詢中）。 */
  state: "pending" | "healthy" | "failed";
  /** 這次安裝的段落裡有沒有 SWAPPED OK（新版真的換進 app 了）。 */
  swapped: boolean;
};

/**
 * 讀 self-install.log，取 pc-selfinstall 對「這一次」安裝下的結論。開機解析器必須等它——自己進得了
 * listen 不代表健康，而且晉升回滾點若搶在它的健康輪詢之前，接著判失敗時會「回滾」到這個壞版本。
 * - 只認 marker.firedAt 之後才開始（=== self-install start ===）的段落：之前安裝留下的
 *   SWAPPED OK／HEALTHY OK 一律不算數。
 * - marker 記了 stagedSha256 時，段落記的 staged hash 也要相符（確定是在裝這一版）。
 * - 段落裡有 UNHEALTHY／FATAL → failed（它會自己回滾，或根本沒裝）；有最終那行「=== self-install OK」
 *   → healthy；都還沒有 → pending。回滾路徑也會印 HEALTHY OK（舊版起來了），所以不認 HEALTHY OK。
 */
export function readSelfInstallVerdict(logText: string, marker: PendingSelfInstall): SelfInstallVerdict {
  const wantHash = (marker.stagedSha256 || "").trim().toUpperCase();
  const matches = (lines: TimestampedLogLine[]) =>
    !wantHash || lines.some((l) => l.message.trim().toUpperCase() === `STAGED HASH: ${wantHash}`);
  let session: TimestampedLogLine[] | null = null;
  let current: TimestampedLogLine[] | null = null;
  for (const line of parseTimestampedLog(logText)) {
    if (line.message.startsWith("=== self-install start ===")) {
      if (current && matches(current)) session = current;
      current = line.at >= marker.firedAt ? [line] : null;
      continue;
    }
    current?.push(line);
  }
  if (current && matches(current)) session = current;
  if (!session) return { state: "pending", swapped: false };
  const has = (re: RegExp) => session!.some((l) => re.test(l.message));
  const swapped = has(/SWAPPED OK/);
  if (has(/UNHEALTHY|^FATAL/)) return { state: "failed", swapped };
  if (has(/^=== self-install OK/)) return { state: "healthy", swapped };
  return { state: "pending", swapped };
}

export class PendingSelfInstallStore {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "self-install-pending.json");
  }

  read(): PendingSelfInstall | null {
    try {
      // 去掉 UTF-8 BOM：PowerShell 寫的 marker 可能帶 BOM，JSON.parse 遇 BOM 會丟錯。
      const raw = fs.readFileSync(this.file, "utf8").replace(/^﻿/, "");
      return normalizePendingSelfInstall(JSON.parse(raw));
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
