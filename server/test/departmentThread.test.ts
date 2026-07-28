import assert from "node:assert/strict";
import test from "node:test";
import { assertMissionTransition, boundedDepartmentContext, parseIntentClassification } from "../src/departmentThread.js";

test("parses semantic department intent and rejects invalid classifier output", () => {
  assert.deepEqual(parseIntentClassification('<department_intent>{"intent":"mission_update","confidence":0.92,"reason":"changes scope","changeImpact":"major","clarificationQuestion":null}</department_intent>'), {
    intent: "mission_update", confidence: 0.92, reason: "changes scope", changeImpact: "major", clarificationQuestion: null,
  });
  assert.equal(parseIntentClassification('<department_intent>{"intent":"guess","confidence":1}</department_intent>'), null);
});

test("rejects illegal Mission lifecycle transitions", () => {
  assert.doesNotThrow(() => assertMissionTransition("running", "replanning"));
  assert.throws(() => assertMissionTransition("completed", "running"), /Illegal Mission transition/);
});

test("department working context is bounded to summaries and recent messages", () => {
  const context = boundedDepartmentContext({
    threadSummary: "thread",
    missionSummary: "mission",
    recentMessages: Array.from({ length: 20 }, (_, index) => ({
      id: String(index), threadId: "t", role: "owner" as const, intent: "question" as const, text: `m${index}`,
      attachmentIds: [], missionId: null, deliveryStatus: "delivered" as const, clientMessageId: null, idempotencyKey: null, classification: null, createdAt: "",
    })),
    workingContext: "working",
  });
  assert.doesNotMatch(context, /m0/);
  assert.match(context, /m19/);
});
