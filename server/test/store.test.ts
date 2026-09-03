import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { LocalStore } from "../src/store.js";
import type { CapabilityState } from "../src/capabilities.js";

test("migrates existing custom avatars to the custom source without losing them", () => {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-store-legacy-avatar-"));
  let store: LocalStore | null = null;
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

    store = new LocalStore(path);
    const workers = store.loadWorkers(10);
    assert.deepEqual(workers.map(({ id, avatarId, avatarKind, avatarPresetId }) => ({ id, avatarId, avatarKind, avatarPresetId })), [
      { id: "legacy-custom", avatarId: "kept-avatar.gif", avatarKind: "custom", avatarPresetId: "classic" },
      { id: "legacy-default", avatarId: null, avatarKind: "preset", avatarPresetId: "classic" },
    ]);
    assert.equal(store.listDepartments()[0]?.name, "repo部門");
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps pre-managed-account Claude sessions on their original home", () => {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-store-legacy-claude-home-"));
  let store: LocalStore | null = null;
  try {
    const path = join(dir, "test.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE workers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        model TEXT,
        color_index INTEGER NOT NULL,
        provider TEXT NOT NULL DEFAULT 'claude',
        workspace_path TEXT,
        claude_session_id TEXT NOT NULL,
        completed_turns INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO workers (id, name, color_index, provider, workspace_path, claude_session_id, completed_turns)
      VALUES
        ('old-claude', '舊 Claude', 0, 'claude', '/repo', 'legacy-session', 4),
        ('new-claude', '新 Claude', 1, 'claude', '/repo', 'new-session', 0),
        ('old-codex', '舊 Codex', 2, 'codex', '/repo', 'codex-session', 5);
    `);
    legacy.close();

    store = new LocalStore(path);
    const homes = new Map(store.loadWorkers(10).map((worker) => [worker.id, worker.claudeHomeMode]));
    assert.equal(homes.get("old-claude"), "legacy");
    assert.equal(homes.get("new-claude"), "managed");
    assert.equal(homes.get("old-codex"), "managed");
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persists workers, bounded events, and capability cache", () => {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-store-"));
  const stores: LocalStore[] = [];
  try {
    const path = join(dir, "test.sqlite");
    const store = new LocalStore(path);
    stores.push(store);
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
      autoApproveMode: "full",
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
      builtinTools: ["Bash", "Read"],
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
    stores.push(reopened);
    const [worker] = reopened.loadWorkers(20);
    assert.equal(worker.name, "一號機");
    assert.equal(worker.completedTurns, 3);
    assert.equal(worker.provider, "claude");
    assert.equal(worker.workspacePath, "/repo");
    assert.equal(worker.avatarId, "avatar-1");
    assert.equal(worker.avatarKind, "custom");
    assert.equal(worker.avatarPresetId, "signal");
    assert.deepEqual(worker.persona, { role: "前端 QA", instructions: "回報 bug 附重現步驟" });
    assert.equal(worker.autoApproveMode, "full");
    assert.equal(worker.claudeHomeMode, "managed");
    assert.deepEqual(worker.events.map((event) => event.type), ["text_delta", "turn_end"]);
    assert.deepEqual(reopened.loadCapabilities("/repo"), capabilities);
    assert.deepEqual(reopened.loadProviderUsage("claude"), usage);
    assert.deepEqual(reopened.loadProviderCheckpoint("worker-1", "claude", "/tmp/project"), {
      model: "sonnet",
      sessionId: "session-checkpoint",
      completedTurns: 4,
    });
    assert.equal(reopened.loadProviderCheckpoint("worker-1", "claude", "/tmp/other-project"), null);
    assert.equal(reopened.deleteProviderCheckpoint("worker-1", "claude"), true);
    assert.equal(reopened.loadProviderCheckpoint("worker-1", "claude", "/tmp/project"), null);
    assert.equal(reopened.listProviderHandoffs("worker-1").length, 1);

    reopened.clearWorkerEvents("worker-1");
    assert.deepEqual(reopened.loadWorkers(20)[0].events, []);

    reopened.deleteWorker("worker-1");
    assert.equal(reopened.loadWorkers(20).length, 0);
  } finally {
    for (const store of stores.reverse()) store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persists collaboration tasks and fails unfinished work on reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-store-collaboration-"));
  const path = join(dir, "test.sqlite");
  const stores: LocalStore[] = [];
  try {
    const store = new LocalStore(path);
    stores.push(store);
    const base = { model: null, avatarId: null, avatarKind: "preset" as const, avatarPresetId: "classic", workspacePath: "/repo", completedTurns: 0, persona: null, autoApproveMode: "off" as const };
    store.saveWorker({ ...base, id: "source", name: "Source", colorIndex: 0, provider: "claude", sessionId: "s1" });
    store.saveWorker({ ...base, id: "target", name: "Target", colorIndex: 1, provider: "codex", sessionId: "s2" });
    store.saveCollaborationTask({
      id: "task-1", sourceWorkerId: "source", targetWorkerId: "target", workspacePath: "/repo",
      mode: "review", objective: "Review auth", acceptanceCriteria: ["cite files"], status: "running",
      sourceContext: { gitState: "M auth.ts" }, baseCommit: "abc123", result: null, continuationResult: null, error: null,
      createdAt: "2026-07-22T00:00:00.000Z", startedAt: "2026-07-22T00:00:01.000Z", completedAt: null,
      adoptedAt: null, handledAt: null,
    });
    store.saveCollaborationTask({
      id: "task-2", sourceWorkerId: "source", targetWorkerId: "target", workspacePath: "/repo",
      mode: "consult", objective: "Continue from advice", acceptanceCriteria: [], status: "returning",
      sourceContext: {}, baseCommit: "abc123", result: null, continuationResult: null, error: null,
      createdAt: "2026-07-22T00:02:00.000Z", startedAt: "2026-07-22T00:02:01.000Z", completedAt: null,
      adoptedAt: "2026-07-22T00:03:00.000Z", handledAt: null,
    });
    assert.equal(store.getCollaborationTask("task-1")?.status, "running");
    assert.equal(store.listCollaborationTasks("source").length, 2);
    store.close();
    stores.pop();

    const reopened = new LocalStore(path);
    stores.push(reopened);
    const recovered = reopened.getCollaborationTask("task-1");
    assert.equal(recovered?.status, "failed");
    assert.match(recovered?.error ?? "", /伺服器重啟/);
    assert.equal(reopened.getCollaborationTask("task-2")?.status, "failed");
  } finally {
    for (const store of stores.reverse()) store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migrates the original collaboration constraint to returning with continuation results", () => {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-store-collaboration-v11-"));
  const path = join(dir, "test.sqlite");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE workers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, color_index INTEGER NOT NULL,
        claude_session_id TEXT NOT NULL, completed_turns INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO workers (id, name, color_index, claude_session_id) VALUES
        ('source', 'Source', 0, 's1'), ('target', 'Target', 1, 's2');
      CREATE TABLE collaboration_tasks (
        id TEXT PRIMARY KEY,
        source_worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
        target_worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
        workspace_path TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('consult', 'review')),
        objective TEXT NOT NULL,
        acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        source_context_json TEXT NOT NULL DEFAULT '{}', base_commit TEXT, result_json TEXT, error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, started_at TEXT, completed_at TEXT, adopted_at TEXT, handled_at TEXT
      );
      INSERT INTO collaboration_tasks (
        id, source_worker_id, target_worker_id, workspace_path, mode, objective, status
      ) VALUES ('legacy-task', 'source', 'target', '/repo', 'review', 'Review old task', 'completed');
    `);
    legacy.close();

    const store = new LocalStore(path);
    try {
      const task = store.getCollaborationTask("legacy-task")!;
      assert.equal(task.continuationResult, null);
      task.status = "returning";
      task.continuationResult = "Source continuation result";
      assert.equal(store.saveCollaborationTask(task), true);
      assert.equal(store.getCollaborationTask(task.id)?.status, "returning");
      assert.equal(store.getCollaborationTask(task.id)?.continuationResult, "Source continuation result");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backfills the graded auto-approve mode from a legacy boolean auto_approve column", () => {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-store-"));
  try {
    const path = join(dir, "test.sqlite");
    // Simulate a DB from before auto_approve_mode existed: the base schema
    // plus the older boolean auto_approve column, no auto_approve_mode.
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE workers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        model TEXT,
        color_index INTEGER NOT NULL,
        avatar_id TEXT,
        avatar_kind TEXT NOT NULL DEFAULT 'preset',
        avatar_preset_id TEXT NOT NULL DEFAULT 'classic',
        provider TEXT NOT NULL DEFAULT 'claude',
        workspace_path TEXT,
        claude_session_id TEXT NOT NULL,
        completed_turns INTEGER NOT NULL DEFAULT 0,
        auto_approve INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    legacy.prepare("INSERT INTO workers (id, name, color_index, claude_session_id, auto_approve) VALUES (?, ?, ?, ?, ?)")
      .run("legacy-on", "曾經開過自動核准", 0, "session-a", 1);
    legacy.prepare("INSERT INTO workers (id, name, color_index, claude_session_id, auto_approve) VALUES (?, ?, ?, ?, ?)")
      .run("legacy-off", "從沒開過", 1, "session-b", 0);
    legacy.close();

    const store = new LocalStore(path);
    try {
      const byId = new Map(store.loadWorkers(20).map((worker) => [worker.id, worker]));
      assert.equal(byId.get("legacy-on")?.autoApproveMode, "safe");
      assert.equal(byId.get("legacy-off")?.autoApproveMode, "off");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stores, updates, and deletes reusable persona templates", () => {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-store-"));
  const stores: LocalStore[] = [];
  try {
    const path = join(dir, "test.sqlite");
    const store = new LocalStore(path);
    stores.push(store);
    store.savePersonaTemplate({ id: "t1", name: "QA", role: "QA 工程師", instructions: "測 UI" });
    store.savePersonaTemplate({ id: "t2", name: "Reviewer", role: "審查員", instructions: "挑毛病" });

    const reopened = new LocalStore(path);
    stores.push(reopened);
    assert.equal(reopened.listPersonaTemplates().length, 2);

    reopened.savePersonaTemplate({ id: "t1", name: "資深 QA", role: "QA 工程師", instructions: "測 UI 與 API" });
    const updated = reopened.listPersonaTemplates().find((template) => template.id === "t1");
    assert.deepEqual(updated, { id: "t1", name: "資深 QA", role: "QA 工程師", instructions: "測 UI 與 API" });

    reopened.deletePersonaTemplate("t2");
    const remaining = reopened.listPersonaTemplates();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, "t1");
  } finally {
    for (const store of stores.reverse()) store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function minimalWorker(id: string, name: string) {
  return {
    id,
    name,
    model: null,
    colorIndex: 0,
    avatarId: null,
    avatarKind: "preset" as const,
    avatarPresetId: "classic",
    provider: "claude" as const,
    workspacePath: "/repo",
    sessionId: `session-${id}`,
    completedTurns: 0,
    persona: null,
    autoApproveMode: "off" as const,
  };
}

test("backfills sort_order from creation order on databases without it", () => {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-store-order-legacy-"));
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
        avatar_kind TEXT NOT NULL DEFAULT 'preset',
        avatar_preset_id TEXT NOT NULL DEFAULT 'classic',
        provider TEXT NOT NULL DEFAULT 'claude',
        workspace_path TEXT,
        claude_session_id TEXT NOT NULL,
        completed_turns INTEGER NOT NULL DEFAULT 0,
        auto_approve_mode TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    const insert = legacy.prepare("INSERT INTO workers (id, name, color_index, claude_session_id, created_at) VALUES (?, ?, 0, ?, ?)");
    insert.run("late", "後來的", "session-late", "2026-07-02 00:00:00");
    insert.run("early", "先來的", "session-early", "2026-07-01 00:00:00");
    legacy.close();

    const store = new LocalStore(path);
    try {
      assert.deepEqual(store.loadWorkers(10).map((worker) => worker.id), ["early", "late"]);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveWorkerOrder persists a custom order across reopen and appends new workers last", () => {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-store-order-"));
  const stores: LocalStore[] = [];
  try {
    const path = join(dir, "test.sqlite");
    const store = new LocalStore(path);
    stores.push(store);
    for (const [id, name] of [["w1", "一號"], ["w2", "二號"], ["w3", "三號"]] as const) {
      store.saveWorker(minimalWorker(id, name));
    }
    assert.deepEqual(store.loadWorkers(10).map((worker) => worker.id), ["w1", "w2", "w3"]);

    assert.equal(store.saveWorkerOrder(["w3", "w1", "w2"]), true);
    assert.deepEqual(store.loadWorkers(10).map((worker) => worker.id), ["w3", "w1", "w2"]);

    // Re-saving an existing worker (e.g. rename) must not disturb its slot.
    store.saveWorker({ ...minimalWorker("w3", "三號改名"), completedTurns: 1 });
    assert.deepEqual(store.loadWorkers(10).map((worker) => worker.id), ["w3", "w1", "w2"]);

    // A brand-new worker lands at the end of the custom order.
    store.saveWorker(minimalWorker("w4", "四號"));
    assert.deepEqual(store.loadWorkers(10).map((worker) => worker.id), ["w3", "w1", "w2", "w4"]);

    const reopened = new LocalStore(path);
    stores.push(reopened);
    assert.deepEqual(reopened.loadWorkers(10).map((worker) => worker.id), ["w3", "w1", "w2", "w4"]);
  } finally {
    for (const store of stores.reverse()) store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("meta counter accumulates and survives a reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-store-counter-"));
  const stores: LocalStore[] = [];
  try {
    const path = join(dir, "test.sqlite");
    const store = new LocalStore(path);
    stores.push(store);

    assert.equal(store.getCounter("completed_turns"), 0);
    assert.equal(store.incrementCounter("completed_turns"), 1);
    assert.equal(store.incrementCounter("completed_turns"), 2);
    assert.equal(store.incrementCounter("completed_turns", 5), 7);
    // Unrelated keys stay independent.
    assert.equal(store.getCounter("other"), 0);

    const reopened = new LocalStore(path);
    stores.push(reopened);
    assert.equal(reopened.getCounter("completed_turns"), 7);
  } finally {
    for (const store of stores.reverse()) store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveGlobalMemoryNote rolls back a duplicate-id insert with no partial side effect", () => {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-store-global-memory-"));
  const stores: LocalStore[] = [];
  try {
    const path = join(dir, "test.sqlite");
    const store = new LocalStore(path);
    stores.push(store);

    const first = { id: "dup-id", note: "first note", sourceWorkerId: null, sourceWorkerName: null, createdAt: "2026-01-01T00:00:00.000Z" };
    assert.equal(store.saveGlobalMemoryNote(first, 50), true);

    const duplicate = { id: "dup-id", note: "second note", sourceWorkerId: null, sourceWorkerName: null, createdAt: "2026-01-02T00:00:00.000Z" };
    assert.equal(store.saveGlobalMemoryNote(duplicate, 50), false);

    const notes = store.listGlobalMemoryNotes();
    assert.equal(notes.length, 1);
    assert.equal(notes[0].note, "first note");
  } finally {
    for (const store of stores.reverse()) store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveGlobalMemoryNote is atomic: if the prune step throws, the insert that already ran is rolled back too", () => {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-store-global-memory-atomic-"));
  const stores: LocalStore[] = [];
  try {
    const path = join(dir, "test.sqlite");
    const store = new LocalStore(path);
    stores.push(store);

    const entry = { id: "will-be-rolled-back", note: "should not survive", sourceWorkerId: null, sourceWorkerName: null, createdAt: "2026-01-01T00:00:00.000Z" };
    // The INSERT (which doesn't touch maxNotes) succeeds on its own; only the
    // prune statement's `LIMIT ?` bind fails on a too-large BigInt. Without
    // the BEGIN/COMMIT/ROLLBACK wrapping, the already-autocommitted INSERT
    // would survive even though this call reports failure.
    const tooLargeMaxNotes = (2n ** 100n) as unknown as number;
    assert.equal(store.saveGlobalMemoryNote(entry, tooLargeMaxNotes), false);

    assert.deepEqual(store.listGlobalMemoryNotes(), []);
  } finally {
    for (const store of stores.reverse()) store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("flush() forces the debounced event queue to disk and checkpoint() truncates the WAL", () => {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-store-checkpoint-"));
  const stores: LocalStore[] = [];
  try {
    const path = join(dir, "test.sqlite");
    const store = new LocalStore(path);
    stores.push(store);
    store.saveWorker({
      id: "w1", name: "一號機", model: null, colorIndex: 0, avatarId: null,
      avatarKind: "preset", avatarPresetId: "classic", provider: "claude",
      workspacePath: "/repo", sessionId: "s1", completedTurns: 0,
      persona: null, autoApproveMode: "off",
    });
    // text_delta is not in appendEvent's immediate-flush set, so without an
    // explicit flush() this would sit in the 150ms debounce queue.
    store.appendEvent("w1", { type: "text_delta", text: "hello" }, 2000);
    store.flush();
    store.checkpoint();

    // A second, independent read-only connection proves the data actually
    // reached the main DB file rather than still sitting in memory or WAL.
    const verify = new DatabaseSync(path, { readOnly: true });
    try {
      const row = verify.prepare("SELECT COUNT(*) AS count FROM runner_events WHERE worker_id = ?").get("w1") as { count: number };
      assert.equal(row.count, 1);
    } finally {
      verify.close();
    }

    // TRUNCATE empties the WAL itself; the -shm index file is a fixed-size
    // memory-mapped bookkeeping file SQLite keeps around regardless, so it
    // is not expected to shrink to zero.
    if (existsSync(`${path}-wal`)) assert.equal(statSync(`${path}-wal`).size, 0);
  } finally {
    for (const store of stores.reverse()) store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persists Boss task chat, stages, and final report across reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-store-boss-task-"));
  const stores: LocalStore[] = [];
  try {
    const path = join(dir, "test.sqlite");
    const store = new LocalStore(path);
    stores.push(store);
    const task = {
      id: "boss-1",
      title: "ERP delivery",
      archivedAt: null,
      workspacePath: "/repo",
      decisionProvider: "codex" as const,
      decisionModel: "gpt",
      objective: "Build ERP",
      acceptanceCriteria: ["QA passes"],
      attachmentIds: ["attachment-1"],
      clientMessageId: "client-1",
      idempotencyKey: "idem-1",
      status: "completed" as const,
      executionMode: "project" as const,
      messages: [{ id: "msg-1", role: "boss" as const, text: "Build ERP", attachmentIds: ["attachment-1"], clientMessageId: "client-1", idempotencyKey: "idem-1", createdAt: "2026-01-01" }],
      stages: [{
        id: "plan", departmentId: "pm", departmentName: "PM", title: "Plan", objective: "Plan",
        acceptanceCriteria: ["scope"], dependsOn: [], status: "completed" as const, missionId: "mission-1", report: "Done",
        executionMode: "project" as const,
      }],
      finalReport: "Final",
      error: null,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-02",
      completedAt: "2026-01-02",
    };
    assert.equal(store.saveBossTask(task), true);
    const reopened = new LocalStore(path);
    stores.push(reopened);
    assert.deepEqual(reopened.getBossTask("boss-1"), task);
    assert.deepEqual(reopened.listBossTasks("/repo").map((item) => item.id), ["boss-1"]);
    const archived = { ...task, archivedAt: "2026-01-03", updatedAt: "2026-01-03" };
    assert.equal(reopened.saveBossTask(archived), true);
    assert.equal(reopened.getBossTask("boss-1")?.archivedAt, "2026-01-03");
    assert.equal(reopened.deleteBossTask("boss-1"), true);
    assert.equal(reopened.getBossTask("boss-1"), null);
  } finally {
    for (const store of stores.reverse()) store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provider accounts round-trip across Codex and Claude, and deleting one falls back its workers to the shared login", () => {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-store-accounts-"));
  const path = join(dir, "test.sqlite");
  const stores: LocalStore[] = [];
  try {
    const store = new LocalStore(path);
    stores.push(store);
    const base = { model: null, avatarId: null, avatarKind: "preset" as const, avatarPresetId: "classic", workspacePath: "/repo", completedTurns: 0, persona: null, autoApproveMode: "off" as const, departmentId: null };

    assert.deepEqual(store.listAccounts(), []);
    const account = { id: "acct-1", provider: "codex" as const, label: "alice", homeDir: "/data/accounts/acct-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    assert.equal(store.saveAccount(account), true);
    assert.deepEqual(store.getAccount("acct-1"), account);
    assert.deepEqual(store.listAccounts(), [account]);
    assert.deepEqual(store.listAccounts("codex"), [account]);
    assert.deepEqual(store.listAccounts("claude"), []);

    const renamed = { ...account, label: "alice (renamed)", updatedAt: "2026-01-02T00:00:00.000Z" };
    assert.equal(store.saveAccount(renamed), true);
    assert.deepEqual(store.getAccount("acct-1"), renamed);

    const claudeAccount = { id: "acct-2", provider: "claude" as const, label: "bob", homeDir: "/data/accounts/acct-2", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    assert.equal(store.saveAccount(claudeAccount), true);
    assert.deepEqual(store.listAccounts("claude"), [claudeAccount]);

    store.saveWorker({ ...base, id: "worker-1", name: "一號機", colorIndex: 0, provider: "codex", sessionId: "s1", accountId: "acct-1" });
    store.saveWorker({ ...base, id: "worker-2", name: "二號機", colorIndex: 1, provider: "claude", sessionId: "s2", accountId: null });
    assert.equal(store.loadWorkers(0).find((w) => w.id === "worker-1")?.accountId, "acct-1");

    const { deleted, orphanedWorkerIds } = store.deleteAccount("acct-1");
    assert.equal(deleted, true);
    assert.deepEqual(orphanedWorkerIds, ["worker-1"]);
    assert.equal(store.getAccount("acct-1"), null);
    const reloaded = store.loadWorkers(0);
    assert.equal(reloaded.find((w) => w.id === "worker-1")?.accountId, null);
    assert.equal(reloaded.find((w) => w.id === "worker-2")?.accountId, null);

    // Deleting an account with no referencing workers reports an empty orphan list.
    assert.deepEqual(store.deleteAccount("never-existed"), { deleted: true, orphanedWorkerIds: [] });
  } finally {
    for (const store of stores.reverse()) store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pre-migration workers table (no account_id column) backfills to NULL, not an error", () => {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-store-legacy-codex-account-"));
  let store: LocalStore | null = null;
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
      INSERT INTO workers (id, name, color_index, provider, workspace_path, claude_session_id)
      VALUES ('pre-migration', '舊角色', 0, 'codex', '/repo', 'session-1');
    `);
    legacy.close();

    store = new LocalStore(path);
    const [worker] = store.loadWorkers(0);
    assert.equal(worker.accountId, null);
    assert.deepEqual(store.listAccounts(), []);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a database with the legacy codex_accounts table rebuilds it into the unified accounts table on boot", () => {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-store-legacy-codex-accounts-table-"));
  let store: LocalStore | null = null;
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
        codex_account_id TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE codex_accounts (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        codex_home TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO codex_accounts (id, label, codex_home, created_at, updated_at)
      VALUES ('acct-legacy', 'legacy alice', '/data/codex-accounts/acct-legacy', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO workers (id, name, color_index, provider, workspace_path, claude_session_id, codex_account_id)
      VALUES ('worker-legacy', '舊角色', 0, 'codex', '/repo', 'session-1', 'acct-legacy');
    `);
    legacy.close();

    store = new LocalStore(path);
    const accounts = store.listAccounts();
    assert.deepEqual(accounts, [{
      id: "acct-legacy", provider: "codex", label: "legacy alice",
      homeDir: "/data/codex-accounts/acct-legacy",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    }]);
    // The one-time backfill (account_id <- codex_account_id) carries the worker's
    // existing assignment forward into the generic column.
    const [worker] = store.loadWorkers(0);
    assert.equal(worker.accountId, "acct-legacy");
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
