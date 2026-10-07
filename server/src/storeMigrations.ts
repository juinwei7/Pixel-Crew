import type { DatabaseSync } from "node:sqlite";
import type { DatabaseMigration } from "./databaseMigrations.js";
import { workspaceIdentity } from "./platform/paths.js";

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
  {
    // Managed provider accounts introduced a private CLAUDE_CONFIG_DIR. A
    // Claude session id can only resume from the config home that created it,
    // so existing conversations must remain on the ambient home after upgrade.
    version: 7,
    name: "preserve-legacy-claude-session-home",
    up: (db) => {
      addColumnIfMissing(db, "workers", "claude_home_mode TEXT NOT NULL DEFAULT 'managed'");
      db.exec(`
        UPDATE workers
        SET claude_home_mode = 'legacy'
        WHERE provider = 'claude'
          AND completed_turns > 0
          AND account_id IS NULL
      `);
    },
  },
  {
    // 排程「每 N 分鐘重複」擴充。必須是「新的」migration 版本：既有 DB 早已套過 version 3，
    // 若把欄位塞回 version 3 的 completeHistoricalStoreSchema，既有 DB 不會重跑該版 → 欄位
    // 永遠不補、開機查排程即崩「no such column: interval_minutes」。interval_minutes 為 null
    // ＝維持舊的「每日 HH:MM 一次」；有值＝每 N 分鐘重複（用 last_run_at 這個 ISO 時間戳判定）。
    version: 8,
    name: "add-schedule-interval-columns",
    up: (db) => {
      addColumnIfMissing(db, "schedules", "interval_minutes INTEGER");
      addColumnIfMissing(db, "schedules", "last_run_at TEXT");
    },
  },
  {
    // 短命 worker（作戰室／研究員／專屬部門）的身分要能撐過重啟。原本只活在記憶體，
    // 所以「專屬部門」為了 department_missions.boss_worker_id 外鍵而把成員寫進 workers
    // 表之後，重啟就認不出它們是短命的——只能靠部門名稱前綴猜，使用者一改名就失效。
    // null＝一般 NPC；有值＝短命工，不還原成 NPC、也不佔滿編名額。
    version: 9,
    name: "add-worker-ephemeral-kind",
    up: (db) => addColumnIfMissing(db, "workers", "ephemeral_kind TEXT"),
  },
  {
    // 以工作區為 key 的資料表先前是「寫入存真實大小寫、查詢轉小寫（win32）」，於是在
    // Windows 上 exact-match 永遠撈不到——光磁碟機代號 C: 對 c: 就不同——部門任務日誌、
    // 交辦清單、Mission 清單全空。寫入端已改成一律存正規化形式，這裡把既有資料列轉過去。
    // 在非 win32 上正規化幾乎是恆等變換（僅收掉尾端分隔符之類），重跑也安全。
    version: 10,
    name: "normalize-workspace-path-keys",
    up: (db) => {
      for (const table of ["department_missions", "boss_tasks", "provider_checkpoints"]) {
        const rows = db
          .prepare(`SELECT DISTINCT workspace_path FROM ${table} WHERE workspace_path IS NOT NULL AND workspace_path != ''`)
          .all() as Array<{ workspace_path: unknown }>;
        const update = db.prepare(`UPDATE ${table} SET workspace_path = ? WHERE workspace_path = ?`);
        for (const row of rows) {
          const raw = String(row.workspace_path);
          const key = workspaceIdentity(raw);
          if (key !== raw) update.run(key, raw);
        }
      }
    },
  },
];
