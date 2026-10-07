// 共用的「登記＋指數退避＋次數上限」重試引擎——bossDeptCreateRetry（P1-3 建立失敗）
// 與 bossUsageRetry（P1-5 用量恢復）內核相同，抽到這裡避免複製貼上；各自的閘門條件
// （工作區空出／用量恢復）與降級文案留在各自模組與 index.ts。
export type BackoffPolicy = { baseMs: number; capMs: number; maxAttempts: number };

/** 指數退避：base × 2^attempts，封頂 cap。attempts 是「已嘗試次數」。 */
export function backoffDelayMs(policy: BackoffPolicy, attempts: number): number {
  return Math.min(policy.baseMs * 2 ** Math.max(0, attempts), policy.capMs);
}

export type BackoffEntry<P> = { payload: P; attempts: number; notBefore: number };

export class BackoffRetryTracker<P> {
  private readonly entries = new Map<string, BackoffEntry<P>>();

  constructor(private readonly policy: BackoffPolicy) {}

  /**
   * 失敗時登記。首次登記也從基本退避起算；已登記者（重試又失敗、或使用者手動介入
   * 又失敗）依已嘗試次數退避，不重置次數；payload 以最新一次失敗為準。
   */
  note(id: string, payload: P, now: number): void {
    const attempts = this.entries.get(id)?.attempts ?? 0;
    this.entries.set(id, { payload, attempts, notBefore: now + backoffDelayMs(this.policy, attempts) });
  }

  get(id: string): BackoffEntry<P> | null {
    return this.entries.get(id) ?? null;
  }

  /** 是否輪到這筆：有登記、次數未用盡、退避已過。 */
  due(id: string, now: number): boolean {
    const entry = this.entries.get(id);
    return !!entry && entry.attempts < this.policy.maxAttempts && now >= entry.notBefore;
  }

  /** 真的發動嘗試前呼叫：記一次並依新次數設退避，回傳這是第幾次（1 起算；未登記回 0）。 */
  begin(id: string, now: number): number {
    const entry = this.entries.get(id);
    if (!entry) return 0;
    entry.attempts += 1;
    entry.notBefore = now + backoffDelayMs(this.policy, entry.attempts);
    return entry.attempts;
  }

  exhausted(id: string): boolean {
    const entry = this.entries.get(id);
    return !!entry && entry.attempts >= this.policy.maxAttempts;
  }

  /** 已推進／終結／被手動接手時移除，停止追蹤。 */
  resolve(id: string): void {
    this.entries.delete(id);
  }

  trackedIds(): string[] {
    return [...this.entries.keys()];
  }

  get size(): number {
    return this.entries.size;
  }
}
