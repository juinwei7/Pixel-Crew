import assert from "node:assert/strict";
import test from "node:test";
import {
  collaborationAcceptsTerminalEvent,
  collaborationActiveWorkerId,
  collaborationPrompt,
  normalizeAcceptanceCriteria,
  normalizeCollaborationMode,
  parseCollaborationResult,
} from "../src/collaboration.js";
import type { CollaborationTask } from "../src/collaboration.js";
import { claudePermissionMode } from "../src/claudeRunner.js";
import { codexSandbox } from "../src/codexRunner.js";

test("normalizes collaboration modes and bounded acceptance criteria", () => {
  assert.equal(normalizeCollaborationMode("review"), "review");
  assert.equal(normalizeCollaborationMode("implement"), null);
  assert.deepEqual(normalizeAcceptanceCriteria([" cite files ", "", ...Array(10).fill("x")]).length, 8);
});

test("parses a structured collaboration result and strips leading path separators", () => {
  const result = parseCollaborationResult(`<collaboration_result>{
    "verdict":"changes_requested",
    "summary":"Found one issue",
    "findings":[{"severity":"blocking","title":"Missing check","detail":"Validate state","file":"/src/auth.ts","line":42}],
    "risks":["callback replay"],"openQuestions":[],"recommendedNextAction":"add validation"
  }</collaboration_result>`);
  assert.equal(result?.verdict, "changes_requested");
  assert.equal(result?.findings[0].file, "src/auth.ts");
  assert.equal(result?.structured, true);
});

test("falls back to a bounded inconclusive result and redacts obvious secrets", () => {
  const result = parseCollaborationResult("api_key=sk-abcdefghijklmnopqrst this needs review");
  assert.equal(result?.verdict, "inconclusive");
  assert.match(result?.summary ?? "", /\[REDACTED\]/);
  assert.doesNotMatch(result?.summary ?? "", /sk-abcdefghijklmnopqrst/);
});

test("collaboration prompt establishes the read-only contract", () => {
  const prompt = collaborationPrompt({
    taskId: "task-1",
    mode: "review",
    sourceName: "一號機",
    sourceRole: "Builder",
    objective: "Review auth",
    acceptanceCriteria: ["cite evidence"],
    recentConversation: "implemented callback",
    gitState: "M src/auth.ts",
  });
  assert.match(prompt, /不得修改檔案/);
  assert.match(prompt, /<collaboration_result>/);
  assert.match(prompt, /Review/);
});

test("provider adapters map collaboration turns to native read-only profiles", () => {
  assert.equal(claudePermissionMode("read_only_collaboration", "default"), "plan");
  assert.equal(claudePermissionMode("normal", "default"), "default");
  assert.equal(codexSandbox("read_only_collaboration", "workspace-write"), "read-only");
  assert.equal(codexSandbox("normal", "workspace-write"), "workspace-write");
});

test("routes terminal events and cancellation to the worker owning the current collaboration phase", () => {
  const task: CollaborationTask = {
    id: "task", sourceWorkerId: "boss", targetWorkerId: "reviewer", workspacePath: "/repo",
    mode: "review", objective: "review", acceptanceCriteria: [], status: "running",
    sourceContext: {}, baseCommit: null, result: null, continuationResult: null, error: null,
    createdAt: "2026-07-22T00:00:00Z", startedAt: null, completedAt: null, adoptedAt: null, handledAt: null,
  };
  assert.equal(collaborationActiveWorkerId(task), "reviewer");
  assert.equal(collaborationAcceptsTerminalEvent(task, "boss"), false);
  task.status = "returning";
  assert.equal(collaborationActiveWorkerId(task), "boss");
  assert.equal(collaborationAcceptsTerminalEvent(task, "reviewer"), false);
  assert.equal(collaborationAcceptsTerminalEvent(task, "boss"), true);
  task.status = "completed";
  assert.equal(collaborationActiveWorkerId(task), null);
});
