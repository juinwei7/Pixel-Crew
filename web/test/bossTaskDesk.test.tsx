import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BossTaskDesk, bossStageProgress } from "../src/components/BossTaskDesk";
import type { BossTask, DepartmentMission } from "../src/types";

const task: BossTask = {
  id: "task-1",
  title: "Simple ERP",
  archivedAt: null,
  workspacePath: "/repo",
  decisionProvider: "codex",
  decisionModel: "gpt-5.6",
  objective: "Build a simple ERP",
  acceptanceCriteria: [],
  status: "needs_input",
  messages: [
    { id: "m1", role: "boss", text: "Build a simple ERP", createdAt: "2026-01-01" },
    { id: "m2", role: "decision_model", text: "Which modules belong in the MVP?", createdAt: "2026-01-01" },
  ],
  stages: [],
  finalReport: null,
  error: null,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  completedAt: null,
};

test("Boss Desk is a persistent chat log with inline discovery reply", () => {
  const html = renderToStaticMarkup(<BossTaskDesk
    workspacePath="/repo"
    tasks={[task]}
    decisionModels={[{ provider: "codex", model: "gpt-5.6", label: "Codex · GPT-5.6" }]}
    onCreate={async () => ({ error: "unused" })}
    onMessage={async () => ({ error: "unused" })}
    onUpdate={async () => ({ error: "unused" })}
    onDelete={async () => ({ error: "unused" })}
    onClose={() => {}}
  />);
  assert.match(html, /BOSS DESK · TASK LOG/);
  assert.match(html, /老闆任務日誌/);
  assert.match(html, /Build a simple ERP/);
  assert.match(html, /Which modules belong in the MVP/);
  assert.match(html, /等待老闆補充/);
  assert.match(html, /直接回答決策模型的問題/);
  assert.doesNotMatch(html, /role="dialog"/);
});

test("renders Boss messages and final reports as Markdown in every desk layout", () => {
  const completed: BossTask = {
    ...task,
    status: "completed",
    messages: [
      { id: "m1", role: "boss", text: "**分析**台股", createdAt: "2026-01-01" },
      { id: "m2", role: "report", text: "# 最終結論\n\n- 先觀望\n- 等待估值確認", createdAt: "2026-01-01" },
    ],
    finalReport: "# 最終結論\n\n- 先觀望\n- 等待估值確認",
    completedAt: "2026-01-01",
  };
  for (const focusMode of [false, true]) {
    const html = renderToStaticMarkup(<BossTaskDesk
      workspacePath="/repo"
      tasks={[completed]}
      decisionModels={[]}
      onCreate={async () => ({ error: "unused" })}
      onMessage={async () => ({ error: "unused" })}
      onUpdate={async () => ({ error: "unused" })}
      onDelete={async () => ({ error: "unused" })}
      onClose={() => {}}
      focusMode={focusMode}
    />);
    assert.match(html, /<strong>分析<\/strong>台股/);
    assert.match(html, /<h1>最終結論<\/h1>/);
    assert.match(html, /<li>先觀望<\/li>/);
    assert.doesNotMatch(html, /# 最終結論/);
  }
});

test("renders a multi-department execution graph inside the same task log", () => {
  const running: BossTask = {
    ...task,
    status: "running",
    stages: [
      { id: "plan", departmentId: "pm", departmentName: "PM", title: "Plan MVP", objective: "plan", acceptanceCriteria: ["scope"], dependsOn: [], status: "completed", missionId: "m1", report: "scope" },
      { id: "build", departmentId: "eng", departmentName: "Engineering", title: "Implement", objective: "build", acceptanceCriteria: ["works"], dependsOn: ["plan"], status: "running", missionId: "m2", report: null },
      { id: "qa", departmentId: "qa", departmentName: "QA", title: "Verify", objective: "test", acceptanceCriteria: ["passes"], dependsOn: ["build"], status: "pending", missionId: null, report: null },
    ],
  };
  const html = renderToStaticMarkup(<BossTaskDesk
    workspacePath="/repo"
    tasks={[running]}
    decisionModels={[]}
    onCreate={async () => ({ error: "unused" })}
    onMessage={async () => ({ error: "unused" })}
    onUpdate={async () => ({ error: "unused" })}
    onDelete={async () => ({ error: "unused" })}
    onClose={() => {}}
  />);
  assert.match(html, /跨部門執行/);
  assert.match(html, /PM · Plan MVP/);
  assert.match(html, /Engineering · Implement/);
  assert.match(html, /QA · Verify/);
});

test("Boss stage progress uses the live Mission step and assignee instead of a raw status", () => {
  const stage = { id: "build", departmentId: "eng", departmentName: "Engineering", title: "Implement", objective: "build", acceptanceCriteria: [], dependsOn: [], status: "running" as const, missionId: "m2", report: null };
  const mission: DepartmentMission = {
    id: "m2", departmentId: "eng", workspacePath: "/repo", bossWorkerId: "lead", objective: "build", acceptanceCriteria: [], status: "executing", planSummary: null,
    steps: [{ id: "step-2", title: "Build API", objective: "api", kind: "execute", assigneeWorkerId: "dev", acceptanceCriteria: [], status: "running", attempt: 1, result: null, reviewResult: null, startedAt: null, completedAt: null }],
    currentStepIndex: 0, correctionCount: 0, maxCorrections: 1, error: null, createdAt: "2026-01-01", startedAt: null, completedAt: null,
  };
  assert.equal(bossStageProgress(stage, mission, [{ id: "dev", name: "小明" } as any]), "第 1/1 步：Build API · 小明");
  assert.equal(bossStageProgress({ ...stage, missionId: null, status: "pending", dependsOn: ["plan"] }, undefined), "等待前一階段");
});

test("new Boss tasks use a compact chat-first starter state", () => {
  const html = renderToStaticMarkup(<BossTaskDesk
    workspacePath="/repo"
    tasks={[]}
    decisionModels={[{ provider: "codex", model: "gpt-5.6", label: "Codex · GPT-5.6" }]}
    onCreate={async () => ({ error: "unused" })}
    onMessage={async () => ({ error: "unused" })}
    onUpdate={async () => ({ error: "unused" })}
    onDelete={async () => ({ error: "unused" })}
    onClose={() => {}}
  />);
  assert.match(html, /今天想完成什麼？/);
  assert.match(html, /規劃並開發一套簡易 ERP/);
  assert.match(html, /驗收條件/);
  assert.doesNotMatch(html, /<details open/);
});

test("Boss records remain visible across NPC workspaces and expose safe organization controls", () => {
  const otherWorkspace = { ...task, id: "task-other", title: "Other workspace task", workspacePath: "/other", status: "completed" as const };
  const html = renderToStaticMarkup(<BossTaskDesk
    workspacePath="/repo"
    tasks={[otherWorkspace]}
    decisionModels={[]}
    onCreate={async () => ({ error: "unused" })}
    onMessage={async () => ({ error: "unused" })}
    onUpdate={async () => ({ error: "unused" })}
    onDelete={async () => ({ error: "unused" })}
    onClose={() => {}}
  />);
  assert.match(html, /Other workspace task/);
  assert.match(html, /other/);
  assert.match(html, /整理/);
});
