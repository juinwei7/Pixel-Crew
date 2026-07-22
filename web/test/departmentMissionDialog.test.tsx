import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DepartmentMissionDialog } from "../src/components/DepartmentMissionDialog";
import { emptyWorker } from "../src/workerState";
import type { CollaborationTask, DepartmentMission } from "../src/types";

const noopAction = async () => null;

test("renders same-department Mission progress, assignees, review result, and retry control", () => {
  const boss = emptyWorker("boss", "BOSS", null, false, 0, "claude", "/repo");
  boss.persona = { role: "Tech Lead", instructions: "" };
  const builder = emptyWorker("builder", "Builder", null, false, 1, "codex", "/repo");
  const outsider = emptyWorker("outside", "Outsider", null, false, 2, "claude", "/other");
  const mission: DepartmentMission = {
    id: "mission", workspacePath: "/repo", bossWorkerId: boss.id, objective: "Build Department Missions",
    acceptanceCriteria: ["tests pass"], status: "needs_attention", planSummary: "Implement, then review.",
    currentStepIndex: 1, correctionCount: 2, maxCorrections: 2, error: "Review needs a decision", attentionReason: "correction_limit",
    createdAt: "2026-07-22T00:00:00Z", startedAt: "2026-07-22T00:00:00Z", completedAt: null,
    steps: [
      { id: "execute", title: "Implement", objective: "Build it", kind: "execute", assigneeWorkerId: builder.id, acceptanceCriteria: [], status: "completed", attempt: 2, result: "Implemented", reviewResult: null, startedAt: null, completedAt: null },
      { id: "review", title: "Review", objective: "Check it", kind: "review", assigneeWorkerId: boss.id, acceptanceCriteria: [], status: "completed", attempt: 3, result: "review", reviewResult: { verdict: "changes_requested", summary: "One issue", findings: [{ severity: "blocking", title: "Missing test", detail: "Add coverage" }], risks: ["Regression"], openQuestions: ["Which browser?"], recommendedNextAction: "fix", structured: true }, startedAt: null, completedAt: null },
    ],
  };
  const legacy: CollaborationTask = {
    id: "legacy", sourceWorkerId: boss.id, targetWorkerId: builder.id, workspacePath: "/repo", mode: "review",
    objective: "Old review", acceptanceCriteria: [], status: "completed", result: { verdict: "pass", summary: "Looks good", findings: [], risks: [], openQuestions: [], recommendedNextAction: "", structured: true },
    continuationResult: "Done", error: null, createdAt: "2026-07-21T00:00:00Z", startedAt: null, completedAt: null, adoptedAt: null, handledAt: null,
  };
  const html = renderToStaticMarkup(<DepartmentMissionDialog
    boss={boss} workers={[boss, builder, outsider]} missions={[mission]} legacyTasks={[legacy]}
    onPrepare={async () => ({ error: "unused" })} onStart={noopAction}
    onCancel={noopAction} onRetryReview={noopAction} onApprovePlan={noopAction} onResolve={noopAction} onClose={() => undefined}
  />);
  assert.match(html, /OWNER DIRECTIVE · AI ROUTED/);
  assert.match(html, /交給 repo 部門/);
  assert.match(html, /你的身份/);
  assert.match(html, /老闆 · 最終決策者/);
  assert.match(html, /部門主管/);
  assert.doesNotMatch(html, />Boss</);
  assert.match(html, /BOSS · Tech Lead/);
  assert.match(html, /BOSS、Builder/);
  assert.doesNotMatch(html, /Outsider/);
  assert.match(html, /需要你決定/);
  assert.match(html, /changes_requested/);
  assert.match(html, /DEPARTMENT MISSION/);
  assert.match(html, /重新 Review/);
  assert.match(html, /Missing test/);
  assert.match(html, /Regression/);
  assert.match(html, /接受風險繼續/);
  assert.match(html, /已修正 2\/2 輪/);
  assert.match(html, /過往單次 NPC 協作 · 1/);
  assert.match(html, /Old review/);
});

test("allows a one-person department to receive Execute work while explaining Review limits", () => {
  const boss = emptyWorker("boss", "BOSS", null, false, 0, "claude", "/repo");
  const html = renderToStaticMarkup(<DepartmentMissionDialog
    boss={boss} workers={[boss]} missions={[]}
    onPrepare={async () => ({ error: "unused" })} onStart={noopAction}
    onCancel={noopAction} onRetryReview={noopAction} onApprovePlan={noopAction} onResolve={noopAction} onClose={() => undefined}
  />);
  assert.match(html, /單人部門模式/);
  assert.match(html, /不會安排獨立 Review/);
});

test("renders Department Work as an embedded focus-capable workspace without modal semantics", () => {
  const boss = emptyWorker("boss", "主管", null, false, 0, "claude", "/repo");
  boss.departmentId = "department";
  const html = renderToStaticMarkup(<DepartmentMissionDialog embedded focusMode boss={boss} workers={[boss]} missions={[]}
    departmentRecord={{ id: "department", name: "產品部", purpose: "打造產品", workspacePath: "/repo", leadWorkerId: "boss", memberWorkerIds: ["boss"], createdAt: "", updatedAt: "" }}
    onPrepare={async () => ({ error: "unused" })} onStart={noopAction} onCancel={noopAction} onRetryReview={noopAction}
    onApprovePlan={noopAction} onResolve={noopAction} onSelectWorker={() => {}} onClose={() => undefined} />);
  assert.match(html, /^<section class="mission-workspace"/);
  assert.match(html, /mission-dialog__card--embedded/);
  assert.match(html, /mission-dialog__card--focus/);
  assert.match(html, /產品部/);
  assert.match(html, /交辦目標/);
  assert.doesNotMatch(html, /role="dialog"/);
  assert.doesNotMatch(html, /關閉部門任務視窗/);
});

