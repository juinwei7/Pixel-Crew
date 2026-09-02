/**
 * Per-NPC extras that live outside the SQLite store: long-term memory notes
 * and the daily spending cap. One small JSON file per worker under
 * `{dataDirectory}/npc-extras/{workerId}.json` — no schema migration, survives
 * restarts, and worker deletion just unlinks the file.
 *
 * Memory notes are injected into the provider system prompt on every spawn
 * (see composeMemorySection), together with a self-serve curl instruction so
 * the NPC itself can persist new facts about the user mid-conversation.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { t } from "./i18n.js";

export type WorkerExtras = {
  notes: string[];
  dailyBudgetUsd: number | null;
  goal: string | null;
};

export const MAX_MEMORY_NOTES = 30;
export const MAX_MEMORY_NOTE_LENGTH = 200;
export const MAX_WORKER_GOAL_LENGTH = 1_000;

const extrasDir = join(config.dataDirectory, "npc-extras");
const cache = new Map<string, WorkerExtras>();

function extrasPath(workerId: string): string {
  // Worker ids are server-minted UUIDs, but sanitize anyway so a corrupt DB
  // row can never traverse out of the extras directory.
  return join(extrasDir, `${workerId.replace(/[^0-9a-zA-Z-]/g, "")}.json`);
}

function emptyExtras(): WorkerExtras {
  return { notes: [], dailyBudgetUsd: null, goal: null };
}

export function getExtras(workerId: string): WorkerExtras {
  const cached = cache.get(workerId);
  if (cached) return cached;
  let extras = emptyExtras();
  try {
    const path = extrasPath(workerId);
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<WorkerExtras>;
      const notes = Array.isArray(raw.notes)
        ? raw.notes.map((note) => String(note).trim().slice(0, MAX_MEMORY_NOTE_LENGTH)).filter(Boolean).slice(0, MAX_MEMORY_NOTES)
        : [];
      const budget = typeof raw.dailyBudgetUsd === "number" && Number.isFinite(raw.dailyBudgetUsd) && raw.dailyBudgetUsd > 0
        ? raw.dailyBudgetUsd
        : null;
      const goal = typeof raw.goal === "string"
        ? raw.goal.trim().replace(/\s+/g, " ").slice(0, MAX_WORKER_GOAL_LENGTH) || null
        : null;
      extras = { notes, dailyBudgetUsd: budget, goal };
    }
  } catch (error) {
    console.warn(`[extras] 讀取 ${workerId} 的 npc-extras 失敗，視為空白：`, (error as Error).message);
  }
  cache.set(workerId, extras);
  return extras;
}

function persist(workerId: string, extras: WorkerExtras): void {
  cache.set(workerId, extras);
  mkdirSync(extrasDir, { recursive: true });
  writeFileSync(extrasPath(workerId), JSON.stringify(extras, null, 2), "utf8");
}

/** Add one memory note. Returns the stored note, or an error string in zh-TW. */
export function addMemoryNote(workerId: string, input: unknown): { ok: true; note: string } | { ok: false; error: string } {
  const note = String(input ?? "").trim().replace(/\s+/g, " ").slice(0, MAX_MEMORY_NOTE_LENGTH);
  if (!note) return { ok: false, error: t("記憶內容不能是空白") };
  const extras = getExtras(workerId);
  if (extras.notes.some((existing) => existing.toLocaleLowerCase() === note.toLocaleLowerCase())) {
    return { ok: false, error: t("這則記憶已經存在") };
  }
  const notes = [...extras.notes, note];
  // Oldest note falls off first — long-term memory is a rolling window, and
  // anything important enough will get re-learned.
  while (notes.length > MAX_MEMORY_NOTES) notes.shift();
  persist(workerId, { ...extras, notes });
  return { ok: true, note };
}

