import assert from "node:assert/strict";
import test from "node:test";

import { DeltaCoalescer, mergeDelta } from "../src/deltaCoalescer.js";
import type { RunnerEvent } from "../src/claudeRunner.js";

// 手動計時器：測試自己決定何時「時間到」。
function manualTimers() {
  const callbacks: Array<(() => void) | null> = [];
  return {
    timers: {
      setTimeout: (callback: () => void) => callbacks.push(callback) - 1,
      clearTimeout: (handle: unknown) => { callbacks[handle as number] = null; },
    },
    fire() {
      for (let i = 0; i < callbacks.length; i++) {
        const cb = callbacks[i];
        callbacks[i] = null;
        cb?.();
      }
    },
    get armed() { return callbacks.filter(Boolean).length; },
  };
}

function setup() {
  const sent: Array<{ workerId: string; event: RunnerEvent }> = [];
  const clock = manualTimers();
  const coalescer = new DeltaCoalescer((workerId, event) => sent.push({ workerId, event }), 33, clock.timers);
  return { sent, clock, coalescer };
}

const text = (t: string, at?: number): RunnerEvent => ({ type: "text_delta", text: t, ...(at ? { at } : {}) });

test("同一 worker 視窗內的連續 text_delta 合併成一筆，時間到才送", () => {
  const { sent, clock, coalescer } = setup();
  coalescer.push("w1", text("Hel", 1));
  coalescer.push("w1", text("lo", 2));
  coalescer.push("w1", text("!", 3));
  assert.equal(sent.length, 0);
  assert.equal(clock.armed, 1);
  clock.fire();
  assert.deepEqual(sent, [{ workerId: "w1", event: { type: "text_delta", text: "Hello!", at: 3 } }]);
});

test("非 delta 事件（turn_end）先 flush 緩衝再立即送，順序不變", () => {
  const { sent, clock, coalescer } = setup();
  coalescer.push("w1", text("a"));
  coalescer.push("w1", text("b"));
  const turnEnd: RunnerEvent = { type: "turn_end", resultText: "ab", costUsd: 0, durationMs: 1, isError: false, permissionDenials: [] };
  coalescer.push("w1", turnEnd);
  assert.deepEqual(sent.map((s) => s.event.type), ["text_delta", "turn_end"]);
  assert.equal((sent[0]!.event as { text: string }).text, "ab");
  assert.equal(clock.armed, 0, "flush 後計時器應已取消");
  clock.fire();
  assert.equal(sent.length, 2);
});

test("不同型別不合併；中間夾 thinking 會斷開，保留分段", () => {
  const { sent, clock, coalescer } = setup();
  coalescer.push("w1", text("a"));
  coalescer.push("w1", { type: "thinking_delta", text: "t" });
  coalescer.push("w1", text("b"));
  clock.fire();
  assert.deepEqual(sent.map((s) => s.event), [
    { type: "text_delta", text: "a" },
    { type: "thinking_delta", text: "t" },
    { type: "text_delta", text: "b" },
  ]);
});

test("tool_call_output_delta 只併同 id", () => {
  const { sent, clock, coalescer } = setup();
  coalescer.push("w1", { type: "tool_call_output_delta", id: "x", delta: "1" });
  coalescer.push("w1", { type: "tool_call_output_delta", id: "x", delta: "2" });
  coalescer.push("w1", { type: "tool_call_output_delta", id: "y", delta: "3" });
  clock.fire();
  assert.deepEqual(sent.map((s) => s.event), [
    { type: "tool_call_output_delta", id: "x", delta: "12" },
    { type: "tool_call_output_delta", id: "y", delta: "3" },
  ]);
});

test("不同 worker 交錯：各自合併、各自順序保留", () => {
  const { sent, clock, coalescer } = setup();
  coalescer.push("w1", text("a"));
  coalescer.push("w2", text("x"));
  coalescer.push("w1", text("b"));
  coalescer.push("w2", text("y"));
  clock.fire();
  assert.deepEqual(sent, [
    { workerId: "w1", event: { type: "text_delta", text: "ab" } },
    { workerId: "w2", event: { type: "text_delta", text: "xy" } },
  ]);
});

test("另一個 worker 的非 delta 事件也會把全部緩衝先送出", () => {
  const { sent, coalescer } = setup();
  coalescer.push("w1", text("a"));
  coalescer.push("w2", { type: "error", message: "boom" });
  assert.deepEqual(sent.map((s) => `${s.workerId}:${s.event.type}`), ["w1:text_delta", "w2:error"]);
});

test("不修改原事件物件（它同時存在 worker.history）", () => {
  const { clock, coalescer } = setup();
  const first = text("a", 1);
  const second = text("b", 2);
  const third = text("c", 3);
  coalescer.push("w1", first);
  coalescer.push("w1", second);
  coalescer.push("w1", third);
  clock.fire();
  assert.deepEqual(first, { type: "text_delta", text: "a", at: 1 });
  assert.deepEqual(second, { type: "text_delta", text: "b", at: 2 });
  assert.deepEqual(third, { type: "text_delta", text: "c", at: 3 });
});

test("外部 flush()（例如新連線 snapshot 前）立即送出", () => {
  const { sent, coalescer } = setup();
  coalescer.push("w1", text("a"));
  coalescer.flush();
  assert.equal(sent.length, 1);
  assert.equal(coalescer.pendingCount, 0);
  coalescer.flush();
  assert.equal(sent.length, 1);
});

test("windowMs=0 時完全不緩衝（等同停用）", () => {
  const sent: RunnerEvent[] = [];
  const coalescer = new DeltaCoalescer((_w, e) => sent.push(e), 0);
  coalescer.push("w1", text("a"));
  coalescer.push("w1", text("b"));
  assert.equal(sent.length, 2);
});

test("超過合併上限就另起一筆，內容串接後仍一致", () => {
  const sent: RunnerEvent[] = [];
  const clock = manualTimers();
  const coalescer = new DeltaCoalescer((_w, e) => sent.push(e), 33, clock.timers, 5);
  for (const piece of ["abc", "de", "fg", "h"]) coalescer.push("w1", text(piece));
  clock.fire();
  assert.deepEqual(sent.map((e) => (e as { text: string }).text), ["abcde", "fgh"]);
});

test("send 拋錯不會卡住其餘事件", () => {
  const sent: string[] = [];
  const clock = manualTimers();
  const coalescer = new DeltaCoalescer((w) => { if (w === "bad") throw new Error("x"); sent.push(w); }, 33, clock.timers);
  const originalError = console.error;
  console.error = () => {};
  try {
    coalescer.push("bad", text("a"));
    coalescer.push("ok", text("b"));
    clock.fire();
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(sent, ["ok"]);
});

test("mergeDelta 保留最後一筆 at、缺 at 時沿用前一筆", () => {
  assert.deepEqual(mergeDelta({ type: "text_delta", text: "a", at: 1 }, { type: "text_delta", text: "b" }), { type: "text_delta", text: "ab", at: 1 });
  assert.deepEqual(mergeDelta({ type: "thinking_delta", text: "a" }, { type: "thinking_delta", text: "b", at: 9 }), { type: "thinking_delta", text: "ab", at: 9 });
});
