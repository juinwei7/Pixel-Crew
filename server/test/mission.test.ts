import assert from "node:assert/strict";
import test from "node:test";
import {
  applyMissionActivityEvent,
  createMissionActivity,
  missionActiveWorkerId,
  missionLocksWorkspace,
  missionFormatRepairPrompt,
  missionFollowUpPrompt,
  missionPlanningPrompt,
  missionStepPrompt,
  parseMissionPlan,
  precedingExecuteIndex,
  type DepartmentMission,
} from "../src/mission.js";

function plan(steps: unknown[]): string {
  return `<department_mission_plan>${JSON.stringify({ summary: "Ship safely", steps })}</department_mission_plan>`;
}

const execute = { title: "Implement", objective: "Build the API", kind: "execute", assigneeWorkerId: "builder", acceptanceCriteria: ["tests pass"] };
const review = { title: "Review", objective: "Check the API", kind: "review", assigneeWorkerId: "reviewer", acceptanceCriteria: ["cite risks"] };

test("parses a bounded ordered same-department Mission plan", () => {
  const result = parseMissionPlan(plan([execute, review]), new Set(["builder", "reviewer"]));
  assert.equal(result.error, undefined);
  assert.equal(result.plan?.steps.length, 2);
  assert.equal(result.plan?.steps[1].kind, "review");
});

test("accepts a Quick Consult or Review only when it returns to the department lead", () => {
  const consult = { title: "Ask specialist", objective: "Investigate", kind: "consult", assigneeWorkerId: "reviewer", acceptanceCriteria: ["give advice"] };
  const continuation = { ...execute, title: "Boss continues", assigneeWorkerId: "boss" };
  const accepted = parseMissionPlan(plan([consult, continuation]), new Set(["boss", "builder", "reviewer"]), "boss");
  assert.equal(accepted.plan?.steps[0].kind, "consult");
  const wrongReturn = parseMissionPlan(plan([consult, { ...continuation, assigneeWorkerId: "builder" }]), new Set(["boss", "builder", "reviewer"]), "boss");
  assert.match(wrongReturn.error ?? "", /必須交回部門主管/);
});

test("research plans are one lead answer or one consult plus the lead answer", () => {
  const leadOnly = parseMissionPlan(
    plan([{ ...execute, title: "Answer owner", assigneeWorkerId: "boss" }]),
    new Set(["boss", "reviewer"]),
    "boss",
    new Set(),
    "research",
  );
  assert.equal(leadOnly.error, undefined);
  assert.equal(leadOnly.plan?.steps.length, 1);

  const consult = { title: "Check evidence", objective: "Find current and contrary evidence", kind: "consult", assigneeWorkerId: "reviewer", acceptanceCriteria: ["cite sources"] };
  const answer = { ...execute, title: "Answer owner", assigneeWorkerId: "boss" };
  const bounded = parseMissionPlan(plan([consult, answer]), new Set(["boss", "reviewer"]), "boss", new Set(), "research");
  assert.equal(bounded.error, undefined);

  const reviewLoop = parseMissionPlan(plan([execute, review]), new Set(["builder", "reviewer", "boss"]), "boss", new Set(), "research");
  assert.match(reviewLoop.error ?? "", /研究模式/);
  const tooMany = parseMissionPlan(plan([consult, answer, answer]), new Set(["boss", "reviewer"]), "boss", new Set(), "research");
  assert.match(tooMany.error ?? "", /1 到 2/);
});

test("rejects department-external assignments and non-adjacent Review steps", () => {
  const outside = parseMissionPlan(plan([execute, { ...review, assigneeWorkerId: "outsider" }]), new Set(["builder", "reviewer"]));
  assert.match(outside.error ?? "", /部門外/);
  const nonAdjacent = parseMissionPlan(plan([execute, review, { ...review, title: "Second review" }]), new Set(["builder", "reviewer"]));
  assert.match(nonAdjacent.error ?? "", /緊接在 Execute/);
});

test("rejects a full Mission when Review is assigned to its Execute author", () => {
  const samePersonReview = parseMissionPlan(
    plan([execute, { ...review, assigneeWorkerId: execute.assigneeWorkerId }]),
    new Set(["builder"]),
    "builder",
  );
  assert.match(samePersonReview.error ?? "", /不同 NPC/);
});

