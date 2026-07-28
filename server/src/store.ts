import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RunnerEvent } from "./claudeRunner.js";
import type { CapabilityState } from "./capabilities.js";
import type { ProviderId } from "./providers/types.js";
import { type Persona, type PersonaTemplate, parsePersona, serializePersona } from "./persona.js";
import type { HandoffProgress } from "./handoff.js";
import type { AutoApproveMode } from "./dangerousCommand.js";
import type { CollaborationTask } from "./collaboration.js";
import type { DepartmentMission } from "./mission.js";
import type { BossTask, BossTaskStatus } from "./bossTask.js";
import { legacyDepartmentName, type Department } from "./department.js";
import type { AttachmentRecord } from "./attachmentRepository.js";
import type { DepartmentMessage, DepartmentThread } from "./departmentThread.js";
import { ensurePrivateDirectorySync, protectFileSync } from "./platform/fileProtection.js";

function normalizeAutoApproveMode(value: unknown): AutoApproveMode {
  return value === "safe" || value === "full" ? value : "off";
}

function jsonValue<T>(value: unknown, fallback: T): T {
  try { return value == null ? fallback : JSON.parse(String(value)) as T; } catch { return fallback; }
}

function collaborationFromRow(row: Record<string, unknown>): CollaborationTask {
  return {
    id: String(row.id),
    sourceWorkerId: String(row.source_worker_id),
    targetWorkerId: String(row.target_worker_id),
    workspacePath: String(row.workspace_path),
    mode: row.mode === "review" ? "review" : "consult",
    objective: String(row.objective),
    acceptanceCriteria: jsonValue<string[]>(row.acceptance_criteria_json, []),
    status: ["queued", "running", "returning", "completed", "failed", "cancelled"].includes(String(row.status))
      ? row.status as CollaborationTask["status"] : "failed",
    sourceContext: jsonValue<Record<string, unknown>>(row.source_context_json, {}),
    baseCommit: row.base_commit == null ? null : String(row.base_commit),
    result: jsonValue<CollaborationTask["result"]>(row.result_json, null),
    continuationResult: row.continuation_result == null ? null : String(row.continuation_result),
    error: row.error == null ? null : String(row.error),
    createdAt: String(row.created_at),
    startedAt: row.started_at == null ? null : String(row.started_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
    adoptedAt: row.adopted_at == null ? null : String(row.adopted_at),
    handledAt: row.handled_at == null ? null : String(row.handled_at),
  };
}

function missionFromRow(row: Record<string, unknown>): DepartmentMission {
  const status = String(row.status);
  const normalizedStatus = ["planning", "executing", "reviewing", "needs_attention", "completed", "failed", "cancelled"].includes(status)
    ? status as DepartmentMission["status"] : "failed";
  const storedSteps = jsonValue<DepartmentMission["steps"]>(row.steps_json, []);
  const steps = normalizedStatus === "failed"
    ? storedSteps.map((step) => step.status === "running" ? { ...step, status: "failed" as const } : step)
    : storedSteps;
  return {
    id: String(row.id),
    departmentId: row.department_id == null ? null : String(row.department_id),
    workspacePath: String(row.workspace_path),
    bossWorkerId: String(row.boss_worker_id),
    objective: String(row.objective),
    acceptanceCriteria: jsonValue<string[]>(row.acceptance_criteria_json, []),
    attachmentIds: jsonValue<string[]>(row.attachment_ids_json, []),
    parentMissionId: row.parent_mission_id == null ? null : String(row.parent_mission_id),
    sourceMessageId: row.source_message_id == null ? null : String(row.source_message_id),
    executionMode: row.execution_mode === "research" ? "research" : "project",
    origin: row.mission_origin === "boss" ? "boss" : "department",
    status: normalizedStatus,
    planSummary: row.plan_summary == null ? null : String(row.plan_summary),
    steps,
    currentStepIndex: row.current_step_index == null ? null : Number(row.current_step_index),
    correctionCount: Number(row.correction_count ?? 0),
    maxCorrections: Number(row.max_corrections ?? 2),
    error: row.error == null ? null : String(row.error),
    createdAt: String(row.created_at),
    startedAt: row.started_at == null ? null : String(row.started_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
    attentionReason: row.attention_reason == null ? null : String(row.attention_reason) as DepartmentMission["attentionReason"],
    planApprovedAt: row.plan_approved_at == null ? null : String(row.plan_approved_at),
    ownerGuidance: row.owner_guidance == null ? null : String(row.owner_guidance),
    formatRepairCount: Number(row.format_repair_count ?? 0),
    delegatedSessions: jsonValue<DepartmentMission["delegatedSessions"]>(row.delegated_sessions_json, []),
    executionEvents: jsonValue<DepartmentMission["executionEvents"]>(row.execution_events_json, []),
  };
}

function bossTaskFromRow(row: Record<string, unknown>): BossTask {
  const task = jsonValue<BossTask>(row.payload_json, null as unknown as BossTask);
  return {
    ...task,
    title: typeof task.title === "string" && task.title.trim() ? task.title.trim().slice(0, 120) : task.objective.slice(0, 120),
    archivedAt: typeof task.archivedAt === "string"
      ? task.archivedAt
      : row.archived_at == null ? null : String(row.archived_at),
  };
}

function departmentThreadFromRow(row: Record<string, unknown>): DepartmentThread {
  return {
    id: String(row.id),
    departmentId: String(row.department_id),
    activeMissionId: row.active_mission_id == null ? null : String(row.active_mission_id),
    summary: String(row.summary ?? ""),
    historyClearedAt: row.history_cleared_at == null ? null : String(row.history_cleared_at),
    lastMessageAt: String(row.last_message_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function departmentMessageFromRow(row: Record<string, unknown>): DepartmentMessage {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    role: String(row.role) as DepartmentMessage["role"],
    intent: String(row.intent) as DepartmentMessage["intent"],
    text: String(row.text ?? ""),
    attachmentIds: jsonValue<string[]>(row.attachment_ids_json, []),
    missionId: row.mission_id == null ? null : String(row.mission_id),
    deliveryStatus: String(row.delivery_status) as DepartmentMessage["deliveryStatus"],
    clientMessageId: row.client_message_id == null ? null : String(row.client_message_id),
    idempotencyKey: row.idempotency_key == null ? null : String(row.idempotency_key),
    classification: jsonValue<DepartmentMessage["classification"]>(row.classification_json, null),
    createdAt: String(row.created_at),
  };
}

function attachmentFromRow(row: Record<string, unknown>): AttachmentRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    mimeType: String(row.mime_type),
    size: Number(row.size),
    checksum: String(row.checksum),
    storageKey: String(row.storage_key),
    kind: row.kind === "image" ? "image" : "document",
    createdAt: String(row.created_at),
  };
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
  departmentId: string | null;
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

      CREATE TABLE IF NOT EXISTS departments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        purpose TEXT NOT NULL DEFAULT '',
        workspace_path TEXT NOT NULL,
        lead_worker_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS departments_workspace
        ON departments(workspace_path, created_at);

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

      CREATE TABLE IF NOT EXISTS collaboration_tasks (
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

      CREATE INDEX IF NOT EXISTS collaboration_tasks_source_created
        ON collaboration_tasks(source_worker_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS collaboration_tasks_target_created
        ON collaboration_tasks(target_worker_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS department_missions (
        id TEXT PRIMARY KEY,
        department_id TEXT,
        workspace_path TEXT NOT NULL,
        boss_worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
        objective TEXT NOT NULL,
        acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK (status IN ('planning', 'executing', 'reviewing', 'needs_attention', 'completed', 'failed', 'cancelled')),
        plan_summary TEXT,
        steps_json TEXT NOT NULL DEFAULT '[]',
        current_step_index INTEGER,
        correction_count INTEGER NOT NULL DEFAULT 0,
        max_corrections INTEGER NOT NULL DEFAULT 2,
        execution_mode TEXT NOT NULL DEFAULT 'project',
        mission_origin TEXT NOT NULL DEFAULT 'department',
        error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS department_missions_workspace_created
        ON department_missions(workspace_path, created_at DESC);

      CREATE TABLE IF NOT EXISTS boss_tasks (
        id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT,
        archived_at TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS boss_tasks_workspace_updated
        ON boss_tasks(workspace_path, updated_at DESC);

      CREATE TABLE IF NOT EXISTS department_threads (
        id TEXT PRIMARY KEY,
        department_id TEXT NOT NULL UNIQUE REFERENCES departments(id) ON DELETE CASCADE,
        active_mission_id TEXT,
        summary TEXT NOT NULL DEFAULT '',
        history_cleared_at TEXT,
        last_message_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS department_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES department_threads(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('owner', 'department', 'system', 'report')),
        intent TEXT NOT NULL CHECK (intent IN ('question', 'context', 'mission_update', 'follow_up_mission', 'approval', 'decision', 'system')),
        text TEXT NOT NULL DEFAULT '',
        attachment_ids_json TEXT NOT NULL DEFAULT '[]',
        mission_id TEXT,
        delivery_status TEXT NOT NULL CHECK (delivery_status IN ('pending', 'delivered', 'failed')),
        client_message_id TEXT,
        idempotency_key TEXT UNIQUE,
        classification_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS department_messages_thread_created
        ON department_messages(thread_id, created_at);

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        checksum TEXT NOT NULL UNIQUE,
        storage_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('image', 'document')),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS attachment_deliveries (
        attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
        mission_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
        error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (attachment_id, mission_id, worker_id)
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        department_id TEXT,
        mission_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS audit_events_department_created
        ON audit_events(department_id, created_at DESC);

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
    this.migrateCollaborationTasks();
    this.db.exec(`
      UPDATE provider_handoffs
      SET status = 'failed', error = COALESCE(error, '伺服器重啟，交接已中止'), completed_at = CURRENT_TIMESTAMP
      WHERE status IN ('checking', 'summarizing', 'fallback', 'bootstrapping')
    `);
    this.db.exec(`
      UPDATE collaboration_tasks
      SET status = 'failed', error = COALESCE(error, '伺服器重啟，NPC 協作已中止'), completed_at = CURRENT_TIMESTAMP
      WHERE status IN ('queued', 'running', 'returning')
    `);
    this.db.exec(`
      UPDATE department_missions
      SET status = 'failed', error = COALESCE(error, '伺服器重啟，Department Mission 已中止'), completed_at = CURRENT_TIMESTAMP
      WHERE status IN ('planning', 'executing', 'reviewing')
    `);
    try {
      this.db.exec("ALTER TABLE department_missions ADD COLUMN attention_reason TEXT");
    } catch {
      // Existing databases already migrated to owner-controlled Mission attention.
    }
    try {
      this.db.exec("ALTER TABLE boss_tasks ADD COLUMN title TEXT");
    } catch {
      // Existing databases already migrated to editable Boss task titles.
    }
    try {
      this.db.exec("ALTER TABLE boss_tasks ADD COLUMN archived_at TEXT");
    } catch {
      // Existing databases already migrated to archivable Boss task records.
    }
    try {
      this.db.exec("ALTER TABLE department_missions ADD COLUMN department_id TEXT");
    } catch {
      // Existing databases already migrated to explicit Mission departments.
    }
    try {
      this.db.exec("ALTER TABLE department_missions ADD COLUMN plan_approved_at TEXT");
    } catch {
      // Existing databases already migrated to explicit plan approval.
    }
    try {
      this.db.exec("ALTER TABLE department_missions ADD COLUMN owner_guidance TEXT");
    } catch {
      // Existing databases already migrated to owner guidance.
    }
    try {
      this.db.exec("ALTER TABLE department_missions ADD COLUMN format_repair_count INTEGER NOT NULL DEFAULT 0");
    } catch {
      // Existing databases already migrated to bounded format repair.
    }
    try {
      this.db.exec("ALTER TABLE department_missions ADD COLUMN attachment_ids_json TEXT NOT NULL DEFAULT '[]'");
    } catch {
      // Existing databases already migrated to persistent Mission attachments.
    }
    try {
      this.db.exec("ALTER TABLE department_missions ADD COLUMN parent_mission_id TEXT");
    } catch {
      // Existing databases already migrated to auditable follow-up Missions.
    }
    try {
      this.db.exec("ALTER TABLE department_missions ADD COLUMN source_message_id TEXT");
    } catch {
      // Existing databases already migrated to thread-linked Missions.
    }
    try {
      this.db.exec("ALTER TABLE department_missions ADD COLUMN delegated_sessions_json TEXT NOT NULL DEFAULT '[]'");
    } catch {
      // Existing databases already migrated to task-owned provider sessions.
    }
    try {
      this.db.exec("ALTER TABLE department_missions ADD COLUMN execution_events_json TEXT NOT NULL DEFAULT '[]'");
    } catch {
      // Existing databases already migrated to Mission-owned runner activity.
    }
    try {
      this.db.exec("ALTER TABLE department_missions ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'project'");
    } catch {
      // Existing databases already migrated to bounded research/project execution.
    }
    try {
      this.db.exec("ALTER TABLE department_missions ADD COLUMN mission_origin TEXT NOT NULL DEFAULT 'department'");
    } catch {
      // Existing databases already migrated to explicit Boss/department ownership.
    }
    try {
      this.db.exec("ALTER TABLE department_threads ADD COLUMN history_cleared_at TEXT");
    } catch {
      // Existing databases already migrated to resettable visible department history.
    }
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
    try {
      this.db.exec("ALTER TABLE workers ADD COLUMN department_id TEXT");
    } catch {
      // Existing databases already migrated to explicit departments.
    }
    this.db.exec(`
      INSERT INTO departments (id, name, purpose, workspace_path, lead_worker_id)
      SELECT 'legacy-' || lower(hex(randomblob(16))), workspace_path,
             '從既有工作位置自動建立', workspace_path,
             (SELECT w2.id FROM workers w2 WHERE w2.workspace_path = workers.workspace_path ORDER BY w2.sort_order, w2.created_at LIMIT 1)
      FROM workers
      WHERE workspace_path IS NOT NULL AND workspace_path != '' AND department_id IS NULL
      GROUP BY workspace_path
    `);
    this.db.exec(`
      UPDATE workers
      SET department_id = (
        SELECT departments.id FROM departments
        WHERE departments.workspace_path = workers.workspace_path
        ORDER BY departments.created_at LIMIT 1
      )
      WHERE department_id IS NULL
    `);
    const legacyDepartments = this.db.prepare(`
      SELECT id, name, workspace_path FROM departments
      WHERE id LIKE 'legacy-%'
    `).all() as Array<{ id: string; name: string; workspace_path: string }>;
    const renameLegacyDepartment = this.db.prepare("UPDATE departments SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
    for (const department of legacyDepartments) {
      if (department.name !== department.workspace_path) continue;
      renameLegacyDepartment.run(legacyDepartmentName(department.workspace_path), department.id);
    }
    this.restrictDatabasePermissions();
  }

  loadWorkers(maxHistory: number): PersistedWorker[] {
    const rows = this.db.prepare(`
      SELECT id, name, model, color_index, avatar_id, avatar_kind, avatar_preset_id, provider, workspace_path, claude_session_id, completed_turns, persona, auto_approve_mode, department_id
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
        departmentId: row.department_id == null ? null : String(row.department_id),
      };
    });
  }

  saveWorker(worker: Omit<PersistedWorker, "events">): boolean {
    return this.safeWrite("save worker", () => {
      this.db.prepare(`
        INSERT INTO workers (
          id, name, model, color_index, avatar_id, avatar_kind, avatar_preset_id, provider, workspace_path, claude_session_id, completed_turns, persona, auto_approve_mode, department_id, sort_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM workers))
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
          department_id = excluded.department_id,
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
        worker.departmentId ?? null,
      );
    });
  }

  listDepartments(): Department[] {
    const rows = this.db.prepare("SELECT * FROM departments ORDER BY created_at, rowid").all() as Record<string, unknown>[];
    const members = this.db.prepare("SELECT id FROM workers WHERE department_id = ? ORDER BY sort_order, created_at");
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      purpose: String(row.purpose ?? ""),
      workspacePath: String(row.workspace_path),
      leadWorkerId: String(row.lead_worker_id),
      memberWorkerIds: (members.all(String(row.id)) as Array<{ id: string }>).map((member) => String(member.id)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  saveDepartment(department: Department): boolean {
    return this.safeWrite("save department", () => {
      this.db.prepare(`
        INSERT INTO departments (id, name, purpose, workspace_path, lead_worker_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          purpose = excluded.purpose,
          workspace_path = excluded.workspace_path,
          lead_worker_id = excluded.lead_worker_id,
          updated_at = excluded.updated_at
      `).run(department.id, department.name, department.purpose, department.workspacePath,
        department.leadWorkerId, department.createdAt, department.updatedAt);
    });
  }

  getDepartmentThread(departmentId: string): DepartmentThread | null {
    const row = this.db.prepare("SELECT * FROM department_threads WHERE department_id = ?").get(departmentId) as Record<string, unknown> | undefined;
    return row ? departmentThreadFromRow(row) : null;
  }

  saveDepartmentThread(thread: DepartmentThread): boolean {
    return this.safeWrite("save department thread", () => {
      this.db.prepare(`
        INSERT INTO department_threads (id, department_id, active_mission_id, summary, history_cleared_at, last_message_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(department_id) DO UPDATE SET
          active_mission_id = excluded.active_mission_id,
          summary = excluded.summary,
          history_cleared_at = excluded.history_cleared_at,
          last_message_at = excluded.last_message_at,
          updated_at = excluded.updated_at
      `).run(thread.id, thread.departmentId, thread.activeMissionId, thread.summary, thread.historyClearedAt, thread.lastMessageAt, thread.createdAt, thread.updatedAt);
    });
  }

  listDepartmentMessages(threadId: string, limit = 200): DepartmentMessage[] {
    const bounded = Math.max(1, Math.min(500, limit));
    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT rowid AS _rowid, * FROM department_messages WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
      ) ORDER BY created_at, _rowid
    `).all(threadId, bounded) as Record<string, unknown>[];
    return rows.map(departmentMessageFromRow);
  }

  getDepartmentMessageByIdempotency(idempotencyKey: string): DepartmentMessage | null {
    if (!idempotencyKey) return null;
    const row = this.db.prepare("SELECT * FROM department_messages WHERE idempotency_key = ?").get(idempotencyKey) as Record<string, unknown> | undefined;
    return row ? departmentMessageFromRow(row) : null;
  }

  saveDepartmentMessage(message: DepartmentMessage): boolean {
    return this.safeWrite("save department message", () => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare(`
          INSERT INTO department_messages (
            id, thread_id, role, intent, text, attachment_ids_json, mission_id,
            delivery_status, client_message_id, idempotency_key, classification_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          message.id, message.threadId, message.role, message.intent, message.text,
          JSON.stringify(message.attachmentIds), message.missionId, message.deliveryStatus,
          message.clientMessageId, message.idempotencyKey, message.classification ? JSON.stringify(message.classification) : null,
          message.createdAt,
        );
        this.db.prepare("UPDATE department_threads SET last_message_at = ?, updated_at = ? WHERE id = ?")
          .run(message.createdAt, message.createdAt, message.threadId);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  updateDepartmentMessageMission(messageId: string, missionId: string | null, deliveryStatus: DepartmentMessage["deliveryStatus"] = "delivered"): boolean {
    return this.safeWrite("link department message mission", () => {
      this.db.prepare(`
        UPDATE department_messages
        SET mission_id = ?, delivery_status = ?
        WHERE id = ?
      `).run(missionId, deliveryStatus, messageId);
    });
  }

  saveAttachment(attachment: AttachmentRecord): boolean {
    return this.safeWrite("save attachment", () => {
      this.db.prepare(`
        INSERT OR IGNORE INTO attachments (id, name, mime_type, size, checksum, storage_key, kind, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(attachment.id, attachment.name, attachment.mimeType, attachment.size, attachment.checksum, attachment.storageKey, attachment.kind, attachment.createdAt);
    });
  }

  getAttachment(id: string): AttachmentRecord | null {
    const row = this.db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? attachmentFromRow(row) : null;
  }

  getAttachmentByChecksum(checksum: string): AttachmentRecord | null {
    const row = this.db.prepare("SELECT * FROM attachments WHERE checksum = ?").get(checksum) as Record<string, unknown> | undefined;
    return row ? attachmentFromRow(row) : null;
  }

  saveAttachmentDelivery(attachmentId: string, missionId: string, workerId: string, status: "pending" | "delivered" | "failed", error: string | null = null): boolean {
    return this.safeWrite("save attachment delivery", () => {
      this.db.prepare(`
        INSERT INTO attachment_deliveries (attachment_id, mission_id, worker_id, status, error, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(attachment_id, mission_id, worker_id) DO UPDATE SET
          status = excluded.status, error = excluded.error, updated_at = excluded.updated_at
      `).run(attachmentId, missionId, workerId, status, error, new Date().toISOString());
    });
  }

  saveAuditEvent(event: { id: string; departmentId?: string | null; missionId?: string | null; type: string; payload?: unknown; createdAt: string }): boolean {
    return this.safeWrite("save audit event", () => {
      this.db.prepare(`
        INSERT INTO audit_events (id, department_id, mission_id, event_type, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(event.id, event.departmentId ?? null, event.missionId ?? null, event.type, JSON.stringify(event.payload ?? {}), event.createdAt);
    });
  }

  listAuditEvents(departmentId: string, limit = 200): Array<{ id: string; departmentId: string | null; missionId: string | null; type: string; payload: unknown; createdAt: string }> {
    const rows = this.db.prepare(`
      SELECT * FROM audit_events WHERE department_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(departmentId, Math.max(1, Math.min(500, limit))) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      departmentId: row.department_id == null ? null : String(row.department_id),
      missionId: row.mission_id == null ? null : String(row.mission_id),
      type: String(row.event_type),
      payload: jsonValue(row.payload_json, {}),
      createdAt: String(row.created_at),
    }));
  }

  deleteDepartment(id: string): boolean {
    return this.safeWrite("delete department", () => {
      this.db.prepare("DELETE FROM departments WHERE id = ?").run(id);
    });
  }

  saveDepartmentWithWorkers(
    department: Department,
    members: Array<Omit<PersistedWorker, "events">>,
  ): boolean {
    return this.safeWrite("save department batch", () => {
      const insertDepartment = this.db.prepare(`
        INSERT INTO departments (id, name, purpose, workspace_path, lead_worker_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const insertWorker = this.db.prepare(`
        INSERT INTO workers (
          id, name, model, color_index, avatar_id, avatar_kind, avatar_preset_id,
          provider, workspace_path, claude_session_id, completed_turns, persona,
          auto_approve_mode, department_id, sort_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM workers))
      `);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        insertDepartment.run(
          department.id, department.name, department.purpose, department.workspacePath,
          department.leadWorkerId, department.createdAt, department.updatedAt,
        );
        for (const worker of members) {
          insertWorker.run(
            worker.id, worker.name, worker.model, worker.colorIndex, worker.avatarId,
            worker.avatarKind, worker.avatarPresetId, worker.provider, worker.workspacePath,
            worker.sessionId, worker.completedTurns, serializePersona(worker.persona),
            worker.autoApproveMode, department.id,
          );
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
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

  saveCollaborationTask(task: CollaborationTask): boolean {
    return this.safeWrite("save collaboration task", () => {
      this.db.prepare(`
        INSERT INTO collaboration_tasks (
          id, source_worker_id, target_worker_id, workspace_path, mode, objective,
          acceptance_criteria_json, status, source_context_json, base_commit,
          result_json, continuation_result, error, created_at, started_at, completed_at, adopted_at, handled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          result_json = excluded.result_json,
          continuation_result = excluded.continuation_result,
          error = excluded.error,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          adopted_at = excluded.adopted_at,
          handled_at = excluded.handled_at
      `).run(
        task.id, task.sourceWorkerId, task.targetWorkerId, task.workspacePath, task.mode, task.objective,
        JSON.stringify(task.acceptanceCriteria), task.status, JSON.stringify(task.sourceContext), task.baseCommit,
        task.result == null ? null : JSON.stringify(task.result), task.continuationResult, task.error, task.createdAt, task.startedAt,
        task.completedAt, task.adoptedAt, task.handledAt,
      );
    });
  }

  getCollaborationTask(id: string): CollaborationTask | null {
    const row = this.db.prepare("SELECT * FROM collaboration_tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? collaborationFromRow(row) : null;
  }

  listCollaborationTasks(workerId: string, limit = 50): CollaborationTask[] {
    const rows = this.db.prepare(`
      SELECT * FROM collaboration_tasks
      WHERE source_worker_id = ? OR target_worker_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(workerId, workerId, Math.max(1, Math.min(100, limit))) as Record<string, unknown>[];
    return rows.map(collaborationFromRow);
  }

  listActiveCollaborationTasks(): CollaborationTask[] {
    const rows = this.db.prepare(`
      SELECT * FROM collaboration_tasks WHERE status IN ('queued', 'running', 'returning') ORDER BY created_at
    `).all() as Record<string, unknown>[];
    return rows.map(collaborationFromRow);
  }

  listRecentCollaborationTasks(limit = 100): CollaborationTask[] {
    const rows = this.db.prepare(`
      SELECT * FROM collaboration_tasks
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(Math.max(1, Math.min(200, limit))) as Record<string, unknown>[];
    return rows.map(collaborationFromRow);
  }

  saveDepartmentMission(mission: DepartmentMission): boolean {
    return this.safeWrite("save department mission", () => {
      this.db.prepare(`
        INSERT INTO department_missions (
          id, department_id, workspace_path, boss_worker_id, objective, acceptance_criteria_json,
          status, plan_summary, steps_json, current_step_index, correction_count,
          max_corrections, error, created_at, started_at, completed_at,
          attention_reason, plan_approved_at, owner_guidance, format_repair_count,
          attachment_ids_json, parent_mission_id, source_message_id,
          delegated_sessions_json, execution_events_json, execution_mode, mission_origin
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          plan_summary = excluded.plan_summary,
          steps_json = excluded.steps_json,
          current_step_index = excluded.current_step_index,
          correction_count = excluded.correction_count,
          max_corrections = excluded.max_corrections,
          error = excluded.error,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at
          , attention_reason = excluded.attention_reason
          , plan_approved_at = excluded.plan_approved_at
          , owner_guidance = excluded.owner_guidance
          , format_repair_count = excluded.format_repair_count
          , attachment_ids_json = excluded.attachment_ids_json
          , parent_mission_id = excluded.parent_mission_id
          , source_message_id = excluded.source_message_id
          , delegated_sessions_json = excluded.delegated_sessions_json
          , execution_events_json = excluded.execution_events_json
          , execution_mode = excluded.execution_mode
          , mission_origin = excluded.mission_origin
      `).run(
        mission.id, mission.departmentId ?? null, mission.workspacePath, mission.bossWorkerId, mission.objective,
        JSON.stringify(mission.acceptanceCriteria), mission.status, mission.planSummary,
        JSON.stringify(mission.steps), mission.currentStepIndex, mission.correctionCount,
        mission.maxCorrections, mission.error, mission.createdAt, mission.startedAt, mission.completedAt,
        mission.attentionReason ?? null, mission.planApprovedAt ?? null,
        mission.ownerGuidance ?? null, mission.formatRepairCount ?? 0,
        JSON.stringify(mission.attachmentIds ?? []), mission.parentMissionId ?? null, mission.sourceMessageId ?? null,
        JSON.stringify(mission.delegatedSessions ?? []), JSON.stringify(mission.executionEvents ?? []),
        mission.executionMode ?? "project", mission.origin ?? "department",
      );
    });
  }

  markDepartmentMissionsOrigin(missionIds: string[], origin: NonNullable<DepartmentMission["origin"]>): boolean {
    const ids = [...new Set(missionIds.filter(Boolean))];
    if (ids.length === 0) return true;
    return this.safeWrite("mark department mission origin", () => {
      const statement = this.db.prepare("UPDATE department_missions SET mission_origin = ? WHERE id = ?");
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const id of ids) statement.run(origin, id);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  getDepartmentMission(id: string): DepartmentMission | null {
    const row = this.db.prepare("SELECT * FROM department_missions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? missionFromRow(row) : null;
  }

  listDepartmentMissions(workspacePath?: string, limit = 100): DepartmentMission[] {
    const bounded = Math.max(1, Math.min(200, limit));
    const rows = workspacePath
      ? this.db.prepare("SELECT * FROM department_missions WHERE workspace_path = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(workspacePath, bounded)
      : this.db.prepare("SELECT * FROM department_missions ORDER BY created_at DESC, rowid DESC LIMIT ?").all(bounded);
    return (rows as Record<string, unknown>[]).map(missionFromRow);
  }

  listReservedDepartmentMissions(): DepartmentMission[] {
    const rows = this.db.prepare(`
      SELECT * FROM department_missions
      WHERE status IN ('planning', 'executing', 'reviewing', 'needs_attention')
      ORDER BY created_at
    `).all() as Record<string, unknown>[];
    return rows.map(missionFromRow);
  }

  saveBossTask(task: BossTask): boolean {
    return this.safeWrite("save boss task", () => {
      this.db.prepare(`
        INSERT INTO boss_tasks (id, workspace_path, status, title, archived_at, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          workspace_path = excluded.workspace_path,
          status = excluded.status,
          title = excluded.title,
          archived_at = excluded.archived_at,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
      `).run(task.id, task.workspacePath, task.status, task.title, task.archivedAt, JSON.stringify(task), task.createdAt, task.updatedAt);
    });
  }

  getBossTask(id: string): BossTask | null {
    const row = this.db.prepare("SELECT payload_json FROM boss_tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? bossTaskFromRow(row) : null;
  }

  deleteBossTask(id: string): boolean {
    return this.safeWrite("delete boss task", () => {
      this.db.prepare("DELETE FROM boss_tasks WHERE id = ?").run(id);
    });
  }

  listBossTasks(workspacePath?: string, limit = 200): BossTask[] {
    const bounded = Math.max(1, Math.min(200, limit));
    const rows = workspacePath
      ? this.db.prepare("SELECT payload_json, archived_at FROM boss_tasks WHERE workspace_path = ? ORDER BY archived_at IS NOT NULL, updated_at DESC LIMIT ?").all(workspacePath, bounded)
      : this.db.prepare("SELECT payload_json, archived_at FROM boss_tasks ORDER BY archived_at IS NOT NULL, updated_at DESC LIMIT ?").all(bounded);
    return (rows as Record<string, unknown>[]).map(bossTaskFromRow);
  }

  listBossTasksByStatus(statuses: BossTaskStatus[]): BossTask[] {
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = this.db.prepare(`SELECT payload_json FROM boss_tasks WHERE status IN (${placeholders})`).all(...statuses);
    return (rows as Record<string, unknown>[]).map(bossTaskFromRow);
  }

  listRunningBossTasks(): BossTask[] {
    return this.listBossTasksByStatus(["running"]);
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

  deleteProviderCheckpoint(workerId: string, provider: ProviderId): boolean {
    return this.safeWrite("delete provider checkpoint", () => {
      this.db.prepare("DELETE FROM provider_checkpoints WHERE worker_id = ? AND provider = ?").run(workerId, provider);
    });
  }

  // SQLite can't ALTER a CHECK constraint in place, so adding the 'returning'
  // status and continuation_result column to collaboration_tasks needs a full
  // rebuild instead of the idempotent ALTER-TABLE pattern used elsewhere.
  private migrateCollaborationTasks(): void {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'collaboration_tasks'").get() as { sql?: string } | undefined;
    const schema = row?.sql ?? "";
    if (schema.includes("'returning'") && schema.includes("continuation_result")) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
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
        SELECT
          id, source_worker_id, target_worker_id, workspace_path, mode, objective,
          acceptance_criteria_json, status, source_context_json, base_commit, result_json,
          NULL, error, created_at, started_at, completed_at, adopted_at, handled_at
        FROM collaboration_tasks_legacy;
        DROP TABLE collaboration_tasks_legacy;
        CREATE INDEX collaboration_tasks_source_created
          ON collaboration_tasks(source_worker_id, created_at DESC);
        CREATE INDEX collaboration_tasks_target_created
          ON collaboration_tasks(target_worker_id, created_at DESC);
      `);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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

  // Public wrapper so callers outside LocalStore (backup export/restore)
  // can force the ~150ms debounce queue to disk before treating `this.path`
  // as authoritative, without having to close the store to do it.
  flush(): void {
    this.flushEvents();
  }

  // Truncates the WAL back into the main DB file so a plain filesystem copy
  // of `this.path` alone (no -wal/-shm needed) is a complete, consistent
  // snapshot for backup export.
  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  }

  close(): void {
    this.flushEvents();
    this.db.close();
  }
}
