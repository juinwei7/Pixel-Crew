import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLocalHandoff,
  parseHandoffSummary,
  recentConversation,
  usageBlockReason,
} from "../src/handoff.js";
import type { RunnerEvent } from "../src/claudeRunner.js";

test("parses a bounded handoff summary and redacts obvious secrets", () => {
  const summary = parseHandoffSummary(JSON.stringify({
    version: 1,
    goal: "部署功能 token=very-secret-value",
    completed: ["完成 API"],
    currentState: ["測試通過"],
    decisions: [{ decision: "使用 SQLite", reason: "本機優先" }],
    changedFiles: ["/server/src/index.ts"],
    constraints: [],
    pending: ["補 UI"],
    risks: ["Authorization: Bearer bearer-secret-value", "api_key=sk-ant-api03-abcdefghijklmnop"],
    nextActions: ["執行測試"],
  }));
  assert.ok(summary);
  assert.match(summary.goal, /\[REDACTED\]/);
  assert.equal(summary.changedFiles[0], "server/src/index.ts");
  assert.equal(summary.decisions[0].reason, "本機優先");
  assert.equal(summary.risks[0], "Authorization: [REDACTED]");
  assert.doesNotMatch(summary.risks[1], /sk-ant/);
});

test("builds a local fallback from recent conversation, tools, failures, and git state", () => {
  const events: RunnerEvent[] = [
    { type: "user_message", text: "完成切換功能" },
    { type: "tool_call_start", id: "1", name: "Bash", input: {} },
    { type: "tool_call_result", id: "1", output: "ok", isError: false },
    { type: "text_delta", text: "已完成主要流程" },
    { type: "turn_end", resultText: "已完成主要流程", costUsd: 0, durationMs: 1, isError: false, permissionDenials: [] },
  ];
  assert.deepEqual(recentConversation(events), [
    { role: "user", text: "完成切換功能" },
    { role: "assistant", text: "已完成主要流程" },
  ]);
  const summary = buildLocalHandoff(events, "branch: main\nHEAD: abc123\n M server/src/index.ts");
  assert.equal(summary.goal, "完成切換功能");
  assert.deepEqual(summary.changedFiles, ["server/src/index.ts"]);
  assert.match(summary.risks[0], /Bash/);
});

test("requires live non-empty target usage and blocks exhausted hard windows", () => {
  const base = {
    provider: "claude" as const,
    loading: false,
    source: "live" as const,
    updatedAt: new Date().toISOString(),
    error: null,
  };
  assert.match(usageBlockReason("claude", { ...base, windows: [] }, null)!, /無法確認/);
  assert.match(usageBlockReason("claude", { ...base, windows: [{ id: "week", label: "本週", usedPercent: 100, remainingPercent: 0, resetsAt: null, scope: "weekly" }] }, null)!, /耗盡/);
  assert.equal(usageBlockReason("claude", { ...base, windows: [{ id: "week", label: "本週", usedPercent: 50, remainingPercent: 50, resetsAt: null, scope: "weekly" }] }, null), null);
  assert.match(usageBlockReason("codex", { ...base, provider: "codex", source: "cache", windows: [{ id: "rate", label: "7 天", usedPercent: 20, remainingPercent: 80, resetsAt: null, scope: "rate" }] }, null)!, /即時/);
});
