import type { ProviderId, WorkerState } from "./types";

export function deriveCommandHistory(workers: WorkerState[], provider: ProviderId, workspacePath: string): string[] {
  const history: string[] = [];
  const seen = new Set<string>();

  for (const worker of [...workers].reverse()) {
    if (worker.provider !== provider || worker.workspacePath !== workspacePath) continue;
    for (const turn of [...worker.turns].reverse()) {
      const command = turn.command.trim();
      if (!command || seen.has(command)) continue;
      seen.add(command);
      history.push(command);
      if (history.length >= 50) return history;
    }
  }

  return history;
}
