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

// ── 長流程 await 後的快照重讀（交互審查 #6）───────────────────────────────
// 決策、建專屬部門、自動循環代答都要跑一兩分鐘的 LLM；store 每次讀取回新物件，手上那份是
// await 前的快照。期間老闆可能取消、刪除、親自回覆，或另一條重試路徑已接手——照舊套用就會
// 整列蓋回去（saveBossTask 是 upsert，連刪掉的列都會復活），已取消的交辦甚至會被真的派工。

/** 重讀到的權威狀態是否仍與快照同一階段：交辦還在、沒被取消／判失敗、狀態沒被別條路徑推動。
 *  回 true 才能把快照上的變更寫回；type guard 讓呼叫端直接拿 live 接著用。 */
export function snapshotStillCurrent<T extends { status: string }>(snapshotStatus: string, live: T | null | undefined): live is T {
  return !!live && live.status !== "cancelled" && live.status !== "failed" && live.status === snapshotStatus;
}

type QuestionView = { status: string; messages: Array<{ id: string; role: string }> };

function latestQuestionId(task: QuestionView): string | null {
  for (let index = task.messages.length - 1; index >= 0; index -= 1) {
    if (task.messages[index].role === "decision_model") return task.messages[index].id;
  }
  return null;
}

/** 自動代答前確認當初那一題還懸著：仍是 needs_input，且最新一題就是拿去代答的那題。老闆期間親自
 *  回覆、決策模型又問了新的一題時狀態一樣是 needs_input，但手上的答案已經答非所問。 */
export function pendingQuestionUnchanged<T extends QuestionView>(snapshot: QuestionView, live: T | null | undefined): live is T {
  return snapshotStillCurrent("needs_input", live) && latestQuestionId(live) === latestQuestionId(snapshot);
}

/** 為交辦剛開的臨時團隊在第二輪決策後是否該收掉：交辦已不在、被取消，或沒有任何 stage 指向它
 *  （決策失敗、改問老闆問題）——取消／刪除／封存的清理都靠 stages 找隊，掃不到它就成了孤兒。 */
export function newCrewOrphaned(live: { status: string; stages: Array<{ departmentId: string }> } | null | undefined, crewId: string): boolean {
  return !live || live.status === "cancelled" || !live.stages.some((stage) => stage.departmentId === crewId);
}
