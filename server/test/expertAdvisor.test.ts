import assert from "node:assert/strict";
import test from "node:test";
import {
  ADVISOR_MAX_PROPOSALS,
  advisorObjectiveForBossTask,
  advisorProposalsDigest,
  expertAdvisorPrompt,
  explainAdvisorFailure,
  parseAdvisorResult,
  type AdvisorResult,
} from "../src/expertAdvisor.js";

function proposalsBlock(proposals: unknown[], domain = "quantitative trading"): string {
  return `<expert_advisor>${JSON.stringify({ status: "proposals", domain, proposals })}</expert_advisor>`;
}

const validProposal = {
  id: "pairs",
  title: "統計套利／配對交易",
  summary: "找兩個長期同向的標的，價差偏離時做多落後、放空領先。",
  insight: "多數新手只想預測單一標的方向；配對把方向風險對沖掉，賺的是價差回歸。",
  approach: "共整合檢定挑對、算 z-score、設進出場門檻，回測含手續費與滑價。",
  considerations: ["共整合會失效（結構性斷裂）", "交易成本吃掉大半價差"],
  objective: "為台股前 50 大權值股建立一套配對交易策略，含選對、進出場規則與含成本回測。",
};

test("prompt casts an expert, targets the unknown-unknowns, and forbids tools", () => {
  const prompt = expertAdvisorPrompt({ idea: "我想用 AI 做量化交易但不知道從何下手", workspacePath: "/repo" });
  assert.match(prompt, /senior domain expert/i);
  assert.match(prompt, /don't know what you don't know/i);
  assert.match(prompt, /Do not use tools/i);
  assert.match(prompt, /expert_advisor/);
  // The owner's idea is embedded verbatim (JSON-encoded).
  assert.match(prompt, /量化交易但不知道從何下手/);
});

test("prompt clamps the proposal ceiling into a sane range", () => {
  assert.match(expertAdvisorPrompt({ idea: "x", workspacePath: "/r", maxProposals: 99 }), /up to 6 DISTINCT/);
  assert.match(expertAdvisorPrompt({ idea: "x", workspacePath: "/r", maxProposals: 0 }), /up to 1 DISTINCT/);
  assert.match(expertAdvisorPrompt({ idea: "x", workspacePath: "/r" }), new RegExp(`up to ${ADVISOR_MAX_PROPOSALS} DISTINCT`));
});

test("proactive mode with no domain signal demands genuinely different fields, not variants of one guessed niche", () => {
  // Root cause of the "全是米線" repetition: an uninformative workspace (e.g. one
  // literally named 測試) gives no domain signal, so the model would anchor on a
  // single fabricated niche and only vary the angle within it. Proactive mode must
  // instead force each proposal into a different field.
  const prompt = expertAdvisorPrompt({ idea: "", workspacePath: "/c/users/victo/desktop/測試", proactive: true });
  assert.match(prompt, /ALWAYS propose/);
  assert.match(prompt, /GENUINELY DIFFERENT field/);
  assert.match(prompt, /do NOT invent one narrow domain/i);
  // The owner-idea path (real idea, non-proactive) stays domain-focused — no breadth mandate.
  const focused = expertAdvisorPrompt({ idea: "我想用 AI 做量化交易", workspacePath: "/repo" });
  assert.doesNotMatch(focused, /GENUINELY DIFFERENT field/);
});

test("parses a well-formed proposals block", () => {
  const result = parseAdvisorResult(proposalsBlock([validProposal]));
  assert.ok(result && result.status === "proposals");
  assert.equal(result.domain, "quantitative trading");
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].title, "統計套利／配對交易");
  assert.equal(result.proposals[0].considerations.length, 2);
});

test("parses a need_focus block when the idea is too vague to propose", () => {
  const result = parseAdvisorResult(`<expert_advisor>${JSON.stringify({ status: "need_focus", question: "你想解決的是投資、還是做一個工具？" })}</expert_advisor>`);
  assert.ok(result && result.status === "need_focus");
  assert.equal(result.question, "你想解決的是投資、還是做一個工具？");
});

test("rejects a response with no marked block and explains why", () => {
  assert.equal(parseAdvisorResult("here are some ideas..."), null);
  assert.match(explainAdvisorFailure("here are some ideas...") ?? "", /Missing an <expert_advisor>/);
});

test("rejects a proposal missing its insight — the whole point is the non-obvious teach", () => {
  const { insight: _omit, ...noInsight } = validProposal;
  assert.equal(parseAdvisorResult(proposalsBlock([noInsight])), null);
  assert.match(explainAdvisorFailure(proposalsBlock([noInsight])) ?? "", /insight/);
});

test("rejects a proposal missing an executable objective", () => {
  const { objective: _omit, ...noObjective } = validProposal;
  assert.equal(parseAdvisorResult(proposalsBlock([noObjective])), null);
  assert.match(explainAdvisorFailure(proposalsBlock([noObjective])) ?? "", /objective/);
});

test("rejects more proposals than the requested cap", () => {
  const three = [
    { ...validProposal, id: "a" },
    { ...validProposal, id: "b" },
    { ...validProposal, id: "c" },
  ];
  assert.equal(parseAdvisorResult(proposalsBlock(three), 2), null);
  assert.match(explainAdvisorFailure(proposalsBlock(three), 2) ?? "", /at most 2/);
});

test("rejects duplicate proposal ids", () => {
  const dup = [validProposal, { ...validProposal }];
  assert.equal(parseAdvisorResult(proposalsBlock(dup)), null);
  assert.match(explainAdvisorFailure(proposalsBlock(dup)) ?? "", /reuses id/);
});

test("a chosen proposal hands its objective straight to Boss Task", () => {
  const result = parseAdvisorResult(proposalsBlock([validProposal])) as Extract<AdvisorResult, { status: "proposals" }>;
  assert.equal(advisorObjectiveForBossTask(result.proposals[0]), validProposal.objective);
});

test("digest renders every proposal's title and insight, never the internal objective", () => {
  const result = parseAdvisorResult(proposalsBlock([validProposal])) as Extract<AdvisorResult, { status: "proposals" }>;
  const digest = advisorProposalsDigest(result);
  assert.match(digest, /統計套利／配對交易/);
  assert.match(digest, /方向風險對沖掉/);
  assert.doesNotMatch(digest, /含成本回測。$/); // objective text stays internal, not echoed to the log
});