test("keeps a Mission turn open across an async Agent intermediate turn_end", () => {
  let activity = createMissionActivity();
  ({ activity } = applyMissionActivityEvent(activity, { type: "tool_call_start", id: "agent-1", name: "Agent" }));
  const launched = applyMissionActivityEvent(activity, {
    type: "tool_call_result",
    id: "agent-1",
    output: "Async agent launched successfully\nagentId: abc123",
    isError: false,
  });
  activity = launched.activity;
  assert.equal(launched.shouldFinish, false);
  const intermediate = applyMissionActivityEvent(activity, { type: "turn_end" });
  assert.equal(intermediate.shouldFinish, false);
  assert.deepEqual(intermediate.activity.openAgentIds, ["agent-1"]);
  ({ activity } = applyMissionActivityEvent(intermediate.activity, {
    type: "tool_call_result",
    id: "agent-1",
    output: "background result",
    isError: false,
  }));
  const final = applyMissionActivityEvent(activity, { type: "turn_end" });
  assert.equal(final.shouldFinish, true);
  assert.deepEqual(final.activity.openAgentIds, []);
});

test("Mission prompt binds assignments and keeps Git release actions unauthorized", () => {
  const prompt = missionPlanningPrompt({
    missionId: "mission-1",
    bossWorkerId: "builder",
    objective: "Implement missions",
    acceptanceCriteria: ["tests pass"],
    workspacePath: "/repo",
    members: [{ id: "builder", name: "Builder", role: "Engineer", provider: "codex" }],
  });
  assert.match(prompt, /2 到 4/);
  assert.match(prompt, /依照每位 NPC 的 role/);
  assert.match(prompt, /不需要再次核准一般分工/);
  assert.match(prompt, /Quick Consult/);
  assert.match(prompt, /assigneeWorkerId/);
  assert.match(prompt, /不可 commit、push、merge、tag、publish、release/);
  assert.match(prompt, /<department_mission_plan>/);
});

test("research prompts require the minimal read-only answer path", () => {
  const prompt = missionPlanningPrompt({
    missionId: "research-1",
    bossWorkerId: "lead",
    objective: "Evaluate whether a market dip is buyable",
    acceptanceCriteria: ["sources dated", "conditional conclusion"],
    workspacePath: "/repo",
    members: [
      { id: "lead", name: "Lead", role: "Portfolio manager", provider: "codex" },
      { id: "analyst", name: "Analyst", role: "Research analyst", provider: "claude" },
    ],
    executionMode: "research",
  });
  assert.match(prompt, /RESEARCH MODE/);
  assert.match(prompt, /1 到 2/);
  assert.match(prompt, /不可建立或修改檔案/);
  assert.doesNotMatch(prompt, /產出 2 到 4/);
});

test("report follow-up prompt is bounded, report-aware, and explicitly read-only", () => {
  const mission: DepartmentMission = {
    id: "mission", departmentId: "department", workspacePath: "/repo", bossWorkerId: "boss", objective: "Ship safely",
    acceptanceCriteria: ["tests pass"], status: "completed", planSummary: "Build then review", currentStepIndex: null,
    correctionCount: 0, maxCorrections: 2, error: null, createdAt: "", startedAt: null, completedAt: "",
    steps: [{ id: "step", title: "Review", objective: "Review", kind: "review", assigneeWorkerId: "reviewer", acceptanceCriteria: [], status: "completed", attempt: 1, result: "Reviewed", reviewResult: { verdict: "pass", summary: "Looks safe", findings: [], risks: ["Deployment timing"], openQuestions: [], recommendedNextAction: "Deploy carefully", structured: true }, startedAt: null, completedAt: null }],
  };
  const prompt = missionFollowUpPrompt(mission, "為什麼這樣做？");
  assert.match(prompt, /Ship safely/);
  assert.match(prompt, /Looks safe/);
  assert.match(prompt, /Deployment timing/);
  assert.match(prompt, /為什麼這樣做/);
  assert.match(prompt, /唯讀追問/);
  assert.match(prompt, /不可修改檔案/);
  assert.match(prompt, /交辦後續工作/);
});

test("format repair is bounded and forbids tools or a repeated analysis", () => {
  const prompt = missionFormatRepairPrompt("review", "I checked it but forgot the envelope");
  assert.match(prompt, /唯一一次格式修復/);
  assert.match(prompt, /不要使用工具、不要啟動 Agent、不要重做分析/);
  assert.match(prompt, /<collaboration_result>/);
});

