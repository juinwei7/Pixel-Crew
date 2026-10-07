// Mission 步驟派工卡住的自動重派 —— needs_attention 全庫盤點（2026-09-30 續篇）發現的
// mission 層同款缺口：dispatchMissionStep 遇到被指派 NPC 忙碌（busy／交接中／協作中）
// 或 provider 未登入時 pauseMission 成 needs_attention，之後沒有任何機制在 NPC 空出／
// 登入後自動重派。bossDispatchRetry 只涵蓋交辦「派工前」的卡住（isPreDispatchStall
// 明確排除 stage 已 needs_attention 的形狀），這種「mission 進行中、某一步派不出去」
// 的卡死只能等人工回覆或開 autoResolve 燒 LLM。
//
// 這裡只放純決策（分類守衛＋退避次數），退避內核共用 backoffRetry.ts；實際的
// NPC 空閒檢查、dispatchMissionStep 呼叫與 turn_end／定期掃描掛勾在 index.ts。
// 追蹤器是記憶體態：重啟後不重建（priorReview 與步驟對應無法從落地資料安全還原，
// 退回既有行為等人工，不誤動作——與追問路徑的取捨相同）。
import { BackoffRetryTracker, type BackoffEntry, type BackoffPolicy } from "./backoffRetry.js";

export const MISSION_STEP_RETRY_MAX_ATTEMPTS = 5;
export const MISSION_STEP_RETRY_POLICY: BackoffPolicy = {
  baseMs: 10_000,
  capMs: 60_000,
  maxAttempts: MISSION_STEP_RETRY_MAX_ATTEMPTS,
};

/** priorReview 泛型：index.ts 存 parseCollaborationResult 的結果，重派時原樣傳回 dispatchMissionStep。 */
export type MissionStepRetryPayload<R = unknown> = {
  stepIndex: number;
  assigneeWorkerId: string;
  /** pauseMission 寫進 mission.error 的文案——守衛用：文案變了代表人已介入或換了卡法。 */
  pausedError: string;
  priorReview: R;
};

export type MissionStepRetryView = {
  status: string;
  attentionReason: string | null;
  error: string | null;
  /** 追蹤的那一步現在的狀態（找不到步驟給 null）。 */
  stepStatus: string | null;
  stepAssigneeId: string | null;
  assigneePresent: boolean;
  /** 空閒且可派：不忙、無交接／協作、provider 已登入（dispatchMissionStep 的完整前置檢查）。 */
  assigneeReady: boolean;
};

export type MissionStepRetryAction<R = unknown> =
  | { kind: "drop" } // 不再追蹤：人已介入／已重新指派／已推進或終結／NPC 消失
  | { kind: "wait" } // 保留追蹤，這輪不動：退避中或 NPC 還沒空出
  | { kind: "exhausted"; payload: MissionStepRetryPayload<R> } // 次數用盡：呼叫端更新 mission.error 明確告知並除名
  | { kind: "retry"; attempt: number; payload: MissionStepRetryPayload<R> }; // 發動重派：呼叫端清 attention 並 dispatchMissionStep

/**
 * 對一筆已登記的 mission 決定這輪掃描要做什麼。due→begin 在同一次同步呼叫內完成，
 * turn_end 掃與定期掃不可能對同一筆各發動一次（單執行緒＋begin 立即進退避）。
 */
export function missionStepRetryAction<R>(
  tracker: BackoffRetryTracker<MissionStepRetryPayload<R>>,
  missionId: string,
  view: MissionStepRetryView,
  now: number,
): MissionStepRetryAction<R> {
  const entry: BackoffEntry<MissionStepRetryPayload<R>> | null = tracker.get(missionId);
  if (!entry) return { kind: "drop" };
  const payload = entry.payload;
  // 只重派「還停在當初那個卡法」的 mission：狀態推進、人工解卡（error 會清掉或改寫）、
  // 換了一種 needs_attention 都放手，不跟人搶。
  if (view.status !== "needs_attention" || view.attentionReason !== "member_unavailable") return { kind: "drop" };
  if (view.error !== payload.pausedError) return { kind: "drop" };
  if (view.stepStatus !== "pending") return { kind: "drop" };
  if (view.stepAssigneeId !== payload.assigneeWorkerId) return { kind: "drop" }; // 已被手動重新指派
  if (!view.assigneePresent) return { kind: "drop" }; // NPC 已消失——那是永久性缺人，留給人工
  if (tracker.exhausted(missionId)) return { kind: "exhausted", payload };
  if (!tracker.due(missionId, now)) return { kind: "wait" };
  if (!view.assigneeReady) return { kind: "wait" };
  return { kind: "retry", attempt: tracker.begin(missionId, now), payload };
}
