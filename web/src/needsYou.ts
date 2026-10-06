// 「需要你」的唯一來源：全 App（頂欄徽章、隊員列、桌面通知、接下一件、場景分流條）
// 都從這裡拿同一份排序好的清單，不再各自用不同條件判斷「誰在等你」。
// 全部是純函式：不碰 DOM、不送請求、不讀時鐘（now 由呼叫端傳進來）。
import type { ApprovalItem, Turn, WorkerState } from "./types";

/** 需要你處理的種類，依優先序排列（越前面越急）。
 *  - approval：工具呼叫卡在等你核准，NPC 停住了。
 *  - decision：自動循環停下來要你拍板（autopilotAsk 回合）。
 *  - question：NPC 回合結束時在問你問題（最後一段回覆以問號收尾）。
 *  - failed：回合失敗，你還沒點進去看過。
 *  - stuck：還在跑，但很久沒有任何進展。 */
export type NeedsYouKind = "approval" | "decision" | "question" | "failed" | "stuck";

export const NEEDS_YOU_PRIORITY: Record<NeedsYouKind, number> = {
  approval: 0,
  decision: 1,
  question: 2,
  failed: 3,
  stuck: 4,
};

export type NeedsYouItem = {
  /** 穩定 key：同一件事在多次 render 間不變（通知去重、React key 用）。 */
  key: string;
  workerId: string;
  workerName: string;
  kind: NeedsYouKind;
  /** 卡片摘要（核准標題／問題末句／失敗指令），已壓成單行。 */
  detail: string;
  /** 對應回合（跳過去時可捲到這張卡）。 */
  turnKey: string | null;
  /** 只有 approval 有：待核准請求 id。 */
  approvalId?: string;
  /** 只有 stuck 有：已經多久沒進展（ms）。 */
  idleMs?: number;
};

/** 進度追蹤表：每位 NPC 最近一次「有變化」的簽章與時間。 */
export type ProgressMap = Record<string, { sig: string; at: number }>;

export type CollectNeedsYouOptions = {
  /** 使用者已經看過的回合 key（workerId → turnKey）；失敗／問題看過就不再算。 */
  seenTurnKeys?: Record<string, string | null | undefined>;
  /** 進度追蹤表（trackProgress 的輸出）；沒給就不判斷「卡住」。 */
  progress?: ProgressMap;
  now?: number;
  /** 多久沒進展算卡住（ms），預設 STUCK_AFTER_MS。 */
  stuckAfterMs?: number;
};

/** 預設：執行中 6 分鐘沒有任何新輸出／工具進度，就標成卡住。 */
export const STUCK_AFTER_MS = 6 * 60_000;

function lastTurn(worker: WorkerState): Turn | undefined {
  return worker.turns[worker.turns.length - 1];
}

function oneLine(text: string, max = 60): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

/** 目前回合裡等你核准的那張卡（沒有就 null）。crew.ts／notifications.ts 共用這個判斷。 */
export function pendingApproval(worker: WorkerState): ApprovalItem | null {
  const last = lastTurn(worker);
  const item = last?.items.find((candidate) => candidate.kind === "approval" && candidate.status === "pending");
  return item && item.kind === "approval" ? item : null;
}

/** 回合最後一段助理文字（沒有就空字串）。 */
function lastAssistantText(turn: Turn): string {
  for (let index = turn.items.length - 1; index >= 0; index--) {
    const item = turn.items[index];
    if (item.kind === "assistant_text") return item.text;
  }
  return "";
}

/** 回覆是不是以「問你」收尾：最後一個非空白行以問號結束（全形/半形），
 *  忽略結尾的 markdown 粗體／括號等符號。只看最後一行，避免把中途的修辭問句算進來。 */
