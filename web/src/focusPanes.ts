let paneSeq = 0;

function nextPaneId(): string {
  paneSeq += 1;
  return `pane-${paneSeq}`;
}

export type FocusPane = {
  id: string;
  workerId: string | null;
};

export const MAX_FOCUS_PANES = 4;

export function createFocusPanes(count: number, seedWorkerIds: Array<string | null> = []): FocusPane[] {
  const clamped = Math.min(MAX_FOCUS_PANES, Math.max(1, Math.trunc(count)));
  return Array.from({ length: clamped }, (_, index) => ({
    id: nextPaneId(),
    workerId: seedWorkerIds[index] ?? null,
  }));
}

export function setPaneWorker(panes: FocusPane[], paneId: string, workerId: string | null): FocusPane[] {
  return panes.map((pane) => (pane.id === paneId ? { ...pane, workerId } : pane));
}

export function addPane(panes: FocusPane[], maxPanes = MAX_FOCUS_PANES): FocusPane[] {
  if (panes.length >= maxPanes) return panes;
  return [...panes, { id: nextPaneId(), workerId: null }];
}

export function removePane(panes: FocusPane[], paneId: string): FocusPane[] {
  if (panes.length <= 1) return panes;
  return panes.filter((pane) => pane.id !== paneId);
}

export function cyclePaneFocus(panes: FocusPane[], focusedPaneId: string, direction: 1 | -1): string {
  if (panes.length === 0) return focusedPaneId;
  const index = panes.findIndex((pane) => pane.id === focusedPaneId);
  if (index === -1) return panes[0].id;
  const next = (index + direction + panes.length) % panes.length;
  return panes[next].id;
}

// Alt+] / Alt+[ move focus between split panes; Alt+1..9 (focusStudioShortcut)
// stays reserved for jumping studios, and Cmd/Ctrl+1..9 is left alone because
// browsers already bind it to tab switching.
export function paneCycleShortcut(event: Pick<KeyboardEvent, "key" | "altKey" | "metaKey" | "ctrlKey" | "shiftKey">, editable = false): 1 | -1 | null {
  if (editable || !event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return null;
  if (event.key === "]") return 1;
  if (event.key === "[") return -1;
  return null;
}
