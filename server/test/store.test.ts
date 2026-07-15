import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalStore } from "../src/store.js";
import type { CapabilityState } from "../src/capabilities.js";

test("persists workers, bounded events, and capability cache", () => {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-store-"));
  try {
    const path = join(dir, "test.sqlite");
    const store = new LocalStore(path);
    store.saveWorker({
      id: "worker-1",
      name: "一號機",
      model: "sonnet",
      colorIndex: 2,
      avatarId: "avatar-1",
      provider: "claude",
      workspacePath: "/repo",
      sessionId: "session-1",
      completedTurns: 3,
    });
    store.appendEvent("worker-1", { type: "user_message", text: "first" }, 2);
    store.appendEvent("worker-1", { type: "text_delta", text: "hello" }, 2);
    store.appendEvent("worker-1", {
      type: "turn_end",
      resultText: "hello",
      costUsd: 0,
      durationMs: 10,
      isError: false,
      permissionDenials: [],
    }, 2);

    const capabilities: CapabilityState = {
      slashCommands: ["complete-task"],
      mcpServers: [{ name: "issue-tracker", status: "connected" }],
      models: [],
      toolCount: 4,
      loading: false,
      source: "live",
      updatedAt: "2026-07-15T00:00:00.000Z",
      error: null,
    };
    store.saveCapabilities("/repo", capabilities);
    const usage = {
      provider: "claude",
      windows: [{ id: "claude-week", label: "本週", usedPercent: 73, remainingPercent: 27, resetsAt: null, scope: "weekly" }],
      loading: false,
      source: "live",
      updatedAt: "2026-07-16T00:00:00.000Z",
      error: null,
    };
    store.saveProviderUsage("claude", usage);

    const reopened = new LocalStore(path);
    const [worker] = reopened.loadWorkers(20);
    assert.equal(worker.name, "一號機");
    assert.equal(worker.completedTurns, 3);
    assert.equal(worker.provider, "claude");
    assert.equal(worker.workspacePath, "/repo");
    assert.equal(worker.avatarId, "avatar-1");
    assert.deepEqual(worker.events.map((event) => event.type), ["text_delta", "turn_end"]);
    assert.deepEqual(reopened.loadCapabilities("/repo"), capabilities);
    assert.deepEqual(reopened.loadProviderUsage("claude"), usage);

    reopened.clearWorkerEvents("worker-1");
    assert.deepEqual(reopened.loadWorkers(20)[0].events, []);

    reopened.deleteWorker("worker-1");
    assert.equal(reopened.loadWorkers(20).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
