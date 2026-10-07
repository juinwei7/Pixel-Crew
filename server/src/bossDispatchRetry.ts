// 交辦派工卡住的自動重派追蹤器 —— 2026-09-30 autoResolve 實測確認的結構性缺口：
// 派工被 missionDepartmentEligibility 擋下（最常見：部門主管正是對話中的 worker）時，
// 交辦落入 needs_attention，而「回覆交辦」只做立即同步重試——主管沒空就再失敗，
// 之後沒有任何機制在主管閒置時自動重派，掛機情境下永遠卡死。
//
// 這裡只放純狀態機（登記／冷卻／次數上限），方便單測；實際的 eligibility 檢查、
// advanceBossTask 呼叫與 turn_end / 定期掃描掛勾在 index.ts。
export const BOSS_DISPATCH_RETRY_MAX_ATTEMPTS = 5;
export const BOSS_DISPATCH_RETRY_COOLDOWN_MS = 10_000;

export type BossDispatchRetryEntry = { attempts: number; notBefore: number };

export class BossDispatchRetryTracker {
  private readonly entries = new Map<string, BossDispatchRetryEntry>();

  /**
   * 派工卡住時登記。首次登記不設冷卻——主管一空出就能立刻重派；
   * 已登記者（重派後又卡回來、或使用者手動回覆又失敗）只延後冷卻，不重置次數。
   */
  note(taskId: string, now: number): void {
    const entry = this.entries.get(taskId);
    if (entry) { entry.notBefore = now + BOSS_DISPATCH_RETRY_COOLDOWN_MS; return; }
    this.entries.set(taskId, { attempts: 0, notBefore: now });
  }

  /** 是否輪到這張重派：有登記、次數未用盡、冷卻已過。 */
  shouldRetry(taskId: string, now: number): boolean {
    const entry = this.entries.get(taskId);
    return !!entry && entry.attempts < BOSS_DISPATCH_RETRY_MAX_ATTEMPTS && now >= entry.notBefore;
  }

  /** 真的發動重派前呼叫：記一次並設冷卻，回傳這是第幾次（1 起算）。 */
  beginRetry(taskId: string, now: number): number {
    const entry = this.entries.get(taskId) ?? { attempts: 0, notBefore: 0 };
    entry.attempts += 1;
    entry.notBefore = now + BOSS_DISPATCH_RETRY_COOLDOWN_MS;
    this.entries.set(taskId, entry);
    return entry.attempts;
  }

  exhausted(taskId: string): boolean {
    const entry = this.entries.get(taskId);
    return !!entry && entry.attempts >= BOSS_DISPATCH_RETRY_MAX_ATTEMPTS;
  }

  /** 交辦已派出／終結／不再適用時移除，停止追蹤。 */
  resolve(taskId: string): void {
    this.entries.delete(taskId);
  }

  trackedIds(): string[] {
    return [...this.entries.keys()];
  }

  get size(): number {
    return this.entries.size;
  }
}

// ── 掃描決策（純函式，index.ts 的 sweep 與單測共用）─────────────────────────

export type DispatchRetryStageView = { id: string; status: string; dependsOn: string[] };

/** 依賴都完成的下一個 pending stage——與 advanceBossTaskStages 的派工挑選邏輯一致。 */
export function runnableNextStage<S extends DispatchRetryStageView>(stages: S[]): S | null {
  const completedIds = new Set(stages.filter((stage) => stage.status === "completed").map((stage) => stage.id));
  return stages.find((stage) => stage.status === "pending" && stage.dependsOn.every((dep) => completedIds.has(dep))) ?? null;
}

/** 這張交辦現在是不是「派工前卡住」的形狀（也是重啟後重建追蹤的判定）。 */
export function isPreDispatchStall(view: { status: string; stages: DispatchRetryStageView[] }): boolean {
  if (view.status !== "needs_attention") return false;
  if (view.stages.some((stage) => stage.status === "running" || stage.status === "needs_attention")) return false;
  return runnableNextStage(view.stages) !== null;
}

export type DispatchRetryAction =
  | { kind: "drop" } // 不再追蹤：已派出/終結/形狀不符/主管消失
  | { kind: "wait" } // 保留追蹤，這輪不動：冷卻中或部門還沒空出來
  | { kind: "exhausted" } // 次數用盡：呼叫端發提示訊息並除名
  | { kind: "retry"; attempt: number }; // 發動重派：呼叫端記訊息並 advanceBossTask

/**
 * 對一張已登記的交辦決定這輪掃描要做什麼。shouldRetry→beginRetry 在同一次同步呼叫內
 * 完成，turn_end 掃與定期掃不可能對同一張各發動一次（單執行緒＋beginRetry 立即進冷卻）。
 */
export function dispatchRetryAction(
  tracker: BossDispatchRetryTracker,
  taskId: string,
  view: { status: string; stages: DispatchRetryStageView[]; leadPresent: boolean; leadEligible: boolean },
  now: number,
): DispatchRetryAction {
  if (!isPreDispatchStall(view)) return { kind: "drop" };
  if (!view.leadPresent) return { kind: "drop" };
  if (tracker.exhausted(taskId)) return { kind: "exhausted" };
  if (!tracker.shouldRetry(taskId, now)) return { kind: "wait" };
  if (!view.leadEligible) return { kind: "wait" };
  return { kind: "retry", attempt: tracker.beginRetry(taskId, now) };
}
