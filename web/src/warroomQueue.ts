// 作戰室排隊的前端跟進邏輯（不碰 React，方便單元測試）。
// 後端臨時席位不夠時 POST /api/warroom 會回 202 { queued, ticketId, ahead }；這裡輪詢
// GET /api/warroom/queue/:ticketId，回報名次、開場，直到拿到裁決／失敗／取消。

export type WarroomTicketView<R> =
  | { state: "queued"; ahead: number }
  | { state: "running" }
  | { state: "done"; result: R }
  | { state: "failed" | "cancelled"; error?: string };

export type WarroomQueueOutcome<R> =
  | { kind: "done"; result: R }
  | { kind: "failed"; error: string }
  | { kind: "cancelled" };

export interface FollowWarroomTicketOptions {
  onQueued: (ahead: number) => void;
  onRunning: () => void;
  isCancelled: () => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  intervalMs?: number;
  // 連續幾次查不到（網路抖動）才放棄；404（server 重啟、票據已失效）立即放棄。
  maxConsecutiveErrors?: number;
  // 整體上限：排隊最多 30 分鐘＋開會最多 12 分鐘，再多留幾分鐘收尾。
  deadlineMs?: number;
  timeoutMessage: string;
}

export const WARROOM_FOLLOW_DEADLINE_MS = 45 * 60_000;

function errorStatus(error: unknown): number {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : 0;
}

export async function followWarroomTicket<R>(
  fetchTicket: () => Promise<WarroomTicketView<R>>,
  options: FollowWarroomTicketOptions,
): Promise<WarroomQueueOutcome<R>> {
  const intervalMs = options.intervalMs ?? 3_000;
  const maxErrors = options.maxConsecutiveErrors ?? 5;
  const deadlineAt = options.now() + (options.deadlineMs ?? WARROOM_FOLLOW_DEADLINE_MS);
  let errors = 0;
  let running = false;
  for (;;) {
    if (options.isCancelled()) return { kind: "cancelled" };
    let view: WarroomTicketView<R>;
    try {
      view = await fetchTicket();
      errors = 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors += 1;
      if (errorStatus(error) === 404 || errors >= maxErrors) return { kind: "failed", error: message };
      view = running ? { state: "running" } : { state: "queued", ahead: -1 };
    }
    if (options.isCancelled()) return { kind: "cancelled" };
    if (view.state === "done") return { kind: "done", result: view.result };
    if (view.state === "cancelled") return { kind: "cancelled" };
    if (view.state === "failed") return { kind: "failed", error: view.error ?? "" };
    if (view.state === "running") {
      if (!running) { running = true; options.onRunning(); }
    } else if (view.state === "queued" && view.ahead >= 0) {
      options.onQueued(view.ahead);
    }
    if (options.now() >= deadlineAt) return { kind: "failed", error: options.timeoutMessage };
    await options.sleep(intervalMs);
  }
}
