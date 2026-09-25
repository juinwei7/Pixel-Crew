import assert from "node:assert/strict";
import test from "node:test";
import {
  applyBossTaskRecordPatch,
  bossTaskClarificationBudget,
  bossTaskDecisionPrompt,
  bossTaskFinalReport,
  bossTaskAcceptancePrompt,
  parseBossTaskAcceptanceVerdicts,
  explainBossTaskDecisionFailure,
  parseBossTaskDecision,
  type BossTask,
} from "../src/bossTask.js";
import type { AssignmentDecisionCandidate } from "../src/assignmentDecision.js";

const candidates: AssignmentDecisionCandidate[] = [
  {
    departmentId: "pm",
    departmentName: "PM",
    workspacePath: "/repo",
    leadWorkerId: "pm-lead",
    purpose: "requirements and product planning",
    members: [{ workerId: "pm-lead", name: "Mina", role: "Product Manager", instructions: "define scope", provider: "codex" }],
  },
  {
    departmentId: "eng",
    departmentName: "Engineering",
    workspacePath: "/repo",
    leadWorkerId: "eng-lead",
    purpose: "implementation",
    members: [{ workerId: "eng-lead", name: "Eli", role: "Backend Engineer", instructions: "build services", provider: "claude" }],
  },
  {
    departmentId: "qa",
    departmentName: "QA",
    workspacePath: "/repo",
    leadWorkerId: "qa-lead",
    purpose: "independent verification",
    members: [{ workerId: "qa-lead", name: "Quinn", role: "QA Engineer", instructions: "verify acceptance", provider: "codex" }],
  },
];

test("broad product work is explicitly gated by discovery in the prompt", () => {
  const prompt = bossTaskDecisionPrompt({
    task: {
      objective: "Build an ERP",
      acceptanceCriteria: [],
      workspacePath: "/repo",
      messages: [{ id: "m1", role: "boss", text: "Build an ERP", createdAt: "2026-01-01" }],
    },
    candidates,
  });
  assert.match(prompt, /normally require discovery/i);
  assert.match(prompt, /ask one blocking clarification question/i);
  assert.match(prompt, /PM/);
  assert.match(prompt, /QA Engineer/);
  assert.match(prompt, /Do not use tools/);
  assert.match(prompt, /research.*project/is);
  assert.match(prompt, /advisory.*one department/is);
});

test("simple imperatives use Department Missions without inventing a delivery channel", () => {
  const prompt = bossTaskDecisionPrompt({
    task: {
      objective: "每個員工都跟我說早安",
      acceptanceCriteria: [],
      workspacePath: "/repo",
      messages: [
        { id: "m1", role: "boss", text: "每個員工都跟我說早安", createdAt: "2026-01-01" },
        { id: "m2", role: "decision_model", text: "何時執行？", createdAt: "2026-01-01" },
        { id: "m3", role: "boss", text: "現在", createdAt: "2026-01-01" },
        { id: "m4", role: "decision_model", text: "哪些員工？", createdAt: "2026-01-01" },
        { id: "m5", role: "boss", text: "所有部門員工", createdAt: "2026-01-01" },
      ],
    },
    candidates,
  });
  assert.match(prompt, /one-time request to execute now/i);
  assert.match(prompt, /Department Missions are the execution and communication channel/i);
  assert.match(prompt, /Never ask whether to use Slack/i);
  assert.match(prompt, /1 clarification question\(s\) remaining/i);
});

test("clarification budget is semantic-flow guardrail and reaches zero after three model questions", () => {
  const messages = [
    { id: "m1", role: "decision_model" as const, text: "Q1", createdAt: "2026-01-01" },
    { id: "m2", role: "boss" as const, text: "A1", createdAt: "2026-01-01" },
    { id: "m3", role: "decision_model" as const, text: "Q2", createdAt: "2026-01-01" },
    { id: "m4", role: "boss" as const, text: "A2", createdAt: "2026-01-01" },
    { id: "m5", role: "decision_model" as const, text: "Q3", createdAt: "2026-01-01" },
  ];
  assert.deepEqual(bossTaskClarificationBudget({ messages }), { used: 3, remaining: 0 });
  const prompt = bossTaskDecisionPrompt({
    task: { objective: "Do it", acceptanceCriteria: [], workspacePath: "/repo", messages },
    candidates,
  });
  assert.match(prompt, /MUST return ready/i);
  assert.match(prompt, /Do not return clarification/i);
});