test("Quick Consult runs read-only and passes structured advice into the department lead continuation", () => {
  const mission: DepartmentMission = {
    id: "quick", workspacePath: "/repo", bossWorkerId: "boss", objective: "Investigate", acceptanceCriteria: ["answer"],
    status: "reviewing", planSummary: "Quick Consult", currentStepIndex: 0, correctionCount: 0, maxCorrections: 2,
    error: null, createdAt: "2026-07-22T00:00:00Z", startedAt: null, completedAt: null,
    steps: [],
  };
  const consultStep = { id: "consult", title: "Ask", objective: "Investigate", kind: "consult" as const, assigneeWorkerId: "reviewer", acceptanceCriteria: [], status: "running" as const, attempt: 1, result: null, reviewResult: null, startedAt: null, completedAt: null };
  const consultPrompt = missionStepPrompt({ mission, step: consultStep, assigneeName: "Reviewer" });
  assert.match(consultPrompt, /唯讀 Consult/);
  assert.match(consultPrompt, /advice\|inconclusive/);
  const advice = { verdict: "advice" as const, summary: "Use the small path", findings: [], risks: [], openQuestions: [], recommendedNextAction: "continue", structured: true };
  const bossPrompt = missionStepPrompt({ mission, step: { ...consultStep, id: "execute", kind: "execute", assigneeWorkerId: "boss" }, assigneeName: "Boss", priorReview: advice });
  assert.match(bossPrompt, /前一位專家的 Consult／Review 結果/);
  assert.match(bossPrompt, /Use the small path/);
});

test("synthesis produces one owner-facing department report with acceptance and risk status", () => {
  const mission: DepartmentMission = {
    id: "report", workspacePath: "/repo", bossWorkerId: "lead", objective: "Ship", acceptanceCriteria: ["tests pass"],
    status: "executing", planSummary: "Build and report", currentStepIndex: 2, correctionCount: 0, maxCorrections: 2,
    error: null, createdAt: "", startedAt: null, completedAt: null,
    steps: [
      { id: "build", ...execute, status: "completed", attempt: 1, result: "Implemented", reviewResult: null, startedAt: null, completedAt: null },
      { id: "review", ...review, status: "completed", attempt: 1, result: "Passed", reviewResult: { verdict: "pass", summary: "Safe", findings: [], risks: [], openQuestions: [], recommendedNextAction: "", structured: true }, startedAt: null, completedAt: null },
    ],
  };
  const synthesis = { id: "report", title: "Report", objective: "Compile", kind: "synthesize" as const, assigneeWorkerId: "lead", acceptanceCriteria: ["tests pass"], status: "running" as const, attempt: 1, result: null, reviewResult: null, startedAt: null, completedAt: null };
  const prompt = missionStepPrompt({ mission, step: synthesis, assigneeName: "Lead" });
  assert.match(prompt, /唯一的最終報告/);
  assert.match(prompt, /各項驗收條件是否達成/);
  assert.match(prompt, /剩餘風險/);
});

test("routes Mission phases to exactly one active worker and finds correction target", () => {
  const mission: DepartmentMission = {
    id: "mission", workspacePath: "/repo", bossWorkerId: "boss", objective: "ship", acceptanceCriteria: [],
    status: "planning", planSummary: null, currentStepIndex: null, correctionCount: 0, maxCorrections: 2,
    error: null, createdAt: "2026-07-22T00:00:00Z", startedAt: null, completedAt: null,
    steps: [
      { id: "a", ...execute, status: "completed", attempt: 1, result: "done", reviewResult: null, startedAt: null, completedAt: null },
      { id: "b", ...review, status: "running", attempt: 1, result: null, reviewResult: null, startedAt: null, completedAt: null },
    ],
  };
  assert.equal(missionActiveWorkerId(mission), "boss");
  mission.status = "reviewing";
  mission.currentStepIndex = 1;
  assert.equal(missionActiveWorkerId(mission), "reviewer");
  assert.equal(precedingExecuteIndex(mission, 1), 0);
  mission.status = "needs_attention";
  assert.equal(missionActiveWorkerId(mission), null);
  assert.equal(missionLocksWorkspace(mission), true);
  mission.status = "completed";
  assert.equal(missionLocksWorkspace(mission), false);
});
