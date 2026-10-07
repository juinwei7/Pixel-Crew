// 專屬部門「建立失敗」的自動重試追蹤器（卡點盤點 P1-3）——三個失敗點共用：
// dedicated 直接路徑、追問重建、decide 的 create_department 分支。最常見主因是
// 「此工作區正在執行其他 Mission」：阻塞的 Mission 結束後沒有任何人重試建部門，
// 交辦停在 needs_attention 只能等老闆回覆。
//
// 這裡只放純狀態機（登記／指數退避／次數上限／降級決策），方便單測；實際的
// 工作區檢查、重試呼叫與 turn_end / 定期掃描掛勾在 index.ts。退避引擎內核與
// bossUsageRetry（P1-5）共用，抽在 backoffRetry.ts。
import { BackoffRetryTracker, backoffDelayMs, type BackoffPolicy } from "./backoffRetry.js";

export const DEPT_CREATE_RETRY_MAX_ATTEMPTS = 3;
export const DEPT_CREATE_RETRY_BASE_COOLDOWN_MS = 15_000;
export const DEPT_CREATE_RETRY_MAX_COOLDOWN_MS = 120_000;

const POLICY: BackoffPolicy = {
  baseMs: DEPT_CREATE_RETRY_BASE_COOLDOWN_MS,
  capMs: DEPT_CREATE_RETRY_MAX_COOLDOWN_MS,
  maxAttempts: DEPT_CREATE_RETRY_MAX_ATTEMPTS,
};

/** 失敗點路徑：重試時各走回自己原本的入口，不互相冒充。 */
export type DeptCreateRetryKind = "dedicated" | "follow_up" | "decide";

/** 寫進 task.stall.kind 的結構化停滯標記：引擎依此認領，不 parse 人類可讀文案。
 * 「dept_create:」命名空間讓本引擎與 bossUsageRetry（usage:*）結構上不可能互搶。 */
export type DeptCreateStallKind = `dept_create:${DeptCreateRetryKind}`;

export function deptCreateStallKind(kind: DeptCreateRetryKind): DeptCreateStallKind {
  return `dept_create:${kind}`;
}

/**
 * 開機重建：從落地資料認回失敗入口（對抗式自審 6ef0aa0 補洞——升級相容）。
 * 優先認結構化 stall.kind；stall 缺欄的列是「結構化改造前」的舊版落地資料，升級後
 * 不能讓當時已卡住的交辦變成無人接手的孤兒——以當年的失敗文案盡力橋接（僅此一處、
 * 僅對舊列生效的一次性遷移；新寫入一律帶 stall，永遠不會走到文案分支）。橋接不到
 * （文案已改寫／語系已換）就回 null，維持 needs_attention 等人工，訊息本就含下一步
 * 指引，不誤動作。帶著別家引擎 stall 標記的列明確回 null，不越界認領。
 */
export function bootRebuildKind(
  stallKind: string | null,
  taskError: string | null,
  legacyCopy: { dedicated: string; decide: string },
): { kind: Exclude<DeptCreateRetryKind, "follow_up">; legacy: boolean } | null {
  if (stallKind === deptCreateStallKind("dedicated")) return { kind: "dedicated", legacy: false };
  if (stallKind === deptCreateStallKind("decide")) return { kind: "decide", legacy: false };
  // follow_up 的追問文字不跨重啟保存、無法安全重放（既有留白）；其他標記屬別的引擎。
  if (stallKind !== null) return null;
  if (taskError !== null && taskError === legacyCopy.dedicated) return { kind: "dedicated", legacy: true };
  if (taskError !== null && taskError === legacyCopy.decide) return { kind: "decide", legacy: true };
  return null;
}

type DeptCreateRetryPayload = {
  kind: DeptCreateRetryKind;
  /** kind="follow_up" 時要重跑的追問文字；其他 kind 為 null。 */
  followUp: string | null;
};

export type DeptCreateRetryEntry = DeptCreateRetryPayload & {
  attempts: number;
  notBefore: number;
};