test("required-input preflight: prompt surfaces attachment count and demands asking for missing inputs up front", () => {
  const base = {
    objective: "對主資料表做實體解析清理並驗證準確率",
    acceptanceCriteria: [],
    workspacePath: "/repo",
    messages: [{ id: "m1", role: "boss" as const, text: "清理主資料", createdAt: "2026-01-01" }],
  };
  // 沒附件：模型必須知道「0 file(s)」，缺輸入要當下就問，別跑到一半才發現。
  const bare = bossTaskDecisionPrompt({ task: base, candidates });
  assert.match(bare, /Required-input preflight/);
  assert.match(bare, /Attachments provided by the Boss: 0 file\(s\)/);
  assert.match(bare, /missing input discovered mid-execution wastes the whole run/i);
  // 有附件：數量如實呈現，讓模型把附件當成已到位的輸入。
  const attached = bossTaskDecisionPrompt({ task: { ...base, attachmentIds: ["a1", "a2"] }, candidates });
  assert.match(attached, /Attachments provided by the Boss: 2 file\(s\)/);
});

test("parses clarification without creating stages", () => {
  const decision = parseBossTaskDecision(
    `<boss_task_decision>{"status":"clarification","question":"Which ERP modules belong in the first release?","rationale":["The requested product boundary is unknown"]}</boss_task_decision>`,
    candidates,
  );
  assert.deepEqual(decision, {
    status: "clarification",
    question: "Which ERP modules belong in the first release?",
    rationale: ["The requested product boundary is unknown"],
  });
});

test("parses create_department and clamps memberCount to 2-4", () => {
  const decision = parseBossTaskDecision(
    `<boss_task_decision>{"status":"create_department","departmentPurpose":"本地優先個人 AI 助理研發","memberCount":9,"rationale":["No existing department covers local RAG + Ollama work"]}</boss_task_decision>`,
    candidates,
  );
  assert.equal(decision?.status, "create_department");
  if (decision?.status === "create_department") {
    assert.equal(decision.departmentPurpose, "本地優先個人 AI 助理研發");
    assert.equal(decision.memberCount, 4); // clamped down from 9
    assert.ok(decision.rationale.length >= 1);
  }
});

test("create_department defaults memberCount to 3 and requires a purpose", () => {
  const defaulted = parseBossTaskDecision(
    `<boss_task_decision>{"status":"create_department","departmentPurpose":"資安稽核","rationale":["fresh domain"]}</boss_task_decision>`,
    candidates,
  );
  assert.equal(defaulted?.status === "create_department" && defaulted.memberCount, 3);
  // Missing purpose is invalid (would create a nameless team).
  const noPurpose = parseBossTaskDecision(
    `<boss_task_decision>{"status":"create_department","memberCount":3,"rationale":["x"]}</boss_task_decision>`,
    candidates,
  );
  assert.equal(noPurpose, null);
});

