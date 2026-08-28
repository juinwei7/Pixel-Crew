import assert from "node:assert/strict";
import test from "node:test";
import {
  BRAIN_SWAP_COOLDOWN_MS,
  BRAIN_SWAP_DISABLE_STREAK,
  BRAIN_SWAP_MIN_TURNS,
  BRAIN_SWAP_THRESHOLD_TOKENS,
  decideBrainSwap,
  type BrainSwapObservation,
} from "../src/brainSwap.js";
import type { RunnerEvent } from "../src/protocol.js";

const NOW = 1_700_000_000_000;

function turnEnd(overrides: Partial<Extract<RunnerEvent, { type: "turn_end" }>> = {}): RunnerEvent {
  return {
    type: "turn_end",
    resultText: "ok",
    costUsd: 0,
    durationMs: 1,
    isError: false,
    permissionDenials: [],
    contextTokens: BRAIN_SWAP_THRESHOLD_TOKENS,
    ...overrides,
  };
}

function observation(overrides: Partial<BrainSwapObservation> = {}): BrainSwapObservation {
  return {
    event: turnEnd(),
    provider: "claude",
    workerName: "一號機",
    pending: false,
    disabled: false,
    engaged: false,
    sessionTurns: BRAIN_SWAP_MIN_TURNS,
    lastSwapAt: null,
    cooldownNoted: false,
    overflowStreak: 0,
    now: NOW,
    ...overrides,
  };
}

test("threshold constants stay pinned", () => {
  assert.equal(BRAIN_SWAP_THRESHOLD_TOKENS, 170_000);
  assert.equal(BRAIN_SWAP_MIN_TURNS, 3);
  assert.equal(BRAIN_SWAP_COOLDOWN_MS, 10 * 60_000);
  assert.equal(BRAIN_SWAP_DISABLE_STREAK, 3);
});

test("error events clear the pending flag regardless of provider or name", () => {
  const decision = decideBrainSwap(observation({
    event: { type: "error", message: "boom" },
    provider: "codex",
    workerName: "🔍研究員",
    pending: true,
  }));
  assert.deepEqual(decision, { action: "clear_pending" });
});

test("non-turn_end events are ignored", () => {
  assert.deepEqual(decideBrainSwap(observation({ event: { type: "text_delta", text: "hi" } })), { action: "ignore" });
});

test("codex workers never swap", () => {
  assert.deepEqual(decideBrainSwap(observation({ provider: "codex" })), { action: "ignore" });
});

test("ephemeral 🏛/🔍 workers never swap, even when pending", () => {
  assert.deepEqual(decideBrainSwap(observation({ workerName: "🏛圓桌" })), { action: "ignore" });
  assert.deepEqual(decideBrainSwap(observation({ workerName: "🔍研究員", pending: true })), { action: "ignore" });
});

test("pending + successful summary turn completes the swap with the trimmed summary", () => {
  const decision = decideBrainSwap(observation({
    pending: true,
    event: turnEnd({ resultText: "  交接摘要內容  " }),
  }));
  assert.deepEqual(decision, { action: "complete_swap", summary: "交接摘要內容" });
});

test("pending + failed or empty summary turn aborts the swap", () => {
  assert.deepEqual(
    decideBrainSwap(observation({ pending: true, event: turnEnd({ isError: true }) })),
    { action: "abort_swap" },
  );
  assert.deepEqual(
    decideBrainSwap(observation({ pending: true, event: turnEnd({ resultText: "   " }) })),
    { action: "abort_swap" },
  );
});

test("below-threshold or missing contextTokens never triggers", () => {
  assert.deepEqual(
    decideBrainSwap(observation({ event: turnEnd({ contextTokens: BRAIN_SWAP_THRESHOLD_TOKENS - 1 }) })),
    { action: "ignore" },
  );
  assert.deepEqual(
    decideBrainSwap(observation({ event: turnEnd({ contextTokens: undefined }) })),
    { action: "ignore" },
  );
});

