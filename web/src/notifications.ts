import { t } from "./i18n";
import type { WorkerState } from "./types";

export type WorkerSnapshot = {
  busy: boolean;
  pendingApprovalId: string | null;
  lastTurnKey: string | null;
};

export type NotifyEvent = {
  tag: string;
  title: string;
  body: string;
};

export function snapshotWorker(worker: WorkerState): WorkerSnapshot {
  const last = worker.turns[worker.turns.length - 1];
  const approval = last?.items.find((item) => item.kind === "approval" && item.status === "pending");
  return {
    busy: worker.busy,
    pendingApprovalId: approval && approval.kind === "approval" ? approval.request.id : null,
    lastTurnKey: last?.key ?? null,
  };
}

function trim(text: string, max = 60): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

/**
 * Diff the previous per-worker snapshots against the current worker list and
 * return the desktop notifications that should fire. Pure — the caller owns
 * permission checks, document.hidden gating, and actually constructing
 * Notification objects.
 */
export function diffNotifications(prev: Map<string, WorkerSnapshot>, workers: WorkerState[]): NotifyEvent[] {
  const events: NotifyEvent[] = [];
  for (const worker of workers) {
    const before = prev.get(worker.id);
    if (!before) continue; // first sight of this worker — establish baseline only
    const last = worker.turns[worker.turns.length - 1];

    const approval = last?.items.find((item) => item.kind === "approval" && item.status === "pending");
    const approvalId = approval && approval.kind === "approval" ? approval.request.id : null;
    if (approvalId && approvalId !== before.pendingApprovalId) {
      events.push({
        tag: `approval:${worker.id}:${approvalId}`,
        title: t("{name} 等待核准", { name: worker.name }),
        body: trim(approval && approval.kind === "approval" ? approval.request.title : ""),
      });
    }

    if (before.busy && !worker.busy && last && (last.status === "done" || last.status === "error")) {
      events.push({
        tag: `turn:${worker.id}:${last.key}`,
        title: last.status === "done" ? t("{name} 完成任務", { name: worker.name }) : t("{name} 任務失敗", { name: worker.name }),
        body: trim(last.command),
      });
    }
  }
  return events;
}
