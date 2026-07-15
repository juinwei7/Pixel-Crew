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
