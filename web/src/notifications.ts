import { t } from "./i18n";
import { pendingApproval, type NeedsYouItem } from "./needsYou";
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
  return {
    busy: worker.busy,
    pendingApprovalId: pendingApproval(worker)?.request.id ?? null,
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

    // 待核准的判斷跟頂欄／隊員列同一份（needsYou.pendingApproval）。
    const approval = pendingApproval(worker);
    const approvalId = approval?.request.id ?? null;
    if (approval && approvalId && approvalId !== before.pendingApprovalId) {
      events.push({
        tag: `approval:${worker.id}:${approvalId}`,
        title: t("{name} 等待核准", { name: worker.name }),
        body: trim(approval.request.title),
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

/**
 * 「需要你」清單新出現的事（決策／提問／卡住）→ 桌面通知。核准與完成／失敗已由
 * diffNotifications 依回合轉換發出，這裡不重複。previousKeys 為 null＝第一次看到，只建基準。
 */
export function diffNeedsYouNotifications(previousKeys: ReadonlySet<string> | null, items: readonly NeedsYouItem[]): NotifyEvent[] {
  if (!previousKeys) return [];
  const events: NotifyEvent[] = [];
  for (const item of items) {
    if (previousKeys.has(item.key)) continue;
    if (item.kind === "decision") events.push({ tag: item.key, title: t("{name} 等你拍板", { name: item.workerName }), body: item.detail });
    else if (item.kind === "question") events.push({ tag: item.key, title: t("{name} 在問你", { name: item.workerName }), body: item.detail });
    else if (item.kind === "stuck") events.push({ tag: item.key, title: t("{name} 好一陣子沒有進展", { name: item.workerName }), body: item.detail });
  }
  return events;
}
