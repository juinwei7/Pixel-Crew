import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DatabaseMigrationRunner } from "../src/databaseMigrations.js";
import { LocalStore } from "../src/store.js";

test("migration runner rolls back a failed version and records an auditable failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-migration-rollback-"));
  const path = join(dir, "test.sqlite");
  const db = new DatabaseSync(path);
  try {
    const runner = new DatabaseMigrationRunner(db);
    assert.throws(() => runner.migrate([
      { version: 1, name: "create-committed-table", up: (connection) => connection.exec("CREATE TABLE committed (id INTEGER PRIMARY KEY)") },
      {
        version: 2,
        name: "rollback-on-error",
        up: (connection) => {
          connection.exec("CREATE TABLE must_rollback (id INTEGER PRIMARY KEY)");
          throw new Error("deliberate migration failure");
        },
      },
    ]), /SQLite migration 2 \(rollback-on-error\) failed/);

    assert.equal(Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'committed'").get()), true);
    assert.equal(Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'must_rollback'").get()), false);
    assert.deepEqual(
      (db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all() as Array<Record<string, unknown>>).map((row) => ({ ...row })),
      [{ version: 1, name: "create-committed-table" }],
    );
    assert.deepEqual(
      (db.prepare("SELECT version, status, error FROM schema_migration_runs ORDER BY version").all() as Array<Record<string, unknown>>).map((row) => ({ ...row })),
      [
        { version: 1, status: "applied", error: null },
        { version: 2, status: "failed", error: "deliberate migration failure" },
      ],
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LocalStore snapshots historical schemas before recording versioned migrations", () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-store-migration-snapshot-"));
  const path = join(dir, "legacy.sqlite");
  let store: LocalStore | null = null;
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE workers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        model TEXT,
        color_index INTEGER NOT NULL,
        claude_session_id TEXT NOT NULL,
        completed_turns INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO workers (id, name, color_index, claude_session_id)
      VALUES ('legacy-worker', 'Legacy worker', 0, 'legacy-session');
    `);
    legacy.close();

    store = new LocalStore(path);
    assert.equal(store.loadWorkers(0)[0]?.id, "legacy-worker");
    store.close();
    store = null;

    const snapshots = readdirSync(dir).filter((name) => name.includes(".before-migration-v1-") && name.endsWith(".sqlite"));
    assert.equal(snapshots.length, 1);
    const snapshotPath = join(dir, snapshots[0]);
    assert.equal(existsSync(snapshotPath), true);
    const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
    try {
      // Snapshot predates the bootstrap CREATE TABLE calls, proving it can be
      // used to recover the original schema rather than an already-mutated DB.
      assert.equal(Boolean(snapshot.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'departments'").get()), false);
      assert.ok(snapshot.prepare("SELECT name FROM workers WHERE id = 'legacy-worker'").get());
    } finally {
      snapshot.close();
    }

    const upgraded = new DatabaseSync(path, { readOnly: true });
    try {
      assert.deepEqual(
        (upgraded.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all() as Array<Record<string, unknown>>).map((row) => ({ ...row })),
        [
          { version: 1, name: "rebuild-collaboration-tasks-returning" },
          { version: 2, name: "unify-provider-accounts" },
          { version: 3, name: "complete-historical-store-schema" },
          { version: 4, name: "persist-mission-execution-boundaries" },
          { version: 5, name: "add-local-diagnostic-events" },
          { version: 6, name: "add-worker-resume-candidates" },
        ],
      );
      assert.deepEqual(
        (upgraded.prepare("SELECT status FROM schema_migration_runs ORDER BY version").all() as Array<Record<string, unknown>>).map((row) => ({ ...row })),
        [{ status: "applied" }, { status: "applied" }, { status: "applied" }, { status: "applied" }, { status: "applied" }, { status: "applied" }],
      );
    } finally {
      upgraded.close();
    }
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fresh LocalStore records its schema versions without creating an empty snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-store-migration-fresh-"));
  const path = join(dir, "fresh.sqlite");
  const store = new LocalStore(path);
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.deepEqual(
        (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<Record<string, unknown>>).map((row) => ({ ...row })),
        [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }],
      );
    } finally {
      db.close();
    }
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".before-migration-")), []);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