test("validates a multi-department acyclic graph and rejects a cycle", () => {
  const ready = parseBossTaskDecision(
    `<boss_task_decision>{"status":"ready","executionMode":"project","summary":"Plan, build, verify","rationale":["Distinct ownership"],"stages":[{"id":"plan","departmentId":"pm","title":"Plan","objective":"Define MVP","acceptanceCriteria":["Approved scope"],"dependsOn":[]},{"id":"build","departmentId":"eng","title":"Build","objective":"Implement MVP","acceptanceCriteria":["Working system"],"dependsOn":["plan"]},{"id":"verify","departmentId":"qa","title":"Verify","objective":"Test MVP","acceptanceCriteria":["Test report"],"dependsOn":["build"]}]}</boss_task_decision>`,
    candidates,
  );
  assert.equal(ready?.status, "ready");
  if (ready?.status === "ready") {
    assert.equal(ready.executionMode, "project");
    assert.deepEqual(ready.stages.map((stage) => stage.departmentId), ["pm", "eng", "qa"]);
  }

  const cycle = parseBossTaskDecision(
    `<boss_task_decision>{"status":"ready","executionMode":"project","summary":"bad","rationale":["bad"],"stages":[{"id":"a","departmentId":"pm","title":"A","objective":"A","acceptanceCriteria":["A"],"dependsOn":["b"]},{"id":"b","departmentId":"eng","title":"B","objective":"B","acceptanceCriteria":["B"],"dependsOn":["a"]}]}</boss_task_decision>`,
    candidates,
  );
  assert.equal(cycle, null);
});

test("directExecute flag is parsed per stage and defaults off", () => {
  const withFlag = parseBossTaskDecision(
    `<boss_task_decision>{"status":"ready","executionMode":"project","summary":"trivial write","rationale":["single action"],"stages":[{"id":"write","departmentId":"eng","title":"Write file","objective":"Create one small file","acceptanceCriteria":["file exists"],"dependsOn":[],"directExecute":true}]}</boss_task_decision>`,
    candidates,
  );
  assert.equal(withFlag?.status, "ready");
  if (withFlag?.status === "ready") assert.equal(withFlag.stages[0].directExecute, true);

  const withoutFlag = parseBossTaskDecision(
    `<boss_task_decision>{"status":"ready","executionMode":"project","summary":"normal","rationale":["multi step"],"stages":[{"id":"build","departmentId":"eng","title":"Build","objective":"Implement the feature","acceptanceCriteria":["works"],"dependsOn":[]}]}</boss_task_decision>`,
    candidates,
  );
  assert.equal(withoutFlag?.status, "ready");
  // 未給旗標時 directExecute 必須是 undefined（falsy）——不能誤啟快速道
  if (withoutFlag?.status === "ready") assert.notEqual(withoutFlag.stages[0].directExecute, true);

  // 非布林垃圾值不得被當真
  const garbage = parseBossTaskDecision(
    `<boss_task_decision>{"status":"ready","executionMode":"project","summary":"garbage flag","rationale":["x"],"stages":[{"id":"s","departmentId":"eng","title":"S","objective":"do","acceptanceCriteria":["ok"],"dependsOn":[],"directExecute":"yes"}]}</boss_task_decision>`,
    candidates,
  );
  if (garbage?.status === "ready") assert.notEqual(garbage.stages[0].directExecute, true);
});

test("noReview flag is parsed per stage and defaults off", () => {
  const withFlag = parseBossTaskDecision(
    `<boss_task_decision>{"status":"ready","executionMode":"project","summary":"simple multi-doc","rationale":["low risk authoring"],"stages":[{"id":"docs","departmentId":"eng","title":"Write docs","objective":"Author a set of related documents","acceptanceCriteria":["files exist"],"dependsOn":[],"noReview":true}]}</boss_task_decision>`,
    candidates,
  );
  assert.equal(withFlag?.status, "ready");
  if (withFlag?.status === "ready") assert.equal(withFlag.stages[0].noReview, true);

  const withoutFlag = parseBossTaskDecision(
    `<boss_task_decision>{"status":"ready","executionMode":"project","summary":"risky logic","rationale":["needs QA"],"stages":[{"id":"impl","departmentId":"eng","title":"Implement","objective":"Write the calculation engine","acceptanceCriteria":["passes"],"dependsOn":[]}]}</boss_task_decision>`,
    candidates,
  );
  // 未給旗標時 noReview 必須是 undefined（falsy）——不能誤啟剝 review
  if (withoutFlag?.status === "ready") assert.notEqual(withoutFlag.stages[0].noReview, true);

  // 非布林垃圾值不得被當真
  const garbage = parseBossTaskDecision(
    `<boss_task_decision>{"status":"ready","executionMode":"project","summary":"garbage","rationale":["x"],"stages":[{"id":"s","departmentId":"eng","title":"S","objective":"do","acceptanceCriteria":["ok"],"dependsOn":[],"noReview":"yes"}]}</boss_task_decision>`,
    candidates,
  );
  if (garbage?.status === "ready") assert.notEqual(garbage.stages[0].noReview, true);
});

