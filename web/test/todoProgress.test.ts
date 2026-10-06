import assert from "node:assert/strict";
import test from "node:test";
import { isTodoTool, todoProgressFromInput, turnTodoProgress } from "../src/todoProgress";
import type { ToolCallItem, Turn } from "../src/types";

function todoCall(key: string, input: unknown, name = "TodoWrite"): ToolCallItem {
  return { kind: "tool_call", key, id: key, name, input, isError: false, status: "done" };
}

test("isTodoTool recognises TodoWrite, update_plan and MCP-wrapped names", () => {
  assert.equal(isTodoTool("TodoWrite"), true);
  assert.equal(isTodoTool("update_plan"), true);
  assert.equal(isTodoTool("mcp__planner__TodoWrite"), true);
  assert.equal(isTodoTool("Bash"), false);
  assert.equal(isTodoTool("TodoRead"), false);
});

test("todoProgressFromInput counts completed entries in todos[] or plan[]", () => {
  assert.deepEqual(todoProgressFromInput({ todos: [
    { content: "a", status: "completed" },
    { content: "b", status: "in_progress" },
    { content: "c", status: "pending" },
  ] }), { done: 1, total: 3 });
  assert.deepEqual(todoProgressFromInput({ plan: [{ step: "x", status: "completed" }, { step: "y", status: "pending" }] }), { done: 1, total: 2 });
});

test("todoProgressFromInput rejects malformed or empty lists", () => {
  assert.equal(todoProgressFromInput(null), null);
  assert.equal(todoProgressFromInput("todos"), null);
  assert.equal(todoProgressFromInput({ todos: [] }), null);
  assert.equal(todoProgressFromInput({ todos: "nope" }), null);
  assert.deepEqual(todoProgressFromInput({ todos: [null, { status: "completed" }] }), { done: 1, total: 1 });
});

test("turnTodoProgress uses the latest write in the turn", () => {
  const turn: Pick<Turn, "items"> = { items: [
    todoCall("t1", { todos: [{ status: "pending" }, { status: "pending" }] }),
    { kind: "assistant_text", key: "x", text: "working" },
    todoCall("t2", { todos: [{ status: "completed" }, { status: "in_progress" }] }),
    { kind: "tool_call", key: "b", id: "b", name: "Bash", input: { command: "ls" }, isError: false, status: "running" },
  ] };
  assert.deepEqual(turnTodoProgress(turn), { done: 1, total: 2 });
  assert.equal(turnTodoProgress({ items: [] }), null);
  assert.equal(turnTodoProgress(undefined), null);
});
