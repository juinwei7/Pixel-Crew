import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ClaudeLoginTracker, type ClaudeLoginState } from "../src/claudeAccountLogin.js";

function fakeChild() {
  const child = new EventEmitter() as any;
  child.pid = 4242;
  child.exitCode = null;
  child.killed = false;
  child.stdin = { write: (data: string) => { child.stdinWritten = (child.stdinWritten ?? "") + data; } };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { child.killed = true; };
  return child;
}

function fakeTerminate(child: any) {
  child.kill();
}

const noopEnsureDir = () => {};

// The exact stdout shape a real `claude auth login` prints (Claude Code
// 2.1.206), OSC-8-wrapped URL followed immediately by the prompt in the same chunk.
function realStdoutChunk(): string {
  const url = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz";
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  return (
    "Opening browser to sign in\n" +
    "If the browser didn't open, visit: " + ESC + "]8;;" + url + BEL + url + ESC + "]8;;" + BEL + "\n" +
    "Paste code here if prompted > "
  );
}

test("start() marks the login running, pins CLAUDE_CONFIG_DIR, and reports a duplicate start as already running", () => {
  const spawnedEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
  const tracker = new ClaudeLoginTracker(
    () => {}, (bin, args, options) => { spawnedEnvs.push(options.env); return fakeChild(); },
    undefined, undefined, undefined, noopEnsureDir,
  );

  const first = tracker.start("default", "/data/claude-home");
  assert.equal(first.state.status, "running");
  assert.equal(first.alreadyRunning, false);
  assert.equal(spawnedEnvs[0]?.CLAUDE_CONFIG_DIR, "/data/claude-home");

  const second = tracker.start("default", "/data/claude-home");
  assert.equal(second.alreadyRunning, true);
  assert.equal(spawnedEnvs.length, 1);
});

test("finding the fallback URL transitions status to awaiting_code and fires onUrlFound", () => {
  let child: any;
  let foundState: ClaudeLoginState | null = null;
  const tracker = new ClaudeLoginTracker(
    () => {}, () => { child = fakeChild(); return child; },
    undefined, undefined,
    (state) => { foundState = state; },
    noopEnsureDir,
  );

  tracker.start("default", "/data/claude-home");
  child.stdout.emit("data", Buffer.from(realStdoutChunk()));

  assert.equal(foundState?.status, "awaiting_code");
  assert.match(foundState?.loginUrl ?? "", /^https:\/\/claude\.com\/cai\/oauth\/authorize/);
  assert.equal(tracker.get("default")?.status, "awaiting_code");
});

test("submitCode writes the pasted code (plus newline) to the waiting child's stdin", () => {
  let child: any;
  const tracker = new ClaudeLoginTracker(
    () => {}, () => { child = fakeChild(); return child; },
    undefined, undefined, undefined, noopEnsureDir,
  );

  tracker.start("default", "/data/claude-home");
  child.stdout.emit("data", Buffer.from(realStdoutChunk()));
  const ok = tracker.submitCode("default", "abc123#state456");

  assert.equal(ok, true);
  assert.equal(child.stdinWritten, "abc123#state456\n");
});

test("submitCode on an unknown or already-finished login is a no-op", () => {
  const tracker = new ClaudeLoginTracker(() => {}, () => fakeChild());
  assert.equal(tracker.submitCode("missing", "code"), false);
});

test("a successful exit (code 0) after submitCode reports succeeded", () => {
  let finishedState: ClaudeLoginState | null = null;
  let child: any;
  const tracker = new ClaudeLoginTracker(
    (state) => { finishedState = state; }, () => { child = fakeChild(); return child; },
    undefined, undefined, undefined, noopEnsureDir,
  );

  tracker.start("default", "/data/claude-home");
  child.stdout.emit("data", Buffer.from(realStdoutChunk()));
  tracker.submitCode("default", "real-code#real-state");
  child.stdout.emit("data", Buffer.from("Login successful\n"));
  child.emit("close", 0);

  assert.equal(finishedState?.status, "succeeded");
  assert.equal(tracker.get("default")?.status, "succeeded");
});

