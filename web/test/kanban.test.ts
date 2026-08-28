import assert from "node:assert/strict";
import test from "node:test";
import { buildKanbanColumns, COLUMNS, DONE_LIMIT, DONE_WINDOW_MS } from "../src/kanban";
import type { BossTask, BossTaskStage, DepartmentMission, DepartmentMissionStep } from "../src/types";

const NOW = Date.parse("2026-08-21T12:00:00");
const workers = [
  { id: "w1", name: "一號機" },
  { id: "w2", name: "二號機" },
];

function step(overrides: Partial<DepartmentMissionStep> = {}): DepartmentMissionStep {
  return {
    id: "s1",
    title: "寫程式",
    objective: "實作功能",
    kind: "execute",
    assigneeWorkerId: "w1",
    acceptanceCriteria: [],
    status: "pending",
    attempt: 1,
    result: null,
    reviewResult: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function mission(overrides: Partial<DepartmentMission> = {}): DepartmentMission {
  return {
    id: "m1",
    workspacePath: "/repo",
    bossWorkerId: "w1",
    objective: "整理一切",
    acceptanceCriteria: [],
    status: "executing",
    planSummary: null,
    steps: [],
    currentStepIndex: null,
    correctionCount: 0,
    maxCorrections: 2,
    error: null,
    createdAt: "2026-08-21T09:00:00",
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function stage(overrides: Partial<BossTaskStage> = {}): BossTaskStage {
  return {
    id: "st1",
    departmentId: "d1",
    departmentName: "工程部",
    title: "後端階段",
    objective: "做後端",
    acceptanceCriteria: [],
    dependsOn: [],
    status: "pending",
    missionId: null,
    report: null,
    ...overrides,
  };
}

function bossTask(overrides: Partial<BossTask> = {}): BossTask {
  return {
    id: "t1",
    title: "大任務標題",
    archivedAt: null,
    workspacePath: "/repo",
    decisionProvider: "claude",
    decisionModel: "sonnet",
    objective: "做一個功能",
    acceptanceCriteria: [],
    status: "running",
    messages: [],
    stages: [],
    finalReport: null,
    error: null,
    createdAt: "2026-08-21T08:00:00",
    updatedAt: "2026-08-21T08:30:00",
    completedAt: null,
    ...overrides,
  };
}

test("null missions render as an empty board", () => {
  const columns = buildKanbanColumns(null, [], workers, NOW);
  assert.deepEqual(columns, { todo: [], doing: [], attention: [], done: [] });
});

test("mission steps land in the right columns by status", () => {
  const columns = buildKanbanColumns([mission({
    steps: [
      step({ id: "a", status: "pending" }),
      step({ id: "b", status: "running" }),
      step({ id: "c", status: "completed", completedAt: "2026-08-21T10:00:00" }),
      step({ id: "d", status: "failed" }),
    ],
  })], [], workers, NOW);
  assert.deepEqual(columns.todo.map((card) => card.key), ["step-m1-a"]);
  assert.deepEqual(columns.doing.map((card) => card.key), ["step-m1-b"]);
  assert.deepEqual(columns.done.map((card) => card.key), ["step-m1-c"]);
  assert.deepEqual(columns.attention.map((card) => card.key), ["step-m1-d"]);
});

test("step cards carry kind icon, assignee name, and fall back for departed workers", () => {
  const columns = buildKanbanColumns([mission({
    steps: [
      step({ id: "a", kind: "review", assigneeWorkerId: "w2" }),
      step({ id: "b", kind: "consult", assigneeWorkerId: "ghost" }),
    ],
  })], [], workers, NOW);
  assert.equal(columns.todo[0].icon, "🔎");
  assert.equal(columns.todo[0].assignee, "二號機");
  assert.equal(columns.todo[1].icon, "💬");
  assert.equal(columns.todo[1].assignee, "（已離職）");
});

test("needs_attention missions add a boss card with a mapped reason", () => {
  const columns = buildKanbanColumns([mission({
    status: "needs_attention",
    attentionReason: "plan_approval",
    planSummary: "計畫摘要",
  })], [], workers, NOW);
  assert.equal(columns.attention.length, 1);
  const card = columns.attention[0];
  assert.equal(card.key, "mission-m1");
  assert.equal(card.title, "計畫等你核准");
  assert.equal(card.assignee, "老闆（你）");
  assert.equal(card.detail, "計畫摘要");
});

test("unknown or missing attention reasons fall back to 等你處理", () => {
  const columns = buildKanbanColumns([mission({ status: "needs_attention", attentionReason: null })], [], workers, NOW);
  assert.equal(columns.attention[0].title, "等你處理");
});

test("a planning mission with no steps shows the AI-planning card", () => {
  const columns = buildKanbanColumns([mission({ status: "planning" })], [], workers, NOW);
  assert.equal(columns.doing.length, 1);
  assert.equal(columns.doing[0].title, "AI 正在拆解任務…");
  assert.equal(columns.doing[0].assignee, "一號機");
});

test("cancelled missions and missions finished over three days ago are hidden", () => {
  const columns = buildKanbanColumns([
    mission({ id: "gone", status: "cancelled", steps: [step({ id: "x" })] }),
    mission({
      id: "old",
      status: "completed",
      completedAt: new Date(NOW - DONE_WINDOW_MS - 1).toISOString(),
      steps: [step({ id: "y", status: "completed", completedAt: "2026-08-17T10:00:00" })],
    }),
    mission({
      id: "recent",
      status: "completed",
      completedAt: new Date(NOW - DONE_WINDOW_MS).toISOString(),
      steps: [step({ id: "z", status: "completed", completedAt: "2026-08-18T10:00:00" })],
    }),
  ], [], workers, NOW);
  assert.deepEqual(columns.done.map((card) => card.key), ["step-recent-z"]);
  assert.equal(columns.todo.length, 0);
});

test("boss task stages map to columns; stages already opened as missions are skipped", () => {
  const columns = buildKanbanColumns([], [bossTask({
    stages: [
      stage({ id: "a", status: "pending" }),
      stage({ id: "b", status: "running" }),
      stage({ id: "c", status: "completed" }),
      stage({ id: "d", status: "needs_attention" }),
      stage({ id: "e", status: "failed" }),
      stage({ id: "f", status: "running", missionId: "m9" }),
    ],
  })], workers, NOW);
  assert.deepEqual(columns.todo.map((card) => card.key), ["stage-t1-a"]);
  assert.deepEqual(columns.doing.map((card) => card.key), ["stage-t1-b"]);
  assert.deepEqual(columns.done.map((card) => card.key), ["stage-t1-c"]);
  assert.deepEqual(columns.attention.map((card) => card.key), ["stage-t1-d", "stage-t1-e"]);
  assert.equal(columns.doing[0].assignee, "工程部");
  assert.equal(columns.doing[0].icon, "🏢");
});

test("archived and cancelled boss tasks are hidden entirely", () => {
  const columns = buildKanbanColumns([], [
    bossTask({ id: "arch", archivedAt: "2026-08-20T00:00:00", stages: [stage({ id: "a" })] }),
    bossTask({ id: "canc", status: "cancelled", stages: [stage({ id: "b" })] }),
  ], workers, NOW);
  assert.deepEqual(buildTotal(columns), 0);
});

function buildTotal(columns: ReturnType<typeof buildKanbanColumns>): number {
  return COLUMNS.reduce((sum, column) => sum + columns[column.id].length, 0);
}

test("needs_input boss tasks surface the latest message as an attention card", () => {
  const columns = buildKanbanColumns([], [bossTask({
    status: "needs_input",
    messages: [
      { id: "m1", role: "boss", text: "第一句", createdAt: "2026-08-21T08:00:00" },
      { id: "m2", role: "decision_model", text: "想先問你一個問題", createdAt: "2026-08-21T08:01:00" },
    ],
  })], workers, NOW);
  assert.equal(columns.attention.length, 1);
  assert.equal(columns.attention[0].title, "AI 有問題想先問你");
  assert.equal(columns.attention[0].detail, "想先問你一個問題");
  // 沒有訊息時退回 objective
  const empty = buildKanbanColumns([], [bossTask({ status: "needs_input" })], workers, NOW);
  assert.equal(empty.attention[0].detail, "做一個功能");
});

test("done column sorts newest completion first; null timestamps sink to the end", () => {
  const columns = buildKanbanColumns([
    mission({
      steps: [
        step({ id: "old", status: "completed", completedAt: "2026-08-19T10:00:00" }),
        step({ id: "new", status: "completed", completedAt: "2026-08-21T10:00:00" }),
        step({ id: "mid", status: "completed", completedAt: "2026-08-20T10:00:00" }),
      ],
    }),
  ], [bossTask({ stages: [stage({ id: "nul", status: "completed" })] })], workers, NOW);
  assert.deepEqual(columns.done.map((card) => card.key), ["step-m1-new", "step-m1-mid", "step-m1-old", "stage-t1-nul"]);
});

test("DONE_LIMIT stays at 30 so the modal slice keeps hiding older cards", () => {
  assert.equal(DONE_LIMIT, 30);
  const steps = Array.from({ length: DONE_LIMIT + 5 }, (_, i) =>
    step({ id: `s${i}`, status: "completed", completedAt: `2026-08-21T10:${String(i).padStart(2, "0")}:00` }));
  const columns = buildKanbanColumns([mission({ steps })], [], workers, NOW);
  // 純函式回傳全部卡片；DONE_LIMIT 的裁切由元件做（與原 useMemo 行為一致）
  assert.equal(columns.done.length, DONE_LIMIT + 5);
  assert.equal(columns.done.slice(0, DONE_LIMIT).length, DONE_LIMIT);
});

test("group text clips mission objective and boss title to 60 chars", () => {
  const longObjective = "目".repeat(80);
  const columns = buildKanbanColumns(
    [mission({ objective: longObjective, steps: [step({ id: "a" })] })],
    [bossTask({ title: "題".repeat(80), stages: [stage({ id: "b" })] })],
    workers,
    NOW,
  );
  assert.equal(columns.todo[0].group, "目".repeat(60));
  assert.equal(columns.todo[1].group, "題".repeat(60));
});
