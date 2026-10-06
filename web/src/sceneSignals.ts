import type { ApprovalItem, BossTask, CollaborationTask, DepartmentMission, Turn, WorkerState } from "./types";
import type { SceneHandoffStage, SceneMissionStep, ScenePlan } from "./game/sceneSignals";
import { turnTodoProgress } from "./todoProgress";

/* 場景信號：從 WorkerState（含回合／事件歷史）與協作／部門任務推導場景要畫的狀態旗標。
   欄位語意與型別對齊 game/sceneSignals.ts（WorkerSceneState 第二輪欄位）。
   全部是純函式——GameCanvas 在 visualWorkers 裡呼叫一次，結果同時餵 Pixi 場景與 DOM 名牌。 */

export type SceneSignals = {
  /** 最近一個真實回合失敗、而使用者還沒選取這位 NPC 看過。 */
  failedUnseen: boolean;
  /** 正在串流 assistant 文字（回覆打字中；不是工具、不是思考）。 */
  replying: boolean;
  /** 等 owner 決策（工具核准以外）：自動循環停下來問你、或自己帶的部門任務卡在需要你。 */
  asking: boolean;
  /** 協作交棒分段：outbound 剛交出、working 目標握棒在做、inbound 交回中。 */
  handoffStage: SceneHandoffStage | null;
  /** 本回合 TodoWrite 清單進度；閒置或沒列清單為 null。 */
  plan: ScenePlan | null;
  /** 所屬進行中部門任務的當前步驟；不在進行中任務裡為 null。 */
  missionStep: SceneMissionStep | null;
  /** 最終完成事件的 nonce（見 finalNoncesOf）；場景只在出現新的 nonce 時播一次大招。 */
  finalNonces: string[];
};

type SignalWorker = Pick<WorkerState, "id" | "busy" | "turns" | "openTextKey"> & Partial<Pick<WorkerState, "departmentId" | "workspacePath">>;

export function pendingApprovalFor(worker: Pick<WorkerState, "turns">): ApprovalItem | null {
  const last = worker.turns[worker.turns.length - 1];
  return last?.items.find((item): item is ApprovalItem => item.kind === "approval" && item.status === "pending") ?? null;
}

// 未回答的「循環問你」：自動循環停下時標成 autopilotAsk 的通知回合會是末尾那筆——owner 一旦發話
// 就會再疊上新回合，所以「最後一筆仍是 ask」即等於還沒回。
export function unansweredAutopilotAsk(worker: Pick<WorkerState, "turns">): boolean {
  return worker.turns[worker.turns.length - 1]?.autopilotAsk === true;
}

/** 最近一個真實回合（跳過系統回合與循環問你通知）若是失敗，回它的 key；否則 null。 */
export function latestErrorTurnKey(worker: Pick<WorkerState, "turns">): string | null {
  for (let i = worker.turns.length - 1; i >= 0; i--) {
    const turn: Turn = worker.turns[i];
    if (turn.system || turn.autopilotAsk) continue;
    return turn.status === "error" ? turn.key : null;
  }
  return null;
}

/** 失敗且未看過：選取中的 NPC 一律算已看（畫面正對著他）。 */
export function isFailedUnseen(worker: Pick<WorkerState, "id" | "turns">, seenErrorKey: string | undefined, activeId: string | null): boolean {
  if (worker.id === activeId) return false;
  const key = latestErrorTurnKey(worker);
  return key !== null && key !== seenErrorKey;
}

/** 正在串流 assistant 文字：回合進行中、且最後一個項目就是那段打開中的回覆。 */
export function isReplying(worker: Pick<WorkerState, "busy" | "turns" | "openTextKey">): boolean {
  if (!worker.busy || !worker.openTextKey) return false;
  const last = worker.turns[worker.turns.length - 1];
  if (!last || last.status !== "running") return false;
  const item = last.items[last.items.length - 1];
  return item?.kind === "assistant_text" && item.key === worker.openTextKey;
}

