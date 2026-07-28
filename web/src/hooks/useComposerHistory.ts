import { useMemo, useState } from "react";
import { deriveCommandHistory } from "../commandHistory";
import type { ProviderId, WorkerState } from "../types";

export function useComposerHistory(config: { enabled: boolean; workers: WorkerState[]; provider: ProviderId; workspacePath: string }): {
  history: string[];
  resetHistoryIndex(): void;
  step(direction: "up" | "down"): string | null;
} {
  const { enabled, workers, provider, workspacePath } = config;
  const [historyIndex, setHistoryIndex] = useState(-1);
  const history = useMemo(
    () => enabled ? deriveCommandHistory(workers, provider, workspacePath) : [],
    [enabled, workers, provider, workspacePath],
  );

  function resetHistoryIndex() {
    setHistoryIndex(-1);
  }

  function step(direction: "up" | "down"): string | null {
    if (history.length === 0) return null;
    const next = direction === "up" ? Math.min(history.length - 1, historyIndex + 1) : Math.max(-1, historyIndex - 1);
    setHistoryIndex(next);
    return next < 0 ? "" : history[next];
  }

  return { history, resetHistoryIndex, step };
}
