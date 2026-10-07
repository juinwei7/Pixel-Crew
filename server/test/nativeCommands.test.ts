import assert from "node:assert/strict";
import test from "node:test";
import type { ApprovalDecision } from "../src/claudeRunner.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cleanWorkerSession, interceptedAppCommand, isClearCommand, matchNativeCommand, parseGoalCommand } from "../src/nativeCommands.js";
import type { AgentSession } from "../src/providers/session.js";

class FakeSession implements AgentSession {
  readonly provider;
  readonly workspacePath = "/tmp/pixel-crew";
  busy = false;
  name = "Architect";
  stopped = false;
  warmed = false;
  private model: string | undefined;

  constructor(private readonly sessionId: string, private readonly completedTurns: number, provider: "claude" | "codex" = "claude") {
    this.provider = provider;
  }

  warmup() { this.warmed = true; }
  send() {}
  interrupt() {}
  stop() { this.stopped = true; }
  requestPromptRefresh() {}
  resolveApproval(_id: string, _decision: ApprovalDecision) { return false; }
  handleApprovalBridge() { return null; }
  setModel(model: string | undefined) { this.model = model; }
  getModel() { return this.model; }
  getPersistenceState() { return { sessionId: this.sessionId, completedTurns: this.completedTurns }; }
}

test("matchNativeCommand recognizes /clean regardless of case or trailing text", () => {
  assert.equal(matchNativeCommand("/clean"), "clean");
  assert.equal(matchNativeCommand("/Clean now please"), "clean");
  assert.equal(matchNativeCommand("  /clean  "), "clean");
});

test("matchNativeCommand ignores unrelated text and provider-native commands", () => {
  assert.equal(matchNativeCommand("/clear"), null);
  assert.equal(matchNativeCommand("/new"), null);
  assert.equal(matchNativeCommand("please clean this up"), null);
  assert.equal(matchNativeCommand(""), null);
});

test("recognizes only the exact provider-neutral /clear conversation control", () => {
  assert.equal(isClearCommand("/clear"), true);
  assert.equal(isClearCommand("  /CLEAR  "), true);
  assert.equal(isClearCommand("/clear old context"), false);
  assert.equal(isClearCommand("/clear\nnext task"), false);
  assert.equal(isClearCommand("/clean"), false);
});

test("parses shared /goal get, clear, and set commands", () => {
  assert.deepEqual(parseGoalCommand("/goal"), { type: "get" });
  assert.deepEqual(parseGoalCommand(" /goal CLEAR "), { type: "clear" });
  assert.deepEqual(parseGoalCommand("/goal ship the release"), { type: "set", objective: "ship the release" });
  assert.deepEqual(parseGoalCommand("/goal clear the auth debt"), { type: "set", objective: "clear the auth debt" });
  assert.equal(parseGoalCommand("/goals"), null);
});

test("cleanWorkerSession refuses a busy worker without touching its session", () => {
  const previous = new FakeSession("old-session", 3);
  const worker = { id: "w1", runner: previous, history: [{ type: "user_message", text: "hi" } as never] };

  const result = cleanWorkerSession(worker, {
    isBusy: () => true,
    createRunner: () => { throw new Error("should not create a runner"); },
    persistWorker: () => true,
    saveCheckpoint: () => true,
    clearWorkerEvents: () => { throw new Error("should not clear events"); },
  });

  assert.deepEqual(result, { ok: false, error: "Architect 正在忙碌中" });
  assert.equal(previous.stopped, false);
  assert.equal(worker.history.length, 1);
});

test("cleanWorkerSession replaces the runner and wipes history on success", () => {
  const previous = new FakeSession("old-session", 3);
  const fresh = new FakeSession("new-session", 0);
  const worker = { id: "w1", runner: previous, history: [{ type: "user_message", text: "hi" } as never] };
  const clearedIds: string[] = [];

  const result = cleanWorkerSession(worker, {
    isBusy: () => false,
    createRunner: () => fresh,
    persistWorker: () => true,
    saveCheckpoint: () => true,
    clearWorkerEvents: (id) => { clearedIds.push(id); },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(previous.stopped, true);
  assert.equal(worker.runner, fresh);
  assert.equal(fresh.warmed, true);
  assert.deepEqual(worker.history, []);
  assert.deepEqual(clearedIds, ["w1"]);
});

test("cleanWorkerSession reports failure when persistence fails and keeps history intact", () => {
  const previous = new FakeSession("old-session", 3);
  const worker = { id: "w1", runner: previous, history: [{ type: "user_message", text: "hi" } as never] };

  const result = cleanWorkerSession(worker, {
    isBusy: () => false,
    createRunner: () => new FakeSession("new-session", 0),
    persistWorker: () => false,
    saveCheckpoint: () => true,
    clearWorkerEvents: () => { throw new Error("should not clear events on failed swap"); },
  });

  assert.deepEqual(result, { ok: false, error: "無法重建工作階段" });
  assert.equal(worker.runner, previous);
  assert.equal(worker.history.length, 1);
});

test("interceptedAppCommand: /clean and bare /clear are app-handled for both providers", () => {
  for (const provider of ["claude", "codex"] as const) {
    assert.deepEqual(interceptedAppCommand(provider, "/clear", false), { type: "clean" });
    assert.deepEqual(interceptedAppCommand(provider, "/clean now", true), { type: "clean" });
    // 帶附件的 /clear 是一般訊息（與 /message 原本的判定一致）。
    assert.equal(interceptedAppCommand(provider, "/clear", true), null);
    assert.equal(interceptedAppCommand(provider, "please clear the cache", false), null);
  }
});

test("interceptedAppCommand: only Claude's /goal is emulated by the app", () => {
  assert.deepEqual(interceptedAppCommand("claude", "/goal ship v2", false), { type: "goal", command: { type: "set", objective: "ship v2" } });
  assert.deepEqual(interceptedAppCommand("claude", "/goal", false), { type: "goal", command: { type: "get" } });
  assert.equal(interceptedAppCommand("claude", "/goal ship v2", true), null);
  // Codex 的 /goal 由它自己的 app-server 處理。
  assert.equal(interceptedAppCommand("codex", "/goal ship v2", false), null);
});

test("queued messages go through the same app-command interception as direct messages", () => {
  const indexSource = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8").replace(/\r\n/g, "\n"); // Windows checkout 是 CRLF
  const body = (marker: string) => {
    const start = indexSource.indexOf(marker);
    assert.ok(start >= 0, `index.ts 找不到 ${marker}`);
    return indexSource.slice(start, indexSource.indexOf("\n}", start));
  };
  const drain = body("function drainWorkerQueue(");
  assert.match(drain, /interceptedAppCommand\(worker\.runner\.provider, next\.message/);
  assert.match(drain, /runAppCommand\(worker, appCommand\)/);
  // 成功才移出佇列（peek → 處理 → remove），失敗沿用有上限的重試。
  assert.ok(drain.indexOf("runAppCommand(") < drain.indexOf("store.removeQueueItem(worker.id, next.id);\n  if (appCommand)"));
  const direct = body('app.post("/api/workers/:id/message"');
  assert.match(direct, /interceptedAppCommand\(worker\.runner\.provider, message/);
});
