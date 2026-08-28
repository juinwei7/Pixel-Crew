import assert from "node:assert/strict";
import test from "node:test";
import { buildDayReport, localDay, resolveReportDay, type DayReportInput } from "../src/dayReport.js";
import type { BossTask } from "../src/bossTask.js";
import type { DepartmentMission, DepartmentMissionStep } from "../src/mission.js";

const DAY = "2026-08-21";
/** 本地時區當天中午——localDay(new Date(...)) 一定落在 DAY。 */
const onDay = (hhmm = "12:00") => `${DAY}T${hhmm}:00`;

test("localDay formats the local calendar day with zero padding", () => {
  assert.equal(localDay(new Date(2026, 0, 5)), "2026-01-05");
  assert.equal(localDay(new Date(2026, 11, 31)), "2026-12-31");
});

test("resolveReportDay only accepts literal YYYY-MM-DD and falls back to today", () => {
  assert.equal(resolveReportDay("2026-08-21", "2026-08-22"), "2026-08-21");
  assert.equal(resolveReportDay("2026-8-21", "2026-08-22"), "2026-08-22");
  assert.equal(resolveReportDay(undefined, "2026-08-22"), "2026-08-22");
  assert.equal(resolveReportDay("junk", "2026-08-22"), "2026-08-22");
});

function baseInput(overrides: Partial<DayReportInput> = {}): DayReportInput {
  return {
    day: DAY,
    today: "2026-08-22",
    dailyCosts: [],
    dayEvents: [],
    bossTasks: [],
    missions: [],
    workerName: () => undefined,
    dailyBudget: () => null,
    ...overrides,
  };
}

