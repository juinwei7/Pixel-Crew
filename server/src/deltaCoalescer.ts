import type { RunnerEvent } from "./claudeRunner.js";

// 高頻串流 delta 的「送出前合併」。模型串流時 text/thinking/工具輸出 delta 一秒可達上百筆，
// 每筆都各自 JSON.stringify＋對每個用戶端 send，前端也每筆跑一次 reducer＋React 更新。這裡把
// 同一 worker 在短視窗（預設 33ms ≈ 2 個畫格）內的連續同型 delta 併成一筆再送。
//
// 正確性保證（前端看到的最終內容與逐筆送完全相同）：
//  - 只合併「同一 worker、緊鄰、同型」的 delta（tool_call_output_delta 還要同 id）；任何其他
//    事件都會先把緩衝**全部**送出再送自己 → 每個 worker 內的事件順序完全保留，turn_end/
//    error/tool_call_start 之前的文字一定先到。
//  - 呼叫端在送任何非 delta 的廣播（worker_updated、stats…）或新連線 snapshot 之前也要
//    flush()，否則會出現「snapshot 已含這段文字、稍後又收到同一段 delta」的重複。
//  - 不修改傳進來的事件物件（它同時存在 worker.history 裡）；合併時一律建新物件。
//  - at 取最後一筆（與前端逐筆套用後 speechAt 的結果相同）。
export type CoalescibleDelta = Extract<RunnerEvent, { type: "text_delta" | "thinking_delta" | "tool_call_output_delta" }>;

export const DELTA_COALESCE_WINDOW_MS = 33;
// 單筆合併上限：視窗很短，正常到不了；只是避免異常洪流把單一訊息撐到無界。
export const DELTA_COALESCE_MAX_CHARS = 64 * 1024;

type Timers = {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

const defaultTimers: Timers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    // 不讓還沒送出的合併計時器把行程撐著不退出（測試/關機）。
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function isCoalescibleDelta(event: RunnerEvent): event is CoalescibleDelta {
  return event.type === "text_delta" || event.type === "thinking_delta" || event.type === "tool_call_output_delta";
}

function deltaText(event: CoalescibleDelta): string {
  return event.type === "tool_call_output_delta" ? event.delta : event.text;
}

/** 兩筆 delta 能否併成一筆（同型、工具輸出還需同 id、合併後不超過上限）。 */
export function canMergeDelta(prev: CoalescibleDelta, next: CoalescibleDelta, maxChars = DELTA_COALESCE_MAX_CHARS): boolean {
  if (prev.type !== next.type) return false;
  if (prev.type === "tool_call_output_delta" && next.type === "tool_call_output_delta" && prev.id !== next.id) return false;
  return deltaText(prev).length + deltaText(next).length <= maxChars;
}

/** 回傳新物件（不動 prev/next）。呼叫前須先確認 canMergeDelta。 */
export function mergeDelta(prev: CoalescibleDelta, next: CoalescibleDelta): CoalescibleDelta {
  const at = next.at ?? prev.at;
  const merged: CoalescibleDelta = prev.type === "tool_call_output_delta"
    ? { ...prev, delta: prev.delta + deltaText(next) }
    : { ...prev, text: prev.text + deltaText(next) };
  if (at !== undefined) merged.at = at;
  return merged;
}

type Pending = { workerId: string; event: RunnerEvent; owned: boolean };

export class DeltaCoalescer {
  private pending: Pending[] = [];
  // 每個 worker 在 pending 中最後一筆的位置——只能併進「該 worker 的最後一筆」，順序才不亂。
  private lastIndex = new Map<string, number>();
  private timer: unknown = null;

  constructor(
    private readonly send: (workerId: string, event: RunnerEvent) => void,
    private readonly windowMs = DELTA_COALESCE_WINDOW_MS,
    private readonly timers: Timers = defaultTimers,
    private readonly maxChars = DELTA_COALESCE_MAX_CHARS,
  ) {}

  /** 送出一個 worker 事件；delta 會在視窗內緩衝合併，其他事件先 flush 再立即送。 */
  push(workerId: string, event: RunnerEvent): void {
    if (this.windowMs <= 0 || !isCoalescibleDelta(event)) {
      this.flush();
      this.send(workerId, event);
      return;
    }
    const index = this.lastIndex.get(workerId);
    const last = index === undefined ? undefined : this.pending[index];
    if (last && isCoalescibleDelta(last.event) && canMergeDelta(last.event, event, this.maxChars)) {
      // 第一次併入時才複製（原物件屬於 worker.history），之後就地累加省配置。
      if (!last.owned) {
        last.event = mergeDelta(last.event, event);
        last.owned = true;
        return;
      }
      if (last.event.type === "tool_call_output_delta") last.event.delta += deltaText(event);
      else last.event.text += deltaText(event);
      if (event.at !== undefined) last.event.at = event.at;
      return;
    }
    this.lastIndex.set(workerId, this.pending.length);
    this.pending.push({ workerId, event, owned: false });
    if (this.timer === null) this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.windowMs);
  }

  /** 立即送出所有緩衝中的 delta（依原順序）。 */
  flush(): void {
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.lastIndex.clear();
    for (const entry of batch) {
      try {
        this.send(entry.workerId, entry.event);
      } catch (error) {
        console.error("[deltaCoalescer] send failed:", error);
      }
    }
  }

  get pendingCount(): number {
    return this.pending.length;
  }
}
