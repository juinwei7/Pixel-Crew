/**
 * Pure aggregation logic behind GET /api/day-report: takes the day's cost rows,
 * runner events, boss tasks and department missions and produces the report
 * object the endpoint returns verbatim. Extracted from index.ts unchanged so it
 * can be unit-tested without a store or Express — index.ts keeps the IO
 * (store reads, worker-name / budget lookups) and hands everything in here.
 */
import type { RunnerEvent } from "./protocol.js";
import type { BossTask } from "./bossTask.js";
import type { DepartmentMission } from "./mission.js";
import { t } from "./i18n.js";

/** Local calendar day (machine timezone) as YYYY-MM-DD. */
export function localDay(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** A requested day only counts when it is a literal YYYY-MM-DD; anything else falls back to today. */
export function resolveReportDay(requested: unknown, today: string): string {
  const value = String(requested ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : today;
}

export type DailyCostRow = { day: string; workerId: string; workerName: string; costUsd: number };
export type DayEventRow = { workerId: string; ts: string; event: RunnerEvent };

export type DayReportWorkerStat = {
  workerId: string; name: string; costUsd: number;
  turns: number; userMessages: number; errors: number; dailyBudgetUsd: number | null;
};

export type DayReportTimelineItem = {
  ts: string; workerId: string; workerName: string;
  kind: "user_message" | "turn_end" | "error"; text: string;
  costUsd?: number; durationMs?: number; isError?: boolean;
};

export type DayReport = {
  day: string;
  today: string;
  totals: { costUsd: number; turns: number; userMessages: number; errors: number };
  workers: DayReportWorkerStat[];
  tasks: {
    bossCompleted: Array<{ id: string; title: string; completedAt: string | null }>;
    missionsCompleted: Array<{ id: string; title: string; completedAt: string | null }>;
    stepsCompleted: Array<{ missionObjective: string; stepTitle: string; assigneeName: string; completedAt: string | null }>;
    attention: Array<{ kind: "boss" | "mission"; id: string; title: string; status: string }>;
  };
  timeline: DayReportTimelineItem[];
};

export type DayReportInput = {
  day: string;
  today: string;
  dailyCosts: DailyCostRow[];
  dayEvents: DayEventRow[];
  bossTasks: BossTask[];
  missions: DepartmentMission[];
  /** Live worker name lookup; undefined when the NPC no longer exists. */
  workerName: (workerId: string) => string | undefined;
  /** Daily budget cap lookup (npc-extras); null when uncapped. */
  dailyBudget: (workerId: string) => number | null;
};

export function buildDayReport(input: DayReportInput): DayReport {
  const { day, today, workerName, dailyBudget } = input;
  const clip = (text: string, max = 160) => {
    const trimmed = (text ?? "").trim();
    return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
  };
  const sameDay = (iso: string | null | undefined) => {
    if (!iso) return false;
    const date = new Date(iso);
    return !Number.isNaN(date.getTime()) && localDay(date) === day;
  };

  const stats = new Map<string, DayReportWorkerStat>();
  const statFor = (workerId: string, fallbackName = "") => {
    let entry = stats.get(workerId);
    if (!entry) {
      entry = {
        workerId,
        name: workerName(workerId) ?? fallbackName ?? workerId,
        costUsd: 0, turns: 0, userMessages: 0, errors: 0,
        dailyBudgetUsd: dailyBudget(workerId) ?? null,
      };
      stats.set(workerId, entry);
    }
    return entry;
  };

  for (const row of input.dailyCosts) {
    if (row.day !== day) continue;
    statFor(row.workerId, row.workerName).costUsd = row.costUsd;
  }

  const timeline: DayReportTimelineItem[] = [];
  for (const { workerId, ts, event } of input.dayEvents) {
    const stat = statFor(workerId);
    if (event.type === "user_message") {
      stat.userMessages += 1;
      timeline.push({ ts, workerId, workerName: stat.name, kind: "user_message", text: clip(event.text) });
    } else if (event.type === "turn_end") {
      stat.turns += 1;
      if (event.isError) stat.errors += 1;
      timeline.push({
        ts, workerId, workerName: stat.name, kind: "turn_end", text: clip(event.resultText),
        costUsd: event.costUsd, durationMs: event.durationMs, isError: event.isError,
      });
    } else if (event.type === "error") {
      stat.errors += 1;
      timeline.push({ ts, workerId, workerName: stat.name, kind: "error", text: clip(event.message) });
    }
  }

  const bossTasks = input.bossTasks;
  const bossCompleted = bossTasks
    .filter((task) => sameDay(task.completedAt))
    .map((task) => ({ id: task.id, title: task.title || clip(task.objective, 80), completedAt: task.completedAt }));
  const missions = input.missions;
  const missionsCompleted = missions
    .filter((mission) => sameDay(mission.completedAt))
    .map((mission) => ({ id: mission.id, title: clip(mission.objective, 80), completedAt: mission.completedAt }));
  const stepsCompleted: Array<{ missionObjective: string; stepTitle: string; assigneeName: string; completedAt: string | null }> = [];
  for (const mission of missions) {
    for (const step of mission.steps) {
      if (step.status !== "completed" || !sameDay(step.completedAt)) continue;
      stepsCompleted.push({
        missionObjective: clip(mission.objective, 60),
        stepTitle: clip(step.title, 80),
        assigneeName: workerName(step.assigneeWorkerId) ?? t("（NPC 已離開）"),
        completedAt: step.completedAt,
      });
    }
  }
  const attention = [
    ...bossTasks
      .filter((task) => !task.archivedAt && (task.status === "needs_input" || task.status === "needs_attention"))
      .map((task) => ({ kind: "boss" as const, id: task.id, title: task.title || clip(task.objective, 80), status: task.status })),
    ...missions
      .filter((mission) => mission.status === "needs_attention")
      .map((mission) => ({ kind: "mission" as const, id: mission.id, title: clip(mission.objective, 80), status: mission.status })),
  ];

  const workerStats = [...stats.values()].sort((a, b) => b.costUsd - a.costUsd);
  const totals = workerStats.reduce(
    (acc, stat) => ({
      costUsd: acc.costUsd + stat.costUsd,
      turns: acc.turns + stat.turns,
      userMessages: acc.userMessages + stat.userMessages,
      errors: acc.errors + stat.errors,
    }),
    { costUsd: 0, turns: 0, userMessages: 0, errors: 0 },
  );

  return {
    day,
    today,
    totals,
    workers: workerStats,
    tasks: { bossCompleted, missionsCompleted, stepsCompleted, attention },
    timeline,
  };
}