function mission(overrides: Partial<DepartmentMission> = {}): DepartmentMission {
  return {
    id: "mission-1",
    workspacePath: "/repo",
    bossWorkerId: "w1",
    objective: "整理文件",
    acceptanceCriteria: [],
    status: "completed",
    planSummary: null,
    steps: [],
    currentStepIndex: null,
    correctionCount: 0,
    maxCorrections: 2,
    error: null,
    createdAt: onDay("09:00"),
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function step(overrides: Partial<DepartmentMissionStep> = {}): DepartmentMissionStep {
  return {
    id: "step-1",
    title: "寫測試",
    objective: "補測試",
    kind: "execute",
    assigneeWorkerId: "w2",
    acceptanceCriteria: [],
    status: "completed",
    attempt: 1,
    result: null,
    reviewResult: null,
    startedAt: null,
    completedAt: onDay("13:00"),
    ...overrides,
  };
}

function bossTask(overrides: Partial<BossTask> = {}): BossTask {
  return {
    id: "task-1",
    title: "大任務",
    archivedAt: null,
    workspacePath: "/repo",
    decisionProvider: "claude",
    decisionModel: "sonnet",
    objective: "做一個功能",
    acceptanceCriteria: [],
    status: "completed",
    messages: [],
    stages: [],
    finalReport: null,
    error: null,
    createdAt: onDay("08:00"),
    updatedAt: onDay("09:00"),
    completedAt: null,
    ...overrides,
  };
}

test("empty input produces an empty report shell", () => {
  const report = buildDayReport(baseInput());
  assert.deepEqual(report, {
    day: DAY,
    today: "2026-08-22",
    totals: { costUsd: 0, turns: 0, userMessages: 0, errors: 0 },
    workers: [],
    tasks: { bossCompleted: [], missionsCompleted: [], stepsCompleted: [], attention: [] },
    timeline: [],
  });
});

test("cost rows for other days are dropped; matching rows seed worker stats", () => {
  const report = buildDayReport(baseInput({
    dailyCosts: [
      { day: DAY, workerId: "w1", workerName: "一號機", costUsd: 1.5 },
      { day: "2026-08-20", workerId: "w2", workerName: "二號機", costUsd: 9 },
    ],
    dailyBudget: (id) => (id === "w1" ? 10 : null),
  }));
  assert.deepEqual(report.workers, [{
    workerId: "w1", name: "一號機", costUsd: 1.5, turns: 0, userMessages: 0, errors: 0, dailyBudgetUsd: 10,
  }]);
  assert.equal(report.totals.costUsd, 1.5);
});

test("live worker names win over the cost-log fallback name", () => {
  const report = buildDayReport(baseInput({
    dailyCosts: [{ day: DAY, workerId: "w1", workerName: "舊名字", costUsd: 1 }],
    workerName: (id) => (id === "w1" ? "新名字" : undefined),
  }));
  assert.equal(report.workers[0].name, "新名字");
});

test("events are tallied into per-worker stats and a clipped timeline", () => {
  const report = buildDayReport(baseInput({
    dayEvents: [
      { workerId: "w1", ts: "09:00:00", event: { type: "user_message", text: "  做點事  " } },
      { workerId: "w1", ts: "09:05:00", event: { type: "turn_end", resultText: "做完了", costUsd: 0.5, durationMs: 1200, isError: false, permissionDenials: [] } },
      { workerId: "w1", ts: "09:10:00", event: { type: "turn_end", resultText: "爆炸", costUsd: 0, durationMs: 10, isError: true, permissionDenials: [] } },
      { workerId: "w1", ts: "09:11:00", event: { type: "error", message: "x".repeat(200) } },
    ],
    workerName: () => "一號機",
  }));
  assert.equal(report.workers.length, 1);
  const stat = report.workers[0];
  assert.equal(stat.turns, 2);
  assert.equal(stat.userMessages, 1);
  assert.equal(stat.errors, 2); // isError 的 turn_end ＋ error 事件
  assert.equal(report.timeline.length, 4);
  assert.deepEqual(report.timeline[0], { ts: "09:00:00", workerId: "w1", workerName: "一號機", kind: "user_message", text: "做點事" });
  assert.deepEqual(report.timeline[1], { ts: "09:05:00", workerId: "w1", workerName: "一號機", kind: "turn_end", text: "做完了", costUsd: 0.5, durationMs: 1200, isError: false });
  // 文字超過 160 字剪裁並加上省略號
  assert.equal(report.timeline[3].text, `${"x".repeat(160)}…`);
  assert.equal(report.timeline[3].text.length, 161);
});

test("workers sort by cost descending and totals aggregate all stats", () => {
  const report = buildDayReport(baseInput({
    dailyCosts: [
      { day: DAY, workerId: "cheap", workerName: "省錢機", costUsd: 0.2 },
      { day: DAY, workerId: "pricey", workerName: "燒錢機", costUsd: 3 },
    ],
    dayEvents: [
      { workerId: "cheap", ts: "10:00:00", event: { type: "user_message", text: "hi" } },
      { workerId: "pricey", ts: "10:01:00", event: { type: "turn_end", resultText: "ok", costUsd: 3, durationMs: 5, isError: false, permissionDenials: [] } },
    ],
  }));
  assert.deepEqual(report.workers.map((w) => w.workerId), ["pricey", "cheap"]);
  assert.deepEqual(report.totals, { costUsd: 3.2, turns: 1, userMessages: 1, errors: 0 });
});

test("boss tasks and missions completed on the requested day are listed; other days are not", () => {
  const report = buildDayReport(baseInput({
    bossTasks: [
      bossTask({ id: "t1", completedAt: onDay("15:00") }),
      bossTask({ id: "t2", completedAt: "2026-08-20T15:00:00" }),
      bossTask({ id: "t3", title: "", objective: "無標題任務的目標", completedAt: onDay("16:00") }),
      bossTask({ id: "t4", completedAt: null }),
    ],
    missions: [
      mission({ id: "m1", completedAt: onDay("17:00") }),
      mission({ id: "m2", completedAt: "not-a-date" }),
    ],
  }));
  assert.deepEqual(report.tasks.bossCompleted.map((t) => t.id), ["t1", "t3"]);
  assert.equal(report.tasks.bossCompleted[1].title, "無標題任務的目標"); // 空標題退回 objective
  assert.deepEqual(report.tasks.missionsCompleted, [{ id: "m1", title: "整理文件", completedAt: onDay("17:00") }]);
});

test("completed steps on the day carry the assignee name or a departed placeholder", () => {
  const report = buildDayReport(baseInput({
    missions: [mission({
      status: "executing",
      steps: [
        step({ id: "s1", assigneeWorkerId: "alive", completedAt: onDay("13:00") }),
        step({ id: "s2", assigneeWorkerId: "gone", completedAt: onDay("14:00") }),
        step({ id: "s3", status: "running", completedAt: null }),
        step({ id: "s4", completedAt: "2026-08-19T10:00:00" }),
      ],
    })],
    workerName: (id) => (id === "alive" ? "在職者" : undefined),
  }));
  assert.deepEqual(report.tasks.stepsCompleted.map((s) => s.assigneeName), ["在職者", "（NPC 已離開）"]);
});

test("needs_attention collects unarchived boss tasks and missions, boss first", () => {
  const report = buildDayReport(baseInput({
    bossTasks: [
      bossTask({ id: "t1", status: "needs_input" }),
      bossTask({ id: "t2", status: "needs_attention" }),
      bossTask({ id: "t3", status: "needs_attention", archivedAt: onDay("10:00") }),
      bossTask({ id: "t4", status: "running" }),
    ],
    missions: [
      mission({ id: "m1", status: "needs_attention" }),
      mission({ id: "m2", status: "executing" }),
    ],
  }));
  assert.deepEqual(report.tasks.attention.map((item) => `${item.kind}:${item.id}`), ["boss:t1", "boss:t2", "mission:m1"]);
});
