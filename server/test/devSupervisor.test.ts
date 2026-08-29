import assert from "node:assert/strict";
import test from "node:test";

const supervisor = await import("../../scripts/dev-server-supervisor.mjs");

test("development supervisor retries unexpected backend exits with a bounded delay", () => {
  assert.equal(supervisor.shouldRestart({ stopping: false, code: 1, signal: null }), true);
  assert.equal(supervisor.shouldRestart({ stopping: true, code: 1, signal: null }), false);
  assert.equal(supervisor.shouldRestart({ stopping: false, code: 0, signal: "SIGINT" }), false);
  assert.equal(supervisor.restartDelayMs(0), 300);
  assert.equal(supervisor.restartDelayMs(100), 5_000);
});

test("development supervisor retries a spawn failure (no code/signal at all)", () => {
  // e.g. ENOENT resolving the tsx binary — spawn's 'error' event fires with
  // no exit code or signal; the supervisor must still attempt a bounded
  // retry instead of leaving a dead child reference with nothing scheduled.
  assert.equal(supervisor.shouldRestart({ stopping: false, code: null, signal: null }), true);
  assert.equal(supervisor.shouldRestart({ stopping: true, code: null, signal: null }), false);
});