/**
 * 等 owner 拍板，但不是工具核准（那是 waiting，場景另有表現）：
 * 自動循環停下來問你，或這位是部門任務的主管、任務卡在 needs_attention（計畫核准、審查無結論…）。
 */
export function isAsking(worker: Pick<WorkerState, "id" | "turns">, mission?: DepartmentMission | null): boolean {
  if (unansweredAutopilotAsk(worker)) return true;
  return mission?.status === "needs_attention" && mission.bossWorkerId === worker.id;
}

/** 剛交出的協作在這段時間內算 outbound（交棒動畫的觸發點），之後轉 working。 */
export const OUTBOUND_WINDOW_MS = 4_000;

/**
 * 協作交棒分段。排隊中＝剛交出；執行中且剛開始（OUTBOUND_WINDOW_MS 內）也算剛交出，
 * 之後是 working；returning＝交回。重整／重連時開始時間早已過窗，直接是 working，不補播交棒。
 */
export function collaborationStage(collaboration: CollaborationTask | null | undefined, nowMs: number): SceneHandoffStage | null {
  if (!collaboration) return null;
  if (collaboration.status === "returning") return "inbound";
  if (collaboration.status === "queued") return "outbound";
  if (collaboration.status !== "running") return null;
  const started = Date.parse(collaboration.startedAt ?? collaboration.createdAt);
  return Number.isFinite(started) && nowMs - started < OUTBOUND_WINDOW_MS ? "outbound" : "working";
}

/** 只在忙碌時給：閒置後的舊清單只是雜訊。 */
export function planOf(worker: Pick<WorkerState, "busy" | "turns">): ScenePlan | null {
  if (!worker.busy) return null;
  return turnTodoProgress(worker.turns[worker.turns.length - 1]);
}

export function missionStepOf(mission: DepartmentMission | null | undefined): SceneMissionStep | null {
  if (!mission || mission.currentStepIndex == null) return null;
  const step = mission.steps[mission.currentStepIndex];
  if (!step) return null;
  return {
    missionId: mission.id,
    index: mission.currentStepIndex,
    total: mission.steps.length,
    kind: step.kind,
    assigneeId: step.assigneeWorkerId,
    status: step.status,
  };
}

/** 最近一個真實回合（跳過系統回合與循環問你通知）。 */
function latestRealTurn(worker: Pick<WorkerState, "turns">): Turn | null {
  for (let i = worker.turns.length - 1; i >= 0; i--) {
    const turn = worker.turns[i];
    if (turn.system || turn.autopilotAsk) continue;
    return turn;
  }
  return null;
}

/** 每類最終完成事件最多帶幾筆（最近的優先）——新完成的一定在裡面，舊的掉出去也不會重播。 */
export const FINAL_NONCE_LIMIT = 3;

function recent<T extends { completedAt: string | null }>(list: T[]): T[] {
  return [...list]
    .sort((a, b) => (Date.parse(b.completedAt ?? "") || 0) - (Date.parse(a.completedAt ?? "") || 0))
    .slice(0, FINAL_NONCE_LIMIT);
}

/** 部門任務歸屬：有部門看部門，沒有就看 workspace（同 visualWorkers 的判定）。 */
function sameDepartment(worker: Partial<Pick<WorkerState, "departmentId" | "workspacePath">>, mission: Pick<DepartmentMission, "departmentId" | "workspacePath">): boolean {
  if (worker.departmentId) return mission.departmentId === worker.departmentId;
  return Boolean(worker.workspacePath) && mission.workspacePath === worker.workspacePath;
}

/**
 * 「整件事真的做完」的事件 nonce——場景據此分「階段完成」與「最終完成」：
 * (a) turn:<key>：最近的真實回合成功結束，且該回合 TodoWrite 清單全部 completed（total>0）。
 * (b) mission:<id>：這位 NPC 參與（主管或任一步負責人）的部門任務 status=completed。
 * (c) boss:<id>：交辦任務 status=completed，且這位 NPC 的部門在它的某個 stage 裡。
 * nonce 本身不代表「剛剛」：場景第一次看到時全部當基準，之後新出現的才播（重整／重連不重播）。
 */