test("selected execution boundary rejects a graph beyond its stage ceiling", () => {
  const fourStages = `<boss_task_decision>{"status":"ready","executionMode":"project","summary":"too broad for standard","rationale":["four owners"],"stages":[{"id":"a","departmentId":"pm","title":"A","objective":"A","acceptanceCriteria":["A"],"dependsOn":[]},{"id":"b","departmentId":"eng","title":"B","objective":"B","acceptanceCriteria":["B"],"dependsOn":["a"]},{"id":"c","departmentId":"qa","title":"C","objective":"C","acceptanceCriteria":["C"],"dependsOn":["b"]},{"id":"d","departmentId":"pm","title":"D","objective":"D","acceptanceCriteria":["D"],"dependsOn":["c"]}]}</boss_task_decision>`;
  assert.match(explainBossTaskDecisionFailure(fourStages, candidates, "standard") ?? "", /1 to 3/);
  assert.match(explainBossTaskDecisionFailure(fourStages, candidates, "quick") ?? "", /1 to 1/);
});

test("research is one department answer workflow and duplicate department stages are rejected", () => {
  const research = parseBossTaskDecision(
    `<boss_task_decision>{"status":"ready","executionMode":"research","summary":"Current evidence and conditional conclusion","rationale":["Decision support"],"stages":[{"id":"market-research","departmentId":"pm","title":"Evaluate the market setup","objective":"Check current evidence, contrary cases, and answer the owner","acceptanceCriteria":["Sources and dates are explicit","Conclusion is conditional"],"dependsOn":[]}]}</boss_task_decision>`,
    candidates,
  );
  assert.equal(research?.status, "ready");
  if (research?.status === "ready") {
    assert.equal(research.executionMode, "research");
    assert.equal(research.stages.length, 1);
  }

  const splitResearch = explainBossTaskDecisionFailure(
    `<boss_task_decision>{"status":"ready","executionMode":"research","summary":"Over split","rationale":["research"],"stages":[{"id":"facts","departmentId":"pm","title":"Facts","objective":"Find facts","acceptanceCriteria":["facts"],"dependsOn":[]},{"id":"conclusion","departmentId":"pm","title":"Conclusion","objective":"Conclude","acceptanceCriteria":["answer"],"dependsOn":["facts"]}]}</boss_task_decision>`,
    candidates,
  );
  assert.match(splitResearch ?? "", /research.*exactly one department stage/i);

  const duplicateProjectDepartment = explainBossTaskDecisionFailure(
    `<boss_task_decision>{"status":"ready","executionMode":"project","summary":"Over split","rationale":["same owner"],"stages":[{"id":"a","departmentId":"eng","title":"A","objective":"A","acceptanceCriteria":["A"],"dependsOn":[]},{"id":"b","departmentId":"eng","title":"B","objective":"B","acceptanceCriteria":["B"],"dependsOn":["a"]}]}</boss_task_decision>`,
    candidates,
  );
  assert.match(duplicateProjectDepartment ?? "", /department.*only once/i);
});

