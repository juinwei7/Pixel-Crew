import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RunnerEvent } from "./claudeRunner.js";
import type { CapabilityState } from "./capabilities.js";
import type { ProviderId } from "./providers/types.js";
import { type Persona, type PersonaTemplate, parsePersona, serializePersona } from "./persona.js";
import type { HandoffProgress } from "./handoff.js";
import type { AutoApproveMode } from "./dangerousCommand.js";
import { ensurePrivateDirectorySync, protectFileSync } from "./platform/fileProtection.js";

function normalizeAutoApproveMode(value: unknown): AutoApproveMode {
  return value === "safe" || value === "full" ? value : "off";
}

export type PersistedWorker = {
  id: string;
  name: string;
  model: string | null;
  colorIndex: number;
  avatarId: string | null;
  avatarKind: "preset" | "custom";
  avatarPresetId: string;
  provider: ProviderId;
  workspacePath: string;
  sessionId: string;
  completedTurns: number;
  persona: Persona | null;
  autoApproveMode: AutoApproveMode;
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
    ensurePrivateDirectorySync(directory);
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS workers (
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
        sort_order INTEGER,
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

      CREATE TABLE IF NOT EXISTS provider_usage_cache (
        provider TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS slash_command_seed (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        commands TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS provider_slash_command_seed (
        provider TEXT PRIMARY KEY CHECK (provider IN ('claude', 'codex')),
        commands TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      INSERT OR IGNORE INTO provider_slash_command_seed (provider, commands, updated_at)
      SELECT 'claude', commands, updated_at FROM slash_command_seed WHERE id = 1;

      CREATE TABLE IF NOT EXISTS persona_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS provider_handoffs (
        id TEXT PRIMARY KEY,
        worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
        from_provider TEXT NOT NULL,
        to_provider TEXT NOT NULL,
        to_model TEXT,
        status TEXT NOT NULL,
        source TEXT,
        summary_json TEXT,
        warning_acknowledged_at TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS provider_handoffs_worker_created
        ON provider_handoffs(worker_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS provider_checkpoints (
        worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        workspace_path TEXT,
        model TEXT,
        session_id TEXT NOT NULL,
        completed_turns INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (worker_id, provider)
      );

      CREATE TABLE IF NOT EXISTS meta_counters (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.db.exec(`
      UPDATE provider_handoffs
      SET status = 'failed', error = COALESCE(error, '伺服器重啟，交接已中止'), completed_at = CURRENT_TIMESTAMP
      WHERE status IN ('checking', 'summarizing', 'fallback', 'bootstrapping')
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
    try {
      this.db.exec("ALTER TABLE workers ADD COLUMN avatar_id TEXT");
    } catch {
      // Existing databases already migrated to avatar-aware workers.
    }
    try {
      this.db.exec("ALTER TABLE workers ADD COLUMN avatar_kind TEXT");
    } catch {
      // Existing databases already migrated to avatar source selection.
    }
    this.db.exec("UPDATE workers SET avatar_kind = CASE WHEN avatar_id IS NULL THEN 'preset' ELSE 'custom' END WHERE avatar_kind IS NULL");
    try {
      this.db.exec("ALTER TABLE workers ADD COLUMN avatar_preset_id TEXT NOT NULL DEFAULT 'classic'");
    } catch {
      // Existing databases already migrated to official avatar presets.
    }
    try {
      this.db.exec("ALTER TABLE workers ADD COLUMN persona TEXT");
    } catch {
      // Existing databases already migrated to persona-aware workers.
    }
    try {
      this.db.exec("ALTER TABLE provider_checkpoints ADD COLUMN workspace_path TEXT");
    } catch {
      // Existing databases already migrated to workspace-scoped checkpoints.
    }
    try {
      this.db.exec("ALTER TABLE workers ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0");
    } catch {
      // Existing databases already migrated to auto-approve-aware workers.
    }
    try {
      // Superseded by the three-state auto_approve_mode below (off/safe/full);
      // kept only as the source for the one-time backfill of it.
      this.db.exec("ALTER TABLE workers ADD COLUMN auto_approve_mode TEXT");
    } catch {
      // Existing databases already migrated to graded auto-approve modes.
    }
    this.db.exec("UPDATE workers SET auto_approve_mode = CASE WHEN auto_approve = 1 THEN 'safe' ELSE 'off' END WHERE auto_approve_mode IS NULL");
    try {
      this.db.exec("ALTER TABLE workers ADD COLUMN sort_order INTEGER");
    } catch {
      // Existing databases already migrated to user-ordered workers.
    }
    this.db.exec(`
      UPDATE workers SET sort_order = (
        SELECT COUNT(*) FROM workers w2
        WHERE w2.created_at < workers.created_at
          OR (w2.created_at = workers.created_at AND w2.rowid < workers.rowid)
      ) WHERE sort_order IS NULL
    `);
    this.restrictDatabasePermissions();
  }

  loadWorkers(maxHistory: number): PersistedWorker[] {
    const rows = this.db.prepare(`
      SELECT id, name, model, color_index, avatar_id, avatar_kind, avatar_preset_id, provider, workspace_path, claude_session_id, completed_turns, persona, auto_approve_mode
      FROM workers ORDER BY sort_order, created_at, rowid
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
        avatarId: row.avatar_id == null ? null : String(row.avatar_id),
        avatarKind: row.avatar_kind === "custom" && row.avatar_id != null ? "custom" : "preset",
        avatarPresetId: row.avatar_preset_id == null ? "classic" : String(row.avatar_preset_id),
        provider: row.provider === "codex" ? "codex" : "claude",
        workspacePath: row.workspace_path == null ? "" : String(row.workspace_path),
        sessionId: String(row.claude_session_id),
        completedTurns: Number(row.completed_turns),
        persona: parsePersona(row.persona),
        autoApproveMode: normalizeAutoApproveMode(row.auto_approve_mode),
        events,
      };
    });
  }

  saveWorker(worker: Omit<PersistedWorker, "events">): boolean {
    return this.safeWrite("save worker", () => {
      this.db.prepare(`
        INSERT INTO workers (
          id, name, model, color_index, avatar_id, avatar_kind, avatar_preset_id, provider, workspace_path, claude_session_id, completed_turns, persona, auto_approve_mode, sort_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM workers))
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          model = excluded.model,
          color_index = excluded.color_index,
          avatar_id = excluded.avatar_id,
          avatar_kind = excluded.avatar_kind,
          avatar_preset_id = excluded.avatar_preset_id,
          provider = excluded.provider,
          workspace_path = excluded.workspace_path,
          claude_session_id = excluded.claude_session_id,
          completed_turns = excluded.completed_turns,
          persona = excluded.persona,
          auto_approve_mode = excluded.auto_approve_mode,
          updated_at = CURRENT_TIMESTAMP
      `).run(
        worker.id,
        worker.name,
        worker.model,
        worker.colorIndex,
        worker.avatarId,
        worker.avatarKind,
        worker.avatarPresetId,
        worker.provider,
        worker.workspacePath,
        worker.sessionId,
        worker.completedTurns,
        serializePersona(worker.persona),
        worker.autoApproveMode,
      );
    });
  }

  saveWorkerOrder(ids: string[]): boolean {
    return this.safeWrite("save worker order", () => {
      const update = this.db.prepare(
        "UPDATE workers SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      );
      this.db.exec("BEGIN");
      try {
        ids.forEach((id, index) => update.run(index, id));
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
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

  getCounter(key: string): number {
    const row = this.db.prepare("SELECT value FROM meta_counters WHERE key = ?").get(key) as { value?: number } | undefined;
    return typeof row?.value === "number" ? row.value : 0;
  }

  incrementCounter(key: string, by = 1): number {
    this.db.prepare(`
      INSERT INTO meta_counters (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = value + excluded.value
    `).run(key, by);
    return this.getCounter(key);
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

  loadProviderUsage(provider: ProviderId): unknown | null {
    const row = this.db.prepare(
      "SELECT payload FROM provider_usage_cache WHERE provider = ?",
    ).get(provider) as { payload?: string } | undefined;
    if (!row?.payload) return null;
    try {
      return JSON.parse(row.payload);
    } catch {
      return null;
    }
  }

  saveProviderUsage(provider: ProviderId, payload: unknown): void {
    this.safeWrite("save provider usage", () => {
      this.db.prepare(`
        INSERT INTO provider_usage_cache (provider, payload, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(provider) DO UPDATE SET
          payload = excluded.payload,
          updated_at = CURRENT_TIMESTAMP
      `).run(provider, JSON.stringify(payload));
    });
  }

  /** Provider-scoped portable command seeds. Workspace commands never belong here. */
  loadSlashCommandSeed(provider: ProviderId = "claude"): string[] {
    const row = this.db.prepare(
      "SELECT commands FROM provider_slash_command_seed WHERE provider = ?",
    ).get(provider) as { commands?: string } | undefined;
    if (!row?.commands) return [];
    try {
      const parsed = JSON.parse(row.commands);
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
    } catch {
      return [];
    }
  }

  saveSlashCommandSeed(commands: string[], provider: ProviderId = "claude"): void {
    this.safeWrite("save slash command seed", () => {
      this.db.prepare(`
        INSERT INTO provider_slash_command_seed (provider, commands, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(provider) DO UPDATE SET
          commands = excluded.commands,
          updated_at = CURRENT_TIMESTAMP
      `).run(provider, JSON.stringify(commands));
    });
  }

  listPersonaTemplates(): PersonaTemplate[] {
    const rows = this.db.prepare(
      "SELECT id, name, role, instructions FROM persona_templates ORDER BY updated_at DESC, rowid DESC",
    ).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      role: row.role == null ? "" : String(row.role),
      instructions: row.instructions == null ? "" : String(row.instructions),
    }));
  }

  savePersonaTemplate(template: PersonaTemplate): boolean {
    return this.safeWrite("save persona template", () => {
      this.db.prepare(`
        INSERT INTO persona_templates (id, name, role, instructions, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          role = excluded.role,
          instructions = excluded.instructions,
          updated_at = CURRENT_TIMESTAMP
      `).run(template.id, template.name, template.role, template.instructions);
    });
  }

  deletePersonaTemplate(id: string): void {
    this.safeWrite("delete persona template", () => {
      this.db.prepare("DELETE FROM persona_templates WHERE id = ?").run(id);
    });
  }

  saveProviderHandoff(workerId: string, progress: HandoffProgress, summary: unknown = null): boolean {
    return this.safeWrite("save provider handoff", () => {
      const terminal = progress.stage === "completed" || progress.stage === "failed";
      this.db.prepare(`
        INSERT INTO provider_handoffs (
          id, worker_id, from_provider, to_provider, to_model, status, source,
          summary_json, warning_acknowledged_at, error, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          source = excluded.source,
          summary_json = COALESCE(excluded.summary_json, provider_handoffs.summary_json),
          error = excluded.error,
          completed_at = excluded.completed_at
      `).run(
        progress.id,
        workerId,
        progress.fromProvider,
        progress.toProvider,
        progress.toModel,
        progress.stage,
        progress.source,
        summary == null ? null : JSON.stringify(summary),
        progress.error,
        terminal ? new Date().toISOString() : null,
      );
    });
  }

  listProviderHandoffs(workerId: string, limit = 20): Array<Record<string, unknown>> {
    return this.db.prepare(`
      SELECT id, from_provider, to_provider, to_model, status, source, summary_json, error, created_at, completed_at
      FROM provider_handoffs WHERE worker_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(workerId, Math.max(1, Math.min(100, limit))) as Array<Record<string, unknown>>;
  }

  loadLatestFailedHandoff(workerId: string): HandoffProgress | null {
    const row = this.db.prepare(`
      SELECT id, from_provider, to_provider, to_model, status, source, error
      FROM provider_handoffs WHERE worker_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(workerId) as Record<string, unknown> | undefined;
    if (!row || row.status !== "failed") return null;
    return {
      id: String(row.id),
      fromProvider: row.from_provider === "codex" ? "codex" : "claude",
      toProvider: row.to_provider === "codex" ? "codex" : "claude",
      toModel: row.to_model == null ? null : String(row.to_model),
      stage: "failed",
      message: "上次 LLM 交接未完成，已保留原本的工作階段",
      source: row.source === "agent" ? "agent" : row.source === "local_fallback" ? "local_fallback" : null,
      error: row.error == null ? "交接未完成" : String(row.error),
    };
  }

  saveProviderCheckpoint(workerId: string, provider: ProviderId, workspacePath: string, model: string | null, state: { sessionId: string; completedTurns: number }): boolean {
    return this.safeWrite("save provider checkpoint", () => {
      this.db.prepare(`
        INSERT INTO provider_checkpoints (worker_id, provider, workspace_path, model, session_id, completed_turns, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(worker_id, provider) DO UPDATE SET
          workspace_path = excluded.workspace_path,
          model = excluded.model,
          session_id = excluded.session_id,
          completed_turns = excluded.completed_turns,
          updated_at = CURRENT_TIMESTAMP
      `).run(workerId, provider, workspacePath, model, state.sessionId, state.completedTurns);
    });
  }

  loadProviderCheckpoint(workerId: string, provider: ProviderId, workspacePath: string): { model: string | null; sessionId: string; completedTurns: number } | null {
    const row = this.db.prepare(`
      SELECT model, session_id, completed_turns FROM provider_checkpoints
      WHERE worker_id = ? AND provider = ? AND workspace_path = ?
    `).get(workerId, provider, workspacePath) as Record<string, unknown> | undefined;
    return row ? {
      model: row.model == null ? null : String(row.model),
      sessionId: String(row.session_id),
      completedTurns: Number(row.completed_turns),
    } : null;
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

  private safeWrite(operation: string, write: () => void): boolean {
    try {
      write();
      this.restrictDatabasePermissions();
      return true;
    } catch (err) {
      console.warn(`SQLite ${operation} failed:`, (err as Error).message);
      return false;
    }
  }

  private restrictDatabasePermissions(): void {
    for (const file of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      try {
        protectFileSync(file);
      } catch {
        // WAL/SHM are created lazily and may not exist yet.
      }
    }
  }

  close(): void {
    this.flushEvents();
    this.db.close();
  }
}