/** 指數退避：15s → 30s → 60s，封頂 120s。attempts 是「已重試次數」。 */
export function deptCreateRetryBackoffMs(attempts: number): number {
  return backoffDelayMs(POLICY, attempts);
}

export class DeptCreateRetryTracker {
  private readonly inner = new BackoffRetryTracker<DeptCreateRetryPayload>(POLICY);

  /**
   * 建立失敗時登記。首次登記也從基本退避起算——建立部門要跑最長 90s 的規劃 LLM，
   * 失敗立刻重打只會連環燒 token。已登記者（自動重試又失敗、或使用者手動回覆又失敗）
   * 依已重試次數退避，不重置次數；kind／followUp 以最新一次失敗為準。
   */
  note(taskId: string, kind: DeptCreateRetryKind, followUp: string | null, now: number): void {
    this.inner.note(taskId, { kind, followUp }, now);
  }

  get(taskId: string): DeptCreateRetryEntry | null {
    const entry = this.inner.get(taskId);
    return entry ? { ...entry.payload, attempts: entry.attempts, notBefore: entry.notBefore } : null;
  }

  /** 是否輪到這張重試：有登記、次數未用盡、退避已過。 */
  shouldRetry(taskId: string, now: number): boolean {
    return this.inner.due(taskId, now);
  }

  /** 真的發動重試前呼叫：記一次並依新次數設退避，回傳這是第幾次（1 起算）。 */
  beginRetry(taskId: string, now: number): number {
    return this.inner.begin(taskId, now);
  }

  exhausted(taskId: string): boolean {
    return this.inner.exhausted(taskId);
  }

  /** 交辦已推進／終結／被手動接手時移除，停止追蹤。 */
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

export type DeptCreateRetryAction =
  | { kind: "drop" } // 不再追蹤：交辦消失／已被推進或終結
  | { kind: "wait" } // 保留追蹤，這輪不動：重試在跑、退避中、或工作區還沒空出來
  | { kind: "exhausted" } // 次數用盡：呼叫端發降級訊息（明確回報主人）並除名，不可靜默
  | { kind: "retry"; attempt: number; entry: DeptCreateRetryEntry }; // 發動重試：呼叫端依 entry.kind 走回原入口

/**
 * 對一張已登記的交辦決定這輪掃描要做什麼。shouldRetry→beginRetry 在同一次同步呼叫內
 * 完成（單執行緒），turn_end 掃與定期掃不會對同一張各發動一次；重試本體是長流程
 * （規劃 LLM 最長 90s）而退避最短 15s，靠 inFlight 擋住重疊發動。
 */
export function deptCreateRetryAction(
  tracker: DeptCreateRetryTracker,
  taskId: string,
  view: { status: string; stallKind: string | null; workspaceFree: boolean; providerReady: boolean; inFlight: boolean },
  now: number,
): DeptCreateRetryAction {
  const entry = tracker.get(taskId);
  if (!entry) return { kind: "drop" };
  if (view.status !== "needs_attention") return { kind: "drop" };
  // 結構化認領：task.stall.kind 不是本登記的標記（例如重試成功後改因派工被擋、換成
  // 用量受限、或任何路徑改寫 task.error 讓中央護欄清掉 stall）——這筆登記作廢，避免
  // 對已經建好部門的交辦再建一支重複部門、或與其他引擎互踩。不比對人類可讀文案，
  // 失敗訊息任意改寫、換語系都不影響認領。
  if (view.stallKind !== deptCreateStallKind(entry.kind)) return { kind: "drop" };
  if (view.inFlight) return { kind: "wait" };
  if (tracker.exhausted(taskId)) return { kind: "exhausted" };
  if (!tracker.shouldRetry(taskId, now)) return { kind: "wait" };
  // 條件未恢復（工作區還在跑 Mission、provider 沒就緒）不消耗次數——次數只花在真的建立嘗試上。
  if (!view.workspaceFree || !view.providerReady) return { kind: "wait" };
  return { kind: "retry", attempt: tracker.beginRetry(taskId, now), entry };
}
