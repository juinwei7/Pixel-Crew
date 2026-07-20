import type { WorkerState } from "./types";
import type { CrewFilter } from "./uiPreferences";
import { roomName } from "./workspace";

export type WorkerAttention = "approval" | "error" | "working" | "done" | "idle";

export function workerAttention(worker: WorkerState): WorkerAttention {
  const last = worker.turns[worker.turns.length - 1];
  if (last?.items.some((item) => item.kind === "approval" && item.status === "pending")) return "approval";
  if (last?.status === "error") return "error";
  if (worker.busy) return "working";
  if (last?.status === "done") return "done";
  return "idle";
}

export function workerFocusStatus(worker: WorkerState): "等待核准" | "執行中" | "需注意" | "待命" {
  const attention = workerAttention(worker);
  if (attention === "approval") return "等待核准";
  if (attention === "working") return "執行中";
  if (attention === "error") return "需注意";
  return "待命";
}

export function latestReadableTurnKey(worker: WorkerState): string | null {
  for (let index = worker.turns.length - 1; index >= 0; index--) {
    if (worker.turns[index].items.some((item) => item.kind === "assistant_text" || item.kind === "system_error")) return worker.turns[index].key;
  }
  return null;
}

export function filterCrew(workers: WorkerState[], filter: CrewFilter, query: string, currentRoom: string): WorkerState[] {
  const needle = query.trim().toLowerCase();
  return workers.filter((worker) => {
    if (needle && !`${worker.name} ${roomName(worker.workspacePath)}`.toLowerCase().includes(needle)) return false;
    const attention = workerAttention(worker);
    if (filter === "working" && !worker.busy) return false;
    if (filter === "attention" && attention !== "approval" && attention !== "error") return false;
    if (filter === "claude" && worker.provider !== "claude") return false;
    if (filter === "codex" && worker.provider !== "codex") return false;
    if (filter === "room" && worker.workspacePath !== currentRoom) return false;
    return true;
  });
}
