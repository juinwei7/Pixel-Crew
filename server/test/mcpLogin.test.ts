import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { McpLoginTracker, type McpLoginState } from "../src/mcpLogin.js";

function fakeChild() {
  const child = new EventEmitter() as any;
  child.pid = 4242;
  child.exitCode = null;
  child.killed = false;
  child.stdin = { end: () => {} };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { child.killed = true; };
  return child;
}

function fakeTerminate(child: any) {
  child.kill();
}

test("start() marks the login running and reports a duplicate start as already running", () => {
  const spawned: string[] = [];
  const tracker = new McpLoginTracker(() => {}, (bin) => { spawned.push(bin); return fakeChild(); });
  const first = tracker.start("claude", "/repo", "notion");
  assert.equal(first.state.status, "running");
  assert.equal(first.alreadyRunning, false);

  const second = tracker.start("claude", "/repo", "notion");
  assert.equal(second.alreadyRunning, true);
  assert.equal(spawned.length, 1);
});

test("an explicit env is passed through to the spawner (Codex logins pin CODEX_HOME); omitting it leaves the ambient environment untouched", () => {
  const spawnedOptions: Array<{ cwd: string; env?: NodeJS.ProcessEnv }> = [];
  const tracker = new McpLoginTracker(() => {}, (_bin, _args, options) => { spawnedOptions.push(options); return fakeChild(); });

  tracker.start("codex", "/repo", "docs", { CODEX_HOME: "/data/codex-home" } as NodeJS.ProcessEnv);
  tracker.start("claude", "/repo", "notion");

  assert.deepEqual(spawnedOptions[0].env, { CODEX_HOME: "/data/codex-home" });
  assert.equal(spawnedOptions[1].env, undefined);
});

test("a successful CLI exit reports succeeded with the captured stdout", () => {
  let finishedState: McpLoginState | null = null;
  let child: any;
  const tracker = new McpLoginTracker((state) => { finishedState = state; }, () => { child = fakeChild(); return child; });

  tracker.start("claude", "/repo", "notion");
  child.stdout.emit("data", Buffer.from("Login successful\n"));
  child.emit("close", 0);

  assert.equal(finishedState?.status, "succeeded");
  assert.match(finishedState?.message ?? "", /Login successful/);
  assert.equal(tracker.get("claude", "/repo", "notion")?.status, "succeeded");
});

test("a non-zero exit reports failed with the stderr tail", () => {
  let finishedState: McpLoginState | null = null;
  let child: any;
  const tracker = new McpLoginTracker((state) => { finishedState = state; }, () => { child = fakeChild(); return child; });

  tracker.start("claude", "/repo", "notion");
  child.stderr.emit("data", Buffer.from("no browser available\n"));
  child.emit("close", 1);

  assert.equal(finishedState?.status, "failed");
  assert.match(finishedState?.message ?? "", /no browser available/);
});

test("cancel() kills the in-flight login, reports cancelled, and ignores a late close event", () => {
  let finishedCount = 0;
  let lastState: McpLoginState | null = null;
  let child: any;
  const tracker = new McpLoginTracker(
    (state) => { finishedCount++; lastState = state; },
    () => { child = fakeChild(); return child; },
    4 * 60_000,
    fakeTerminate,
  );

  tracker.start("claude", "/repo", "notion");
  assert.equal(tracker.cancel("claude", "/repo", "notion"), true);
  assert.equal(child.killed, true);
  assert.equal(lastState?.status, "cancelled");

  // The killed process eventually emits "close" — this must not re-finish
  // (and must not overwrite the "cancelled" status with "failed").
  child.emit("close", null);
  assert.equal(finishedCount, 1);
  assert.equal(tracker.get("claude", "/repo", "notion")?.status, "cancelled");
});

test("cancel() on an unknown login is a no-op", () => {
  const tracker = new McpLoginTracker(() => {}, () => fakeChild());
  assert.equal(tracker.cancel("claude", "/repo", "missing"), false);
});

test("the safety-net timeout kills a stuck login and reports timeout", async () => {
  let finishedState: McpLoginState | null = null;
  let child: any;
  const tracker = new McpLoginTracker(
    (state) => { finishedState = state; },
    () => { child = fakeChild(); return child; },
    10,
    fakeTerminate,
  );

  tracker.start("claude", "/repo", "notion");
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(finishedState?.status, "timeout");
  assert.equal(child.killed, true);
});
