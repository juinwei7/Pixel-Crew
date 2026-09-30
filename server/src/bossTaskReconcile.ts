// 重啟殭屍交辦的和解決策（卡點盤點 P0-1/P0-2）——
// discovering（探索）與 synthesizing（驗收核對）都是純記憶體 async：App 重啟/崩潰後
// 結果永遠不會回來，交辦卡在該狀態，而 /restart 又對「執行中」一律 409，連手動重開
// 都被擋，只剩取消重建一途。這裡放開機和解與 409 放行的純決策，index.ts 與單測共用。

export type ReconcileStageView = { status: string };

export type SynthesizingZombieAction = "resynthesize" | "needs_attention";

/** synthesizing 殭屍怎麼收：各部門交付都在（stages 全 completed）就打回 running 重新驗收；
 *  否則（探索沒排出 stage、或有 stage 沒跑完就進了 synthesizing 的異常形狀）誠實轉 needs_attention。 */
export function synthesizingZombieAction(stages: ReconcileStageView[]): SynthesizingZombieAction {
  return stages.length > 0 && stages.every((stage) => stage.status === "completed")
    ? "resynthesize"
    : "needs_attention";
}

/** /restart 是否該以「正在整理交辦內容」409：只擋本程序真的有背景在跑的
 *  discovering/synthesizing；重啟殭屍（狀態卡著但沒有任何 in-flight 工作）放行，讓手動重開能救。 */
export function restartBlockedByActiveWork(view: {
  status: string;
  discoveryInFlight: boolean;
  synthesisInFlight: boolean;
}): boolean {
  if (view.status === "discovering") return view.discoveryInFlight;
  if (view.status === "synthesizing") return view.synthesisInFlight;
  return false;
}

/** 探索 in-flight 計數（decideBossTask 會遞迴：建部門失敗後降級重決策，Set 會被內層 finally 誤清）。 */
export class BossTaskWorkCounter {
  private readonly depth = new Map<string, number>();

  enter(taskId: string): void {
    this.depth.set(taskId, (this.depth.get(taskId) ?? 0) + 1);
  }

  exit(taskId: string): void {
    const next = (this.depth.get(taskId) ?? 0) - 1;
    if (next <= 0) this.depth.delete(taskId);
    else this.depth.set(taskId, next);
  }

  inFlight(taskId: string): boolean {
    return this.depth.has(taskId);
  }
}