test("explains exactly why a decision failed so a repair prompt can name the fix", () => {
  assert.match(explainBossTaskDecisionFailure("no tags here", candidates) ?? "", /Missing a <boss_task_decision>/);
  assert.match(explainBossTaskDecisionFailure(`<boss_task_decision>{not json}</boss_task_decision>`, candidates) ?? "", /did not parse/);
  assert.match(
    explainBossTaskDecisionFailure(
      `<boss_task_decision>{"status":"ready","executionMode":"project","summary":"s","rationale":["r"],"stages":[{"id":"a","departmentId":"marketing","title":"A","objective":"A","acceptanceCriteria":["A"],"dependsOn":[]}]}</boss_task_decision>`,
      candidates,
    ) ?? "",
    /not in the eligible department catalog.*pm.*eng.*qa/,
  );
  assert.match(
    explainBossTaskDecisionFailure(
      `<boss_task_decision>{"status":"ready","executionMode":"project","summary":"s","rationale":["r"],"stages":[{"id":"a","departmentId":"pm","title":"A","objective":"A","acceptanceCriteria":[],"dependsOn":[]}]}</boss_task_decision>`,
      candidates,
    ) ?? "",
    /needs at least one non-empty "acceptanceCriteria"/,
  );
  assert.match(
    explainBossTaskDecisionFailure(
      `<boss_task_decision>{"status":"ready","executionMode":"project","summary":"bad","rationale":["bad"],"stages":[{"id":"a","departmentId":"pm","title":"A","objective":"A","acceptanceCriteria":["A"],"dependsOn":["b"]},{"id":"b","departmentId":"eng","title":"B","objective":"B","acceptanceCriteria":["B"],"dependsOn":["a"]}]}</boss_task_decision>`,
      candidates,
    ) ?? "",
    /cycle/,
  );
  assert.equal(
    explainBossTaskDecisionFailure(
      `<boss_task_decision>{"status":"clarification","question":"Which release?","rationale":["Unknown scope"]}</boss_task_decision>`,
      candidates,
    ),
    null,
  );
  assert.match(
    explainBossTaskDecisionFailure(
      `<boss_task_decision>{"status":"ready","summary":"s","rationale":["r"],"stages":[{"id":"a","departmentId":"pm","title":"A","objective":"A","acceptanceCriteria":["A"],"dependsOn":[]}]}</boss_task_decision>`,
      candidates,
    ) ?? "",
    /executionMode/,
  );
});

test("consolidates department reports into one Boss report", () => {
  const task = {
    id: "task",
    title: "Build ERP",
    archivedAt: null,
    workspacePath: "/repo",
    decisionProvider: "codex",
    decisionModel: "gpt",
    objective: "Build ERP",
    acceptanceCriteria: ["QA passes"],
    status: "completed",
    messages: [],
    stages: [
      { id: "plan", departmentId: "pm", departmentName: "PM", title: "Plan", objective: "Plan", acceptanceCriteria: ["scope"], dependsOn: [], status: "completed", missionId: "m1", report: "MVP scope" },
      { id: "qa", departmentId: "qa", departmentName: "QA", title: "Verify", objective: "Verify", acceptanceCriteria: ["pass"], dependsOn: ["plan"], status: "completed", missionId: "m2", report: "All tests passed" },
    ],
    finalReport: null,
    error: null,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    completedAt: "2026-01-01",
  } satisfies BossTask;
  const report = bossTaskFinalReport(task);
  assert.match(report, /MVP scope/);
  assert.match(report, /All tests passed/);
  assert.match(report, /QA passes/);
});

function completedTask(criteria: string[], reports: string[]): BossTask {
  return {
    id: "task",
    title: "Build ERP",
    archivedAt: null,
    workspacePath: "/repo",
    decisionProvider: "codex",
    decisionModel: "gpt",
    objective: "Build ERP",
    acceptanceCriteria: criteria,
    status: "completed",
    messages: [],
    stages: reports.map((report, index) => ({
      id: `s${index}`,
      departmentId: `d${index}`,
      departmentName: `Dept ${index}`,
      title: `Stage ${index}`,
      objective: "do",
      acceptanceCriteria: [],
      dependsOn: [],
      status: "completed" as const,
      missionId: `m${index}`,
      report,
    })),
    finalReport: null,
    error: null,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    completedAt: "2026-01-01",
  } satisfies BossTask;
}

test("acceptance prompt carries every criterion and each stage report for judging", () => {
  const task = completedTask(["Login works", "Data persists"], ["Auth shipped", "DB wired"]);
  const prompt = bossTaskAcceptancePrompt(task);
  assert.match(prompt, /Acceptance Verification/);
  assert.match(prompt, /Login works/);
  assert.match(prompt, /Data persists/);
  assert.match(prompt, /Auth shipped/);
  assert.match(prompt, /DB wired/);
  assert.match(prompt, /<boss_task_acceptance>/);
});

