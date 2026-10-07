import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ApprovalDecision } from "../src/claudeRunner.js";
import { replaceWithFreshSession, switchAccountWithReset } from "../src/freshSession.js";
import type { AgentSession } from "../src/providers/session.js";

class FakeSession implements AgentSession {
  readonly provider;
  readonly workspacePath = "/tmp/pixel-crew";
  busy = false;
  name = "Architect";
  stopped = false;
  warmed = false;
  private model: string | undefined;

  constructor(private readonly sessionId: string, private readonly completedTurns: number, model?: string, provider: "claude" | "codex" = "claude") {
    this.model = model;
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

test("fresh model switch replaces only the provider session", () => {
  const previous = new FakeSession("old-session", 7, "sonnet");
  const worker = { runner: previous, persona: "kept", departmentId: "engineering" };
  const persisted: string[] = [];
  const checkpointed: string[] = [];

  const result = replaceWithFreshSession(
    worker,
    "opus",
    () => new FakeSession("new-session", 0),
    (runner) => { persisted.push(runner.getPersistenceState().sessionId); return true; },
    (runner) => { checkpointed.push(runner.getPersistenceState().sessionId); return true; },
  );

  assert.equal(result, worker.runner);
  assert.equal(previous.stopped, true);
  assert.equal(worker.runner.name, "Architect");
  assert.equal(worker.runner.getModel(), "opus");
  assert.deepEqual(worker.runner.getPersistenceState(), { sessionId: "new-session", completedTurns: 0 });
  assert.equal(worker.persona, "kept");
  assert.equal(worker.departmentId, "engineering");
  assert.deepEqual(persisted, ["new-session"]);
  assert.deepEqual(checkpointed, ["new-session"]);
});

test("fresh cross-provider switch discards the source checkpoint", () => {
  const previous = new FakeSession("claude-session", 5, "sonnet", "claude");
  const worker = { runner: previous };
  const discarded: string[] = [];

  const result = replaceWithFreshSession(
    worker,
    undefined,
    () => new FakeSession("codex-session", 0, undefined, "codex"),
    () => true,
    () => true,
    (runner) => { discarded.push(`${runner.provider}:${runner.getPersistenceState().sessionId}`); return true; },
  );

  assert.equal(result?.provider, "codex");
  assert.deepEqual(result?.getPersistenceState(), { sessionId: "codex-session", completedTurns: 0 });
  assert.deepEqual(discarded, ["claude:claude-session"]);
});

test("fresh model switch restores the previous runner when persistence fails", () => {
  const previous = new FakeSession("old-session", 7, "sonnet");
  const fresh = new FakeSession("new-session", 0);
  const worker = { runner: previous };
  let persistCalls = 0;

  const result = replaceWithFreshSession(
    worker,
    "opus",
    () => fresh,
    () => { persistCalls++; return persistCalls > 1; },
    () => true,
  );

  assert.equal(result, null);
  assert.equal(worker.runner, previous);
  assert.equal(previous.getModel(), "sonnet");
  assert.equal(fresh.stopped, true);
  assert.equal(persistCalls, 2);
});

test("account switch with reset applies the new account before the fresh runner warms up", () => {
  const worker = { accountId: "old" as string | null };
  let accountAtReset: string | null = null;
  const result = switchAccountWithReset(worker, "new", () => {
    // 重置當場會暖機新 runner，它讀到的帳號決定 CLI 生在哪個 home。
    accountAtReset = worker.accountId;
    return { ok: true };
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(accountAtReset, "new");
  assert.equal(worker.accountId, "new");
});

test("account switch with reset restores the previous account when the reset fails", () => {
  const worker = { accountId: "old" as string | null };
  const result = switchAccountWithReset(worker, null, () => ({ ok: false, error: "busy" }));
  assert.deepEqual(result, { ok: false, error: "busy" });
  assert.equal(worker.accountId, "old");
});

test("account route: a warm runner without history is respawned under the new account", () => {
  // 沒有對話紀錄時不清除，但暖機好的 CLI 是用舊帳號的 home 生的；不重生的話第一回合會跑在舊帳號上。
  const indexSource = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8").replace(/\r\n/g, "\n"); // Windows checkout 是 CRLF
  const start = indexSource.indexOf('app.patch("/api/workers/:id/account"');
  assert.ok(start >= 0);
  const route = indexSource.slice(start, indexSource.indexOf("\n});", start));
  assert.match(route, /switchAccountWithReset\(worker, accountId, \(\) => cleanWorkerAndAnnounce\(worker\)\)/);
  assert.match(route, /if \(!respawned && previousAccountId !== accountId\) \{\n\s+worker\.runner\.stop\(\);\n\s+if \(workerProviderReady\(worker\)\) worker\.runner\.warmup\(\);/);
  assert.ok(route.indexOf("worker.accountId = accountId;") < route.indexOf("worker.runner.stop();"), "先換帳號再重生");
});