test("keeps a completed report open for read-only questions and explicit follow-up work", () => {
  const boss = emptyWorker("boss", "主管", null, false, 0, "claude", "/repo");
  boss.departmentId = "department";
  boss.turns = [{
    key: "follow-up", command: "部門追問：為什麼採用這個方案？", departmentFollowUpMissionId: "completed", status: "done",
    items: [{ kind: "assistant_text", key: "answer", text: "因為這是風險最低且驗證完整的方案。" }],
  }];
  const mission: DepartmentMission = {
    id: "completed", departmentId: "department", workspacePath: "/repo", bossWorkerId: "boss", objective: "完成 API", acceptanceCriteria: ["測試通過"], status: "completed", planSummary: "完成並驗證",
    steps: [{ id: "synthesis", title: "彙整", objective: "報告", kind: "synthesize", assigneeWorkerId: "boss", acceptanceCriteria: [], status: "completed", attempt: 1, result: "已完成", reviewResult: null, startedAt: null, completedAt: null }],
    currentStepIndex: null, correctionCount: 0, maxCorrections: 2, error: null, createdAt: "2026-07-22T00:00:00Z", startedAt: null, completedAt: "2026-07-22T00:10:00Z",
  };
  const html = renderToStaticMarkup(<DepartmentMissionDialog embedded boss={boss} workers={[boss]} missions={[mission]}
    departmentRecord={{ id: "department", name: "產品部", purpose: "打造產品", workspacePath: "/repo", leadWorkerId: "boss", memberWorkerIds: ["boss"], createdAt: "", updatedAt: "" }}
    onPrepare={async () => ({ error: "unused" })} onStart={noopAction} onCancel={noopAction} onRetryReview={noopAction}
    onApprovePlan={noopAction} onResolve={noopAction} onAsk={noopAction} onClose={() => undefined} />);
  assert.match(html, /接著追問或交辦/);
  assert.match(html, /詢問部門/);
  assert.match(html, /交辦後續工作/);
  assert.match(html, /為什麼採用這個方案？/);
  assert.match(html, /風險最低且驗證完整/);
  assert.match(html, /唯讀追問/);
  assert.doesNotMatch(html, /departmentFollowUpMissionId|mission-1/);
});

test("labels an AI-selected two-step review path as Quick Review", () => {
  const boss = emptyWorker("boss", "BOSS", null, false, 0, "claude", "/repo");
  const reviewer = emptyWorker("reviewer", "Reviewer", null, false, 1, "codex", "/repo");
  const mission: DepartmentMission = {
    id: "quick", workspacePath: "/repo", bossWorkerId: "boss", objective: "Check the current patch", acceptanceCriteria: ["safe"],
    status: "completed", planSummary: "A focused review is sufficient.", currentStepIndex: null, correctionCount: 0, maxCorrections: 2,
    error: null, createdAt: "2026-07-22T00:00:00Z", startedAt: null, completedAt: "2026-07-22T00:01:00Z",
    steps: [
      { id: "review", title: "Review patch", objective: "Check it", kind: "review", assigneeWorkerId: "reviewer", acceptanceCriteria: [], status: "completed", attempt: 1, result: "pass", reviewResult: { verdict: "pass", summary: "Safe", findings: [], risks: [], openQuestions: [], recommendedNextAction: "", structured: true }, startedAt: null, completedAt: null },
      { id: "finish", title: "Finish", objective: "Apply the result", kind: "execute", assigneeWorkerId: "boss", acceptanceCriteria: [], status: "completed", attempt: 1, result: "Done", reviewResult: null, startedAt: null, completedAt: null },
    ],
  };
  const html = renderToStaticMarkup(<DepartmentMissionDialog
    boss={boss} workers={[boss, reviewer]} missions={[mission]}
    onPrepare={async () => ({ error: "unused" })} onStart={noopAction}
    onCancel={noopAction} onRetryReview={noopAction} onApprovePlan={noopAction} onResolve={noopAction} onClose={() => undefined}
  />);
  assert.match(html, /QUICK REVIEW · Mission 完成/);
  assert.match(html, /A focused review is sufficient/);
});

test("shows the actual generated plan for explicit owner approval before execution", () => {
  const boss = emptyWorker("boss", "主管", null, false, 0, "claude", "/repo");
  const builder = emptyWorker("builder", "工程師", null, false, 1, "codex", "/repo");
  const mission: DepartmentMission = {
    id: "approval", workspacePath: "/repo", bossWorkerId: boss.id, objective: "Build it", acceptanceCriteria: ["tests pass"],
    status: "needs_attention", attentionReason: "plan_approval", planSummary: "Implement and review before synthesis.", currentStepIndex: 0,
    correctionCount: 0, maxCorrections: 2, error: null, createdAt: "2026-07-22T00:00:00Z", startedAt: null, completedAt: null,
    steps: [{ id: "execute", title: "Implement API", objective: "Build", kind: "execute", assigneeWorkerId: builder.id, acceptanceCriteria: ["tests"], status: "pending", attempt: 0, result: null, reviewResult: null, startedAt: null, completedAt: null }],
  };
  const html = renderToStaticMarkup(<DepartmentMissionDialog boss={boss} workers={[boss, builder]} missions={[mission]}
    onPrepare={async () => ({ error: "unused" })} onStart={noopAction} onCancel={noopAction} onRetryReview={noopAction}
    onApprovePlan={noopAction} onResolve={noopAction} onClose={() => undefined} />);
  assert.match(html, /Implement API/);
  assert.match(html, /工程師/);
  assert.match(html, /核准計畫並開始/);
  assert.doesNotMatch(html, /重新 Review/);
});