export function finalNoncesOf(
  worker: SignalWorker,
  missions: readonly DepartmentMission[] = [],
  bossTasks: readonly BossTask[] = [],
): string[] {
  const out: string[] = [];
  const last = latestRealTurn(worker);
  if (last?.status === "done") {
    const plan = turnTodoProgress(last);
    if (plan && plan.total > 0 && plan.done === plan.total) out.push(`turn:${last.key}`);
  }
  const doneMissions = missions.filter((mission) =>
    mission.status === "completed" && sameDepartment(worker, mission) &&
    (mission.bossWorkerId === worker.id || mission.steps.some((step) => step.assigneeWorkerId === worker.id)),
  );
  for (const mission of recent(doneMissions)) out.push(`mission:${mission.id}`);
  if (worker.departmentId) {
    const doneTasks = bossTasks.filter((task) =>
      task.status === "completed" && task.stages.some((stage) => stage.departmentId === worker.departmentId),
    );
    for (const task of recent(doneTasks)) out.push(`boss:${task.id}`);
  }
  return out;
}

export function sceneSignals(
  worker: SignalWorker,
  context: {
    activeId: string | null;
    seenErrorKey?: string;
    mission?: DepartmentMission | null;
    collaboration?: CollaborationTask | null;
    nowMs?: number;
    /** 全部部門任務（含已完成）——最終完成 (b) 用。 */
    missions?: readonly DepartmentMission[];
    /** 全部交辦任務——最終完成 (c) 用。 */
    bossTasks?: readonly BossTask[];
  },
): SceneSignals {
  return {
    failedUnseen: isFailedUnseen(worker, context.seenErrorKey, context.activeId),
    replying: isReplying(worker),
    asking: isAsking(worker, context.mission),
    handoffStage: collaborationStage(context.collaboration, context.nowMs ?? Date.now()),
    plan: planOf(worker),
    missionStep: missionStepOf(context.mission),
    finalNonces: finalNoncesOf(worker, context.missions, context.bossTasks),
  };
}

/* 「看過的失敗」跨重整保留：不然每次重開頁面，所有歷史上最後一回合失敗的 NPC 都會亮紅。 */
const SEEN_STORAGE_KEY = "pixel-crew.failedSeen";

function defaultStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

export function loadSeenErrors(storage?: Pick<Storage, "getItem"> | null): Map<string, string> {
  try {
    const raw = (storage === undefined ? defaultStorage() : storage)?.getItem(SEEN_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    return new Map(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return new Map();
  }
}

export function saveSeenErrors(seen: ReadonlyMap<string, string>, storage?: Pick<Storage, "setItem"> | null): void {
  try {
    (storage === undefined ? defaultStorage() : storage)?.setItem(SEEN_STORAGE_KEY, JSON.stringify(Object.fromEntries(seen)));
  } catch {
    /* 隱私模式／配額滿：只是少了跨重整記憶 */
  }
}

/**
 * 把「選取中的 NPC 最近一次失敗」記成已看；有變動回 true（呼叫端據此存檔）。
 * 也順手清掉已不在名單上的 NPC，避免存檔無限長大。
 */
export function markErrorSeen(seen: Map<string, string>, workers: ReadonlyArray<Pick<WorkerState, "id" | "turns">>, activeId: string | null): boolean {
  let changed = false;
  const ids = new Set(workers.map((worker) => worker.id));
  // 名單還沒到（snapshot 前是空的）時不清，免得把存檔洗掉。
  if (ids.size > 0) for (const id of [...seen.keys()]) {
    if (!ids.has(id)) { seen.delete(id); changed = true; }
  }
  const active = activeId ? workers.find((worker) => worker.id === activeId) : undefined;
  const key = active ? latestErrorTurnKey(active) : null;
  if (active && key && seen.get(active.id) !== key) {
    seen.set(active.id, key);
    changed = true;
  }
  return changed;
}
