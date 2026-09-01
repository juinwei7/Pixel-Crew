import type { DatabaseSync } from "node:sqlite";
import type { DatabaseMigration } from "./databaseMigrations.js";

function tableSql(db: DatabaseSync, table: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql?: string } | undefined;
  return row?.sql ?? "";
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((entry) => entry.name === column);
}

function addColumnIfMissing(db: DatabaseSync, table: string, definition: string): void {
  const column = definition.trim().split(/\s+/, 1)[0];
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function migrateCollaborationTasks(db: DatabaseSync): void {
  const schema = tableSql(db, "collaboration_tasks");
  if (schema.includes("'returning'") && schema.includes("continuation_result")) return;
  db.exec(`
    DROP INDEX IF EXISTS collaboration_tasks_source_created;
    DROP INDEX IF EXISTS collaboration_tasks_target_created;
    ALTER TABLE collaboration_tasks RENAME TO collaboration_tasks_legacy;
    CREATE TABLE collaboration_tasks (
      id TEXT PRIMARY KEY,
      source_worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
      target_worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
      workspace_path TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('consult', 'review')),
      objective TEXT NOT NULL,
      acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'returning', 'completed', 'failed', 'cancelled')),
      source_context_json TEXT NOT NULL DEFAULT '{}',
      base_commit TEXT,
      result_json TEXT,
      continuation_result TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      completed_at TEXT,
      adopted_at TEXT,
      handled_at TEXT
    );
    INSERT INTO collaboration_tasks (
      id, source_worker_id, target_worker_id, workspace_path, mode, objective,
      acceptance_criteria_json, status, source_context_json, base_commit, result_json,
      continuation_result, error, created_at, started_at, completed_at, adopted_at, handled_at
    )
    SELECT id, source_worker_id, target_worker_id, workspace_path, mode, objective,
      acceptance_criteria_json, status, source_context_json, base_commit, result_json,
      NULL, error, created_at, started_at, completed_at, adopted_at, handled_at
    FROM collaboration_tasks_legacy;
    DROP TABLE collaboration_tasks_legacy;
    CREATE INDEX collaboration_tasks_source_created
      ON collaboration_tasks(source_worker_id, created_at DESC);
    CREATE INDEX collaboration_tasks_target_created
      ON collaboration_tasks(target_worker_id, created_at DESC);
  `);
}

function migrateCodexAccountsToUnifiedAccounts(db: DatabaseSync): void {
  if (tableSql(db, "accounts")) return;
  if (!tableSql(db, "codex_accounts")) {
    db.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        label TEXT NOT NULL,
        home_dir TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    return;
  }
  db.exec(`
    ALTER TABLE codex_accounts RENAME TO accounts_legacy;
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      label TEXT NOT NULL,
      home_dir TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO accounts (id, provider, label, home_dir, created_at, updated_at)
      SELECT id, 'codex', label, codex_home, created_at, updated_at FROM accounts_legacy;
    DROP TABLE accounts_legacy;
  `);
}

function completeHistoricalStoreSchema(db: DatabaseSync): void {
  addColumnIfMissing(db, "department_missions", "attention_reason TEXT");
  addColumnIfMissing(db, "boss_tasks", "title TEXT");
  addColumnIfMissing(db, "boss_tasks", "archived_at TEXT");
  addColumnIfMissing(db, "department_missions", "department_id TEXT");
  addColumnIfMissing(db, "department_missions", "plan_approved_at TEXT");
  addColumnIfMissing(db, "department_missions", "owner_guidance TEXT");
  addColumnIfMissing(db, "department_missions", "format_repair_count INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "department_missions", "attachment_ids_json TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, "department_missions", "parent_mission_id TEXT");
  addColumnIfMissing(db, "department_missions", "source_message_id TEXT");
  addColumnIfMissing(db, "department_missions", "delegated_sessions_json TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, "department_missions", "execution_events_json TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, "department_missions", "execution_mode TEXT NOT NULL DEFAULT 'project'");
  addColumnIfMissing(db, "department_missions", "mission_origin TEXT NOT NULL DEFAULT 'department'");
  addColumnIfMissing(db, "department_threads", "history_cleared_at TEXT");
  addColumnIfMissing(db, "workers", "provider TEXT NOT NULL DEFAULT 'claude'");
  addColumnIfMissing(db, "workers", "workspace_path TEXT");
  addColumnIfMissing(db, "workers", "avatar_id TEXT");
  addColumnIfMissing(db, "workers", "avatar_kind TEXT");
  db.exec("UPDATE workers SET avatar_kind = CASE WHEN avatar_id IS NULL THEN 'preset' ELSE 'custom' END WHERE avatar_kind IS NULL");
  addColumnIfMissing(db, "workers", "avatar_preset_id TEXT NOT NULL DEFAULT 'classic'");
  addColumnIfMissing(db, "workers", "persona TEXT");
  addColumnIfMissing(db, "provider_checkpoints", "workspace_path TEXT");
  addColumnIfMissing(db, "workers", "auto_approve INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "workers", "auto_approve_mode TEXT");
  db.exec("UPDATE workers SET auto_approve_mode = CASE WHEN auto_approve = 1 THEN 'safe' ELSE 'off' END WHERE auto_approve_mode IS NULL");
  addColumnIfMissing(db, "workers", "sort_order INTEGER");
  db.exec(`
    UPDATE workers SET sort_order = (
      SELECT COUNT(*) FROM workers w2
      WHERE w2.created_at < workers.created_at
        OR (w2.created_at = workers.created_at AND w2.rowid < workers.rowid)
    ) WHERE sort_order IS NULL
  `);
  addColumnIfMissing(db, "workers", "department_id TEXT");
  addColumnIfMissing(db, "workers", "codex_account_id TEXT");
  addColumnIfMissing(db, "workers", "account_id TEXT");
  db.exec("UPDATE workers SET account_id = codex_account_id WHERE codex_account_id IS NOT NULL AND account_id IS NULL");
}

export const storeMigrations: readonly DatabaseMigration[] = [
  { version: 1, name: "rebuild-collaboration-tasks-returning", up: migrateCollaborationTasks },
  { version: 2, name: "unify-provider-accounts", up: migrateCodexAccountsToUnifiedAccounts },
  { version: 3, name: "complete-historical-store-schema", up: completeHistoricalStoreSchema },
  {
    version: 4,
    name: "persist-mission-execution-boundaries",
    up: (db) => {
      addColumnIfMissing(db, "department_missions", "execution_profile TEXT NOT NULL DEFAULT 'standard'");
      addColumnIfMissing(db, "department_missions", "max_plan_steps INTEGER NOT NULL DEFAULT 4");
      addColumnIfMissing(db, "department_missions", "member_worker_ids_json TEXT NOT NULL DEFAULT '[]'");
    },
  },
  {
    version: 5,
    name: "add-local-diagnostic-events",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS diagnostic_events (
          id TEXT PRIMARY KEY,
          event_kind TEXT NOT NULL CHECK (event_kind IN ('websocket_reconnect', 'ui_long_task', 'fps_sample', 'approval_wait')),
          value REAL NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS diagnostic_events_created ON diagnostic_events(created_at DESC);
      `);
    },
  },
  {
    version: 6,
    name: "add-worker-resume-candidates",
    up: (db) => db.exec(`CREATE TABLE IF NOT EXISTS worker_resume_candidates (
      worker_id TEXT PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE,
      task_text TEXT NOT NULL, session_id TEXT NOT NULL, interrupted_at TEXT NOT NULL, reset_at TEXT
    )`),
  },
];
