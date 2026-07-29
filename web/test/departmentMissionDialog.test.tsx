import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DepartmentMissionDialog, prepareAndStartDepartmentMission } from "../src/components/DepartmentMissionDialog";
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
    delegatedSessions: [{ workerId: builder.id, provider: "codex", model: "gpt-5.6", sessionId: "mission-session", completedTurns: 1 }],
    executionEvents: [
      { workerId: builder.id, stepId: "execute", event: { type: "tool_call_start", id: "tool-1", name: "mcp__issues__list", input: {} } },
      { workerId: builder.id, stepId: "execute", event: { type: "approval_requested", request: { id: "approval-1", activityId: "tool-1", category: "tool", title: "更新 issue", input: {}, reason: "需要寫入狀態", decisions: ["allow_once", "allow_session", "deny"] } } },
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
    onCancel={noopAction} onRetryReview={noopAction} onApprovePlan={noopAction} onResolve={noopAction} onResolveApproval={noopAction} onClose={() => undefined}
  />);
  assert.match(html, /DEPARTMENT CHAT · DIRECT EXECUTION/);
  assert.match(html, />repo</);
  assert.match(html, /2 位成員 · 查看職務/);
  assert.doesNotMatch(html, />Boss</);
  assert.match(html, /<strong>BOSS<\/strong><small>Tech Lead<\/small>/);
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
  assert.match(html, /這項工作需要你的核准/);
  assert.match(html, /本次任務都允許/);
  assert.match(html, /任務執行紀錄 · 2/);
  assert.match(html, /tool-row__name">list</);
  assert.match(html, /MCP·issues/);
  assert.match(html, /等待核准：更新 issue/);
});

