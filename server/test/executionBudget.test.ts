import assert from "node:assert/strict";
import test from "node:test";
import { executionBudgetFor } from "../src/executionBudget.js";

test("預設旋鈕時，估算完全等同 profile 原表（不動既有預設）", () => {
  const b = executionBudgetFor("standard");
  assert.deepEqual(b.estimatedAgentTurns, { min: 6, max: 16 });
  assert.deepEqual(b.estimatedDurationMinutes, { min: 10, max: 35 });
  assert.deepEqual(b.claudeUsd, { min: 0.1, max: 0.7 });
  assert.deepEqual(b.codexQuota5hPercent, { min: 4, max: 12 });

  const q = executionBudgetFor("quick");
  assert.deepEqual(q.estimatedDurationMinutes, { min: 2, max: 10 });
  const d = executionBudgetFor("deep");
  assert.deepEqual(d.estimatedDurationMinutes, { min: 30, max: 90 });
});

test("調低 maxMissionSteps 會等比壓低工期、回合與花費", () => {
  const base = executionBudgetFor("standard");
  const fewer = executionBudgetFor("standard", { maxMissionSteps: 2 });
  assert.equal(fewer.maxMissionSteps, 2);
  // 2/3 廣度 → 工期、回合、花費都要比預設低
  assert.ok(fewer.estimatedDurationMinutes.max < base.estimatedDurationMinutes.max);
  assert.ok(fewer.estimatedAgentTurns.max < base.estimatedAgentTurns.max);
  assert.ok(fewer.claudeUsd.max < base.claudeUsd.max);
});

test("調低 maxAgents 會壓低回合與花費，但工期（牆鐘）不因並行變動", () => {
  const base = executionBudgetFor("standard");
  const solo = executionBudgetFor("standard", { maxAgents: 2 });
  assert.equal(solo.maxAgents, 2);
  assert.ok(solo.estimatedAgentTurns.max < base.estimatedAgentTurns.max);
  assert.ok(solo.claudeUsd.max < base.claudeUsd.max);
  // agent 並行只影響廣度/花費，不拉長工期 → 工期維持原值
  assert.deepEqual(solo.estimatedDurationMinutes, base.estimatedDurationMinutes);
});

test("估算保底：壓到最小也不會出現 0 或負值", () => {
  const tiny = executionBudgetFor("quick", { maxAgents: 1, maxMissionSteps: 2 });
  assert.ok(tiny.estimatedAgentTurns.min >= 1);
  assert.ok(tiny.estimatedDurationMinutes.min >= 1);
  assert.ok(tiny.claudeUsd.min >= 0.01);
  assert.ok(tiny.codexQuota5hPercent.min >= 1);
});

test("旋鈕不會被推高超過 profile 上限（overrides 只能往下）", () => {
  const b = executionBudgetFor("standard", { maxAgents: 99, maxMissionSteps: 99, maxStages: 99 });
  assert.equal(b.maxAgents, 4);
  assert.equal(b.maxStages, 3);
  assert.equal(b.maxMissionSteps, 3);
  // 被夾回預設 → 估算等同原表
  assert.deepEqual(b.estimatedDurationMinutes, { min: 10, max: 35 });
});