export function removeMemoryNote(workerId: string, index: number): boolean {
  const extras = getExtras(workerId);
  if (!Number.isInteger(index) || index < 0 || index >= extras.notes.length) return false;
  persist(workerId, { ...extras, notes: extras.notes.filter((_, i) => i !== index) });
  return true;
}

/** null clears the cap; otherwise a positive USD amount (2-decimal precision). */
export function setDailyBudget(workerId: string, input: unknown): { ok: true; dailyBudgetUsd: number | null } | { ok: false; error: string } {
  if (input == null || input === "") {
    persist(workerId, { ...getExtras(workerId), dailyBudgetUsd: null });
    return { ok: true, dailyBudgetUsd: null };
  }
  const value = Math.round(Number(input) * 100) / 100;
  if (!Number.isFinite(value) || value <= 0 || value > 10_000) {
    return { ok: false, error: t("預算上限需為 0 到 10000 之間的美元金額") };
  }
  persist(workerId, { ...getExtras(workerId), dailyBudgetUsd: value });
  return { ok: true, dailyBudgetUsd: value };
}

/** null clears the goal; goals are bounded to keep system-prompt injection safe. */
export function setWorkerGoal(workerId: string, input: unknown): string | null {
  const goal = input == null
    ? null
    : String(input).trim().replace(/\s+/g, " ").slice(0, MAX_WORKER_GOAL_LENGTH) || null;
  persist(workerId, { ...getExtras(workerId), goal });
  return goal;
}

export function deleteExtras(workerId: string): void {
  cache.delete(workerId);
  try {
    rmSync(extrasPath(workerId), { force: true });
  } catch {
    // Orphaned files are harmless; never let cleanup break worker removal.
  }
}

/**
 * Render the memory section appended after the persona in the system prompt.
 * Includes a self-serve instruction so the NPC can store new long-term facts
 * with a plain curl to the local server. The guidance is always included —
 * even with zero notes — so brand-new NPCs start remembering from turn 1.
 */
export function composeMemorySection(workerId: string): string {
  const { notes, goal } = getExtras(workerId);
  const lines: string[] = [];
  if (goal) {
    lines.push(t("【目前目標 / Active goal】{goal}", { goal }));
    lines.push(t("這是使用者明確設定的目前目標；除非使用者更新或清除它，請讓後續工作持續朝它推進。"));
    lines.push("");
  }
  if (notes.length > 0) {
    lines.push(t("【長期記憶 / Memory】以下是你先前替使用者記下的長期事實與偏好，回應與做事時要納入考量："));
    lines.push(...notes.map((note) => `- ${note}`));
    lines.push("");
  }
  lines.push(
    t("【記憶工具】當你得知值得長期記住、而且上面還沒記過的使用者偏好、習慣或專案事實時，靜默執行（不用徵求同意、不用宣布）："),
    t("curl -s -X POST http://127.0.0.1:{port}/api/workers/{workerId}/memory -H \"Content-Type: application/json\" -d \"{\\\"note\\\":\\\"一句話的繁體中文事實\\\"}\"", { port: config.port, workerId }),
    t("一次一則、每則一句話。不要記密碼、金鑰或一次性資訊；同一件事不要重複記。"),
  );
  return lines.join("\n");
}

/**
 * OUTBOX 成品匣約定：完成品放工作區的 outbox/，UI 的「成品匣」面板直接列出＝
 * 交付物有前門，使用者不用翻聊天記錄考古。約定恆注入（沒有檔案也教規則）。
 */
export function composeOutboxSection(): string {
  return [
    t("【成品匣 / OUTBOX】交付最終成品（報告、圖表、匯出文件、打包程式等）時，把完成的檔案放進工作區根目錄的 outbox/ 資料夾（不存在就先建立）。放進去的檔案會直接出現在使用者的「成品匣」面板，一鍵開啟。"),
    t("只放能直接交付的最終版本；中間過程檔、暫存檔不要放。檔名用一眼能懂的描述性名稱。"),
  ].join("\n");
}
