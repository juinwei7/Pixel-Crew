// 第二輪場景訊號：WorkerSceneState 新欄位的型別，以及場景據此做決定的純邏輯
// （分層完成、工作站黏性、交棒觸發、待辦紙進度）。這裡不碰 Pixi，方便單元測試；
// scene.ts / person.ts / personalDesks.ts 只畫這些函式決定的東西。
import type { StationKey } from "../stations";
import type { CharacterState } from "../types";

/** NPC 的 TodoWrite 計畫進度：done＝已完成項數，total＝總項數（total 0＝沒有計畫）。 */
export type ScenePlan = { done: number; total: number };

/**
 * 協作交棒分段（掛在協作兩端的 NPC 身上，scene 以 collaborationRole/PartnerId 找對方）：
 * - outbound：來源把工作交給對方（剛開始協作）→ 來源→目標 交棒動畫一次
 * - working：目標手上握著棒子在做事 → 目標身上畫一根小棒
 * - inbound：目標把成果交回（returning）→ 目標→來源 交棒動畫一次
 */
export type SceneHandoffStage = "outbound" | "working" | "inbound";

/** 部門任務當前步驟（該 NPC 所屬、進行中的 mission）。 */
export type SceneMissionStep = {
  missionId: string;
  /** 0 起算的當前步驟序號。 */
  index: number;
  total: number;
  kind: "execute" | "review" | "consult" | "synthesize";
  assigneeId: string;
  status: "pending" | "running" | "completed" | "failed";
};

// ---------------------------------------------------------------- 分層完成

export type CompletionTier = "none" | "tool-ok" | "tool-fail" | "turn-ok" | "turn-fail";

/**
 * 這次角色狀態更新要播哪一層的完成表現：
 * 工具呼叫回來（outcome=tool）只播小勾／小紅點；回合結束（outcome=turn，或舊資料沒帶 outcome）
 * 才播完整慶祝；失敗回合只有失敗反應、不慶祝。bump 沒變或 mood=neutral＝不是完成事件。
 */
export function completionTier(prev: CharacterState | null, next: CharacterState): CompletionTier {
  if (!prev || prev.bump === next.bump || next.mood === "neutral") return "none";
  const ok = next.mood === "success";
  if (next.outcome === "tool") return ok ? "tool-ok" : "tool-fail";
  return ok ? "turn-ok" : "turn-fail";
}

// ---------------------------------------------------------------- 工作站黏性

/** 工具之間的短暫空檔（思考／講話／站位資料閃回 home）最多在站點等這麼久，再走回座位。 */
export const TOOL_GAP_HOLD_MS = 6_000;
/** 回合結束後在站點多留一下（讓結果螢幕看得到），再走回座位。 */
export const TURN_END_HOLD_MS = 1_500;

export type StationHold = { station: StationKey; until: number } | null;

function isToolStation(station: StationKey | null): station is StationKey {
  return station !== null && station !== "home" && station !== "meeting";
}

/**
 * 工作站黏性：角色狀態從某個工具站跳回 home 時，不立刻走回座位——
 * 先在原站點等（TOOL_GAP_HOLD_MS；回合結束則 TURN_END_HOLD_MS），期間下一個工具若在同一站
 * 就原地繼續，換站則直接從這站走過去，不再「走回家又走回來」。
 * `shown` 是場景目前顯示的站點；回傳這一刻該顯示的站點與更新後的 hold。
 */
export function heldStation(
  shown: StationKey | null,
  incoming: Pick<CharacterState, "station" | "mood" | "outcome">,
  hold: StationHold,
  now: number,
): { station: StationKey; hold: StationHold } {
  if (incoming.station !== "home") return { station: incoming.station, hold: null };
  const turnEnded = incoming.outcome === "turn" && incoming.mood !== "neutral";
  if (hold) {
    const until = turnEnded ? Math.min(hold.until, now + TURN_END_HOLD_MS) : hold.until;
    if (now >= until) return { station: "home", hold: null };
    return { station: hold.station, hold: until === hold.until ? hold : { station: hold.station, until } };
  }
  if (isToolStation(shown)) {
    return { station: shown, hold: { station: shown, until: now + (turnEnded ? TURN_END_HOLD_MS : TOOL_GAP_HOLD_MS) } };
  }
  return { station: "home", hold: null };
}

// ---------------------------------------------------------------- 交棒

export type BatonPass = { from: string; to: string };