test("verdict parser aligns to criteria order and fills gaps with unverifiable", () => {
  const criteria = ["A", "B", "C"];
  const text = `noise <boss_task_acceptance>{"verdicts":[{"index":1,"status":"met","evidence":"done"},{"index":2,"status":"unmet","evidence":"missing"}]}</boss_task_acceptance>`;
  const verdicts = parseBossTaskAcceptanceVerdicts(text, criteria);
  assert.equal(verdicts.length, 3);
  assert.deepEqual(verdicts.map((v) => v.status), ["met", "unmet", "unverifiable"]);
  assert.equal(verdicts[0].criterion, "A");
  assert.equal(verdicts[0].evidence, "done");
  assert.equal(verdicts[2].evidence, "");
});

test("verdict parser degrades to all-unverifiable when the block is missing or invalid", () => {
  const criteria = ["A", "B"];
  for (const text of ["", "no block here", "<boss_task_acceptance>not json</boss_task_acceptance>"]) {
    const verdicts = parseBossTaskAcceptanceVerdicts(text, criteria);
    assert.equal(verdicts.length, 2);
    assert.ok(verdicts.every((v) => v.status === "unverifiable"));
  }
  // Out-of-range or bad status values are ignored, not trusted.
  const bad = parseBossTaskAcceptanceVerdicts(
    `<boss_task_acceptance>{"verdicts":[{"index":9,"status":"met"},{"index":1,"status":"perfect"}]}</boss_task_acceptance>`,
    criteria,
  );
  assert.deepEqual(bad.map((v) => v.status), ["unverifiable", "unverifiable"]);
});

test("final report renders a per-criterion verdict table with a met/unmet tally", () => {
  const task = completedTask(["Login works", "Data persists"], ["report"]);
  const report = bossTaskFinalReport(task, [
    { criterion: "Login works", status: "met", evidence: "auth tested" },
    { criterion: "Data persists", status: "unmet", evidence: "no db" },
  ]);
  assert.match(report, /1 項達成/);
  assert.match(report, /\| --- \| --- \| --- \|/);
  assert.match(report, /達成.*Login works.*auth tested/);
  assert.match(report, /未達成.*Data persists.*no db/);
});

test("final report escapes pipes so criterion text cannot break the table", () => {
  const task = completedTask(["a | b"], ["report"]);
  const report = bossTaskFinalReport(task, [{ criterion: "a | b", status: "met", evidence: "" }]);
  assert.match(report, /a \\\| b/);
});

test("final report without verdicts stays honest that criteria were not auto-checked", () => {
  const task = completedTask(["Login works"], ["report"]);
  const report = bossTaskFinalReport(task);
  assert.match(report, /未能自動逐條核對/);
  assert.match(report, /- Login works/);
});

test("record metadata can be renamed, while only terminal Boss tasks can be archived", () => {
  const running = {
    id: "task",
    title: "Original title",
    archivedAt: null,
    workspacePath: "/repo",
    decisionProvider: "codex",
    decisionModel: "gpt",
    objective: "Immutable original objective",
    acceptanceCriteria: [],
    status: "running",
    messages: [],
    stages: [],
    finalReport: null,
    error: null,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    completedAt: null,
  } satisfies BossTask;
  assert.equal(applyBossTaskRecordPatch(running, { title: "Readable title" }), null);
  assert.equal(running.title, "Readable title");
  assert.equal(running.objective, "Immutable original objective");
  assert.equal(applyBossTaskRecordPatch(running, { archived: true }), "進行中或等待處理的任務不能封存");
  assert.equal(running.archivedAt, null);
  running.status = "completed";
  assert.equal(applyBossTaskRecordPatch(running, { archived: true }, "2026-01-02"), null);
  assert.equal(running.archivedAt, "2026-01-02");
  assert.equal(applyBossTaskRecordPatch(running, { archived: false }), null);
  assert.equal(running.archivedAt, null);
});
