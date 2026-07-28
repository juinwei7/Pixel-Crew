import assert from "node:assert/strict";
import test from "node:test";
import {
  assignmentDecisionPrompt,
  normalizeAssignmentClarifications,
  parseAssignmentDecision,
  type AssignmentDecisionCandidate,
} from "../src/assignmentDecision.js";

const candidates: AssignmentDecisionCandidate[] = [
  {
    departmentId: "product",
    departmentName: "產品部",
    workspacePath: "/repo",
    leadWorkerId: "product-lead",
    purpose: "設計使用者體驗並交付產品功能",
    members: [{ workerId: "designer", name: "Mina", role: "產品設計師", instructions: "研究使用流程", provider: "claude" }],
  },
  {
    departmentId: "reliability",
    departmentName: "可靠性部",
    workspacePath: "/repo",
    leadWorkerId: "sre-lead",
    purpose: "維持服務韌性、容量與事故應變",
    members: [{ workerId: "sre", name: "Kai", role: "SRE", instructions: "observability and incident response", provider: "codex" }],
  },
];

test("decision prompt supplies real departments and forbids tools", () => {
  const prompt = assignmentDecisionPrompt({
    objective: "Customers lose requests whenever traffic suddenly spikes",
    acceptanceCriteria: ["demonstrate recovery"],
    preferredWorkspace: "/repo",
    candidates,
  });
  assert.match(prompt, /Customers lose requests/);
  assert.match(prompt, /可靠性部/);
  assert.match(prompt, /SRE/);
  assert.match(prompt, /Do not use tools/);
  assert.match(prompt, /Department purpose and NPC position matter more than shared words/);
  assert.match(prompt, /<assignment_decision>/);
});

test("decision prompt carries the Boss clarification transcript without changing the objective", () => {
  const prompt = assignmentDecisionPrompt({
    objective: "Say good morning",
    acceptanceCriteria: ["Every colleague says good morning"],
    preferredWorkspace: "/repo",
    candidates,
    clarifications: [{
      question: "Does every colleague mean Finance or the whole company?",
      answer: "The whole company.",
    }],
  });
  assert.match(prompt, /Say good morning/);
  assert.match(prompt, /The whole company\./);
  assert.match(prompt, /authoritative context/);
  assert.match(prompt, /do not repeat an answered question/);
});

test("normalizes a bounded clarification transcript", () => {
  assert.deepEqual(normalizeAssignmentClarifications([
    { question: " Scope? ", answer: " Everyone " },
    { question: "", answer: "ignored" },
    { question: "Second?", answer: "Answer" },
    { question: "Third?", answer: "Answer" },
    { question: "Fourth?", answer: "is outside the three-turn bound" },
  ]), [
    { question: "Scope?", answer: "Everyone" },
    { question: "Second?", answer: "Answer" },
  ]);
});

test("parses a semantic department decision without keyword scoring", () => {
  const decision = parseAssignmentDecision(`<assignment_decision>
{"departmentId":"reliability","confidence":0.91,"reasons":["Traffic-loss behavior is an availability and capacity concern","The SRE position owns observability and incident response"],"clarificationQuestion":null}
</assignment_decision>`, candidates);
  assert.deepEqual(decision, {
    departmentId: "reliability",
    confidence: 0.91,
    reasons: [
      "Traffic-loss behavior is an availability and capacity concern",
      "The SRE position owns observability and incident response",
    ],
    clarificationQuestion: null,
  });
});

test("rejects invented departments and malformed decisions", () => {
  assert.equal(parseAssignmentDecision(`<assignment_decision>{"departmentId":"invented","confidence":0.9,"reasons":["guess"],"clarificationQuestion":null}</assignment_decision>`, candidates), null);
  assert.equal(parseAssignmentDecision(`<assignment_decision>{"departmentId":"product","confidence":"high","reasons":["guess"],"clarificationQuestion":null}</assignment_decision>`, candidates), null);
  assert.equal(parseAssignmentDecision("product", candidates), null);
});

test("preserves a low-confidence clarification for the API to stop on", () => {
  const decision = parseAssignmentDecision(`<assignment_decision>
{"departmentId":"product","confidence":0.42,"reasons":["The objective could describe either UX or platform behavior"],"clarificationQuestion":"Is the failure visible to users or limited to service infrastructure?"}
</assignment_decision>`, candidates);
  assert.equal(decision?.confidence, 0.42);
  assert.match(decision?.clarificationQuestion ?? "", /visible to users/);
});
