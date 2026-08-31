import { roomName } from "./workspace";

export type FocusStudioWorker = {
  id: string;
  name: string;
  workspacePath: string;
  busy: boolean;
  needsAttention: boolean;
  unread?: boolean;
};

export type FocusStudio = {
  workspacePath: string;
  name: string;
  workerIds: string[];
  busyCount: number;
  attentionCount: number;
  unreadCount: number;
};

export function buildFocusStudios(workspacePaths: string[], workers: FocusStudioWorker[]): FocusStudio[] {
  const paths = [...new Set([...workspacePaths, ...workers.map((worker) => worker.workspacePath)].filter(Boolean))];
  return paths.map((workspacePath) => {
    const members = workers.filter((worker) => worker.workspacePath === workspacePath);
    return {
      workspacePath,
      name: roomName(workspacePath),
      workerIds: members.map((worker) => worker.id),
      busyCount: members.filter((worker) => worker.busy).length,
      attentionCount: members.filter((worker) => worker.needsAttention).length,
      unreadCount: members.filter((worker) => worker.unread).length,
    };
  });
}

export function studioWorkerId(studio: FocusStudio, rememberedWorkerId: string | undefined): string | null {
  if (rememberedWorkerId && studio.workerIds.includes(rememberedWorkerId)) return rememberedWorkerId;
  return studio.workerIds[0] ?? null;
}

export function focusStudioWorkers<T extends { id: string; workspacePath: string }>(workers: T[], workspacePath: string): T[] {
  return workers.filter((worker) => worker.workspacePath === workspacePath);
}

export function focusStudioShortcut(event: Pick<KeyboardEvent, "key" | "altKey" | "metaKey" | "ctrlKey" | "shiftKey">, editable = false): number | null {
  if (editable || !event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return null;
  const value = Number(event.key);
  return Number.isInteger(value) && value >= 1 && value <= 9 && String(value) === event.key ? value - 1 : null;
}