// Verified empirically: an invalid code makes `claude auth login` print
// "Login failed: Request failed with status code 400" to stderr and exit 1
// within about a second — it fails clean, it doesn't hang.
test("an invalid pasted code reports failed with the real CLI's error message", () => {
  let finishedState: ClaudeLoginState | null = null;
  let child: any;
  const tracker = new ClaudeLoginTracker(
    (state) => { finishedState = state; }, () => { child = fakeChild(); return child; },
    undefined, undefined, undefined, noopEnsureDir,
  );

  tracker.start("default", "/data/claude-home");
  child.stdout.emit("data", Buffer.from(realStdoutChunk()));
  tracker.submitCode("default", "garbage-fake-code");
  child.stderr.emit("data", Buffer.from("Login failed: Request failed with status code 400\n"));
  child.emit("close", 1);

  assert.equal(finishedState?.status, "failed");
  assert.match(finishedState?.message ?? "", /Login failed/);
});

test("cancel() works from the awaiting_code phase, not just running", () => {
  let lastState: ClaudeLoginState | null = null;
  let child: any;
  const tracker = new ClaudeLoginTracker(
    (state) => { lastState = state; }, () => { child = fakeChild(); return child; },
    5 * 60_000, fakeTerminate, undefined, noopEnsureDir,
  );

  tracker.start("default", "/data/claude-home");
  child.stdout.emit("data", Buffer.from(realStdoutChunk()));
  assert.equal(tracker.cancel("default"), true);
  assert.equal(child.killed, true);
  assert.equal(lastState?.status, "cancelled");

  child.emit("close", null);
  assert.equal(tracker.get("default")?.status, "cancelled");
});

test("cancel() on an unknown login is a no-op", () => {
  const tracker = new ClaudeLoginTracker(() => {}, () => fakeChild());
  assert.equal(tracker.cancel("missing"), false);
});

test("ensureDir failing reports a clean failed state instead of throwing", () => {
  let finishedState: ClaudeLoginState | null = null;
  const tracker = new ClaudeLoginTracker(
    (state) => { finishedState = state; },
    () => fakeChild(),
    undefined, undefined, undefined,
    () => { throw new Error("EACCES: permission denied"); },
  );

  assert.doesNotThrow(() => {
    const { state } = tracker.start("default", "/root/claude-home");
    assert.equal(state.status, "failed");
  });
  assert.equal(finishedState?.status, "failed");
  assert.match(finishedState?.message ?? "", /EACCES/);
});

// The class has always been accountId-keyed (see start/get/cancel/submitCode
// above), but until named Claude accounts (帳號管理) every real caller only
// ever passed the constant "default" id. This is the first test to actually
// exercise two distinct accountIds concurrently, to confirm the per-id state
// really is isolated and not accidentally sharing a single-slot assumption.
test("two different accountIds progress independently without cross-contaminating state", () => {
  const children = new Map<string, any>();
  const tracker = new ClaudeLoginTracker(
    () => {},
    (bin, args, options) => { const child = fakeChild(); children.set(options.cwd, child); return child; },
    undefined, undefined, undefined, noopEnsureDir,
  );

  tracker.start("acct-1", "/data/accounts/acct-1");
  tracker.start("acct-2", "/data/accounts/acct-2");

  const child1 = children.get("/data/accounts/acct-1");
  child1.stdout.emit("data", Buffer.from(realStdoutChunk()));
  assert.equal(tracker.get("acct-1")?.status, "awaiting_code");
  assert.equal(tracker.get("acct-2")?.status, "running");

  tracker.submitCode("acct-1", "code-for-acct-1");
  assert.equal(child1.stdinWritten, "code-for-acct-1\n");
  const child2 = children.get("/data/accounts/acct-2");
  assert.equal(child2.stdinWritten, undefined);

  child1.emit("close", 0);
  assert.equal(tracker.get("acct-1")?.status, "succeeded");
  assert.equal(tracker.get("acct-2")?.status, "running");

  assert.equal(tracker.cancel("acct-2"), true);
  assert.equal(tracker.get("acct-2")?.status, "cancelled");
  assert.equal(tracker.get("acct-1")?.status, "succeeded");
});

test("the safety-net timeout kills a stuck login (never even visited the URL) and reports timeout", async () => {
  let finishedState: ClaudeLoginState | null = null;
  let child: any;
  const tracker = new ClaudeLoginTracker(
    (state) => { finishedState = state; },
    () => { child = fakeChild(); return child; },
    10, fakeTerminate, undefined, noopEnsureDir,
  );

  tracker.start("default", "/data/claude-home");
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(finishedState?.status, "timeout");
  assert.equal(child.killed, true);
});
