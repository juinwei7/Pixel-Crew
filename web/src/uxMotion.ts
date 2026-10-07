// 第四輪「優化體驗」用到的純邏輯（畫面在各元件與 styles/motion-ux.css）。
// 全部是純函式，方便測試；不碰 DOM、不送請求。
import { collectNeedsYou } from "./needsYou";
import type { WorkerState } from "./types";

/** 誰在等你：等核准的 NPC（照隊員順序），第一位就是「前往」要跳過去的人。 */
export function attentionSummary(workers: WorkerState[]): { count: number; firstId: string | null; firstName: string } {
  // 只取「待核准」：與頂欄、隊員列、通知共用 needsYou 的同一份判斷。
  const waiting = collectNeedsYou(workers).filter((item) => item.kind === "approval").map((item) => ({ id: item.workerId, name: item.workerName }));
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
  next_attention: { mac: "N", other: "N" },
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
/** 按住確認的鍵盤手勢：Enter／空白鍵第一次按下才開始計時；按住不放時的自動重複 keydown 一律吞掉
 *  （不擋預設動作的話，瀏覽器每次重複都會對按鈕觸發 click，過了 onClick 的門檻就提早確認）。 */
export function holdKeyAction(key: string, repeat: boolean): "start" | "swallow" | "ignore" {
  if (key !== "Enter" && key !== " ") return "ignore";
  return repeat ? "swallow" : "start";
}
