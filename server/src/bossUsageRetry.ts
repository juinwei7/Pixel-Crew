// 用量／額度擋住交辦任務判斷後的「恢復探測＋自動重跑」追蹤器（卡點盤點 P1-5）。
// 兩個失敗點：dedicated 直接路徑與 decide 的開頭 usageBlockReason 檢查——usage 視窗
// 重置（整點／5h）後沒有任何人重試，交辦停在 needs_attention 只能等老闆回覆。
//
// 「已恢復」的明確依據：定期探測 usageRegistry.refresh（強制抓即時用量）後
// usageBlockReason 歸空才算，不猜時間。每次探測計一次數（探測本身就是嘗試）、
// 指數退避拉長間隔；上限用盡仍受限就發明確降級訊息回報主人，不靜默續等。
// 退避引擎內核與 bossDeptCreateRetry（P1-3）共用，抽在 backoffRetry.ts。
import { BackoffRetryTracker, backoffDelayMs, type BackoffPolicy } from "./backoffRetry.js";

// 60s → 2m → 4m → 8m → 15m 封頂；24 次累計約 5.5 小時，涵蓋最長的 5h 用量視窗——
// 視窗重置後最多一個封頂間隔（15 分鐘）內就會被探測到並自動接手。
export const USAGE_RETRY_MAX_PROBES = 24;
export const USAGE_RETRY_BASE_COOLDOWN_MS = 60_000;
export const USAGE_RETRY_MAX_COOLDOWN_MS = 900_000;

const POLICY: BackoffPolicy = {
  baseMs: USAGE_RETRY_BASE_COOLDOWN_MS,
  capMs: USAGE_RETRY_MAX_COOLDOWN_MS,
  maxAttempts: USAGE_RETRY_MAX_PROBES,
};

/** 失敗點路徑：恢復後各走回自己原本的入口（追問路徑不做 usage 前置檢查，故無此 kind）。 */
export type UsageRetryKind = "dedicated" | "decide";

/** 寫進 task.stall.kind 的結構化停滯標記：引擎依此認領，不 parse 人類可讀文案。
 * 「usage:」命名空間讓本引擎與 bossDeptCreateRetry（dept_create:*）結構上不可能互搶。 */
export type UsageStallKind = `usage:${UsageRetryKind}`;

export function usageStallKind(kind: UsageRetryKind): UsageStallKind {
  return `usage:${kind}`;
}

type UsageRetryPayload = {
  kind: UsageRetryKind;
};

export type UsageRetryEntry = UsageRetryPayload & {
  probes: number;
  notBefore: number;
};

export function usageRetryBackoffMs(probes: number): number {
  return backoffDelayMs(POLICY, probes);
}

export class UsageRetryTracker {
  private readonly inner = new BackoffRetryTracker<UsageRetryPayload>(POLICY);

  note(taskId: string, kind: UsageRetryKind, now: number): void {
    this.inner.note(taskId, { kind }, now);
  }

  get(taskId: string): UsageRetryEntry | null {
    const entry = this.inner.get(taskId);
    return entry ? { ...entry.payload, probes: entry.attempts, notBefore: entry.notBefore } : null;
  }

  shouldProbe(taskId: string, now: number): boolean {
    return this.inner.due(taskId, now);
  }

  /** 真的發動探測前呼叫：記一次並依新次數設退避，回傳這是第幾次（1 起算）。 */
  beginProbe(taskId: string, now: number): number {
    return this.inner.begin(taskId, now);
  }

  exhausted(taskId: string): boolean {
    return this.inner.exhausted(taskId);
  }

  resolve(taskId: string): void {
    this.inner.resolve(taskId);
  }

  trackedIds(): string[] {
    return this.inner.trackedIds();
  }

  get size(): number {
    return this.inner.size;
  }
}

export type UsageRetryAction =
  | { kind: "drop" } // 不再追蹤：交辦消失／已推進／別的失敗接手（stall 標記換人或被清）
  | { kind: "wait" } // 保留追蹤，這輪不動：退避中或上一輪探測還在跑
  | { kind: "exhausted" } // 探測次數用盡仍受限：呼叫端發降級訊息（明確回報主人）並除名
  | { kind: "probe"; probe: number; entry: UsageRetryEntry }; // 發動探測：呼叫端查即時用量，恢復才重跑原入口

/**
 * 對一張已登記的交辦決定這輪掃描要做什麼。shouldProbe→beginProbe 在同一次同步呼叫內
 * 完成（單執行緒）；探測含網路呼叫與可能的重跑（LLM 長流程），靠 inFlight 擋重疊。
 */
export function usageRetryAction(
  tracker: UsageRetryTracker,
  taskId: string,
  view: { status: string; stallKind: string | null; inFlight: boolean },
  now: number,
): UsageRetryAction {
  const entry = tracker.get(taskId);
  if (!entry) return { kind: "drop" };
  if (view.status !== "needs_attention") return { kind: "drop" };
  // 結構化認領：task.stall.kind 不是本登記的標記（例如恢復重跑後換成建立失敗、改由
  // bossDeptCreateRetry 追蹤，或任何路徑改寫 task.error 讓中央護欄清掉 stall）——這筆
  // 登記作廢，兩套引擎不互踩。不比對人類可讀文案，受限訊息改寫、換語系都不影響認領。
  if (view.stallKind !== usageStallKind(entry.kind)) return { kind: "drop" };
  if (view.inFlight) return { kind: "wait" };
  if (tracker.exhausted(taskId)) return { kind: "exhausted" };
  if (!tracker.shouldProbe(taskId, now)) return { kind: "wait" };
  return { kind: "probe", probe: tracker.beginProbe(taskId, now), entry };
}
