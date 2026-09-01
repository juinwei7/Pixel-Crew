import type { DepartmentMission } from "./mission.js";

export type DiagnosticEventKind = "websocket_reconnect" | "ui_long_task" | "fps_sample" | "approval_wait";
export type DiagnosticEvent = { kind: DiagnosticEventKind; value: number; createdAt: string };

export type LocalDiagnostics = {
  generatedAt: string;
  scope: "local-only";
  privacy: "No prompts, paths, model output, tool input/output, or identifiers are included.";
  missions: { total: number; completed: number; failed: number; successRate: number | null; failuresByReason: Array<{ reason: string; count: number }> };
  responsiveness: { websocketReconnects: number; longUiTasks: number; medianFps: number | null; fpsBand: "good" | "fair" | "poor" | "unknown"; medianApprovalWaitSeconds: number | null };
};

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function conciseReason(value: string | null): string {
  const normalized = (value ?? "Unknown failure").replace(/\s+/g, " ").trim();
  return normalized.slice(0, 120) || "Unknown failure";
}

export function buildLocalDiagnostics(missions: DepartmentMission[], events: DiagnosticEvent[], now = new Date().toISOString()): LocalDiagnostics {
  const terminal = missions.filter((mission) => mission.status === "completed" || mission.status === "failed");
  const completed = terminal.filter((mission) => mission.status === "completed").length;
  const failed = terminal.filter((mission) => mission.status === "failed");
  const reasons = new Map<string, number>();
  for (const mission of failed) {
    const reason = conciseReason(mission.error);
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  const fps = median(events.filter((event) => event.kind === "fps_sample").map((event) => event.value));
  const approvalWait = median(events.filter((event) => event.kind === "approval_wait").map((event) => event.value));
  return {
    generatedAt: now,
    scope: "local-only",
    privacy: "No prompts, paths, model output, tool input/output, or identifiers are included.",
    missions: {
      total: terminal.length, completed, failed: failed.length,
      successRate: terminal.length ? Math.round((completed / terminal.length) * 1000) / 10 : null,
      failuresByReason: [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)).slice(0, 8),
    },
    responsiveness: {
      websocketReconnects: events.filter((event) => event.kind === "websocket_reconnect").length,
      longUiTasks: events.filter((event) => event.kind === "ui_long_task").length,
      medianFps: fps == null ? null : Math.round(fps * 10) / 10,
      fpsBand: fps == null ? "unknown" : fps >= 45 ? "good" : fps >= 24 ? "fair" : "poor",
      medianApprovalWaitSeconds: approvalWait == null ? null : Math.round(approvalWait * 10) / 10,
    },
  };
}
