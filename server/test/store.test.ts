import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { LocalStore } from "../src/store.js";
import type { CapabilityState } from "../src/capabilities.js";

test("migrates existing custom avatars to the custom source without losing them", () => {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-store-legacy-avatar-"));
  try {
    const path = join(dir, "test.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE workers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        model TEXT,
        color_index INTEGER NOT NULL,
        avatar_id TEXT,
        provider TEXT NOT NULL DEFAULT 'claude',
        workspace_path TEXT,
        claude_session_id TEXT NOT NULL,
        completed_turns INTEGER NOT NULL DEFAULT 0,
        persona TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO workers (id, name, color_index, avatar_id, provider, workspace_path, claude_session_id)
      VALUES ('legacy-custom', '舊角色', 0, 'kept-avatar.gif', 'claude', '/repo', 'session-1');
      INSERT INTO workers (id, name, color_index, avatar_id, provider, workspace_path, claude_session_id)
      VALUES ('legacy-default', '預設角色', 1, NULL, 'codex', '/repo', 'session-2');
    `);
    legacy.close();

    const store = new LocalStore(path);
    const workers = store.loadWorkers(10);
    assert.deepEqual(workers.map(({ id, avatarId, avatarKind, avatarPresetId }) => ({ id, avatarId, avatarKind, avatarPresetId })), [
      { id: "legacy-custom", avatarId: "kept-avatar.gif", avatarKind: "custom", avatarPresetId: "classic" },
      { id: "legacy-default", avatarId: null, avatarKind: "preset", avatarPresetId: "classic" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
      avatarKind: "custom",
      avatarPresetId: "signal",
      provider: "claude",
      workspacePath: "/repo",
      sessionId: "session-1",
      completedTurns: 3,
      persona: { role: "前端 QA", instructions: "回報 bug 附重現步驟" },
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
    store.saveProviderCheckpoint("worker-1", "claude", "/tmp/project", "sonnet", { sessionId: "session-checkpoint", completedTurns: 4 });
    store.saveProviderHandoff("worker-1", {
      id: "handoff-1",
      fromProvider: "claude",
      toProvider: "codex",
      toModel: null,
      stage: "completed",
      message: "Codex 已接手",
      source: "agent",
      error: null,
    }, { version: 1, goal: "continue" });

    const reopened = new LocalStore(path);
    const [worker] = reopened.loadWorkers(20);
    assert.equal(worker.name, "一號機");
    assert.equal(worker.completedTurns, 3);
    assert.equal(worker.provider, "claude");
    assert.equal(worker.workspacePath, "/repo");
    assert.equal(worker.avatarId, "avatar-1");
    assert.equal(worker.avatarKind, "custom");
    assert.equal(worker.avatarPresetId, "signal");
    assert.deepEqual(worker.persona, { role: "前端 QA", instructions: "回報 bug 附重現步驟" });
    assert.deepEqual(worker.events.map((event) => event.type), ["text_delta", "turn_end"]);
    assert.deepEqual(reopened.loadCapabilities("/repo"), capabilities);
    assert.deepEqual(reopened.loadProviderUsage("claude"), usage);
    assert.deepEqual(reopened.loadProviderCheckpoint("worker-1", "claude", "/tmp/project"), {
      model: "sonnet",
      sessionId: "session-checkpoint",
      completedTurns: 4,
    });
    assert.equal(reopened.loadProviderCheckpoint("worker-1", "claude", "/tmp/other-project"), null);
    assert.equal(reopened.listProviderHandoffs("worker-1").length, 1);

    reopened.clearWorkerEvents("worker-1");
    assert.deepEqual(reopened.loadWorkers(20)[0].events, []);

    reopened.deleteWorker("worker-1");
    assert.equal(reopened.loadWorkers(20).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stores, updates, and deletes reusable persona templates", () => {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-store-"));
  try {
    const path = join(dir, "test.sqlite");
    const store = new LocalStore(path);
    store.savePersonaTemplate({ id: "t1", name: "QA", role: "QA 工程師", instructions: "測 UI" });
    store.savePersonaTemplate({ id: "t2", name: "Reviewer", role: "審查員", instructions: "挑毛病" });

    const reopened = new LocalStore(path);
    assert.equal(reopened.listPersonaTemplates().length, 2);

    reopened.savePersonaTemplate({ id: "t1", name: "資深 QA", role: "QA 工程師", instructions: "測 UI 與 API" });
    const updated = reopened.listPersonaTemplates().find((template) => template.id === "t1");
    assert.deepEqual(updated, { id: "t1", name: "資深 QA", role: "QA 工程師", instructions: "測 UI 與 API" });

    reopened.deletePersonaTemplate("t2");
    const remaining = reopened.listPersonaTemplates();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, "t1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
