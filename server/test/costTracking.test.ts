import assert from "node:assert/strict";
import test from "node:test";
import { costMicrosForTurnEnd } from "../src/costTracking.js";

function turnEnd(costUsd: number, isError = false) {
  return {
    type: "turn_end" as const,
    resultText: "",
    costUsd,
    durationMs: 0,
    isError,
    permissionDenials: [],
  };
}

test("Codex never contributes cost, regardless of the value on the event", () => {
  assert.equal(costMicrosForTurnEnd("codex", turnEnd(0.0034)), 0);
  assert.equal(costMicrosForTurnEnd("codex", turnEnd(5)), 0);
});

test("Claude turn cost converts to integer micros", () => {
  assert.equal(costMicrosForTurnEnd("claude", turnEnd(0.0034)), 3400);
});

test("failed Claude turns still bill — must not regress to 0", () => {
  assert.equal(costMicrosForTurnEnd("claude", turnEnd(0.0034, true)), 3400);
});

test("zero cost is a no-op, not a counter-polluting zero delta", () => {
  assert.equal(costMicrosForTurnEnd("claude", turnEnd(0)), 0);
});

test("a malformed negative cost is defensively treated as zero", () => {
  assert.equal(costMicrosForTurnEnd("claude", turnEnd(-1)), 0);
});