export function endsWithQuestion(text: string): boolean {
  const lines = text.trim().split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const tail = lines[lines.length - 1] ?? "";
  const stripped = tail.replace(/[\s*_`)）」』"'\]]+$/u, "");
  return /[?？]$/.test(stripped);
}

/** 單一 NPC 目前「需要你」的那件事（一位 NPC 最多一件，取最急的）。 */
export function workerNeedsYou(worker: WorkerState, options: CollectNeedsYouOptions = {}): NeedsYouItem | null {
  const last = lastTurn(worker);
  const base = { workerId: worker.id, workerName: worker.name, turnKey: last?.key ?? null };
  const approval = pendingApproval(worker);
  if (approval) {
    return { ...base, key: `approval:${worker.id}:${approval.request.id}`, kind: "approval", detail: oneLine(approval.request.title ?? ""), approvalId: approval.request.id };
  }
  // 短命 NPC（作戰室成員、研究員、交辦專屬工）的失敗／提問由編排器收尾，不打擾你；
  // 只有核准是真的卡在你身上。
  if (worker.ephemeralKind) return null;
  if (!last) return null;
  const seen = options.seenTurnKeys?.[worker.id];
  if (!worker.busy) {
    if (last.autopilotAsk) {
      return { ...base, key: `decision:${worker.id}:${last.key}`, kind: "decision", detail: oneLine(lastAssistantText(last) || last.command) };
    }
    if (last.status === "error" && seen !== last.key) {
      return { ...base, key: `failed:${worker.id}:${last.key}`, kind: "failed", detail: oneLine(last.command) };
    }
    if (last.status === "done" && seen !== last.key) {
      const text = lastAssistantText(last);
      if (text && endsWithQuestion(text)) {
        const lines = text.trim().split(/\n+/).filter((line) => line.trim());
        return { ...base, key: `question:${worker.id}:${last.key}`, kind: "question", detail: oneLine(lines[lines.length - 1] ?? text) };
      }
    }
    return null;
  }
  const stuck = stuckFor(worker, options.progress, options.now, options.stuckAfterMs);
  if (stuck !== null) {
    return { ...base, key: `stuck:${worker.id}:${last.key}`, kind: "stuck", detail: oneLine(last.command), idleMs: stuck };
  }
  return null;
}

/** 收集全隊需要你的事，排序：種類優先序 → 隊員順序（輸入陣列順序）。穩定、可重現。 */
export function collectNeedsYou(workers: readonly WorkerState[], options: CollectNeedsYouOptions = {}): NeedsYouItem[] {
  const items: Array<{ item: NeedsYouItem; index: number }> = [];
  workers.forEach((worker, index) => {
    const item = workerNeedsYou(worker, options);
    if (item) items.push({ item, index });
  });
  items.sort((a, b) => NEEDS_YOU_PRIORITY[a.item.kind] - NEEDS_YOU_PRIORITY[b.item.kind] || a.index - b.index);
  return items.map((entry) => entry.item);
}

/** 「接下一件」：目前看的是 currentId，回傳清單裡的下一位（循環）。
 *  current 不在清單裡＝從最急的那件開始。清單空＝null。 */
export function nextNeedsYou(items: readonly NeedsYouItem[], currentId: string | null): NeedsYouItem | null {
  if (items.length === 0) return null;
  const index = currentId ? items.findIndex((item) => item.workerId === currentId) : -1;
  if (index < 0) return items[0];
  return items[(index + 1) % items.length] ?? null;
}

/** 頂欄徽章要的摘要。stuck 不算進「需要你」的數字（那是提醒，不是待辦）。 */
export function needsYouSummary(items: readonly NeedsYouItem[]): { count: number; first: NeedsYouItem | null; kinds: NeedsYouKind[] } {
  const actionable = items.filter((item) => item.kind !== "stuck");
  const kinds = [...new Set(actionable.map((item) => item.kind))];
  return { count: actionable.length, first: actionable[0] ?? null, kinds };
}

/** 以 workerId 索引，隊員列每一行查自己有沒有事。 */
export function needsYouByWorker(items: readonly NeedsYouItem[]): Map<string, NeedsYouItem> {
  const map = new Map<string, NeedsYouItem>();
  for (const item of items) if (!map.has(item.workerId)) map.set(item.workerId, item);
  return map;
}

// ── 卡住偵測 ──────────────────────────────────────────────────────────

/** 「進度簽章」：忙碌狀態、最新回合、項目數、最後一項的狀態與文字長度。
 *  串流文字變長、工具回報、開新回合都會讓簽章改變＝有進展。 */
export function progressSignature(worker: WorkerState): string {
  const last = lastTurn(worker);
  if (!last) return `${worker.busy ? 1 : 0}|-`;
  const tail = last.items[last.items.length - 1];
  const tailSig = !tail ? "-"
    : tail.kind === "tool_call" ? `${tail.key}:${tail.status}`
    : tail.kind === "approval" ? `${tail.key}:${tail.status}`
    : `${tail.key}:${tail.text.length}`;
  return `${worker.busy ? 1 : 0}|${last.key}|${last.status}|${last.items.length}|${tailSig}`;
}

/** 更新進度表：簽章變了就把時間記成 now；沒變就保留舊時間。移除已不存在的 NPC。
 *  沒有任何變動時回傳同一個物件（React 可據此略過重渲染）。 */
export function trackProgress(previous: ProgressMap, workers: readonly WorkerState[], now: number): ProgressMap {
  let changed = Object.keys(previous).length !== workers.length;
  const next: ProgressMap = {};
  for (const worker of workers) {
    const sig = progressSignature(worker);
    const before = previous[worker.id];
    if (before && before.sig === sig) next[worker.id] = before;
    else { next[worker.id] = { sig, at: now }; changed = true; }
  }
  return changed ? next : previous;
}

/** 執行中且超過門檻沒進展：回傳已停滯多久（ms）；否則 null。等核准不算卡住（那是在等你）。 */
export function stuckFor(worker: WorkerState, progress: ProgressMap | undefined, now: number | undefined, stuckAfterMs = STUCK_AFTER_MS): number | null {
  if (!progress || now === undefined || !worker.busy) return null;
  if (pendingApproval(worker)) return null;
  const entry = progress[worker.id];
  if (!entry) return null;
  const idle = now - entry.at;
  return idle >= stuckAfterMs ? idle : null;
}

/** 卡住的 NPC id → 停滯 ms。 */
export function stuckWorkers(workers: readonly WorkerState[], progress: ProgressMap, now: number, stuckAfterMs = STUCK_AFTER_MS): Map<string, number> {
  const map = new Map<string, number>();
  for (const worker of workers) {
    const idle = stuckFor(worker, progress, now, stuckAfterMs);
    if (idle !== null) map.set(worker.id, idle);
  }
  return map;
}

// ── 隊員列排序 ────────────────────────────────────────────────────────

/** 隊員列分三層：0＝需要你、1＝工作中、2＝待命。 */
export type CrewTier = 0 | 1 | 2;

export function crewTier(worker: WorkerState, needs: ReadonlyMap<string, NeedsYouItem>): CrewTier {
  const item = needs.get(worker.id);
  if (item && item.kind !== "stuck") return 0;
  return worker.busy ? 1 : 2;
}

/** 穩定排序：同層維持原本（隊員自訂）順序，不會因為重渲染互換位置。 */
export function sortByTier<T extends { id: string }>(list: readonly T[], tierOf: (item: T) => number): T[] {
  return list
    .map((item, index) => ({ item, index, tier: tierOf(item) }))
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map((entry) => entry.item);
}

/** 防跳動：新層級要「穩定維持 holdMs」才生效；升到「需要你」立刻生效（那是要你馬上看的）。
 *  pending 記錄每位 NPC 想換去的層級與開始時間。回傳 { settled, pending, nextCheckAt }。 */
export type TierState = { settled: Record<string, CrewTier>; pending: Record<string, { tier: CrewTier; since: number }> };

export function settleTiers(previous: TierState, live: Record<string, CrewTier>, now: number, holdMs: number): TierState & { nextCheckAt: number | null } {
  const settled: Record<string, CrewTier> = {};
  const pending: TierState["pending"] = {};
  let nextCheckAt: number | null = null;
  for (const [id, tier] of Object.entries(live)) {
    const current = previous.settled[id];
    if (current === undefined || current === tier || tier === 0) {
      settled[id] = tier;
      continue;
    }
    const waiting = previous.pending[id];
    const since = waiting && waiting.tier === tier ? waiting.since : now;
    if (now - since >= holdMs) {
      settled[id] = tier;
    } else {
      settled[id] = current;
      pending[id] = { tier, since };
      const due = since + holdMs;
      nextCheckAt = nextCheckAt === null ? due : Math.min(nextCheckAt, due);
    }
  }
  return { settled, pending, nextCheckAt };
}
