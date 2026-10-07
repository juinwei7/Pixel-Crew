import type { Turn } from "./types";

/* 待辦清單進度：NPC 用 TodoWrite（Claude）或 update_plan（Codex 風格）列計畫時，
   把「最新一次寫入的清單」折成 {done,total}，給場景畫小進度刻度。純函式、不碰 DOM。 */

export type TodoProgress = { done: number; total: number };

const DONE_STATUSES = new Set(["completed", "complete", "done"]);

function normalizedName(name: string): string {
  // MCP 包裝（mcp__x__TodoWrite）只看最後一段。
  const tail = name.split("__").pop() ?? name;
  return tail.replace(/[\s_-]/g, "").toLowerCase();
}

/** 這個工具呼叫是不是在寫待辦／計畫清單。 */
export function isTodoTool(name: string): boolean {
  const n = normalizedName(name);
  return n === "todowrite" || n === "updateplan";
}

/** 從單一 TodoWrite／update_plan 的 input 算進度；格式不對或清單為空回 null。 */
export function todoProgressFromInput(input: unknown): TodoProgress | null {
  if (!input || typeof input !== "object") return null;
  const rec = input as Record<string, unknown>;
  const list = Array.isArray(rec.todos) ? rec.todos : Array.isArray(rec.plan) ? rec.plan : null;
  if (!list) return null;
  let total = 0;
  let done = 0;
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    total += 1;
    const status = (entry as Record<string, unknown>).status;
    if (typeof status === "string" && DONE_STATUSES.has(status.toLowerCase())) done += 1;
  }
  return total > 0 ? { done, total } : null;
}

/** 單一回合裡最後一次寫入的清單進度（後寫的覆蓋先寫的）；沒寫過回 null。 */
export function turnTodoProgress(turn: Pick<Turn, "items"> | undefined): TodoProgress | null {
  if (!turn) return null;
  for (let i = turn.items.length - 1; i >= 0; i--) {
    const item = turn.items[i];
    if (item.kind !== "tool_call" || !isTodoTool(item.name)) continue;
    const progress = todoProgressFromInput(item.input);
    if (progress) return progress;
  }
  return null;
}