test("error turns and disabled or engaged workers are ignored", () => {
  assert.deepEqual(decideBrainSwap(observation({ event: turnEnd({ isError: true }) })), { action: "ignore" });
  assert.deepEqual(decideBrainSwap(observation({ disabled: true })), { action: "ignore" });
  assert.deepEqual(decideBrainSwap(observation({ engaged: true })), { action: "ignore" });
});

test("a single post-swap overflow spike cools down, it does NOT disable", () => {
  // host 一接手就被交辦超重工作＝首回合就爆，但只有一次尖峰不該永久停用
  const decision = decideBrainSwap(observation({
    lastSwapAt: NOW - BRAIN_SWAP_COOLDOWN_MS * 2,
    sessionTurns: 1,
    overflowStreak: 1,
    event: turnEnd({ contextTokens: 180_000 }),
  }));
  assert.equal(decision.action, "cooldown");
});

test("connected post-swap overflows across the first turns disable brain swap permanently", () => {
  const decision = decideBrainSwap(observation({
    lastSwapAt: NOW - BRAIN_SWAP_COOLDOWN_MS * 2,
    sessionTurns: BRAIN_SWAP_DISABLE_STREAK,
    overflowStreak: BRAIN_SWAP_DISABLE_STREAK,
    event: turnEnd({ contextTokens: 180_000 }),
  }));
  assert.equal(decision.action, "disable");
  if (decision.action === "disable") {
    assert.match(decision.message, /換腦後連續 3 回合 context 都達 180k/);
    assert.match(decision.message, /已停用這顆 NPC 的自動換腦/);
  }
});

test("a matured session that fills up is NOT disabled even with a long overflow streak — it swaps", () => {
  // 跑很久的 session 連續超標＝該換腦（換到全新底盤），不是停用
  const decision = decideBrainSwap(observation({
    lastSwapAt: NOW - BRAIN_SWAP_COOLDOWN_MS,
    sessionTurns: 20,
    overflowStreak: 5,
    event: turnEnd({ contextTokens: 180_000 }),
  }));
  assert.equal(decision.action, "start_swap");
});

test("a fresh worker with few turns is NOT disabled — it cools down instead", () => {
  // lastSwapAt 為 null（從未換過腦）時，即使 sessionTurns <= 1 也只是冷卻
  const decision = decideBrainSwap(observation({ lastSwapAt: null, sessionTurns: 1 }));
  assert.equal(decision.action, "cooldown");
});

test("too few session turns cools down with a one-time note", () => {
  const first = decideBrainSwap(observation({ sessionTurns: BRAIN_SWAP_MIN_TURNS - 1, event: turnEnd({ contextTokens: 171_000 }) }));
  assert.equal(first.action, "cooldown");
  if (first.action === "cooldown") {
    assert.match(String(first.message), /context 已達 171k，但距離上次換腦太近/);
  }
  const repeat = decideBrainSwap(observation({ sessionTurns: BRAIN_SWAP_MIN_TURNS - 1, cooldownNoted: true }));
  assert.deepEqual(repeat, { action: "cooldown", message: null });
});

test("a swap inside the 10-minute window cools down even with enough turns", () => {
  const decision = decideBrainSwap(observation({
    lastSwapAt: NOW - BRAIN_SWAP_COOLDOWN_MS + 1,
    sessionTurns: BRAIN_SWAP_MIN_TURNS + 5,
  }));
  assert.equal(decision.action, "cooldown");
});

test("enough turns and an expired cooldown start a swap with the announcement text", () => {
  const decision = decideBrainSwap(observation({
    lastSwapAt: NOW - BRAIN_SWAP_COOLDOWN_MS,
    sessionTurns: BRAIN_SWAP_MIN_TURNS,
    event: turnEnd({ contextTokens: 176_400 }),
  }));
  assert.deepEqual(decision, {
    action: "start_swap",
    message: "🧠 context 已達 176k/200k，啟動自動換腦——先請 NPC 寫交接摘要",
  });
});

test("a never-swapped worker with enough turns starts a swap at the threshold", () => {
  const decision = decideBrainSwap(observation({ lastSwapAt: null, sessionTurns: 10 }));
  assert.equal(decision.action, "start_swap");
});
