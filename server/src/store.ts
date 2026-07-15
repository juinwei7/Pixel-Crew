import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RunnerEvent } from "./claudeRunner.js";
import type { CapabilityState } from "./capabilities.js";
import type { ProviderId } from "./providers/types.js";

export type PersistedWorker = {
  id: string;
  name: string;
  model: string | null;
  colorIndex: number;
  provider: ProviderId;
  workspacePath: string;
  sessionId: string;
  completedTurns: number;
  events: RunnerEvent[];
};

export class LocalStore {
  private readonly db: DatabaseSync;
  private readonly path: string;
  private pendingEvents: Array<{
    workerId: string;
    event: RunnerEvent;
    maxHistory: number;
  }> = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(path: string) {
    this.path = path;
    const directory = dirname(path);
    const createdDirectory = !existsSync(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (createdDirectory) chmodSync(directory, 0o700);
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS workers (
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

      CREATE TABLE IF NOT EXISTS runner_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS runner_events_worker_seq
        ON runner_events(worker_id, seq);

      CREATE TABLE IF NOT EXISTS capability_cache (
        repo_path TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    try {
      this.db.exec("ALTER TABLE workers ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'");
    } catch {
      // Existing databases already migrated to the provider-aware schema.
    }
    try {
      this.db.exec("ALTER TABLE workers ADD COLUMN workspace_path TEXT");
    } catch {
      // Existing databases already migrated to workspace-aware workers.
    }
    this.restrictDatabasePermissions();
  }

  loadWorkers(maxHistory: number): PersistedWorker[] {
    const rows = this.db.prepare(`
      SELECT id, name, model, color_index, provider, workspace_path, claude_session_id, completed_turns
      FROM workers ORDER BY created_at, rowid
    `).all() as Array<Record<string, unknown>>;
    const eventQuery = this.db.prepare(`
      SELECT payload FROM runner_events
      WHERE worker_id = ? ORDER BY seq DESC LIMIT ?
    `);
    return rows.map((row) => {
      const eventRows = eventQuery.all(String(row.id), maxHistory) as Array<{ payload: string }>;
      const events = eventRows.reverse().flatMap((eventRow) => {
        try {
          return [JSON.parse(eventRow.payload) as RunnerEvent];
        } catch {
          return [];
        }
      });
      return {
        id: String(row.id),
        name: String(row.name),
        model: row.model == null ? null : String(row.model),
        colorIndex: Number(row.color_index),
        provider: row.provider === "codex" ? "codex" : "claude",
        workspacePath: row.workspace_path == null ? "" : String(row.workspace_path),
        sessionId: String(row.claude_session_id),
        completedTurns: Number(row.completed_turns),
        events,
      };
    });
  }

  saveWorker(worker: Omit<PersistedWorker, "events">): void {
    this.safeWrite("save worker", () => {
      this.db.prepare(`
        INSERT INTO workers (
          id, name, model, color_index, provider, workspace_path, claude_session_id, completed_turns
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          model = excluded.model,
          color_index = excluded.color_index,
          provider = excluded.provider,
          workspace_path = excluded.workspace_path,
          claude_session_id = excluded.claude_session_id,
          completed_turns = excluded.completed_turns,
          updated_at = CURRENT_TIMESTAMP
      `).run(
        worker.id,
        worker.name,
        worker.model,
        worker.colorIndex,
        worker.provider,
        worker.workspacePath,
        worker.sessionId,
        worker.completedTurns,
      );
    });
  }

  deleteWorker(id: string): void {
    this.flushEvents();
    this.safeWrite("delete worker", () => {
      this.db.prepare("DELETE FROM workers WHERE id = ?").run(id);
    });
  }

  clearWorkerEvents(id: string): void {
    this.flushEvents();
    this.safeWrite("clear worker events", () => {
      this.db.prepare("DELETE FROM runner_events WHERE worker_id = ?").run(id);
    });
  }

  appendEvent(workerId: string, event: RunnerEvent, maxHistory: number): void {
    this.pendingEvents.push({ workerId, event, maxHistory });
    if (event.type === "user_message" || event.type === "turn_end" || event.type === "error") {
      this.flushEvents();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushEvents(), 150);
      this.flushTimer.unref();
    }
  }

  loadCapabilities(repoPath: string): CapabilityState | null {
    const row = this.db.prepare(
      "SELECT payload FROM capability_cache WHERE repo_path = ?",
    ).get(repoPath) as { payload?: string } | undefined;
    if (!row?.payload) return null;
    try {
      return JSON.parse(row.payload) as CapabilityState;
    } catch {
      return null;
    }
  }

  saveCapabilities(repoPath: string, state: CapabilityState): void {
    this.safeWrite("save capabilities", () => {
      this.db.prepare(`
        INSERT INTO capability_cache (repo_path, payload, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(repo_path) DO UPDATE SET
          payload = excluded.payload,
          updated_at = CURRENT_TIMESTAMP
      `).run(repoPath, JSON.stringify(state));
    });
  }

  private flushEvents(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pendingEvents.length === 0) return;
    const batch = this.pendingEvents.splice(0);
    this.safeWrite("flush events", () => {
      const insert = this.db.prepare(
        "INSERT INTO runner_events (worker_id, payload) VALUES (?, ?)",
      );
      const limits = new Map<string, number>();
      this.db.exec("BEGIN");
      try {
        for (const item of batch) {
          insert.run(item.workerId, JSON.stringify(item.event));
          limits.set(item.workerId, item.maxHistory);
        }
        const prune = this.db.prepare(`
          DELETE FROM runner_events
          WHERE worker_id = ? AND seq NOT IN (
            SELECT seq FROM runner_events
            WHERE worker_id = ? ORDER BY seq DESC LIMIT ?
          )
        `);
        for (const [workerId, maxHistory] of limits) {
          prune.run(workerId, workerId, maxHistory);
        }
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    });
  }

  private safeWrite(operation: string, write: () => void): void {
    try {
      write();
      this.restrictDatabasePermissions();
    } catch (err) {
      console.warn(`SQLite ${operation} failed:`, (err as Error).message);
    }
  }

  private restrictDatabasePermissions(): void {
    for (const file of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      try {
        chmodSync(file, 0o600);
      } catch {
        // WAL/SHM are created lazily and may not exist yet.
      }
    }
  }
}
