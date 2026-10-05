// 第四輪「優化體驗」用到的純邏輯（畫面在各元件與 styles/motion-ux.css）。
// 全部是純函式，方便測試；不碰 DOM、不送請求。
import { workerAttention } from "./crew";
import type { WorkerState } from "./types";

/** 誰在等你：等核准的 NPC（照隊員順序），第一位就是「前往」要跳過去的人。 */
export function attentionSummary(workers: WorkerState[]): { count: number; firstId: string | null; firstName: string } {
  const waiting = workers.filter((worker) => workerAttention(worker) === "approval");
  return { count: waiting.length, firstId: waiting[0]?.id ?? null, firstName: waiting[0]?.name ?? "" };
}

/** 任務日誌「新內容」計數：離開底部那一刻記下基準，之後多出來的就是沒看到的。
 *  回到底部就歸零、基準跟著最新內容走。 */
export type UnseenState = { baseline: number; unseen: number };
export function trackUnseen(previous: UnseenState | null, atBottom: boolean, count: number): UnseenState {
  if (atBottom || !previous) return { baseline: count, unseen: 0 };
  // 內容變少（切換 NPC、清空）：重新起算，不顯示負數。
  if (count < previous.baseline) return { baseline: count, unseen: 0 };
  return { baseline: previous.baseline, unseen: count - previous.baseline };
}

/** 日誌的「內容量」：回合數＋最後一個回合的項目數（串流時會一直長）。 */
export function logContentCount(turns: Array<{ items: unknown[] }>): number {
  return turns.length + (turns[turns.length - 1]?.items.length ?? 0);
}

/** 用滑鼠做了有快捷鍵的事：提示一次快捷鍵。同一個動作每個分頁 session 只提示一次。 */
export const SHORTCUT_HINTS = {
  toggle_task_log: { mac: "⌘ J", other: "Ctrl J" },
  approval: { mac: "⌘ ⇧ A", other: "Ctrl ⇧ A" },
  command_palette: { mac: "⌘ K", other: "Ctrl K" },
  shortcuts_help: { mac: "?", other: "?" },
} as const;
export type ShortcutHintId = keyof typeof SHORTCUT_HINTS;

export function shortcutLabel(id: string, mac: boolean): string | null {
  const entry = (SHORTCUT_HINTS as Record<string, { mac: string; other: string }>)[id];
  return entry ? (mac ? entry.mac : entry.other) : null;
}

export function takeShortcutHint(id: string, seen: { has(key: string): boolean; add(key: string): void }): boolean {
  if (!(id in SHORTCUT_HINTS) || seen.has(id)) return false;
  seen.add(id);
  return true;
}

/** 按住確認：按了多久才算數。比這短就是「誤觸」，回去抖一下提示要按住。 */
export const HOLD_CONFIRM_MS = 650;
export function holdOutcome(heldMs: number, holdMs = HOLD_CONFIRM_MS): "confirm" | "too-short" {
  return heldMs >= holdMs ? "confirm" : "too-short";
}