type HandoffWorker = {
  id: string;
  handoffStage?: SceneHandoffStage | null;
  collaborationRole?: "source" | "target" | null;
  collaborationPartnerId?: string | null;
  missionStep?: SceneMissionStep | null;
};

/**
 * 協作交棒：每對（來源>目標）看分段變化，進入 outbound 時來源→目標、進入 inbound 時目標→來源各交棒一次。
 * 分段取來源身上的值，沒有就取目標的。回傳新的 seen（下次比對用）與這次要播的交棒。
 */
export function handoffBatons(
  prev: ReadonlyMap<string, SceneHandoffStage>,
  list: readonly HandoffWorker[],
): { seen: Map<string, SceneHandoffStage>; passes: BatonPass[] } {
  const byId = new Map(list.map((w) => [w.id, w]));
  const seen = new Map<string, SceneHandoffStage>();
  const passes: BatonPass[] = [];
  for (const w of list) {
    if (!w.collaborationPartnerId || !w.collaborationRole) continue;
    const source = w.collaborationRole === "source" ? w.id : w.collaborationPartnerId;
    const target = w.collaborationRole === "source" ? w.collaborationPartnerId : w.id;
    const key = `${source}>${target}`;
    if (seen.has(key)) continue;
    const stage = byId.get(source)?.handoffStage ?? byId.get(target)?.handoffStage ?? null;
    if (!stage) continue;
    seen.set(key, stage);
    if (prev.get(key) === stage || !byId.has(source) || !byId.has(target)) continue;
    if (stage === "outbound") passes.push({ from: source, to: target });
    else if (stage === "inbound") passes.push({ from: target, to: source });
  }
  return { seen, passes };
}

/**
 * 部門任務換手：同一個 mission 的當前步驟負責人換人時，上一棒→下一棒交棒一次。
 * 第一次看到的 mission 只記錄、不播（載入／重連時不補播）。
 */
export function missionBatons(
  prev: ReadonlyMap<string, string>,
  list: readonly HandoffWorker[],
): { seen: Map<string, string>; passes: BatonPass[] } {
  const ids = new Set(list.map((w) => w.id));
  const seen = new Map<string, string>();
  const passes: BatonPass[] = [];
  for (const w of list) {
    const step = w.missionStep;
    if (!step || seen.has(step.missionId)) continue;
    seen.set(step.missionId, step.assigneeId);
    const before = prev.get(step.missionId);
    if (before && before !== step.assigneeId && ids.has(before) && ids.has(step.assigneeId)) {
      passes.push({ from: before, to: step.assigneeId });
    }
  }
  return { seen, passes };
}

// ---------------------------------------------------------------- 待辦紙

/** 待辦紙上的進度條寬度（像素），用來畫 done/total；沒有計畫回 null。 */
export const PLAN_BAR_PX = 4;

export function planPaper(plan: ScenePlan | null | undefined): { filled: number; complete: boolean } | null {
  if (!plan) return null;
  const total = Math.max(0, Math.floor(plan.total));
  if (total <= 0) return null;
  const done = Math.max(0, Math.min(total, Math.floor(plan.done)));
  // 有做一點就至少一格，還沒全部做完就不滿格——兩端都看得出差別。
  let filled = Math.round((done / total) * PLAN_BAR_PX);
  if (done > 0 && filled === 0) filled = 1;
  if (done < total && filled === PLAN_BAR_PX) filled = PLAN_BAR_PX - 1;
  return { filled, complete: done === total };
}

// ---------------------------------------------------------------- 最終完成

/**
 * 最終完成只在「出現新的 nonce」那一刻觸發一次。`seen` 為 null＝這位 NPC 第一次被場景看到
 * （載入／重整）：當下的 nonce 全部當基準、不播。之後名單裡出現沒看過的 nonce 才算新的最終完成。
 * 看過的 nonce 一直記著（掉出名單再回來也不重播）。
 */
export function finalTrigger(
  seen: ReadonlySet<string> | null,
  nonces: readonly string[] | null | undefined,
): { seen: Set<string>; fresh: boolean } {
  const list = nonces ?? [];
  if (seen === null) return { seen: new Set(list), fresh: false };
  let fresh = false;
  const next = new Set(seen);
  for (const nonce of list) {
    if (next.has(nonce)) continue;
    next.add(nonce);
    fresh = true;
  }
  return { seen: next, fresh };
}
