import assert from "node:assert/strict";
import test from "node:test";
import { departmentPlanPrompt, normalizeDepartmentPurpose, parseDepartmentPlan } from "../src/departmentPlan.js";

test("department plan prompt binds purpose, count, workspace, and existing roles", () => {
  const prompt = departmentPlanPrompt({
    purpose: "電商產品開發",
    count: 3,
    workspacePath: "/projects/shop",
    existingMembers: [{ name: "小藍", role: "產品經理" }],
  });
  assert.match(prompt, /電商產品開發/);
  assert.match(prompt, /恰好產生 3 位/);
  assert.match(prompt, /產品經理/);
  assert.match(prompt, /不要呼叫工具/);
});

test("department plan parser requires the expected count and unique complete members", () => {
  const valid = '<department_plan>{"summary":"互補分工","members":[{"name":"小築","role":"前端工程師","instructions":"負責介面"},{"name":"小盾","role":"QA 工程師","instructions":"負責驗證"}]}</department_plan>';
  assert.deepEqual(parseDepartmentPlan(valid, 2), {
    summary: "互補分工",
    members: [
      { name: "小築", role: "前端工程師", instructions: "負責介面" },
      { name: "小盾", role: "QA 工程師", instructions: "負責驗證" },
    ],
  });
  assert.equal(parseDepartmentPlan(valid, 3), null);
  assert.equal(parseDepartmentPlan(valid.replace("QA 工程師", "前端工程師"), 2), null);
  assert.equal(parseDepartmentPlan("{}", 2), null);
});

test("department purpose is trimmed and bounded", () => {
  assert.equal(normalizeDepartmentPurpose("  資安稽核  "), "資安稽核");
  assert.equal(normalizeDepartmentPurpose("x".repeat(500)).length, 200);
});
