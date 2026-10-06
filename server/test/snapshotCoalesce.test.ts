import assert from "node:assert/strict";
import test from "node:test";

import { coalesceDeltaEvents, snapshotHistory, SNAPSHOT_MAX_FIELD_CHARS } from "../src/snapshotHistory.js";
import type { RunnerEvent } from "../src/claudeRunner.js";

// 模擬前端 reducer（web/src/workerState.ts）對 text/thinking 的處理：連續同型 delta 串進同一個
// 開著的 item；tool_call_start / user_message 關閉開著的 item。用來比對「合併前後重播結果相同」。
function replay(events: RunnerEvent[]): Array<{ kind: string; text: string }> {
  const items: Array<{ kind: string; text: string }> = [];
  let openText: number | null = null;
  let openThinking: number | null = null;
  for (const ev of events) {
    if (ev.type === "user_message" || ev.type === "tool_call_start") {
      openText = null;
      openThinking = null;
      items.push({ kind: ev.type, text: ev.type === "user_message" ? ev.text : ev.name });
    } else if (ev.type === "text_delta") {
      if (openText === null) { openText = items.length; items.push({ kind: "text", text: "" }); }
      items[openText]!.text += ev.text;
    } else if (ev.type === "thinking_delta") {
      if (openThinking === null) { openThinking = items.length; items.push({ kind: "thinking", text: "" }); }
      items[openThinking]!.text += ev.text;
    } else {
      items.push({ kind: ev.type, text: "" });
    }
  }
  return items;
}

function sampleHistory(): RunnerEvent[] {
  const events: RunnerEvent[] = [{ type: "user_message", text: "go", at: 1 }];
  for (let i = 0; i < 50; i++) events.push({ type: "thinking_delta", text: `think${i} `, at: 2 + i });
  for (let i = 0; i < 200; i++) events.push({ type: "text_delta", text: `word${i} `, at: 100 + i });
  events.push({ type: "tool_call_start", id: "t1", name: "Bash", input: { command: "ls" }, at: 400 });
  events.push({ type: "tool_call_result", id: "t1", output: "ok", isError: false, at: 401 });
  for (let i = 0; i < 100; i++) events.push({ type: "text_delta", text: `after${i} `, at: 500 + i });
  events.push({ type: "turn_end", resultText: "done", costUsd: 0, durationMs: 1, isError: false, permissionDenials: [], at: 700 });
  return events;
}

test("合併連續 text/thinking delta：重播結果完全相同、筆數大幅減少", () => {
  const history = sampleHistory();
  const merged = coalesceDeltaEvents(history);
  assert.deepEqual(replay(merged), replay(history));
  assert.equal(merged.length, 7); // user, thinking, text, tool_start, tool_result, text, turn_end
  const before = Buffer.byteLength(JSON.stringify(history));
  const after = Buffer.byteLength(JSON.stringify(merged));
  assert.ok(after < before * 0.5, `payload 應至少減半：${before} → ${after}`);
});

test("合併後 at 取最後一筆；不改動輸入陣列與事件物件", () => {
  const history = sampleHistory();
  const snapshot = JSON.stringify(history);
  const merged = coalesceDeltaEvents(history);
  assert.equal(JSON.stringify(history), snapshot);
  assert.equal(merged[2]!.at, 299);
  assert.equal(merged[1]!.at, 51);
});

test("合併長度不超過 SNAPSHOT_MAX_FIELD_CHARS，避免被 trim 截短改變內容", () => {
  const history: RunnerEvent[] = [{ type: "user_message", text: "go" }];
  const piece = "y".repeat(1000);
  for (let i = 0; i < 20; i++) history.push({ type: "text_delta", text: piece });
  const out = coalesceDeltaEvents(snapshotHistory(history));
  for (const ev of out) if (ev.type === "text_delta") assert.ok(ev.text.length <= SNAPSHOT_MAX_FIELD_CHARS);
  assert.deepEqual(replay(out), replay(history));
  assert.ok(out.length < history.length);
});

test("已被截短的超大單筆不會再和鄰居合併", () => {
  const huge = "z".repeat(SNAPSHOT_MAX_FIELD_CHARS + 10);
  const history: RunnerEvent[] = [
    { type: "user_message", text: "go" },
    { type: "text_delta", text: "a" },
    { type: "text_delta", text: huge },
    { type: "text_delta", text: "b" },
  ];
  const out = coalesceDeltaEvents(snapshotHistory(history));
  assert.equal(out.length, 4);
});

test("不同型別、中間夾其他事件都不合併", () => {
  const history: RunnerEvent[] = [
    { type: "text_delta", text: "a" },
    { type: "thinking_delta", text: "b" },
    { type: "text_delta", text: "c" },
    { type: "tool_call_output_delta", id: "x", delta: "d" },
    { type: "tool_call_output_delta", id: "x", delta: "e" },
  ];
  assert.deepEqual(coalesceDeltaEvents(history), history);
});

test("空陣列與無 delta 的歷史原樣返回", () => {
  assert.deepEqual(coalesceDeltaEvents([]), []);
  const plain: RunnerEvent[] = [{ type: "user_message", text: "x" }, { type: "error", message: "e" }];
  assert.deepEqual(coalesceDeltaEvents(plain), plain);
});
