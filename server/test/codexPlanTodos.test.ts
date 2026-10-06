import assert from "node:assert/strict";
import test from "node:test";

import { CodexSession, codexPlanToTodos, codexTool } from "../src/codexRunner.js";
import type { RunnerEvent } from "../src/claudeRunner.js";

function deliverNotification(session: CodexSession, method: string, params: unknown): void {
  (session as unknown as { handleRpcLine(line: string, generation: number): void }).handleRpcLine(
    JSON.stringify({ method, params }),
    (session as unknown as { generation: number }).generation,
  );
}

test("codexPlanToTodos 正規化 camelCase / snake_case 狀態成 Claude TodoWrite 形狀", () => {
  assert.deepEqual(codexPlanToTodos([
    { step: "讀程式", status: "completed" },
    { step: "改程式", status: "inProgress" },
    { step: "跑測試", status: "in_progress" },
    { step: "回報", status: "pending" },
  ]), [
    { content: "讀程式", status: "completed", activeForm: "讀程式" },
    { content: "改程式", status: "in_progress", activeForm: "改程式" },
    { content: "跑測試", status: "in_progress", activeForm: "跑測試" },
    { content: "回報", status: "pending", activeForm: "回報" },
  ]);
});

test("codexPlanToTodos 支援 exec todo_list 的 {text, completed}，忽略空白/無效項", () => {
  assert.deepEqual(codexPlanToTodos([{ text: "a", completed: true }, { text: "b", completed: false }, { text: "  " }, null, 3]), [
    { content: "a", status: "completed", activeForm: "a" },
    { content: "b", status: "pending", activeForm: "b" },
  ]);
  assert.equal(codexPlanToTodos([]), null);
  assert.equal(codexPlanToTodos(undefined), null);
  assert.equal(codexPlanToTodos({ step: "x" }), null);
});

test("turn/plan/updated 轉成 TodoWrite 的 tool_call_start + tool_call_result（同 id、成對）", () => {
  const events: RunnerEvent[] = [];
  const session = new CodexSession((event) => events.push(event), "/repo", () => "", () => false);
  deliverNotification(session, "turn/plan/updated", {
    turnId: "turn-1",
    explanation: "先讀再改",
    plan: [{ step: "讀", status: "completed" }, { step: "改", status: "inProgress" }],
  });
  assert.equal(events.length, 2);
  const [start, result] = events;
  assert.equal(start!.type, "tool_call_start");
  assert.equal(result!.type, "tool_call_result");
  if (start!.type !== "tool_call_start" || result!.type !== "tool_call_result") return;
  assert.equal(start.name, "TodoWrite");
  assert.equal(start.id, result.id);
  assert.equal(result.isError, false);
  assert.deepEqual(start.input, {
    todos: [
      { content: "讀", status: "completed", activeForm: "讀" },
      { content: "改", status: "in_progress", activeForm: "改" },
    ],
    explanation: "先讀再改",
  });
});

test("每次 plan 更新都是新的 tool id（前端當成多次 TodoWrite，最後一次為準）", () => {
  const events: RunnerEvent[] = [];
  const session = new CodexSession((event) => events.push(event), "/repo", () => "", () => false);
  deliverNotification(session, "turn/plan/updated", { plan: [{ step: "a", status: "pending" }] });
  deliverNotification(session, "turn/plan/updated", { plan: [{ step: "a", status: "completed" }] });
  const starts = events.filter((e) => e.type === "tool_call_start");
  assert.equal(starts.length, 2);
  assert.notEqual((starts[0] as { id: string }).id, (starts[1] as { id: string }).id);
});

test("空 plan 不發任何事件", () => {
  const events: RunnerEvent[] = [];
  const session = new CodexSession((event) => events.push(event), "/repo", () => "", () => false);
  deliverNotification(session, "turn/plan/updated", { plan: [] });
  assert.equal(events.length, 0);
});

test("legacy exec 的 todo_list item 也轉成 TodoWrite", () => {
  const tool = codexTool({ type: "todo_list", items: [{ text: "x", completed: false }] });
  assert.deepEqual(tool, {
    name: "TodoWrite",
    input: { todos: [{ content: "x", status: "pending", activeForm: "x" }] },
    output: "Todos have been modified successfully.",
    isError: false,
  });
  assert.equal(codexTool({ type: "todo_list", items: [] }), null);
});