test("collapses consecutive tool calls from the same NPC into one grouped activity row", () => {
  const boss = emptyWorker("boss", "BOSS", null, false, 0, "claude", "/repo");
  const builder = emptyWorker("builder", "Builder", null, false, 1, "codex", "/repo");
  const mission: DepartmentMission = {
    id: "mission", workspacePath: "/repo", bossWorkerId: boss.id, objective: "Ship the feature",
    acceptanceCriteria: [], status: "executing", planSummary: null,
    currentStepIndex: 0, correctionCount: 0, maxCorrections: 2, error: null, attentionReason: null,
    createdAt: "2026-07-22T00:00:00Z", startedAt: "2026-07-22T00:00:00Z", completedAt: null,
    steps: [
      { id: "execute", title: "Implement", objective: "Build it", kind: "execute", assigneeWorkerId: builder.id, acceptanceCriteria: [], status: "running", attempt: 1, result: null, reviewResult: null, startedAt: null, completedAt: null },
    ],
    executionEvents: [
      { workerId: builder.id, stepId: "execute", event: { type: "tool_call_start", id: "tool-1", name: "Bash", input: { command: "npm test" } } },
      { workerId: builder.id, stepId: "execute", event: { type: "tool_call_result", id: "tool-1", output: "ok", isError: false } },
      { workerId: builder.id, stepId: "execute", event: { type: "tool_call_start", id: "tool-2", name: "Read", input: { file_path: "a.ts" } } },
      { workerId: builder.id, stepId: "execute", event: { type: "tool_call_result", id: "tool-2", output: "contents", isError: false } },
    ],
  };
  const html = renderToStaticMarkup(<DepartmentMissionDialog
    boss={boss} workers={[boss, builder]} missions={[mission]}
    onPrepare={async () => ({ error: "unused" })} onStart={noopAction}
    onCancel={noopAction} onRetryReview={noopAction} onApprovePlan={noopAction} onResolve={noopAction} onResolveApproval={noopAction} onClose={() => undefined}
  />);
  assert.match(html, /任務執行紀錄 · 4/);
  assert.match(html, /tool-group__summary/);
  assert.match(html, />2 項</);
  const builderNameCount = (html.match(/mission-activity-row__who">Builder</g) ?? []).length;
  assert.equal(builderNameCount, 1);
});

test("allows a one-person department to receive Execute work while explaining Review limits", () => {
  const boss = emptyWorker("boss", "BOSS", null, false, 0, "claude", "/repo");
  const html = renderToStaticMarkup(<DepartmentMissionDialog
    boss={boss} workers={[boss]} missions={[]}
    onPrepare={async () => ({ error: "unused" })} onStart={noopAction}
    onCancel={noopAction} onRetryReview={noopAction} onApprovePlan={noopAction} onResolve={noopAction} onClose={() => undefined}
  />);
  assert.match(html, /單人部門：可直接執行/);
  assert.match(html, /不會安排獨立 Review/);
});

test("keeps Boss-owned Missions out of both normal and focus department history", () => {
  const boss = emptyWorker("boss", "主管", null, false, 0, "claude", "/repo");
  boss.departmentId = "department";
  const directMission: DepartmentMission = {
    id: "direct", origin: "department", departmentId: "department", workspacePath: "/repo", bossWorkerId: boss.id,
    objective: "部門直接交辦", acceptanceCriteria: [], status: "completed", planSummary: "direct",
    currentStepIndex: null, correctionCount: 0, maxCorrections: 2, error: null,
    createdAt: "2026-07-22T00:00:00Z", startedAt: null, completedAt: "2026-07-22T00:01:00Z", steps: [],
  };
  const bossMission: DepartmentMission = {
    ...directMission,
    id: "boss-owned",
    origin: "boss",
    objective: "只應出現在老闆任務日誌",
    createdAt: "2026-07-23T00:00:00Z",
  };
  for (const focusMode of [false, true]) {
    const html = renderToStaticMarkup(<DepartmentMissionDialog
      embedded focusMode={focusMode} boss={boss} workers={[boss]} missions={[directMission, bossMission]}
      onPrepare={async () => ({ error: "unused" })} onStart={noopAction}
      onCancel={noopAction} onRetryReview={noopAction} onApprovePlan={noopAction}
      onResolve={noopAction} onClose={() => undefined}
    />);
    assert.match(html, /部門直接交辦/);
    assert.doesNotMatch(html, /只應出現在老闆任務日誌/);
  }
  const detailHtml = renderToStaticMarkup(<DepartmentMissionDialog
    embedded boss={boss} workers={[boss]} missions={[directMission, bossMission]} missionDetailId="boss-owned"
    onPrepare={async () => ({ error: "unused" })} onStart={noopAction}
    onCancel={noopAction} onRetryReview={noopAction} onApprovePlan={noopAction}
    onResolve={noopAction} onClose={() => undefined}
  />);
  assert.match(detailHtml, /只應出現在老闆任務日誌/);
  assert.doesNotMatch(detailHtml, /部門直接交辦/);
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
  assert.match(html, /直接告訴部門要完成什麼/);
  assert.match(html, /驗收條件.*選填/);
  assert.match(html, /送出即授權部門依成員職務開始/);
  assert.doesNotMatch(html, /role="dialog"/);
  assert.doesNotMatch(html, /關閉部門任務視窗/);
});

test("one department chat submission prepares and immediately starts the mission", async () => {
  const calls: string[] = [];
  const error = await prepareAndStartDepartmentMission(
    { bossWorkerId: "lead", objective: "完成 API", acceptanceCriteria: ["測試通過"] },
    async (input) => {
      calls.push(`prepare:${input.objective}`);
      return { data: { missionToken: "token", objective: input.objective, acceptanceCriteria: input.acceptanceCriteria, maxCorrections: 2, members: [], warnings: [] } };
    },
    async (workerId, token) => {
      calls.push(`start:${workerId}:${token}`);
      return null;
    },
  );
  assert.equal(error, null);
  assert.deepEqual(calls, ["prepare:完成 API", "start:lead:token"]);
});

test("department chat does not start when preparation fails", async () => {
  let started = false;
  const error = await prepareAndStartDepartmentMission(
    { bossWorkerId: "lead", objective: "完成 API", acceptanceCriteria: [] },
    async () => ({ error: "部門忙碌中" }),
    async () => { started = true; return null; },
  );
  assert.equal(error, "部門忙碌中");
  assert.equal(started, false);
});

test("keeps a completed report open with one composer that lets the department judge question vs. follow-up work", () => {
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
  assert.match(html, /部門最終報告/);
  assert.match(html, /DEPARTMENT REPORT/);
  assert.match(html, /由 主管 判斷這是唯讀提問還是新的後續工作/);
  assert.doesNotMatch(html, /詢問部門/);
  assert.doesNotMatch(html, /交辦後續工作/);
  assert.doesNotMatch(html, /department-continuation__modes/);
  assert.match(html, /為什麼採用這個方案？/);
  assert.match(html, /風險最低且驗證完整/);
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

test("shows only the current Mission prominently and tucks other department Missions into a collapsed history", () => {
  const boss = emptyWorker("boss", "主管", null, false, 0, "claude", "/repo");
  const analyst = emptyWorker("analyst", "分析師", null, false, 1, "claude", "/repo");
  const oldMission: DepartmentMission = {
    id: "old-leverage", workspacePath: "/repo", bossWorkerId: boss.id, objective: "評估是否該排除槓桿方案", acceptanceCriteria: ["年化 30% 定義明確"],
    status: "completed", planSummary: "槓桿風險評估", currentStepIndex: null, correctionCount: 0, maxCorrections: 2,
    error: null, createdAt: "2026-07-20T00:00:00Z", startedAt: null, completedAt: "2026-07-20T01:00:00Z",
    steps: [{ id: "synthesis", title: "彙整", objective: "報告", kind: "synthesize", assigneeWorkerId: boss.id, acceptanceCriteria: [], status: "completed", attempt: 1, result: "排除槓桿方案（方案E）之結論", reviewResult: null, startedAt: null, completedAt: null }],
  };
  const activeMission: DepartmentMission = {
    id: "current-tsla", workspacePath: "/repo", bossWorkerId: boss.id, objective: "整理 TSLA 投資報告", acceptanceCriteria: ["含風險評估"],
    status: "needs_attention", planSummary: "風險審視卡住", currentStepIndex: 1, correctionCount: 0, maxCorrections: 2,
    error: "API Error: Connection closed mid-response.", createdAt: "2026-07-25T00:00:00Z", startedAt: null, completedAt: null,
    steps: [
      { id: "research", title: "TSLA 投資研究與財報分析", objective: "分析", kind: "execute", assigneeWorkerId: analyst.id, acceptanceCriteria: [], status: "completed", attempt: 1, result: "已完成", reviewResult: null, startedAt: null, completedAt: null },
      { id: "risk", title: "風險與假設獨立審視", objective: "審視", kind: "review", assigneeWorkerId: analyst.id, acceptanceCriteria: [], status: "failed", attempt: 1, result: null, reviewResult: null, startedAt: null, completedAt: null },
    ],
  };
  const html = renderToStaticMarkup(<DepartmentMissionDialog
    boss={boss} workers={[boss, analyst]} missions={[oldMission, activeMission]}
    onPrepare={async () => ({ error: "unused" })} onStart={noopAction}
    onCancel={noopAction} onRetryReview={noopAction} onApprovePlan={noopAction} onResolve={noopAction} onClose={() => undefined}
  />);
  assert.match(html, /需要你決定/);
  assert.match(html, /此部門過往 Mission · 1/);
  const historyIndex = html.indexOf('class="mission-dialog__history"');
  const pastMissionsIndex = html.indexOf('class="mission-dialog__past-missions"');
  assert.ok(historyIndex > -1 && pastMissionsIndex > historyIndex);
  const prominentSection = html.slice(historyIndex, pastMissionsIndex);
  const collapsedSection = html.slice(pastMissionsIndex);
  assert.match(prominentSection, /TSLA 投資研究與財報分析/);
  assert.match(prominentSection, /風險與假設獨立審視/);
  assert.doesNotMatch(prominentSection, /評估是否該排除槓桿方案/);
  assert.match(collapsedSection, /評估是否該排除槓桿方案/);
});
