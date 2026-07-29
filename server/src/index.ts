import express, { type Response } from "express";
import cors, { type CorsOptions } from "cors";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { release as osRelease, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "./config.js";
import { ClaudeSession, type RunnerEvent } from "./claudeRunner.js";
import { costMicrosForTurnEnd } from "./costTracking.js";
import { buildClaudeMcpAddArgs, buildClaudeMcpRemoveArgs, CapabilityRegistry } from "./capabilities.js";
import { buildCodexMcpAddArgs, CodexCapabilityRegistry } from "./codexCapabilities.js";
import { McpLoginTracker } from "./mcpLogin.js";
import { LocalStore, type PersistedWorker } from "./store.js";
import { ClaudeAuthProvider } from "./providers/claudeAuth.js";
import { CodexAuthProvider } from "./providers/codexAuth.js";
import { CodexSession } from "./codexRunner.js";
import type { AgentSession, MessageDocument, MessageImage } from "./providers/session.js";
import type { AgentAuthProvider, ProviderAuthState, ProviderId } from "./providers/types.js";
import { deleteProjectCommand, listProjectCommands, saveProjectCommand } from "./commandLibrary.js";
import { UpdateChecker, readCurrentVersion } from "./updateCheck.js";
import { deleteProjectSkill, listProjectSkills, saveProjectSkill } from "./skillLibrary.js";
import { isAllowedLocalRequest, isAllowedLoopbackOrigin } from "./localAccess.js";
import { WorkflowLibraryWatcher } from "./workflowWatcher.js";
import { AvatarStore, AvatarValidationError } from "./avatarStore.js";
import { ensurePrivateDirectorySync } from "./platform/fileProtection.js";
import { stageExportDirectory } from "./backupExport.js";
import {
  BackupValidationError,
  extractAndValidateBackup,
  readAndClearRestoreMarker,
  restoreFromSnapshot,
  snapshotCurrentData,
  swapInRestoredData,
  writeRestoreMarker,
} from "./backupImport.js";
import multer from "multer";
import * as tar from "tar";
import { ProviderUsageRegistry } from "./providerUsage.js";
import {
  composePersonaPrompt,
  normalizePersona,
  normalizePersonaTemplate,
  parsePersonaSuggestion,
  personaSuggestionPrompt,
  type Persona,
  type PersonaTemplate,
} from "./persona.js";
import type { AutoApproveMode } from "./dangerousCommand.js";
import { MessageImageValidationError, parseMessageImages } from "./messageImages.js";
import { MessageDocumentValidationError, parseMessageDocuments } from "./messageDocuments.js";
import {
  bootstrapPrompt,
  buildLocalHandoff,
  parseHandoffSummary,
  recentConversation,
  summaryMarkdown,
  summaryPrompt,
  usageBlockReason,
  type HandoffProgress,
  type HandoffSummary,
} from "./handoff.js";
import { canonicalWorkspacePath, sameWorkspace, workspaceIdentity } from "./platform/paths.js";
import { execCli, resolveExecutable } from "./platform/processes.js";
import { pickDirectory } from "./platform/directoryPicker.js";
import { parseCommandLine } from "./platform/commandLine.js";
import { ProviderInstaller } from "./providerInstaller.js";
import {
  adoptedCollaborationMessage,
  collaborationAcceptsTerminalEvent,
  collaborationActiveWorkerId,
  collaborationConversation,
  collaborationPrompt,
  collaborationText,
  normalizeAcceptanceCriteria,
  normalizeCollaborationMode,
  parseCollaborationResult,
  type CollaborationTask,
} from "./collaboration.js";
import {
  applyMissionActivityEvent,
  createMissionActivity,
  isAgentTool,
  isAsyncAgentLaunch,
  missionActiveWorkerId,
  missionLocksWorkspace,
  missionFormatRepairPrompt,
  missionFollowUpPrompt,
  missionPlanningPrompt,
  missionStepPrompt,
  parseMissionPlan,
  precedingExecuteIndex,
  type DepartmentMission,
  type DepartmentMissionStep,
  type MissionActivity,
  type MissionExecutionMode,
} from "./mission.js";
import {
  departmentPlanPrompt,
  normalizeDepartmentPurpose,
  parseDepartmentPlan,
  type DepartmentPlan,
} from "./departmentPlan.js";
import { normalizeDepartmentName, type Department } from "./department.js";
import {
  assignmentDecisionPrompt,
  normalizeAssignmentClarifications,
  parseAssignmentDecision,
  type AssignmentDecisionCandidate,
} from "./assignmentDecision.js";
import { replaceWithFreshSession } from "./freshSession.js";
import { cleanWorkerSession, matchNativeCommand, type WorkerCleanDeps } from "./nativeCommands.js";
import {
  applyBossTaskRecordPatch,
  bossTaskDecisionPrompt,
  bossTaskClarificationBudget,
  bossTaskFinalReport,
  explainBossTaskDecisionFailure,
  parseBossTaskDecision,
  type BossTask,
  type BossTaskMessage,
  type BossTaskMessageRole,
} from "./bossTask.js";
import { AttachmentRepository, type AttachmentRecord } from "./attachmentRepository.js";
import {
  boundedDepartmentContext,
  intentClassificationPrompt,
  parseIntentClassification,
  type DepartmentMessage,
  type DepartmentMessageIntent,
  type DepartmentThread,
  type IntentClassification,
} from "./departmentThread.js";
import { queryToolPolicy, readOnlyMcpToolNames } from "./toolPolicy.js";
import { McpConfigWatcher, type McpConfigChange } from "./mcpConfigWatcher.js";

const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  if (!isAllowedLocalRequest(req.headers.host, req.headers.origin)) {
    res.status(403).json({ error: "Pixel Crew only accepts requests addressed to its local interface" });
    return;
  }
  next();
});
const loopbackCors: CorsOptions = {
  origin(origin, callback) {
    callback(null, isAllowedLoopbackOrigin(origin));
  },
};
app.use(cors(loopbackCors));
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; font-src 'self' data:");
  next();
});
// Four documents (20 MiB total) plus images (10 MiB total) expand by roughly
// one third when transported as base64. Keep the HTTP ceiling just above the
// validated attachment budget; individual parsers still enforce tighter caps.
app.use(express.json({ limit: "44mb" }));
// A backup restore in progress means the DB is being swapped out from under
// this process — every write API except the backup routes themselves must
// be rejected until the process exits and relaunches against the new data.
// GETs stay served (harmless; lets the frontend keep polling system status).
app.use((req, res, next) => {
  if (maintenanceMode && req.method !== "GET" && !req.path.startsWith("/api/backup/")) {
    res.status(503).json({ error: "還原正在進行中" });
    return;
  }
  next();
});

const server = createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/ws",
  verifyClient(info, done) {
    done(!maintenanceMode && isAllowedLocalRequest(info.req.headers.host, info.origin));
  },
});

const MAX_HISTORY = 2000;
const MAX_WORKERS = 20;
const MAX_ACTIVE_COLLABORATIONS = 5;
const AVATAR_PRESET_IDS = new Set(["classic", "cyber", "signal", "spark", "ops"]);
const store = new LocalStore(config.dbPath);
store.markDepartmentMissionsOrigin(
  store.listBossTasks(undefined, 200)
    .flatMap((task) => task.stages.flatMap((stage) => stage.missionId ? [stage.missionId] : [])),
  "boss",
);
const avatarStore = new AvatarStore(config.avatarDir);
const attachmentRepository = new AttachmentRepository(join(config.dataDirectory, "attachments"), store);

function persistAttachments(
  images: MessageImage[],
  documents: MessageDocument[],
  res: Response,
): AttachmentRecord[] | null {
  try {
    return attachmentRepository.persist(images, documents);
  } catch (error) {
    console.error("附件保存失敗", error);
    res.status(500).json({ error: "附件保存失敗，請稍後重試" });
    return null;
  }
}

function resolveAttachmentMetadata(ids: string[]): Array<{ id: string; name: string; mimeType: string }> {
  return ids.flatMap((id) => {
    const attachment = store.getAttachment(id);
    return attachment ? [{ id, name: attachment.name, mimeType: attachment.mimeType }] : [];
  });
}

// Set only while a backup restore's commit is in flight — every write API
// (except the backup routes themselves) is rejected until the process exits.
// Never reset back to false: the process always exits at the end of a
// commit attempt (see POST /api/backup/import/commit), success or failure.
let maintenanceMode = false;
const pendingImports = new Map<string, { stagingDir: string; createdAt: number }>();
function discardPendingImport(token: string): void {
  const pending = pendingImports.get(token);
  if (!pending) return;
  pendingImports.delete(token);
  rmSync(pending.stagingDir, { recursive: true, force: true });
}
const usageRegistry = new ProviderUsageRegistry(
  store,
  (usage) => {
    broadcast({ type: "usage_updated", provider: usage.provider, usage });
  },
  providerReady,
);
const updateChecker = new UpdateChecker(readCurrentVersion(), (info) => {
  broadcast({ type: "update_info", updateInfo: info });
});
updateChecker.start();
const authProviders: Record<ProviderId, AgentAuthProvider> = {
  claude: new ClaudeAuthProvider(),
  codex: new CodexAuthProvider(),
};
const authStates: Record<ProviderId, ProviderAuthState> = {
  claude: initialAuthState(authProviders.claude),
  codex: initialAuthState(authProviders.codex),
};
const providerInstaller = new ProviderInstaller(async (provider) => {
  await refreshOneAuth(provider);
});
const mcpLoginTracker = new McpLoginTracker(async (state) => {
  broadcast({
    type: "mcp_login_result",
    provider: state.provider,
    workspacePath: state.workspacePath,
    name: state.name,
    ok: state.status === "succeeded",
    status: state.status,
    message: state.message,
  });
  if (state.provider === "codex") await codexCapabilitiesFor(state.workspacePath).refresh();
  else await claudeCapabilitiesFor(state.workspacePath).refresh();
  await reloadMcpWorkers(state.provider, state.workspacePath);
});

// Read (and cleared) exactly once at startup — a restore's outcome is only
// relevant to the very first status the frontend sees after relaunching, and
// re-checking on every call would make an already-cleared marker ambiguous
// with "no restore ever happened."
const lastRestoreResult = readAndClearRestoreMarker(config.dataDirectory);

function systemStatus() {
  const release = osRelease();
  const windowsBuild = process.platform === "win32" ? Number(release.split(".")[2] ?? 0) : null;
  return {
    platform: process.platform,
    arch: process.arch,
    release,
    node: process.version,
    dataDirectory: config.dataDirectory,
    folderPicker: process.platform === "darwin" || process.platform === "win32",
    workspaceSetupRequired: workers.size === 0 && !config.targetRepoConfigured,
    codexWindowsBestEffort: process.platform === "win32" && Number.isFinite(windowsBuild) && (windowsBuild ?? 0) < 22_000,
    lastRestoreResult,
  };
}

type Worker = {
  id: string;
  runner: AgentSession;
  history: RunnerEvent[];
  colorIndex: number;
  avatarId: string | null;
  avatarKind: "preset" | "custom";
  avatarPresetId: string;
  persona: Persona | null;
  // "off": always prompt. "safe": narrow allowlist (autoApprovalPolicy) —
  // still asks for anything not specifically recognized as read-only/safe.
  // "full": allow everything except commands matched by isDangerousCommand.
  // See dangerousCommand.ts. Read live by Claude/CodexSession, so switching
  // modes takes effect immediately without restarting the session.
  autoApproveMode: AutoApproveMode;
  handoff: HandoffProgress | null;
  departmentId: string | null;
};

const workers = new Map<string, Worker>();
const departments = new Map<string, Department>(store.listDepartments().map((department) => [department.id, department]));
const activeCollaborations = new Map<string, CollaborationTask>();
const collaborationActivities = new Map<string, MissionActivity>();
const activeMissions = new Map<string, DepartmentMission>(
  store.listReservedDepartmentMissions().map((mission) => [mission.id, mission]),
);
const missionActivities = new Map<string, MissionActivity>();
type MissionRunnerHandle = {
  runner: AgentSession;
  workerId: string;
  stepId: string | null;
};
const missionRunners = new Map<string, MissionRunnerHandle>();
const pendingMissionReplans = new Map<string, { message: string; attachmentIds: string[]; sourceMessageId: string }>();
let workerCounter = 0;

function workerSummary(w: Worker) {
  const handoffBusy = handoffInProgress(w);
  const collaborationIds = [...activeCollaborations.values()]
    .filter((task) => task.sourceWorkerId === w.id || task.targetWorkerId === w.id)
    .map((task) => task.id);
  const missionIds = [...activeMissions.values()]
    .filter((mission) => missionLocksWorkspace(mission) && missionMatchesScope(mission, w.runner.workspacePath, w.departmentId))
    .map((mission) => mission.id);
  const missionBusy = [...activeMissions.values()].some((mission) => missionActiveWorkerId(mission) === w.id);
  return {
    id: w.id,
    name: w.runner.name,
    model: w.runner.getModel() ?? null,
    busy: w.runner.busy || handoffBusy || collaborationIds.length > 0 || missionBusy,
    colorIndex: w.colorIndex,
    avatarId: w.avatarId,
    avatarKind: w.avatarKind,
    avatarPresetId: w.avatarPresetId,
    provider: w.runner.provider,
    workspacePath: w.runner.workspacePath,
    departmentId: w.departmentId,
    persona: w.persona,
    autoApproveMode: w.autoApproveMode,
    handoff: w.handoff,
    collaborationIds,
    missionIds,
  };
}

function handoffInProgress(worker: Worker): boolean {
  return Boolean(worker.handoff && !["completed", "failed"].includes(worker.handoff.stage));
}

function collaborationInProgress(workerId: string): boolean {
  return [...activeCollaborations.values()].some(
    (task) => task.sourceWorkerId === workerId || task.targetWorkerId === workerId,
  );
}

function missionMatchesScope(mission: DepartmentMission, workspacePath: string, departmentId?: string | null): boolean {
  if (mission.departmentId != null && departmentId != null) return mission.departmentId === departmentId;
  return sameWorkspacePath(mission.workspacePath, workspacePath);
}

function workspaceMission(workspacePath: string, departmentId?: string | null): DepartmentMission | null {
  return [...activeMissions.values()].find((mission) =>
    missionLocksWorkspace(mission) && missionMatchesScope(mission, workspacePath, departmentId),
  ) ?? null;
}

function missionInProgress(workerId: string): boolean {
  const worker = workers.get(workerId);
  return Boolean(worker && workspaceMission(worker.runner.workspacePath, worker.departmentId));
}

function broadcastMission(mission: DepartmentMission, created = false): void {
  broadcast({ type: created ? "mission_created" : "mission_updated", mission });
  for (const worker of workers.values()) {
    if (sameWorkspacePath(worker.runner.workspacePath, mission.workspacePath)) {
      broadcast({ type: "worker_updated", worker: workerSummary(worker) });
    }
  }
}

function ensureDepartmentThread(departmentId: string): DepartmentThread {
  const existing = store.getDepartmentThread(departmentId);
  if (existing) return existing;
  const now = new Date().toISOString();
  const thread: DepartmentThread = {
    id: randomUUID(),
    departmentId,
    activeMissionId: null,
    summary: "",
    historyClearedAt: null,
    lastMessageAt: now,
    createdAt: now,
    updatedAt: now,
  };
  if (!store.saveDepartmentThread(thread)) throw new Error("無法建立部門對話");
  return thread;
}

function departmentThreadPayload(departmentId: string) {
  const thread = ensureDepartmentThread(departmentId);
  const messages = visibleDepartmentMessages(thread);
  const attachmentIds = [...new Set(messages.flatMap((message) => message.attachmentIds))];
  return {
    thread,
    messages,
    attachments: attachmentIds.flatMap((id) => {
      const attachment = store.getAttachment(id);
      return attachment ? [{
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        kind: attachment.kind,
        createdAt: attachment.createdAt,
      }] : [];
    }),
  };
}

function visibleDepartmentMessages(thread: DepartmentThread, limit = 200): DepartmentMessage[] {
  return store.listDepartmentMessages(thread.id, limit)
    .filter((message) => !thread.historyClearedAt || message.createdAt > thread.historyClearedAt)
    .filter((message) => {
      if (!message.missionId) return true;
      return store.getDepartmentMission(message.missionId)?.origin !== "boss";
    });
}

function visibleBossTaskMessages(task: BossTask): BossTaskMessage[] {
  const clearedAt = task.historyClearedAt;
  return clearedAt ? task.messages.filter((message) => message.createdAt > clearedAt) : task.messages;
}

function bossTaskForDisplay(task: BossTask): BossTask {
  return { ...task, messages: visibleBossTaskMessages(task) };
}

function timestampAfter(timestamp: string): string {
  return new Date(Math.max(Date.now(), Date.parse(timestamp) + 1)).toISOString();
}

function appendDepartmentMessage(
  input: Omit<DepartmentMessage, "id" | "createdAt"> & { createdAt?: string },
): DepartmentMessage {
  const { createdAt, ...messageInput } = input;
  const message: DepartmentMessage = {
    ...messageInput,
    id: randomUUID(),
    createdAt: createdAt ?? new Date().toISOString(),
  };
  if (!store.saveDepartmentMessage(message)) throw new Error("無法保存部門訊息");
  broadcast({ type: "department_message_created", message });
  return message;
}

function updateDepartmentThreadMission(departmentId: string | null | undefined, missionId: string | null): void {
  if (!departmentId) return;
  const thread = ensureDepartmentThread(departmentId);
  thread.activeMissionId = missionId;
  thread.updatedAt = new Date().toISOString();
  store.saveDepartmentThread(thread);
  broadcast({ type: "department_thread_updated", thread });
}

function departmentAudit(
  type: string,
  departmentId: string | null | undefined,
  missionId: string | null | undefined,
  payload: unknown = {},
): void {
  store.saveAuditEvent({
    id: randomUUID(),
    departmentId: departmentId ?? null,
    missionId: missionId ?? null,
    type,
    payload,
    createdAt: new Date().toISOString(),
  });
}

function broadcastBossTask(task: BossTask, created = false): void {
  broadcast({ type: created ? "boss_task_created" : "boss_task_updated", bossTask: bossTaskForDisplay(task) });
}

function broadcastCollaboration(task: CollaborationTask, created = false): void {
  broadcast({ type: created ? "collaboration_created" : "collaboration_updated", collaboration: task });
  const source = workers.get(task.sourceWorkerId);
  const target = workers.get(task.targetWorkerId);
  if (source) broadcast({ type: "worker_updated", worker: workerSummary(source) });
  if (target) broadcast({ type: "worker_updated", worker: workerSummary(target) });
}

function broadcast(payload: unknown): void {
  const raw = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(raw);
  }
}

function initialAuthState(provider: AgentAuthProvider): ProviderAuthState {
  return {
    provider: provider.id,
    displayName: provider.displayName,
    status: "checking",
    loginCommand: provider.loginCommand,
    checkedAt: null,
    error: null,
    debug: null,
  };
}

function providerReady(provider: ProviderId): boolean {
  return authStates[provider].status === "authenticated";
}

const claudeCapabilityRegistries = new Map<string, CapabilityRegistry>();
const codexCapabilityRegistries = new Map<string, CodexCapabilityRegistry>();

function registryKey(workspacePath: string): string {
  return workspaceIdentity(workspacePath);
}

function claudeCapabilitiesFor(workspacePath = config.targetRepoPath): CapabilityRegistry {
  const key = registryKey(workspacePath);
  let registry = claudeCapabilityRegistries.get(key);
  if (!registry) {
    registry = new CapabilityRegistry(store, (state) => {
      broadcast({ type: "capabilities_updated", workspacePath: key, provider: "claude", capabilities: state });
    }, key);
    claudeCapabilityRegistries.set(key, registry);
  }
  return registry;
}

function codexCapabilitiesFor(workspacePath = config.targetRepoPath): CodexCapabilityRegistry {
  const key = registryKey(workspacePath);
  let registry = codexCapabilityRegistries.get(key);
  if (!registry) {
    registry = new CodexCapabilityRegistry((state) => {
      broadcast({ type: "capabilities_updated", workspacePath: key, provider: "codex", capabilities: state });
    }, key, store);
    codexCapabilityRegistries.set(key, registry);
  }
  return registry;
}

function persistWorker(worker: Worker): boolean {
  return store.saveWorker(workerPersistenceRecord(worker));
}

function workerPersistenceRecord(worker: Worker): Omit<PersistedWorker, "events"> {
  const session = worker.runner.getPersistenceState();
  return {
    id: worker.id,
    name: worker.runner.name,
    model: worker.runner.getModel() ?? null,
    colorIndex: worker.colorIndex,
    avatarId: worker.avatarId,
    avatarKind: worker.avatarKind,
    avatarPresetId: worker.avatarPresetId,
    provider: worker.runner.provider,
    workspacePath: worker.runner.workspacePath,
    persona: worker.persona,
    autoApproveMode: worker.autoApproveMode,
    departmentId: worker.departmentId,
    ...session,
  };
}

function repairDepartmentAfterMemberLeaves(departmentId: string | null, workerId: string): void {
  if (!departmentId) return;
  const department = departments.get(departmentId);
  if (!department) return;
  const remaining = [...workers.values()].filter((worker) => worker.departmentId === departmentId && worker.id !== workerId);
  if (remaining.length === 0) {
    departments.delete(departmentId);
    store.deleteDepartment(departmentId);
    broadcast({ type: "department_removed", departmentId });
    return;
  }
  const updated: Department = {
    ...department,
    leadWorkerId: department.leadWorkerId === workerId ? remaining[0].id : department.leadWorkerId,
    memberWorkerIds: remaining.map((worker) => worker.id),
    updatedAt: new Date().toISOString(),
  };
  departments.set(departmentId, updated);
  store.saveDepartment(updated);
  broadcast({ type: "department_updated", department: updated });
}

async function deleteAvatarIfUnused(avatarId: string): Promise<void> {
  if ([...workers.values()].some((worker) => worker.avatarId === avatarId)) return;
  try {
    await avatarStore.delete(avatarId);
  } catch (error) {
    console.warn("Delete unused avatar failed:", (error as Error).message);
  }
}

function finishCollaboration(worker: Worker, event: RunnerEvent): void {
  if (event.type !== "turn_end" && event.type !== "error") return;
  const task = [...activeCollaborations.values()].find((candidate) =>
    collaborationAcceptsTerminalEvent(candidate, worker.id),
  );
  if (!task) return;
  const now = new Date().toISOString();
  const fail = (message: unknown) => {
    task.status = "failed";
    task.error = collaborationText(message, 2_000) || "協作執行失敗";
    task.completedAt = now;
    activeCollaborations.delete(task.id);
    collaborationActivities.delete(task.id);
    store.saveCollaborationTask(task);
    broadcastCollaboration(task);
  };

  if (task.status === "returning") {
    if (event.type === "error" || event.isError) {
      task.continuationResult = collaborationText(event.type === "error" ? event.message : event.resultText, 40_000) || null;
      fail(event.type === "error" ? event.message : event.resultText || "來源 NPC 接續工作失敗");
      return;
    }
    task.continuationResult = collaborationText(event.resultText, 40_000) || null;
    task.status = "completed";
    task.error = null;
    task.completedAt = now;
    activeCollaborations.delete(task.id);
    collaborationActivities.delete(task.id);
    store.saveCollaborationTask(task);
    broadcastCollaboration(task);
    return;
  }

  if (event.type === "error" || event.isError) {
    fail(event.type === "error" ? event.message : event.resultText || "目標 NPC 協作失敗");
    return;
  }

  const result = parseCollaborationResult(event.resultText || "");
  if (!result) {
    fail("目標 NPC 沒有回傳協作結果");
    return;
  }
  task.result = result;
  const source = workers.get(task.sourceWorkerId);
  const target = workers.get(task.targetWorkerId);
  if (!source || !target) {
    fail("來源或目標 NPC 已不存在，無法自動交回結果");
    return;
  }
  if (!sameWorkspacePath(source.runner.workspacePath, task.workspacePath) || !sameWorkspacePath(target.runner.workspacePath, task.workspacePath)) {
    fail("NPC 工作位置已改變，無法自動交回結果");
    return;
  }
  if (source.runner.busy || handoffInProgress(source)) {
    fail("來源 NPC 狀態已改變，無法自動接續工作");
    return;
  }
  if (!providerReady(source.runner.provider)) {
    fail(`${providerLabel(source.runner.provider)} 尚未登入，無法自動接續工作`);
    return;
  }
  task.status = "returning";
  task.adoptedAt = now;
  task.error = null;
  store.saveCollaborationTask(task);
  broadcastCollaboration(task);
  const message = adoptedCollaborationMessage(task, target.runner.name);
  record(source, { type: "user_message", text: message });
  try {
    source.runner.send(message);
    broadcast({ type: "worker_status", workerId: source.id, busy: true });
  } catch (error) {
    record(source, { type: "error", message: (error as Error).message || "無法自動交回協作結果" });
    // record(error) owns the failure transition while the task is returning.
  }
}

function missionMembers(mission: DepartmentMission): Worker[] {
  return [...workers.values()].filter((worker) => mission.departmentId
    ? worker.departmentId === mission.departmentId
    : sameWorkspacePath(worker.runner.workspacePath, mission.workspacePath));
}

function failMission(mission: DepartmentMission, message: unknown): void {
  const now = new Date().toISOString();
  const activeIndex = mission.currentStepIndex;
  const step = activeIndex == null ? null : mission.steps[activeIndex];
  if (step?.status === "running") {
    step.status = "failed";
    step.completedAt = now;
  }
  mission.status = "failed";
  mission.error = collaborationText(message, 2_000) || "Department Mission 執行失敗";
  mission.completedAt = now;
  activeMissions.delete(mission.id);
  missionActivities.delete(mission.id);
  stopMissionRunners(mission.id);
  store.saveDepartmentMission(mission);
  updateDepartmentThreadMission(mission.departmentId, null);
  departmentAudit("mission_failed", mission.departmentId, mission.id, { error: mission.error });
  broadcastMission(mission);
  advanceBossTasksForMission(mission.id);
}

function pauseMission(
  mission: DepartmentMission,
  message: unknown,
  reason: NonNullable<DepartmentMission["attentionReason"]> = "step_failed",
): void {
  const activeIndex = mission.currentStepIndex;
  const step = activeIndex == null ? null : mission.steps[activeIndex];
  if (step?.status === "running") {
    step.status = "failed";
    step.completedAt = new Date().toISOString();
  }
  mission.status = "needs_attention";
  mission.attentionReason = reason;
  mission.error = collaborationText(message, 2_000) || "Department Mission 需要你決定後續";
  missionActivities.delete(mission.id);
  store.saveDepartmentMission(mission);
  departmentAudit("mission_updated", mission.departmentId, mission.id, {
    status: mission.status,
    attentionReason: mission.attentionReason,
    error: mission.error,
  });
  broadcastMission(mission);
  advanceBossTasksForMission(mission.id);
}

function dispatchMissionStep(
  mission: DepartmentMission,
  stepIndex: number,
  priorReview: ReturnType<typeof parseCollaborationResult> = null,
): void {
  const step = mission.steps[stepIndex];
  const assignee = step ? workers.get(step.assigneeWorkerId) : null;
  if (!step || !assignee) {
    pauseMission(mission, "Mission 指派的 NPC 已不存在，請重新指派", "member_unavailable");
    return;
  }
  if (!sameWorkspacePath(assignee.runner.workspacePath, mission.workspacePath)) {
    pauseMission(mission, "Mission 指派的 NPC 已離開原部門，請重新指派", "member_unavailable");
    return;
  }
  if (assignee.runner.busy || handoffInProgress(assignee) || collaborationInProgress(assignee.id)) {
    pauseMission(mission, `${assignee.runner.name} 正在執行其他工作，請稍後重試或重新指派`, "member_unavailable");
    return;
  }
  if (!providerReady(assignee.runner.provider)) {
    pauseMission(mission, `${providerLabel(assignee.runner.provider)} 尚未登入，請登入後重試或重新指派`, "member_unavailable");
    return;
  }
  const now = new Date().toISOString();
  mission.currentStepIndex = stepIndex;
  mission.status = step.kind === "execute" ? "executing" : "reviewing";
  mission.attentionReason = null;
  mission.error = null;
  step.status = "running";
  step.attempt += 1;
  step.startedAt = now;
  step.completedAt = null;
  store.saveDepartmentMission(mission);
  broadcastMission(mission);
  advanceBossTasksForMission(mission.id);
  const message = missionStepPrompt({
    mission,
    step,
    assigneeName: assignee.runner.name,
    priorReview,
  });
  const stepAttachmentIds = step.attachmentIds ?? [];
  const stepAttachments = attachmentRepository.load(stepAttachmentIds);
  attachmentRepository.markDelivery(stepAttachmentIds, mission.id, assignee.id, "pending");
  try {
    const executionOptions = mission.executionMode === "research"
      ? {
          executionProfile: "read_only_query" as const,
          queryAllowedTools: readOnlyMcpToolNames(
            assignee.runner.provider === "codex"
              ? codexCapabilitiesFor(mission.workspacePath).getState()
              : claudeCapabilitiesFor(mission.workspacePath).getState(),
          ),
        }
      : step.kind !== "execute"
        ? { executionProfile: "read_only_collaboration" as const }
        : undefined;
    sendMissionRunner(
      mission,
      assignee,
      message,
      `部門工作 · ${step.title}（${stepIndex + 1}/${mission.steps.length}）`,
      stepAttachments.images,
      stepAttachments.documents,
      executionOptions,
    );
    attachmentRepository.markDelivery(stepAttachmentIds, mission.id, assignee.id, "delivered");
  } catch (error) {
    const message = (error as Error).message || "無法啟動 Mission 步驟";
    attachmentRepository.markDelivery(stepAttachmentIds, mission.id, assignee.id, "failed", message);
    appendMissionExecutionEvent(mission, assignee.id, step.id, { type: "error", message });
    pauseMission(mission, message);
  }
}

function beginMissionReplan(
  mission: DepartmentMission,
  update: { message: string; attachmentIds: string[]; sourceMessageId: string },
): void {
  const lead = workers.get(mission.bossWorkerId);
  const members = missionMembers(mission);
  if (!lead || members.length === 0) {
    pauseMission(mission, "部門成員狀態已改變，無法重新規劃", "member_unavailable");
    return;
  }
  const completedContext = mission.steps
    .filter((step) => step.status === "completed")
    .map((step) => ({ title: step.title, kind: step.kind, result: step.result, reviewResult: step.reviewResult }));
  departmentAudit("mission_updated", mission.departmentId, mission.id, {
    action: "replan",
    requestedUpdate: update.message,
    priorSteps: mission.steps,
  });
  mission.ownerGuidance = [mission.ownerGuidance, update.message].filter(Boolean).join("\n\n").slice(0, 6_000);
  mission.attachmentIds = [...new Set([...(mission.attachmentIds ?? []), ...update.attachmentIds])];
  mission.sourceMessageId = update.sourceMessageId;
  mission.status = "planning";
  mission.currentStepIndex = null;
  mission.planSummary = null;
  mission.steps = [];
  mission.error = null;
  mission.attentionReason = null;
  mission.formatRepairCount = 0;
  store.saveDepartmentMission(mission);
  broadcastMission(mission);
  const metadata = resolveAttachmentMetadata(mission.attachmentIds ?? []);
  const prompt = missionPlanningPrompt({
    missionId: mission.id,
    bossWorkerId: mission.bossWorkerId,
    objective: `${mission.objective}\n\n老闆要求調整：${update.message}\n\n已完成、不得默默丟棄的工作：${JSON.stringify(completedContext)}`.slice(0, 12_000),
    acceptanceCriteria: mission.acceptanceCriteria,
    workspacePath: mission.workspacePath,
    members: members.map((member) => ({
      id: member.id,
      name: member.runner.name,
      role: member.persona?.role || null,
      provider: member.runner.provider,
    })),
    attachments: metadata,
    executionMode: mission.executionMode ?? "project",
  });
  const attachments = attachmentRepository.load(mission.attachmentIds ?? []);
  attachmentRepository.markDelivery(mission.attachmentIds ?? [], mission.id, lead.id, "pending");
  try {
    sendMissionRunner(
      mission,
      lead,
      prompt,
      `部門工作 · 依老闆修改重新規劃：${update.message}`,
      attachments.images,
      attachments.documents,
      { executionProfile: "read_only_collaboration" },
    );
    attachmentRepository.markDelivery(mission.attachmentIds ?? [], mission.id, lead.id, "delivered");
  } catch (error) {
    const message = (error as Error).message || "無法啟動重新規劃";
    attachmentRepository.markDelivery(mission.attachmentIds ?? [], mission.id, lead.id, "failed", message);
    pauseMission(mission, message);
  }
}

function completeMissionStep(mission: DepartmentMission, stepIndex: number, priorReview: ReturnType<typeof parseCollaborationResult> = null): void {
  const pendingReplan = pendingMissionReplans.get(mission.id);
  if (pendingReplan) {
    pendingMissionReplans.delete(mission.id);
    beginMissionReplan(mission, pendingReplan);
    return;
  }
  const nextIndex = stepIndex + 1;
  if (nextIndex < mission.steps.length) {
    dispatchMissionStep(mission, nextIndex, priorReview);
    return;
  }
  mission.status = "completed";
  mission.currentStepIndex = null;
  mission.error = null;
  mission.completedAt = new Date().toISOString();
  activeMissions.delete(mission.id);
  missionActivities.delete(mission.id);
  stopMissionRunners(mission.id);
  store.saveDepartmentMission(mission);
  updateDepartmentThreadMission(mission.departmentId, null);
  departmentAudit("mission_completed", mission.departmentId, mission.id);
  if (mission.departmentId && mission.origin !== "boss") {
    const thread = ensureDepartmentThread(mission.departmentId);
    appendDepartmentMessage({
      threadId: thread.id,
      role: "report",
      intent: "system",
      text: missionReport(mission),
      attachmentIds: [],
      missionId: mission.id,
      deliveryStatus: "delivered",
      clientMessageId: null,
      idempotencyKey: null,
      classification: null,
    });
  }
  broadcastMission(mission);
  advanceBossTasksForMission(mission.id);
}

function finishMission(
  mission: DepartmentMission,
  workerId: string,
  runner: AgentSession,
  event: RunnerEvent,
): void {
  if (event.type !== "turn_end" && event.type !== "error") return;
  const worker = workers.get(workerId);
  if (!worker || missionActiveWorkerId(mission) !== workerId) return;
  if (event.type === "error" || event.isError) {
    pauseMission(mission, event.type === "error" ? event.message : event.resultText || "Mission 步驟失敗");
    return;
  }
  const output = collaborationText(event.resultText, 40_000);
  if (mission.status === "planning") {
    const members = missionMembers(mission);
    const parsed = parseMissionPlan(
      output,
      new Set(members.map((member) => member.id)),
      mission.bossWorkerId,
      new Set(mission.attachmentIds ?? []),
      mission.executionMode ?? "project",
    );
    if (!parsed.plan) {
      if ((mission.formatRepairCount ?? 0) < 1) {
        mission.formatRepairCount = 1;
        mission.error = "計畫格式不完整，正在要求主管只修復輸出格式";
        store.saveDepartmentMission(mission);
        broadcastMission(mission);
        const repair = missionFormatRepairPrompt("plan", output);
        try {
          sendMissionRunner(
            mission,
            worker,
            repair,
            "部門工作 · 修復計畫輸出格式",
            [],
            [],
            { executionProfile: "read_only_collaboration" },
          );
        } catch (error) {
          appendMissionExecutionEvent(mission, worker.id, null, { type: "error", message: (error as Error).message || "無法修復 Mission 計畫格式" });
          pauseMission(mission, (error as Error).message || "無法修復 Mission 計畫格式");
        }
        return;
      }
      mission.status = "needs_attention";
      mission.attentionReason = "step_failed";
      mission.error = parsed.error || "Mission 計畫格式仍然無效，請重試規劃或取消";
      store.saveDepartmentMission(mission);
      broadcastMission(mission);
      return;
    }
    mission.planSummary = parsed.plan.summary;
    mission.steps = parsed.plan.steps.map((step) => ({
      ...step,
      id: randomUUID(),
      status: "pending" as const,
      attempt: 0,
      result: null,
      reviewResult: null,
      startedAt: null,
      completedAt: null,
      formatRepairCount: 0,
    }));
    if (mission.executionMode !== "research") mission.steps.push({
      id: randomUUID(),
      title: "向老闆提交部門報告",
      objective: "整合所有成員的執行、Consult 與 Review 結果，提交一份包含結論、驗收狀態、主要交付、驗證、風險與待決事項的最終報告",
      kind: "synthesize",
      assigneeWorkerId: mission.bossWorkerId,
      acceptanceCriteria: mission.acceptanceCriteria,
      status: "pending",
      attempt: 0,
      result: null,
      reviewResult: null,
      startedAt: null,
      completedAt: null,
      formatRepairCount: 0,
      attachmentIds: [],
    });
    mission.currentStepIndex = 0;
    mission.status = "executing";
    mission.attentionReason = null;
    mission.error = null;
    store.saveDepartmentMission(mission);
    departmentAudit("mission_started", mission.departmentId, mission.id, {
      planSummary: mission.planSummary,
      stepCount: mission.steps.length,
    });
    broadcastMission(mission);
    const pendingReplan = pendingMissionReplans.get(mission.id);
    if (pendingReplan) {
      pendingMissionReplans.delete(mission.id);
      beginMissionReplan(mission, pendingReplan);
      return;
    }
    dispatchMissionStep(mission, 0);
    return;
  }
  const stepIndex = mission.currentStepIndex;
  if (stepIndex == null) {
    failMission(mission, "Mission 找不到目前步驟");
    return;
  }
  const step = mission.steps[stepIndex];
  if (!step || step.assigneeWorkerId !== worker.id || step.status !== "running") return;
  const now = new Date().toISOString();
  step.result = output || null;
  step.completedAt = now;
  if (step.kind === "review" || step.kind === "consult") {
    const review = parseCollaborationResult(output);
    if (!review || !review.structured) {
      if ((step.formatRepairCount ?? 0) < 1) {
        step.formatRepairCount = 1;
        step.result = output || null;
        mission.error = "專家結果格式不完整，正在要求只修復輸出格式";
        store.saveDepartmentMission(mission);
        broadcastMission(mission);
        const repair = missionFormatRepairPrompt(step.kind, output);
        try {
          sendMissionRunner(
            mission,
            worker,
            repair,
            `部門工作 · 修復 ${step.kind === "consult" ? "Consult" : "Review"} 輸出格式`,
            [],
            [],
            { executionProfile: "read_only_collaboration" },
          );
        } catch (error) {
          appendMissionExecutionEvent(mission, worker.id, step.id, { type: "error", message: (error as Error).message || "無法修復專家結果格式" });
          pauseMission(mission, (error as Error).message || "無法修復專家結果格式");
        }
        return;
      }
      step.status = "failed";
      mission.status = "needs_attention";
      mission.attentionReason = "step_failed";
      mission.error = "專家 NPC 兩次都沒有回傳結構化 Consult／Review 結果";
      store.saveDepartmentMission(mission);
      broadcastMission(mission);
      return;
    }
    step.reviewResult = review;
    step.status = "completed";
    if (step.kind === "consult") {
      completeMissionStep(mission, stepIndex, review);
      return;
    }
    const quickReview = stepIndex === 0 && mission.steps[1]?.kind === "execute";
    if (quickReview) {
      if (review.verdict === "pass" || review.verdict === "changes_requested") {
        completeMissionStep(mission, stepIndex, review);
      } else {
        mission.status = "needs_attention";
        mission.attentionReason = "review_inconclusive";
        mission.error = "快速 Review 無法確認結果，需要你補充資訊或重新檢查";
        store.saveDepartmentMission(mission);
        broadcastMission(mission);
      }
      return;
    }
    if (review.verdict === "changes_requested") {
      if (mission.correctionCount >= mission.maxCorrections) {
        mission.status = "needs_attention";
        mission.attentionReason = "correction_limit";
        mission.error = `Review 已退回 ${mission.correctionCount + 1} 次，需要你決定後續`;
        store.saveDepartmentMission(mission);
        broadcastMission(mission);
        return;
      }
      const executeIndex = precedingExecuteIndex(mission, stepIndex);
      if (executeIndex == null) {
        failMission(mission, "Review 找不到可退回修正的 Execute 步驟");
        return;
      }
      mission.correctionCount += 1;
      step.status = "pending";
      step.completedAt = null;
      const executeStep = mission.steps[executeIndex];
      executeStep.status = "pending";
      executeStep.completedAt = null;
      store.saveDepartmentMission(mission);
      broadcastMission(mission);
      dispatchMissionStep(mission, executeIndex, review);
      return;
    }
    if (review.verdict !== "pass") {
      mission.status = "needs_attention";
      mission.attentionReason = "review_inconclusive";
      mission.error = "Review 無法確認通過，需要你補充資訊或重新檢查";
      store.saveDepartmentMission(mission);
      broadcastMission(mission);
      return;
    }
    completeMissionStep(mission, stepIndex);
    return;
  }
  step.status = "completed";
  completeMissionStep(mission, stepIndex);
}

function collaborationEventIsTerminal(worker: Worker, event: RunnerEvent): boolean {
  const task = [...activeCollaborations.values()].find((candidate) => collaborationAcceptsTerminalEvent(candidate, worker.id));
  if (!task) return false;
  const current = collaborationActivities.get(task.id) ?? createMissionActivity();
  const result = applyMissionActivityEvent(current, event);
  if (result.shouldFinish) collaborationActivities.delete(task.id);
  else collaborationActivities.set(task.id, result.activity);
  return result.shouldFinish;
}

function record(worker: Worker, event: RunnerEvent): void {
  // Output deltas can arrive many times per second. Keep a compact live copy
  // for reconnect snapshots without turning every chunk into a SQLite row.
  // The provider's final tool result is still persisted normally.
  const previous = worker.history[worker.history.length - 1];
  if (
    event.type === "tool_call_output_delta" &&
    previous?.type === "tool_call_output_delta" &&
    previous.id === event.id
  ) {
    worker.history[worker.history.length - 1] = {
      ...event,
      delta: `${previous.delta}${event.delta}`.slice(-200_000),
    };
  } else {
    worker.history.push(event);
  }
  if (worker.history.length > MAX_HISTORY) {
    worker.history.splice(0, worker.history.length - MAX_HISTORY);
  }
  if (event.type !== "tool_call_output_delta") {
    store.appendEvent(worker.id, event, MAX_HISTORY);
  }
  if (event.type === "meta" && worker.runner.provider === "claude") {
    claudeCapabilitiesFor(worker.runner.workspacePath).mergeWorkerMeta(event);
  }
  if (event.type === "turn_end" || event.type === "error") persistWorker(worker);
  if (event.type === "turn_end") void usageRegistry.refresh(worker.runner.provider);
  if (event.type === "turn_end") {
    const completedTurns = event.isError
      ? store.getCounter("completed_turns")
      : store.incrementCounter("completed_turns");
    const costMicros = costMicrosForTurnEnd(worker.runner.provider, event);
    const totalCostUsd =
      (costMicros > 0
        ? store.incrementCounter("total_cost_usd_micros", costMicros)
        : store.getCounter("total_cost_usd_micros")) / 1_000_000;
    broadcast({ type: "stats_updated", stats: { completedTurns, totalCostUsd } });
  }
  const collaborationTerminal = collaborationEventIsTerminal(worker, event);
  broadcast({ type: "event", workerId: worker.id, event });
  if ((event.type === "turn_end" || event.type === "error") && collaborationTerminal) finishCollaboration(worker, event);
}

function createWorker(
  name?: string,
  model?: string,
  provider: ProviderId = "claude",
  workspacePath = config.targetRepoPath,
  persisted?: PersistedWorker,
  initialPersona: Persona | null = null,
  departmentId: string | null = null,
  options: { warmup?: boolean; persist?: boolean; broadcast?: boolean } = {},
): Worker {
  const workerProvider = persisted?.provider ?? provider;
  const workerWorkspace = registryKey(persisted?.workspacePath || workspacePath || config.targetRepoPath);
  const id = persisted?.id ?? randomUUID();
  const worker: Worker = {
    id,
    runner: null as unknown as AgentSession,
    history: persisted?.events ?? [],
    colorIndex: persisted?.colorIndex ?? workerCounter % 6,
    avatarId: persisted?.avatarId ?? null,
    avatarKind: persisted?.avatarKind ?? (persisted?.avatarId ? "custom" : "preset"),
    avatarPresetId: AVATAR_PRESET_IDS.has(persisted?.avatarPresetId ?? "") ? persisted!.avatarPresetId : "classic",
    persona: persisted?.persona ?? initialPersona,
    autoApproveMode: persisted?.autoApproveMode ?? "off",
    handoff: persisted ? store.loadLatestFailedHandoff(id) : null,
    departmentId: persisted?.departmentId ?? departmentId,
  };
  const initialState = persisted
    ? { sessionId: persisted.sessionId, completedTurns: persisted.completedTurns }
    : undefined;
  const runner = createRunner(worker, workerProvider, workerWorkspace, initialState);
  worker.runner = runner;
  workerCounter++;
  runner.name = persisted?.name || name?.trim() || `${["一", "二", "三", "四", "五", "六", "七", "八", "九"][
    (workerCounter - 1) % 9
  ]}號機`;
  const selectedModel = persisted?.model ?? model;
  if (selectedModel && validModel(workerProvider, selectedModel)) runner.setModel(selectedModel);
  workers.set(id, worker);
  if (options.warmup === true && providerReady(workerProvider)) runner.warmup();
  if (options.persist !== false) {
    if (!persisted && !worker.departmentId) {
      const departmentId = randomUUID();
      const now = new Date().toISOString();
      worker.departmentId = departmentId;
      const department: Department = {
        id: departmentId,
        name: `${basename(workerWorkspace) || "個人"}部門`,
        purpose: "個人工作部門",
        workspacePath: workerWorkspace,
        leadWorkerId: worker.id,
        memberWorkerIds: [worker.id],
        createdAt: now,
        updatedAt: now,
      };
      if (store.saveDepartmentWithWorkers(department, [workerPersistenceRecord(worker)])) {
        departments.set(department.id, department);
        broadcast({ type: "department_created", department });
      } else {
        worker.departmentId = null;
        persistWorker(worker);
      }
    } else {
      persistWorker(worker);
    }
  }
  if (persisted && hasUnfinishedTurn(worker.history)) {
    record(worker, { type: "error", message: "伺服器已重啟，上一個未完成的回合已中止" });
  }
  if (!persisted && options.broadcast !== false) broadcast({ type: "worker_added", worker: workerSummary(worker) });
  return worker;
}

function createRunner(
  worker: Worker,
  provider: ProviderId,
  workspacePath: string,
  initialState?: { sessionId: string; completedTurns: number },
): AgentSession {
  return provider === "codex"
    ? new CodexSession(
        (event) => record(worker, event),
        workspacePath,
        () => composePersonaPrompt(worker.persona),
        () => worker.autoApproveMode,
        initialState,
      )
    : new ClaudeSession(
        (event) => record(worker, event),
        workspacePath,
        () => claudeCapabilitiesFor(workspacePath).getAllowedTools(),
        () => composePersonaPrompt(worker.persona),
        () => worker.autoApproveMode,
        initialState,
      );
}

function workerCleanDeps(worker: Worker): WorkerCleanDeps {
  return {
    isBusy: () =>
      worker.runner.busy
      || handoffInProgress(worker)
      || collaborationInProgress(worker.id)
      || missionInProgress(worker.id),
    createRunner: (provider, workspacePath) => createRunner(worker, provider, workspacePath),
    persistWorker: () => persistWorker(worker),
    saveCheckpoint: (runner) => store.saveProviderCheckpoint(
      worker.id,
      runner.provider,
      runner.workspacePath,
      runner.getModel() ?? null,
      runner.getPersistenceState(),
    ),
    clearWorkerEvents: (workerId) => store.clearWorkerEvents(workerId),
  };
}

function cleanWorkerAndAnnounce(worker: Worker): { ok: true } | { ok: false; error: string } {
  const result = cleanWorkerSession(worker, workerCleanDeps(worker));
  if (!result.ok) return result;
  broadcast({ type: "worker_updated", worker: workerSummary(worker), reset: true });
  const announcement = "已清除工作階段，NPC 記憶重新開始。";
  record(worker, { type: "text_delta", text: announcement });
  record(worker, {
    type: "turn_end",
    resultText: announcement,
    costUsd: 0,
    durationMs: 0,
    isError: false,
    permissionDenials: [],
  });
  return { ok: true };
}

function missionRunnerKey(missionId: string, workerId: string): string {
  return `${missionId}\0${workerId}`;
}

function persistMissionRunnerCheckpoint(
  mission: DepartmentMission,
  worker: Worker,
  runner: AgentSession,
): void {
  const state = runner.getPersistenceState();
  const checkpoint = {
    workerId: worker.id,
    provider: runner.provider,
    model: runner.getModel() ?? null,
    sessionId: state.sessionId,
    completedTurns: state.completedTurns,
  };
  mission.delegatedSessions = [
    ...(mission.delegatedSessions ?? []).filter((item) => item.workerId !== worker.id),
    checkpoint,
  ];
}

function missionRunnerFor(mission: DepartmentMission, worker: Worker): MissionRunnerHandle {
  const key = missionRunnerKey(mission.id, worker.id);
  const existing = missionRunners.get(key);
  if (existing) return existing;
  const checkpoint = (mission.delegatedSessions ?? []).find((item) =>
    item.workerId === worker.id && item.provider === worker.runner.provider,
  );
  let handle: MissionRunnerHandle;
  const onEvent = (event: RunnerEvent) => recordMissionRunnerEvent(mission.id, worker.id, event);
  const runner: AgentSession = worker.runner.provider === "codex"
    ? new CodexSession(
        onEvent,
        mission.workspacePath,
        () => composePersonaPrompt(worker.persona),
        () => worker.autoApproveMode,
        checkpoint ? { sessionId: checkpoint.sessionId, completedTurns: checkpoint.completedTurns } : undefined,
      )
    : new ClaudeSession(
        onEvent,
        mission.workspacePath,
        () => claudeCapabilitiesFor(mission.workspacePath).getAllowedTools(),
        () => composePersonaPrompt(worker.persona),
        () => worker.autoApproveMode,
        checkpoint ? { sessionId: checkpoint.sessionId, completedTurns: checkpoint.completedTurns } : undefined,
      );
  runner.name = worker.runner.name;
  const model = checkpoint?.model ?? worker.runner.getModel();
  if (model && validModel(runner.provider, model)) runner.setModel(model);
  handle = { runner, workerId: worker.id, stepId: null };
  missionRunners.set(key, handle);
  persistMissionRunnerCheckpoint(mission, worker, runner);
  store.saveDepartmentMission(mission);
  return handle;
}

function stopMissionRunners(missionId: string, interrupt = false): void {
  for (const [key, handle] of missionRunners) {
    if (!key.startsWith(`${missionId}\0`)) continue;
    if (interrupt && handle.runner.busy) handle.runner.interrupt();
    else handle.runner.stop();
    missionRunners.delete(key);
  }
}

function appendMissionExecutionEvent(
  mission: DepartmentMission,
  workerId: string,
  stepId: string | null,
  event: RunnerEvent,
): void {
  const events = mission.executionEvents ?? [];
  const previous = events[events.length - 1];
  if (
    event.type === "tool_call_output_delta"
    && previous?.workerId === workerId
    && previous.stepId === stepId
    && previous.event.type === "tool_call_output_delta"
    && previous.event.id === event.id
  ) {
    previous.event = { ...event, delta: `${previous.event.delta}${event.delta}`.slice(-100_000) };
  } else if (
    event.type === "text_delta"
    && previous?.workerId === workerId
    && previous.stepId === stepId
    && previous.event.type === "text_delta"
  ) {
    previous.event = { ...event, text: `${previous.event.text}${event.text}`.slice(-100_000) };
  } else {
    events.push({ workerId, stepId, event });
  }
  if (events.length > 500) events.splice(0, events.length - 500);
  mission.executionEvents = events;
}

function missionRunnerEventIsTerminal(mission: DepartmentMission, event: RunnerEvent): boolean {
  const current = missionActivities.get(mission.id) ?? createMissionActivity();
  const result = applyMissionActivityEvent(current, event);
  if (result.shouldFinish) missionActivities.delete(mission.id);
  else missionActivities.set(mission.id, result.activity);
  return result.shouldFinish;
}

function recordMissionRunnerEvent(missionId: string, workerId: string, event: RunnerEvent): void {
  const mission = activeMissions.get(missionId) ?? store.getDepartmentMission(missionId);
  const worker = workers.get(workerId);
  const handle = missionRunners.get(missionRunnerKey(missionId, workerId));
  if (!mission || !worker || !handle) return;
  appendMissionExecutionEvent(mission, workerId, handle.stepId, event);
  if (event.type === "meta" && handle.runner.provider === "claude") {
    claudeCapabilitiesFor(mission.workspacePath).mergeWorkerMeta(event);
  }
  if (event.type === "turn_end" || event.type === "error") {
    persistMissionRunnerCheckpoint(mission, worker, handle.runner);
  }
  if (event.type === "turn_end") {
    void usageRegistry.refresh(handle.runner.provider);
    const completedTurns = event.isError
      ? store.getCounter("completed_turns")
      : store.incrementCounter("completed_turns");
    const costMicros = costMicrosForTurnEnd(handle.runner.provider, event);
    const totalCostUsd =
      (costMicros > 0
        ? store.incrementCounter("total_cost_usd_micros", costMicros)
        : store.getCounter("total_cost_usd_micros")) / 1_000_000;
    broadcast({ type: "stats_updated", stats: { completedTurns, totalCostUsd } });
  }
  if (event.type !== "text_delta" && event.type !== "tool_call_output_delta") {
    store.saveDepartmentMission(mission);
  }
  broadcastMission(mission);
  const terminal = missionRunnerEventIsTerminal(mission, event);
  if ((event.type === "turn_end" || event.type === "error") && terminal) {
    finishMission(mission, workerId, handle.runner, event);
  }
}

function sendMissionRunner(
  mission: DepartmentMission,
  worker: Worker,
  prompt: string,
  label: string,
  images: Parameters<AgentSession["send"]>[1] = [],
  documents: Parameters<AgentSession["send"]>[2] = [],
  options?: Parameters<AgentSession["send"]>[3],
): AgentSession {
  const handle = missionRunnerFor(mission, worker);
  handle.stepId = mission.currentStepIndex == null ? null : mission.steps[mission.currentStepIndex]?.id ?? null;
  appendMissionExecutionEvent(mission, worker.id, handle.stepId, { type: "user_message", text: label });
  persistMissionRunnerCheckpoint(mission, worker, handle.runner);
  store.saveDepartmentMission(mission);
  handle.runner.send(prompt, images, documents, options);
  broadcastMission(mission);
  return handle.runner;
}

function validModel(_provider: ProviderId, model: string): boolean {
  // Both CLIs accept a short alias (e.g. "sonnet") or a full model id
  // (e.g. "claude-sonnet-5"); the CLI itself rejects anything bogus at
  // spawn time, so this only guards against obviously malformed input.
  if (!model) return true;
  return /^[A-Za-z0-9._-]+$/.test(model);
}

function resolveDecisionRuntime(
  requestedProvider: unknown,
  requestedModel: unknown,
  preferredWorkspace?: string | null,
): { provider: ProviderId; model: string } | { error: string } {
  const explicitProvider: ProviderId | null = requestedProvider === "claude" || requestedProvider === "codex"
    ? requestedProvider
    : null;
  const explicitModel = collaborationText(requestedModel, 200);
  if (explicitModel && !validModel(explicitProvider ?? "claude", explicitModel)) return { error: "決策模型格式無效" };
  const runtimeModels = (provider: ProviderId): string[] => {
    const capabilities = provider === "claude"
      ? claudeCapabilitiesFor(preferredWorkspace || config.targetRepoPath).getState()
      : codexCapabilitiesFor(preferredWorkspace || config.targetRepoPath).getState();
    return [...new Set([
      ...[...workers.values()]
        .filter((worker) => worker.runner.provider === provider && (!preferredWorkspace || sameWorkspacePath(worker.runner.workspacePath, preferredWorkspace)))
        .flatMap((worker) => worker.runner.getModel() ? [worker.runner.getModel()!] : []),
      ...capabilities.models.map((candidate) => candidate.id).filter(Boolean),
    ])];
  };
  if (explicitProvider) {
    if (!providerReady(explicitProvider)) return { error: `${providerLabel(explicitProvider)} 尚未登入，無法進行部門判斷` };
    if (explicitModel) return { provider: explicitProvider, model: explicitModel };
    const model = runtimeModels(explicitProvider)[0];
    return model
      ? { provider: explicitProvider, model }
      : { error: `${providerLabel(explicitProvider)} 目前沒有可用的決策模型` };
  }
  if (explicitModel) {
    for (const provider of ["claude", "codex"] as const) {
      if (providerReady(provider) && runtimeModels(provider).includes(explicitModel)) return { provider, model: explicitModel };
    }
    return { error: "指定的決策模型目前不在任何已登入 provider 的可用清單中" };
  }
  if (preferredWorkspace) {
    const recent = store.listBossTasks(preferredWorkspace).find((task) =>
      task.stages.length > 0
      && providerReady(task.decisionProvider)
      && runtimeModels(task.decisionProvider).includes(task.decisionModel),
    );
    if (recent) return { provider: recent.decisionProvider, model: recent.decisionModel };
    for (const worker of workers.values()) {
      if (!sameWorkspacePath(worker.runner.workspacePath, preferredWorkspace) || !providerReady(worker.runner.provider)) continue;
      const model = worker.runner.getModel();
      if (model && validModel(worker.runner.provider, model)) return { provider: worker.runner.provider, model };
    }
  }
  for (const provider of ["claude", "codex"] as const) {
    if (!providerReady(provider)) continue;
    const model = runtimeModels(provider)[0];
    if (model) return { provider, model };
  }
  return { error: "Claude 與 Codex 目前都無法進行部門判斷；請先登入至少一個 provider" };
}

function normalizeWorkspacePath(input: unknown): string {
  return canonicalWorkspacePath(input, config.targetRepoPath);
}

function normalizeManagedWorkspacePath(input: unknown): string {
  const canonical = normalizeWorkspacePath(input);
  const managedPaths = [config.targetRepoPath, ...[...workers.values()].map((worker) => worker.runner.workspacePath)];
  const managed = managedPaths.some((path) => sameWorkspace(path, canonical));
  if (!managed) throw new Error("只能管理目前已加入 Pixel Crew 的工作資料夾");
  return canonical;
}

function sameWorkspacePath(left: string, right: string): boolean {
  return sameWorkspace(left, right);
}

function recentWorkspacePaths(): string[] {
  return [...new Set([
    registryKey(config.targetRepoPath),
    ...[...workers.values()].map((worker) => worker.runner.workspacePath),
  ].filter(Boolean))];
}

function capabilitiesSnapshot(): Record<string, Record<ProviderId, ReturnType<CapabilityRegistry["getState"]>>> {
  return Object.fromEntries(recentWorkspacePaths().map((workspacePath) => [
    workspacePath,
    {
      claude: claudeCapabilitiesFor(workspacePath).getState(),
      codex: codexCapabilitiesFor(workspacePath).getState(),
    },
  ]));
}

function hasUnfinishedTurn(events: RunnerEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index--) {
    const type = events[index].type;
    if (type === "turn_end" || type === "error") return false;
    if (type === "user_message") return true;
  }
  return false;
}

function providerLabel(provider: ProviderId): string {
  return provider === "claude" ? "Claude Code" : "Codex";
}

function handoffActivityBlock(events: RunnerEvent[]): string | null {
  const pendingApprovals = new Set<string>();
  const openAgents = new Set<string>();
  for (const event of events) {
    if (event.type === "approval_requested") pendingApprovals.add(event.request.id);
    if (event.type === "approval_resolved") pendingApprovals.delete(event.id);
    if (event.type === "tool_call_start" && isAgentTool(event.name)) openAgents.add(event.id);
    if (event.type === "tool_call_result") {
      if (event.isError || !isAsyncAgentLaunch(event.output)) openAgents.delete(event.id);
    }
    if (event.type === "turn_end") {
      pendingApprovals.clear();
      openAgents.clear();
    }
    if (event.type === "error") {
      pendingApprovals.clear();
      openAgents.clear();
    }
  }
  if (pendingApprovals.size) return "仍有等待處理的權限確認，請先允許或拒絕";
  if (openAgents.size) return "仍有背景 Agent 執行中，請等待完成或先中止任務";
  return null;
}

function setHandoff(worker: Worker, progress: HandoffProgress, summary: HandoffSummary | null = null): void {
  worker.handoff = progress;
  store.saveProviderHandoff(worker.id, progress, summary);
  broadcast({ type: "worker_updated", worker: workerSummary(worker) });
}

async function workspaceGitState(workspacePath: string): Promise<string> {
  try {
    const [branch, head, status] = await Promise.all([
      execCli("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workspacePath, timeout: 5_000 }),
      execCli("git", ["rev-parse", "--short", "HEAD"], { cwd: workspacePath, timeout: 5_000 }),
      execCli("git", ["status", "--short"], { cwd: workspacePath, timeout: 5_000, maxBuffer: 200_000 }),
    ]);
    return `branch: ${branch.stdout.trim()}\nHEAD: ${head.stdout.trim()}\n${status.stdout.trim()}`.trim();
  } catch {
    return "目前工作位置不是可讀取的 Git repository，請接手後自行確認檔案狀態。";
  }
}

function detachedRunner(
  provider: ProviderId,
  workspacePath: string,
  model: string | null,
  initialState: { sessionId: string; completedTurns: number } | undefined,
  onEvent: (event: RunnerEvent) => void,
  persona: Persona | null,
): AgentSession {
  const runner: AgentSession = provider === "codex"
    ? new CodexSession(onEvent, workspacePath, () => composePersonaPrompt(persona), () => "off", initialState)
    : new ClaudeSession(onEvent, workspacePath, () => [], () => composePersonaPrompt(persona), () => "off", initialState);
  if (model && validModel(provider, model)) runner.setModel(model);
  return runner;
}

type DetachedTurnPolicy =
  | { kind: "normal" }
  | { kind: "no_tools" }
  | { kind: "read_only_query"; allowedTools: string[] };

function runDetachedTurn(
  provider: ProviderId,
  workspacePath: string,
  model: string | null,
  initialState: { sessionId: string; completedTurns: number } | undefined,
  persona: Persona | null,
  prompt: string,
  timeoutMs = 60_000,
  policy: DetachedTurnPolicy = { kind: "normal" },
): Promise<{
  text: string;
  state: { sessionId: string; completedTurns: number };
  toolCalls: Array<{ id: string; name: string; isError: boolean | null }>;
}> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let runner: AgentSession | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let streamedText = "";
    const toolCalls = new Map<string, { id: string; name: string; isError: boolean | null }>();
    const allowedQueryTools = new Set(policy.kind === "read_only_query" ? policy.allowedTools : []);
    const finish = (error?: Error, text = "") => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const state = runner?.getPersistenceState();
      runner?.stop();
      if (error) rejectPromise(error);
      else if (!state) rejectPromise(new Error("無法建立 LLM 交接工作階段"));
      else resolvePromise({ text, state, toolCalls: [...toolCalls.values()] });
    };
    runner = detachedRunner(provider, workspacePath, model, initialState, (event) => {
      if (event.type === "text_delta") streamedText += event.text;
      else if (event.type === "tool_call_start") {
        if (policy.kind === "no_tools") {
          finish(new Error("這個模型回合不得使用工具"));
          return;
        }
        if (policy.kind === "read_only_query") {
          const decision = queryToolPolicy(event.name, allowedQueryTools);
          if (!decision.allowed) {
            finish(new Error(`唯讀查詢已拒絕 ${event.name}：${decision.reason}`));
            return;
          }
        }
        toolCalls.set(event.id, { id: event.id, name: event.name, isError: null });
      }
      else if (event.type === "tool_call_result") {
        const existing = toolCalls.get(event.id);
        if (existing) toolCalls.set(event.id, { ...existing, isError: event.isError });
      }
      else if (event.type === "approval_requested" && policy.kind !== "read_only_query") finish(new Error("交接整理意外要求工具權限"));
      else if (event.type === "error") finish(new Error(event.message));
      else if (event.type === "turn_end") {
        if (event.isError) finish(new Error(event.resultText || "LLM 交接回合失敗"));
        else {
          const result = (event.resultText || streamedText).trim();
          if (!result) finish(new Error("LLM 沒有回傳交接內容"));
          else finish(undefined, result);
        }
      }
    }, persona);
    timer = setTimeout(() => finish(new Error("LLM 交接逾時")), timeoutMs);
    try {
      runner.send(prompt, [], [], policy.kind === "read_only_query"
        ? { executionProfile: "read_only_query", queryAllowedTools: policy.allowedTools }
        : undefined);
    } catch (error) {
      finish(error as Error);
    }
  });
}

async function performProviderHandoff(worker: Worker, progress: HandoffProgress): Promise<void> {
  const sourceProvider = progress.fromProvider;
  const sourceModel = worker.runner.getModel() ?? null;
  const workspacePath = worker.runner.workspacePath;
  const sourceName = worker.runner.name;
  let sourceState = worker.runner.getPersistenceState();
  let summary: HandoffSummary | null = null;
  let source: HandoffProgress["source"] = null;
  const hasHistory = worker.history.some((event) => event.type === "user_message");

  try {
    worker.runner.stop();

    // A completely empty NPC has no memory to summarize or bootstrap. Keep
    // the usage/auth gate, but switch to a fresh target session without
    // consuming an LLM turn or adding a synthetic task-log entry.
    if (!hasHistory) {
      if (!store.saveProviderCheckpoint(worker.id, sourceProvider, workspacePath, sourceModel, sourceState)) {
        throw new Error("無法保存原本的 LLM 工作階段");
      }
      const targetModel = progress.toModel || null;
      const targetRunner = createRunner(worker, progress.toProvider, workspacePath);
      targetRunner.name = sourceName;
      if (targetModel) targetRunner.setModel(targetModel);
      worker.runner = targetRunner;
      if (providerReady(progress.toProvider)) targetRunner.warmup();
      const completed = { ...progress, stage: "completed" as const, message: `${providerLabel(progress.toProvider)} 已切換`, source: null, error: null };
      worker.handoff = completed;
      if (!persistWorker(worker)) throw new Error("無法保存新的 LLM 工作階段");
      if (!store.saveProviderHandoff(worker.id, completed, null)) throw new Error("無法保存 LLM 切換紀錄");
      broadcast({ type: "worker_updated", worker: workerSummary(worker) });
      if (progress.toProvider === "claude") void claudeCapabilitiesFor(workspacePath).refresh();
      else void codexCapabilitiesFor(workspacePath).refresh();
      return;
    }

    const gitState = await workspaceGitState(workspacePath);
    const localSummary = buildLocalHandoff(worker.history, gitState);
    source = "agent";
    setHandoff(worker, { ...progress, stage: "summarizing", message: `請 ${providerLabel(sourceProvider)} 整理工作大綱`, source: null });
    const sourceUsage = await usageRegistry.refresh(sourceProvider, true);
    const sourceUsageError = usageBlockReason(sourceProvider, sourceUsage, sourceModel);
    try {
      if (sourceUsageError) throw new Error(sourceUsageError);
      const result = await runDetachedTurn(
        sourceProvider,
        workspacePath,
        sourceModel,
        sourceState,
        worker.persona,
        summaryPrompt(worker.history, localSummary),
      );
      sourceState = result.state;
      summary = parseHandoffSummary(result.text);
      if (!summary) throw new Error("來源 LLM 沒有回傳有效的交接格式");
    } catch (error) {
      source = "local_fallback";
      summary = localSummary;
      setHandoff(worker, { ...progress, stage: "fallback", message: `來源 LLM 無法整理，改用本機任務紀錄：${(error as Error).message}`, source });
    }

    if (!store.saveProviderCheckpoint(worker.id, sourceProvider, workspacePath, sourceModel, sourceState)) {
      throw new Error("無法保存原本的 LLM 工作階段");
    }
    setHandoff(worker, { ...progress, stage: "bootstrapping", message: `${providerLabel(progress.toProvider)} 正在讀取交接資料`, source });
    const checkpoint = store.loadProviderCheckpoint(worker.id, progress.toProvider, workspacePath);
    const targetModel = progress.toModel || checkpoint?.model || null;
    const targetResult = await runDetachedTurn(
      progress.toProvider,
      workspacePath,
      targetModel,
      checkpoint ? { sessionId: checkpoint.sessionId, completedTurns: checkpoint.completedTurns } : undefined,
      worker.persona,
      bootstrapPrompt(summary, recentConversation(worker.history), sourceProvider),
    );
    if (!store.saveProviderCheckpoint(worker.id, progress.toProvider, workspacePath, targetModel, targetResult.state)) {
      throw new Error("無法保存目標 LLM 工作階段");
    }

    const targetRunner = createRunner(worker, progress.toProvider, workspacePath, targetResult.state);
    targetRunner.name = sourceName;
    if (targetModel) targetRunner.setModel(targetModel);
    worker.runner = targetRunner;
    if (providerReady(progress.toProvider)) targetRunner.warmup();
    const completed = { ...progress, stage: "completed" as const, message: `${providerLabel(progress.toProvider)} 已接手`, source, error: null };
    worker.handoff = completed;
    if (!persistWorker(worker)) throw new Error("無法保存新的 LLM 工作階段");
    if (!store.saveProviderHandoff(worker.id, completed, summary)) throw new Error("無法保存 LLM 交接紀錄");
    record(worker, { type: "user_message", text: `LLM 交接：${providerLabel(sourceProvider)} → ${providerLabel(progress.toProvider)}` });
    record(worker, { type: "text_delta", text: `${summaryMarkdown(summary)}\n\n**接手確認**\n${targetResult.text}` });
    record(worker, { type: "turn_end", resultText: `${summaryMarkdown(summary)}\n\n接手確認：${targetResult.text}`, costUsd: 0, durationMs: 0, isError: false, permissionDenials: [] });
    broadcast({ type: "worker_updated", worker: workerSummary(worker) });
    if (progress.toProvider === "claude") void claudeCapabilitiesFor(workspacePath).refresh();
    else void codexCapabilitiesFor(workspacePath).refresh();
  } catch (error) {
    // The target runner may already have spawned during warmup. Always stop
    // whichever runner is currently attached before rebuilding the source.
    worker.runner.stop();
    const restored = createRunner(worker, sourceProvider, workspacePath, sourceState);
    restored.name = sourceName;
    if (sourceModel) restored.setModel(sourceModel);
    worker.runner = restored;
    if (providerReady(sourceProvider)) restored.warmup();
    const failed = { ...progress, stage: "failed" as const, message: "交接失敗，已恢復原本的 LLM", source, error: (error as Error).message };
    worker.handoff = failed;
    persistWorker(worker);
    store.saveProviderHandoff(worker.id, failed, summary);
    if (hasHistory) {
      record(worker, { type: "user_message", text: `LLM 交接：${providerLabel(sourceProvider)} → ${providerLabel(progress.toProvider)}` });
      record(worker, { type: "error", message: `交接失敗，已恢復 ${providerLabel(sourceProvider)}：${(error as Error).message}` });
    }
    broadcast({ type: "worker_updated", worker: workerSummary(worker) });
  }
}

wss.on("connection", (socket) => {
  for (const task of store.listBossTasksByStatus(["ready", "running"])) {
    advanceBossTask(task);
  }
  socket.send(
    JSON.stringify({
      type: "snapshot",
      targetRepoPath: config.targetRepoPath,
      system: systemStatus(),
      stats: {
        completedTurns: store.getCounter("completed_turns"),
        totalCostUsd: store.getCounter("total_cost_usd_micros") / 1_000_000,
      },
      updateInfo: updateChecker.getInfo(),
      workspacePaths: recentWorkspacePaths(),
      auth: Object.values(authStates),
      providerUsage: usageRegistry.getStates(),
      capabilitiesByWorkspace: capabilitiesSnapshot(),
      collaborations: store.listRecentCollaborationTasks(),
      missions: store.listDepartmentMissions(),
      bossTasks: store.listBossTasks().map(bossTaskForDisplay),
      departments: store.listDepartments(),
      workers: [...workers.values()].map((w) => ({
        ...workerSummary(w),
        events: w.history,
      })),
    }),
  );
});

app.get("/api/workers", (_req, res) => {
  res.json({ workers: [...workers.values()].map(workerSummary) });
});

app.get("/api/departments", (_req, res) => {
  res.json({ departments: store.listDepartments() });
});

app.patch("/api/departments/:departmentId", (req, res) => {
  const department = departments.get(req.params.departmentId);
  if (!department) {
    res.status(404).json({ error: "找不到部門" });
    return;
  }
  const name = normalizeDepartmentName(req.body?.name);
  if (!name) {
    res.status(400).json({ error: "請輸入部門名稱" });
    return;
  }
  const updated: Department = {
    ...department,
    name,
    updatedAt: new Date().toISOString(),
  };
  if (!store.saveDepartment(updated)) {
    res.status(500).json({ error: "無法儲存部門名稱" });
    return;
  }
  departments.set(updated.id, updated);
  broadcast({ type: "department_updated", department: updated });
  res.json({ department: updated });
});

app.get("/api/workspaces", (_req, res) => {
  res.json({ defaultPath: config.targetRepoPath, paths: recentWorkspacePaths() });
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, version: "0.1.0", platform: process.platform, arch: process.arch });
});

app.get("/api/system/status", (_req, res) => {
  const available = (command: string) => {
    const resolved = resolveExecutable(command);
    return resolved !== command || existsSync(resolved);
  };
  res.json({
    ...systemStatus(),
    providers: {
      claude: { installed: available(config.claudeBin) },
      codex: { installed: available(config.codexBin) },
    },
    git: { installed: available("git") },
    windows: process.platform === "win32" ? { codexSupport: "Windows 11 recommended; fully updated Windows 10 is best effort" } : null,
  });
});

app.post("/api/workspaces/validate", (req, res) => {
  try {
    res.json({ ok: true, path: normalizeWorkspacePath(req.body?.path) });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || "無法使用這個工作位置" });
  }
});

app.post("/api/workspaces/pick", async (_req, res) => {
  try {
    const result = await pickDirectory();
    if (result.canceled) {
      res.json({ canceled: true });
      return;
    }
    res.json({ path: normalizeWorkspacePath(result.path) });
  } catch (error: any) {
    res.status(process.platform === "darwin" || process.platform === "win32" ? 500 : 501)
      .json({ error: "無法開啟系統資料夾選擇器，請改用絕對路徑" });
  }
});

app.get("/api/capabilities", (req, res) => {
  try {
    const workspacePath = normalizeManagedWorkspacePath(req.query.workspacePath);
    res.json({
      workspacePath,
      capabilities: {
        claude: claudeCapabilitiesFor(workspacePath).getState(),
        codex: codexCapabilitiesFor(workspacePath).getState(),
      },
    });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || "無法讀取房間能力" });
  }
});

app.get("/api/commands", async (req, res) => {
  try {
    const workspacePath = normalizeManagedWorkspacePath(req.query.workspacePath);
    res.json({ commands: await listProjectCommands(workspacePath), workspacePath });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || "無法讀取專案指令" });
  }
});

app.put("/api/commands", async (req, res) => {
  try {
    const workspacePath = normalizeManagedWorkspacePath(req.body?.workspacePath);
    const command = await saveProjectCommand(
      workspacePath,
      String(req.body?.name ?? ""),
      String(req.body?.content ?? ""),
      req.body?.originalName ? String(req.body.originalName) : undefined,
    );
    restartIdleWorkers("claude", workspacePath);
    void claudeCapabilitiesFor(workspacePath).refresh(true).catch((error) => {
      console.error("failed to refresh Claude capabilities after saving a command", error);
    });
    // CommandCenter's own list view refetches on `workflowRevisions` changes,
    // which otherwise only update on WorkflowLibraryWatcher's ~1.5s poll —
    // rescan now so the tab that just saved (and any other open tab) reflect
    // it immediately instead of waiting out the interval.
    void workflowWatcher.scanNow();
    res.json({ command });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || "無法儲存專案指令" });
  }
});

app.delete("/api/commands", async (req, res) => {
  try {
    const workspacePath = normalizeManagedWorkspacePath(req.body?.workspacePath);
    await deleteProjectCommand(workspacePath, String(req.body?.name ?? ""));
    restartIdleWorkers("claude", workspacePath);
    void claudeCapabilitiesFor(workspacePath).refresh(true).catch((error) => {
      console.error("failed to refresh Claude capabilities after deleting a command", error);
    });
    void workflowWatcher.scanNow();
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || "無法刪除專案指令" });
  }
});

app.get("/api/skills", async (req, res) => {
  try {
    const workspacePath = normalizeManagedWorkspacePath(req.query.workspacePath);
    res.json({ skills: await listProjectSkills(workspacePath), workspacePath });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || "無法讀取 Codex Skills" });
  }
});

app.put("/api/skills", async (req, res) => {
  try {
    const workspacePath = normalizeManagedWorkspacePath(req.body?.workspacePath);
    const skill = await saveProjectSkill(
      workspacePath,
      String(req.body?.name ?? ""),
      String(req.body?.content ?? ""),
      req.body?.originalName ? String(req.body.originalName) : undefined,
    );
    restartIdleWorkers("codex", workspacePath);
    // Codex skills aren't part of CodexCapabilityRegistry (they're `$`
    // triggered, not part of the fixed slash-command set) — the only signal
    // any tab's CodexSkillCenter has for "the list changed" is
    // WorkflowLibraryWatcher's revision counter, so rescan now instead of
    // waiting out its ~1.5s poll.
    void workflowWatcher.scanNow();
    res.json({ skill });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || "無法儲存 Codex Skill" });
  }
});

app.delete("/api/skills", async (req, res) => {
  try {
    const workspacePath = normalizeManagedWorkspacePath(req.body?.workspacePath);
    await deleteProjectSkill(workspacePath, String(req.body?.name ?? ""));
    restartIdleWorkers("codex", workspacePath);
    void workflowWatcher.scanNow();
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || "無法刪除 Codex Skill" });
  }
});

app.get("/api/auth", (_req, res) => {
  res.json({ auth: Object.values(authStates) });
});

app.get("/api/usage", (_req, res) => {
  res.json({ usage: usageRegistry.getStates() });
});

app.post("/api/usage/refresh", async (_req, res) => {
  res.json({ usage: await usageRegistry.refreshAll(true) });
});

app.post("/api/auth/refresh", async (req, res) => {
  const requested = String(req.body?.provider ?? "");
  const provider = requested === "claude" || requested === "codex" ? requested : undefined;
  const auth = await refreshAuth(provider);
  res.json({ auth });
});

function requestedProvider(value: unknown): ProviderId | null {
  return value === "claude" || value === "codex" ? value : null;
}

app.get("/api/providers/:provider/install", (req, res) => {
  const provider = requestedProvider(req.params.provider);
  if (!provider) {
    res.status(400).json({ error: "不支援的 AI provider" });
    return;
  }
  res.json({ install: providerInstaller.get(provider) });
});

app.post("/api/providers/:provider/install", (req, res) => {
  if (!isAllowedLoopbackOrigin(req.headers.origin)) {
    res.status(403).json({ error: "安裝只能從本機 Pixel Crew 介面啟動" });
    return;
  }
  const provider = requestedProvider(req.params.provider);
  if (!provider) {
    res.status(400).json({ error: "不支援的 AI provider" });
    return;
  }
  if (authStates[provider].status === "authenticated") {
    res.status(409).json({ error: `${authStates[provider].displayName} 已經可以使用` });
    return;
  }
  res.status(202).json({ install: providerInstaller.start(provider) });
});

app.post("/api/workers", (req, res) => {
  if (workers.size >= MAX_WORKERS) {
    res.status(409).json({ error: `NPC 已達上限（最多 ${MAX_WORKERS} 位）` });
    return;
  }
  const provider: ProviderId = req.body?.provider === "codex" ? "codex" : "claude";
  try {
    const workspacePath = normalizeWorkspacePath(req.body?.workspacePath);
    if (workspaceMission(workspacePath)) {
      res.status(409).json({ error: "這個部門正在執行 Department Mission，暫時不能加入新 NPC" });
      return;
    }
    const worker = createWorker(
      req.body?.name,
      String(req.body?.model ?? ""),
      provider,
      workspacePath,
      undefined,
      null,
      null,
      { warmup: true },
    );
    if (provider === "claude") void claudeCapabilitiesFor(workspacePath).refresh();
    else void codexCapabilitiesFor(workspacePath).refresh();
    res.json(workerSummary(worker));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || "無法使用這個工作位置" });
  }
});

type PreparedDepartment = {
  provider: ProviderId;
  workspacePath: string;
  purpose: string;
  plan: DepartmentPlan;
  workerCount: number;
  expiresAt: number;
};
const preparedDepartments = new Map<string, PreparedDepartment>();

app.post("/api/departments/plan", async (req, res) => {
  const provider: ProviderId = req.body?.provider === "codex" ? "codex" : "claude";
  const purpose = normalizeDepartmentPurpose(req.body?.purpose);
  const count = Number(req.body?.count);
  if (!purpose) {
    res.status(400).json({ error: "請輸入部門用途，例如：產品開發、QA 或資安稽核" });
    return;
  }
  if (!Number.isInteger(count) || count < 1 || count > MAX_WORKERS - workers.size) {
    res.status(400).json({ error: `NPC 數量需為 1 到 ${Math.max(0, MAX_WORKERS - workers.size)} 位` });
    return;
  }
  if (!providerReady(provider)) {
    res.status(503).json({ error: `${providerLabel(provider)} 尚未登入，登入後才能規劃部門`, auth: authStates[provider] });
    return;
  }
  try {
    const workspacePath = normalizeWorkspacePath(req.body?.workspacePath);
    if (workspaceMission(workspacePath)) {
      res.status(409).json({ error: "這個工作位置正在執行部門工作，暫時不能建立新部門" });
      return;
    }
    const existingMembers = [...workers.values()]
      .filter((member) => sameWorkspacePath(member.runner.workspacePath, workspacePath))
      .map((member) => ({ name: member.runner.name, role: member.persona?.role || null }));
    const prompt = departmentPlanPrompt({ purpose, count, workspacePath, existingMembers });
    let result;
    try {
      result = await runDetachedTurn(provider, workspacePath, null, undefined, null, prompt, 75_000);
    } catch {
      // One bounded retry stays on the owner-selected Provider and its default
      // model. Never cross Providers implicitly: that changes cost and policy.
      result = await runDetachedTurn(provider, workspacePath, null, undefined, null, prompt, 75_000);
    }
    const plan = parseDepartmentPlan(result.text, count);
    const existingNames = new Set([...workers.values()].map((member) => member.runner.name.toLocaleLowerCase()));
    if (!plan || plan.members.some((member) => existingNames.has(member.name.toLocaleLowerCase()))) {
      res.status(502).json({ error: "AI 回傳的部門名單不完整或名稱重複，請重新規劃" });
      return;
    }
    for (const [token, prepared] of preparedDepartments) {
      if (prepared.expiresAt < Date.now()) preparedDepartments.delete(token);
    }
    const planToken = randomUUID();
    preparedDepartments.set(planToken, {
      provider,
      workspacePath,
      purpose,
      plan,
      workerCount: workers.size,
      expiresAt: Date.now() + 5 * 60_000,
    });
    res.json({ planToken, provider, workspacePath, purpose, plan });
  } catch (error) {
    res.status(502).json({ error: (error as Error).message || "AI 暫時無法規劃部門" });
  }
});

app.post("/api/departments", (req, res) => {
  const token = String(req.body?.planToken ?? "");
  const prepared = preparedDepartments.get(token);
  if (!prepared || prepared.expiresAt < Date.now()) {
    preparedDepartments.delete(token);
    res.status(409).json({ error: "部門規劃已過期，請重新產生" });
    return;
  }
  if (workers.size !== prepared.workerCount || workers.size + prepared.plan.members.length > MAX_WORKERS) {
    res.status(409).json({ error: "NPC 名單已變動，請重新規劃部門" });
    return;
  }
  if (workspaceMission(prepared.workspacePath)) {
    res.status(409).json({ error: "這個工作位置正在執行部門工作" });
    return;
  }
  const requestedMembers: unknown[] = Array.isArray(req.body?.members) ? req.body.members as unknown[] : prepared.plan.members;
  if (requestedMembers.length !== prepared.plan.members.length) {
    res.status(400).json({ error: "編輯後的 NPC 數量必須與 AI 規劃一致" });
    return;
  }
  const normalizedMembers = requestedMembers.map((candidate: unknown) => {
    const value = candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : {};
    return {
      name: collaborationText(value.name, 80),
      persona: normalizePersona({ role: value.role, instructions: value.instructions }),
      provider: prepared.provider,
      model: undefined,
    };
  });
  const names = normalizedMembers.map((member) => member.name.toLocaleLowerCase());
  const existingNames = new Set([...workers.values()].map((member) => member.runner.name.toLocaleLowerCase()));
  if (normalizedMembers.some((member) => !member.name || !member.persona)
    || new Set(names).size !== names.length || names.some((name) => existingNames.has(name))) {
    res.status(400).json({ error: "請確認每位 NPC 都有不重複的姓名、職位與個性" });
    return;
  }
  const unavailableProvider = normalizedMembers.find((member) => !providerReady(member.provider))?.provider;
  if (unavailableProvider) {
    res.status(503).json({ error: `${providerLabel(unavailableProvider)} 尚未登入` });
    return;
  }
  const leadIndex = Number(req.body?.leadIndex ?? 0);
  if (!Number.isInteger(leadIndex) || leadIndex < 0 || leadIndex >= normalizedMembers.length) {
    res.status(400).json({ error: "請指定一位部門主管" });
    return;
  }
  const departmentId = randomUUID();
  const now = new Date().toISOString();
  const created = normalizedMembers.map((member) => createWorker(
    member.name,
    member.model,
    member.provider,
    prepared.workspacePath,
    undefined,
    member.persona,
    departmentId,
    { warmup: false, persist: false, broadcast: false },
  ));
  const department: Department = {
    id: departmentId,
    name: normalizeDepartmentName(req.body?.name) || `${prepared.purpose.slice(0, 20)}部門`,
    purpose: prepared.purpose,
    workspacePath: prepared.workspacePath,
    leadWorkerId: created[leadIndex].id,
    memberWorkerIds: created.map((worker) => worker.id),
    createdAt: now,
    updatedAt: now,
  };
  if (!store.saveDepartmentWithWorkers(department, created.map(workerPersistenceRecord))) {
    for (const worker of created) {
      worker.runner.stop();
      workers.delete(worker.id);
    }
    res.status(500).json({ error: "部門建立失敗，沒有新增任何 NPC" });
    return;
  }
  departments.set(department.id, department);
  preparedDepartments.delete(token);
  broadcast({ type: "department_created", department });
  for (const worker of created) broadcast({ type: "worker_added", worker: workerSummary(worker) });
  if (prepared.provider === "claude") void claudeCapabilitiesFor(prepared.workspacePath).refresh();
  else void codexCapabilitiesFor(prepared.workspacePath).refresh();
  res.json({
    purpose: prepared.purpose,
    department,
    workers: created.map(workerSummary),
  });
});

// Must be registered before /api/workers/:id or Express treats "order" as an id.
app.patch("/api/workers/order", (req, res) => {
  const order = req.body?.order;
  const valid = Array.isArray(order)
    && order.length === workers.size
    && new Set(order).size === order.length
    && order.every((id) => typeof id === "string" && workers.has(id));
  if (!valid) {
    res.status(409).json({ error: "人員清單已變動，請重試" });
    return;
  }
  if (!store.saveWorkerOrder(order as string[])) {
    res.status(500).json({ error: "無法儲存人員順序" });
    return;
  }
  const reordered = (order as string[]).map((id) => [id, workers.get(id)!] as const);
  workers.clear();
  for (const [id, worker] of reordered) workers.set(id, worker);
  broadcast({ type: "workers_reordered", order });
  res.json({ order });
});

app.patch("/api/workers/:id", (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) {
    res.status(404).json({ error: "unknown worker" });
    return;
  }
  if (handoffInProgress(worker) || collaborationInProgress(worker.id) || missionInProgress(worker.id)) {
    res.status(409).json({ error: "NPC 正在進行 LLM 交接、協作或部門 Mission，暫時不能改名" });
    return;
  }
  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "名稱不能是空白" });
    return;
  }
  if (name.length > 24) {
    res.status(400).json({ error: "名稱最多 24 個字元" });
    return;
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    res.status(400).json({ error: "名稱包含不支援的控制字元" });
    return;
  }
  worker.runner.name = name;
  persistWorker(worker);
  const summary = workerSummary(worker);
  broadcast({ type: "worker_updated", worker: summary });
  res.json(summary);
});

app.get("/api/avatars/:id", async (req, res) => {
  try {
    const avatar = await avatarStore.read(req.params.id);
    if (!avatar) {
      res.status(404).json({ error: "找不到角色圖片" });
      return;
    }
    res.set({
      "Content-Type": avatar.mimeType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    });
    res.send(avatar.data);
  } catch (error) {
    console.warn("Read avatar failed:", (error as Error).message);
    res.status(500).json({ error: "無法讀取角色圖片" });
  }
});

app.put("/api/workers/:id/avatar", async (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) {
    res.status(404).json({ error: "unknown worker" });
    return;
  }
  try {
    const previousId = worker.avatarId;
    const previousKind = worker.avatarKind;
    const avatarId = await avatarStore.save(req.body?.dataBase64 ?? req.body?.pngBase64, req.body?.mimeType ?? "image/png");
    worker.avatarId = avatarId;
    worker.avatarKind = "custom";
    if (!persistWorker(worker)) {
      worker.avatarId = previousId;
      worker.avatarKind = previousKind;
      await avatarStore.delete(avatarId);
      res.status(500).json({ error: "無法將角色圖片寫入本機資料庫" });
      return;
    }
    const summary = workerSummary(worker);
    broadcast({ type: "worker_updated", worker: summary });
    res.json(summary);
    if (previousId) await deleteAvatarIfUnused(previousId);
  } catch (error) {
    if (error instanceof AvatarValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.warn("Save avatar failed:", (error as Error).message);
    res.status(500).json({ error: "無法儲存角色圖片" });
  }
});

app.get("/api/backup/export", async (_req, res) => {
  const stagingDir = join(config.dataDirectory, `.export-${randomUUID()}`);
  try {
    // Force the ~150ms debounce queue to disk and the WAL back into the
    // main file, so a plain copy of dbPath alone is a complete snapshot.
    store.flush();
    store.checkpoint();
    stageExportDirectory({ dbPath: config.dbPath, avatarDir: config.avatarDir }, stagingDir);
    const filename = `pixel-crew-backup-${new Date().toISOString().slice(0, 10)}.tar.gz`;
    res.set({
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Content-Type-Options": "nosniff",
    });
    const stream = tar.create({ gzip: true, cwd: stagingDir, portable: true } as any, ["manifest.json", "db", "avatars"]);
    stream.on("error", (err: unknown) => {
      console.warn("Backup export stream failed:", (err as Error).message);
      res.destroy(err as Error);
    });
    res.on("close", () => rmSync(stagingDir, { recursive: true, force: true }));
    (stream as unknown as NodeJS.ReadableStream).pipe(res);
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    console.warn("Backup export failed:", (error as Error).message);
    if (!res.headersSent) res.status(500).json({ error: "無法建立備份檔案" });
    else res.destroy();
  }
});

const uploadBackup = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      try {
        const dir = join(config.dataDirectory, `.import-upload-${randomUUID()}`);
        ensurePrivateDirectorySync(dir);
        cb(null, dir);
      } catch (error) {
        cb(error as Error, "");
      }
    },
    filename: (_req, _file, cb) => cb(null, "upload.tar.gz"),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
});

app.post("/api/backup/import/validate", uploadBackup.single("backup"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "缺少備份檔案" });
    return;
  }
  const uploadDir = dirname(req.file.path);
  const stagingDir = join(config.dataDirectory, `.import-staged-${randomUUID()}`);
  try {
    const result = await extractAndValidateBackup(req.file.path, stagingDir);
    const token = randomUUID();
    pendingImports.set(token, { stagingDir, createdAt: Date.now() });
    // Auto-discard an abandoned validation (uploaded but never confirmed)
    // so its staging directory doesn't linger indefinitely.
    setTimeout(() => discardPendingImport(token), 10 * 60_000).unref();
    res.json({ importToken: token, ...result });
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    const message = error instanceof BackupValidationError ? error.message : "備份檔案驗證失敗";
    res.status(400).json({ error: message });
  } finally {
    rmSync(uploadDir, { recursive: true, force: true });
  }
});

app.delete("/api/backup/import/:token", (req, res) => {
  discardPendingImport(req.params.token);
  res.status(204).end();
});

app.post("/api/backup/import/commit", async (req, res) => {
  const importToken = req.body?.importToken;
  const confirmPhrase = req.body?.confirmPhrase;
  const pending = typeof importToken === "string" ? pendingImports.get(importToken) : undefined;
  if (!pending) {
    res.status(410).json({ error: "備份檢查已過期，請重新上傳" });
    return;
  }
  if (confirmPhrase !== "RESTORE") {
    res.status(400).json({ error: "確認文字不正確" });
    return;
  }
  if (maintenanceMode) {
    res.status(409).json({ error: "已有還原正在進行" });
    return;
  }

  maintenanceMode = true;
  for (const worker of workers.values()) worker.runner.stop();
  for (const client of wss.clients) client.terminate();

  const paths = { dbPath: config.dbPath, avatarDir: config.avatarDir };
  const snapshotDir = join(config.dataDirectory, `pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  let exitCode = 0;
  let responseBody: { ok: boolean; message: string; preRestoreSnapshot?: string };
  try {
    // Checkpoint-then-close is the real point of no return: once the live
    // DB handle is gone, this process cannot safely keep serving anything
    // that depends on `store`, whether the swap that follows succeeds or
    // has to roll back — both outcomes past this point end in process exit.
    store.flush();
    store.checkpoint();
    store.close();
    try {
      snapshotCurrentData(paths, snapshotDir);
      try {
        swapInRestoredData(paths, pending.stagingDir);
        writeRestoreMarker(config.dataDirectory, { success: true, at: new Date().toISOString(), snapshotDir });
        responseBody = { ok: true, message: "還原完成，請重新啟動 Pixel Crew", preRestoreSnapshot: snapshotDir };
      } catch (swapError) {
        restoreFromSnapshot(paths, snapshotDir);
        writeRestoreMarker(config.dataDirectory, { success: false, at: new Date().toISOString(), message: (swapError as Error).message, snapshotDir });
        exitCode = 1;
        responseBody = { ok: false, message: "還原失敗，已還原成原本的資料，請重新啟動 Pixel Crew 後再試一次" };
      }
    } catch (error) {
      writeRestoreMarker(config.dataDirectory, { success: false, at: new Date().toISOString(), message: (error as Error).message, snapshotDir: null });
      exitCode = 1;
      responseBody = { ok: false, message: "還原失敗，請重新啟動 Pixel Crew 後再試一次" };
    }
  } finally {
    discardPendingImport(importToken);
  }
  let exitScheduled = false;
  const scheduleExit = () => {
    if (exitScheduled) return;
    exitScheduled = true;
    setImmediate(() => process.exit(exitCode));
  };
  // `finish` is the normal response-completed path; `close` covers a client
  // disconnect after the live store has already been closed/swapped. Either
  // way this process must relaunch before it can safely serve more requests.
  res.once("finish", scheduleExit);
  res.once("close", scheduleExit);
  res.status(exitCode === 0 ? 200 : 500).json(responseBody);
});

app.put("/api/workers/:id/avatar-preset", (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) {
    res.status(404).json({ error: "unknown worker" });
    return;
  }
  const presetId = typeof req.body?.presetId === "string" ? req.body.presetId.trim() : "";
  if (!AVATAR_PRESET_IDS.has(presetId)) {
    res.status(400).json({ error: "未知的官方角色" });
    return;
  }
  const previousKind = worker.avatarKind;
  const previousPresetId = worker.avatarPresetId;
  worker.avatarKind = "preset";
  worker.avatarPresetId = presetId;
  if (!persistWorker(worker)) {
    worker.avatarKind = previousKind;
    worker.avatarPresetId = previousPresetId;
    res.status(500).json({ error: "無法更新本機角色設定" });
    return;
  }
  const summary = workerSummary(worker);
  broadcast({ type: "worker_updated", worker: summary });
  res.json(summary);
});

app.post("/api/workers/:id/avatar/custom", (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) {
    res.status(404).json({ error: "unknown worker" });
    return;
  }
  if (!worker.avatarId) {
    res.status(409).json({ error: "尚未上傳自訂角色" });
    return;
  }
  const previousKind = worker.avatarKind;
  worker.avatarKind = "custom";
  if (!persistWorker(worker)) {
    worker.avatarKind = previousKind;
    res.status(500).json({ error: "無法更新本機角色設定" });
    return;
  }
  const summary = workerSummary(worker);
  broadcast({ type: "worker_updated", worker: summary });
  res.json(summary);
});

app.delete("/api/workers/:id/avatar", async (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) {
    res.status(404).json({ error: "unknown worker" });
    return;
  }
  const previousId = worker.avatarId;
  const previousKind = worker.avatarKind;
  const previousPresetId = worker.avatarPresetId;
  worker.avatarId = null;
  worker.avatarKind = "preset";
  worker.avatarPresetId = "classic";
  if (!persistWorker(worker)) {
    worker.avatarId = previousId;
    worker.avatarKind = previousKind;
    worker.avatarPresetId = previousPresetId;
    res.status(500).json({ error: "無法更新本機角色設定" });
    return;
  }
  const summary = workerSummary(worker);
  broadcast({ type: "worker_updated", worker: summary });
  res.json(summary);
  if (previousId) await deleteAvatarIfUnused(previousId);
});

app.patch("/api/workers/:id/provider", (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) {
    res.status(404).json({ error: "unknown worker" });
    return;
  }
  const provider: ProviderId = req.body?.provider === "codex" ? "codex" : "claude";
  if (provider === worker.runner.provider) {
    res.json(workerSummary(worker));
    return;
  }
  res.status(409).json({ error: "切換 LLM 必須先檢查工作能量並確認交接風險，請使用交接流程" });
});

type PreparedMission = {
  bossWorkerId: string;
  workspacePath: string;
  objective: string;
  acceptanceCriteria: string[];
  attachmentIds: string[];
  parentMissionId: string | null;
  sourceMessageId: string | null;
  memberStates: Array<{ id: string; sessionId: string; historyLength: number }>;
  expiresAt: number;
};
const preparedMissions = new Map<string, PreparedMission>();

function launchDepartmentMission(
  boss: Worker,
  members: Worker[],
  objective: string,
  acceptanceCriteria: string[],
  options: {
    attachmentIds?: string[];
    parentMissionId?: string | null;
    sourceMessageId?: string | null;
    executionMode?: MissionExecutionMode;
    origin?: DepartmentMission["origin"];
  } = {},
): { mission?: DepartmentMission; error?: string } {
  const now = new Date().toISOString();
  const attachmentIds = [...new Set(options.attachmentIds ?? [])];
  const mission: DepartmentMission = {
    id: randomUUID(),
    departmentId: boss.departmentId,
    workspacePath: boss.runner.workspacePath,
    bossWorkerId: boss.id,
    objective,
    acceptanceCriteria,
    status: "planning",
    planSummary: null,
    steps: [],
    currentStepIndex: null,
    correctionCount: 0,
    maxCorrections: options.executionMode === "research" ? 0 : 2,
    error: null,
    createdAt: now,
    startedAt: now,
    completedAt: null,
    attentionReason: null,
    planApprovedAt: null,
    ownerGuidance: null,
    formatRepairCount: 0,
    attachmentIds,
    parentMissionId: options.parentMissionId ?? null,
    sourceMessageId: options.sourceMessageId ?? null,
    executionMode: options.executionMode ?? "project",
    origin: options.origin ?? "department",
  };
  activeMissions.set(mission.id, mission);
  if (!store.saveDepartmentMission(mission)) {
    activeMissions.delete(mission.id);
    return { error: "無法保存 Department Mission" };
  }
  updateDepartmentThreadMission(mission.departmentId, mission.id);
  departmentAudit("mission_created", mission.departmentId, mission.id, {
    objective: mission.objective,
    attachmentIds,
    parentMissionId: mission.parentMissionId,
  });
  broadcastMission(mission, true);
  const attachmentMetadata = resolveAttachmentMetadata(attachmentIds);
  const prompt = missionPlanningPrompt({
    missionId: mission.id,
    bossWorkerId: mission.bossWorkerId,
    objective: mission.objective,
    acceptanceCriteria: mission.acceptanceCriteria,
    workspacePath: mission.workspacePath,
    members: members.map((member) => ({
      id: member.id,
      name: member.runner.name,
      role: member.persona?.role || null,
      provider: member.runner.provider,
    })),
    attachments: attachmentMetadata,
    executionMode: mission.executionMode ?? "project",
  });
  const planningAttachments = attachmentRepository.load(attachmentIds);
  attachmentRepository.markDelivery(attachmentIds, mission.id, boss.id, "pending");
  try {
    sendMissionRunner(
      mission,
      boss,
      prompt,
      `老闆交辦 · AI 依職務分工：${mission.objective}`,
      planningAttachments.images,
      planningAttachments.documents,
      { executionProfile: "read_only_collaboration" },
    );
    attachmentRepository.markDelivery(attachmentIds, mission.id, boss.id, "delivered");
  } catch (error) {
    const message = (error as Error).message || "無法啟動 Mission 規劃";
    attachmentRepository.markDelivery(attachmentIds, mission.id, boss.id, "failed", message);
    appendMissionExecutionEvent(mission, boss.id, null, { type: "error", message });
    failMission(mission, message);
    return { mission, error: message };
  }
  return { mission };
}

function missionDepartmentEligibility(boss: Worker): { members?: Worker[]; error?: string } {
  if (workspaceMission(boss.runner.workspacePath, boss.departmentId)) return { error: "這個部門已有進行中或待決定的 Mission" };
  const members = [...workers.values()].filter((worker) => boss.departmentId
    ? worker.departmentId === boss.departmentId
    : sameWorkspacePath(worker.runner.workspacePath, boss.runner.workspacePath));
  if (members.length < 1) return { error: "部門目前沒有可執行工作的 NPC" };
  if (boss.runner.busy || handoffInProgress(boss) || collaborationInProgress(boss.id)) return { error: `${boss.runner.name} 正在工作、交接或協作中` };
  if (handoffActivityBlock(boss.history)) return { error: `${boss.runner.name} 尚有待處理的權限或背景 Agent` };
  if (!providerReady(boss.runner.provider)) return { error: `${providerLabel(boss.runner.provider)} 尚未登入` };
  return { members };
}

function departmentMissions(department: Department): DepartmentMission[] {
  const clearedAt = store.getDepartmentThread(department.id)?.historyClearedAt ?? null;
  return store.listDepartmentMissions(department.workspacePath, 200)
    .filter((mission) => mission.departmentId === department.id && mission.origin !== "boss")
    .filter((mission) => !clearedAt || mission.createdAt > clearedAt)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function classifyDepartmentMessage(input: {
  department: Department;
  lead: Worker;
  thread: DepartmentThread;
  message: string;
  attachmentNames: string[];
  activeMission: DepartmentMission | null;
  latestCompletedMission: DepartmentMission | null;
}): Promise<IntentClassification> {
  const recent = visibleDepartmentMessages(input.thread, 24);
  const prompt = intentClassificationPrompt({
    departmentName: input.department.name,
    departmentPurpose: input.department.purpose,
    activeMission: input.activeMission ? {
      id: input.activeMission.id,
      objective: input.activeMission.objective,
      status: input.activeMission.status,
    } : null,
    latestCompletedMission: input.latestCompletedMission ? {
      id: input.latestCompletedMission.id,
      objective: input.latestCompletedMission.objective,
    } : null,
    threadSummary: input.thread.summary,
    recentMessages: recent.map(({ role, text }) => ({ role, text })),
    message: input.message,
    attachmentNames: input.attachmentNames,
  });
  try {
    let output = (await runDetachedTurn(
      input.lead.runner.provider,
      input.department.workspacePath,
      input.lead.runner.getModel() ?? null,
      undefined,
      input.lead.persona,
      prompt,
      60_000,
      { kind: "no_tools" },
    )).text;
    let classification = parseIntentClassification(output);
    if (!classification) {
      output = (await runDetachedTurn(
        input.lead.runner.provider,
        input.department.workspacePath,
        input.lead.runner.getModel() ?? null,
        undefined,
        input.lead.persona,
        `${prompt}\n\n前次格式無效。只能回傳一個合法的 <department_intent> JSON 標記。`,
        60_000,
        { kind: "no_tools" },
      )).text;
      classification = parseIntentClassification(output);
    }
    if (classification) return classification;
  } catch {
    // A classifier outage must not guess a routing decision.
  }
  return {
    intent: "system",
    confidence: 0,
    reason: "無法可靠判斷這則訊息要詢問、修改目前工作，或建立後續 Mission",
    changeImpact: "none",
    clarificationQuestion: "請再說明這是要詢問目前結果、補充進行中的工作，還是建立一項新的交辦？",
  };
}

async function answerDepartmentQuestion(input: {
  department: Department;
  lead: Worker;
  thread: DepartmentThread;
  mission: DepartmentMission | null;
  question: string;
}): Promise<{ text: string; toolsUsed: string[] }> {
  if (input.lead.runner.provider === "codex") {
    try {
      const discovered = await (input.lead.runner as CodexSession).listMcpServerTools();
      if (discovered.ok) codexCapabilitiesFor(input.department.workspacePath).mergeMcpTools(discovered.servers);
    } catch {
      // Use the last live catalog. A query can still answer from bounded
      // department context and local read-only inspection when MCP discovery
      // is temporarily unavailable.
    }
  }
  const capabilities = input.lead.runner.provider === "codex"
    ? codexCapabilitiesFor(input.department.workspacePath).getState()
    : claudeCapabilitiesFor(input.department.workspacePath).getState();
  const allowedTools = readOnlyMcpToolNames(capabilities);
  if (input.lead.runner.provider === "codex") {
    // Unlike Claude's --allowedTools, Codex's app-server has no way to refuse
    // an MCP tool call before it executes (handleServerRequest only gates
    // commandExecution/fileChange/permissions RPCs) — the after-the-fact
    // tool_call_start check in runDetachedTurn can only abort the turn, not
    // undo an MCP call that already ran. If any connected MCP tool isn't
    // verified read-only, fail closed instead of silently risking a mutation.
    const totalMcpToolCount = capabilities.mcpServers.reduce((sum, server) => sum + (server.tools?.length ?? 0), 0);
    if (totalMcpToolCount > allowedTools.length) {
      return {
        text: "此部門設定了非唯讀的 MCP 工具，Codex 目前無法在執行前攔截個別 MCP 呼叫，因此無法安全地進行唯讀查詢。請改用 Claude 主管回答，或移除非唯讀 MCP 工具後再試一次。",
        toolsUsed: [],
      };
    }
  }
  const context = boundedDepartmentContext({
    threadSummary: input.thread.summary,
    missionSummary: input.mission
      ? `${input.mission.objective}\n${input.mission.planSummary ?? ""}\n狀態：${input.mission.status}`
      : "目前沒有可供追問的 Mission。",
    recentMessages: visibleDepartmentMessages(input.thread, 24),
    workingContext: input.mission?.ownerGuidance ?? "",
  });
  const queryContract = `\n\n唯讀查詢工具契約：
- 必要時使用內建唯讀檢查或下列已驗證的 MCP 查詢工具取得即時資料：${JSON.stringify(allowedTools)}
- 不可使用清單以外的 MCP 工具，不可修改檔案、repository、外部服務或任何系統狀態。
- 不要聲稱部門角色不能使用工具。若缺少合適的唯讀工具，直接說明目前沒有可安全查詢該資料來源的工具。
- 不可把對話、Mission 報告或記憶中的舊資料冒充即時查詢結果。`;
  const prompt = input.mission
    ? `${missionFollowUpPrompt(input.mission, input.question)}\n\n以下是有界限的部門對話脈絡：\n${context}`
    : `你是 ${input.department.name} 的部門主管。回答老闆的問題；需要即時資料時執行必要的唯讀查詢，不可修改任何狀態。\n${context}\n\n老闆問題：${input.question}`;
  const result = await runDetachedTurn(
    input.lead.runner.provider,
    input.department.workspacePath,
    input.lead.runner.getModel() ?? null,
    undefined,
    input.lead.persona,
    `${prompt}${queryContract}`,
    60_000,
    { kind: "read_only_query", allowedTools },
  );
  return {
    text: result.text,
    toolsUsed: [...new Set(result.toolCalls.filter((tool) => tool.isError !== true).map((tool) => tool.name))],
  };
}

app.get("/api/departments/:departmentId/thread", (req, res) => {
  const department = departments.get(req.params.departmentId);
  if (!department) { res.status(404).json({ error: "找不到部門" }); return; }
  res.json({
    ...departmentThreadPayload(department.id),
    missions: departmentMissions(department),
    audit: store.listAuditEvents(department.id),
  });
});

app.post("/api/departments/:departmentId/messages", async (req, res) => {
  const department = departments.get(req.params.departmentId);
  const lead = department ? workers.get(department.leadWorkerId) : null;
  if (!department || !lead) { res.status(404).json({ error: "找不到部門或部門主管" }); return; }
  const thread = ensureDepartmentThread(department.id);
  const clientMessageId = collaborationText(req.body?.clientMessageId, 200) || randomUUID();
  const idempotencyKey = collaborationText(req.body?.idempotencyKey, 200) || clientMessageId;
  const duplicate = store.getDepartmentMessageByIdempotency(idempotencyKey);
  if (duplicate) {
    const mission = duplicate.missionId ? store.getDepartmentMission(duplicate.missionId) : null;
    res.json({ duplicate: true, message: duplicate, mission, ...departmentThreadPayload(department.id) });
    return;
  }
  const text = collaborationText(req.body?.message, 4_000);
  let images;
  let documents;
  try {
    images = parseMessageImages(req.body?.images);
    documents = parseMessageDocuments(req.body?.documents);
  } catch (error) {
    if (error instanceof MessageImageValidationError || error instanceof MessageDocumentValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }
  if (!text && images.length === 0 && documents.length === 0) {
    res.status(400).json({ error: "請輸入訊息或附加檔案" });
    return;
  }
  if (matchNativeCommand(text) === "clean") {
    const activeMission = workspaceMission(department.workspacePath, department.id);
    if (activeMission) {
      res.status(409).json({ error: "部門仍有進行中或待決定的 Mission，不能重建工作階段", mission: activeMission });
      return;
    }
    const members = department.memberWorkerIds.flatMap((id) => {
      const worker = workers.get(id);
      return worker ? [worker] : [];
    });
    if (members.length === 0) {
      res.status(400).json({ error: "沒有可重建工作階段的部門成員" });
      return;
    }
    const preflightError = await departmentCleanPreflightError(members);
    if (preflightError) {
      res.status(409).json({ error: preflightError });
      return;
    }
    const outcome = cleanDepartment(department, members);
    const failed = outcome.results.filter((result) => !result.ok);
    const responseMessage = appendDepartmentMessage({
      threadId: thread.id,
      role: "system",
      intent: "system",
      text: failed.length > 0
        ? `部門工作階段部分重建失敗：${failed.map((result) => result.name).join("、")}`
        : "已清除部門工作階段，所有成員記憶重新開始。",
      attachmentIds: [],
      missionId: null,
      deliveryStatus: "delivered",
      clientMessageId: null,
      idempotencyKey: null,
      classification: null,
      createdAt: outcome.historyClearedAt ? timestampAfter(outcome.historyClearedAt) : undefined,
    });
    res.status(failed.length > 0 ? 207 : 200).json({
      responseMessage,
      results: outcome.results,
      historyClearedAt: outcome.historyClearedAt,
      ...departmentThreadPayload(department.id),
    });
    return;
  }
  const attachmentRecords = persistAttachments(images, documents, res);
  if (!attachmentRecords) return;
  const attachmentIds = attachmentRecords.map((attachment) => attachment.id);
  for (const attachment of attachmentRecords) {
    departmentAudit("attachment_added", department.id, null, {
      attachmentId: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
    });
  }
  const allMissions = departmentMissions(department);
  const activeMission = workspaceMission(department.workspacePath, department.id);
  const latestCompletedMission = allMissions.find((mission) => mission.status === "completed") ?? null;
  const userText = text || `請依附件處理：${attachmentRecords.map((attachment) => attachment.name).join("、")}`;
  const classification = await classifyDepartmentMessage({
    department,
    lead,
    thread,
    message: userText,
    attachmentNames: attachmentRecords.map((attachment) => attachment.name),
    activeMission,
    latestCompletedMission,
  });
  let ownerMessage: DepartmentMessage;
  try {
    ownerMessage = appendDepartmentMessage({
      threadId: thread.id,
      role: "owner",
      intent: classification.intent,
      text: userText,
      attachmentIds,
      missionId: activeMission?.id ?? null,
      deliveryStatus: "pending",
      clientMessageId,
      idempotencyKey,
      classification,
    });
  } catch {
    const raced = store.getDepartmentMessageByIdempotency(idempotencyKey);
    if (raced) {
      res.json({ duplicate: true, message: raced, ...departmentThreadPayload(department.id) });
      return;
    }
    res.status(500).json({ error: "無法保存部門訊息" });
    return;
  }

  const reply = (message: string, intent: DepartmentMessageIntent = "system", missionId: string | null = activeMission?.id ?? null) =>
    appendDepartmentMessage({
      threadId: thread.id,
      role: "department",
      intent,
      text: message,
      attachmentIds: [],
      missionId,
      deliveryStatus: "delivered",
      clientMessageId: null,
      idempotencyKey: null,
      classification: null,
    });

  if (classification.confidence < 0.7 || classification.clarificationQuestion) {
    const responseMessage = reply(
      classification.clarificationQuestion || "這項指示仍有歧義，請說明你希望詢問、修改目前工作，或建立新交辦。",
    );
    res.json({ message: ownerMessage, responseMessage, classification, ...departmentThreadPayload(department.id) });
    return;
  }

  if (activeMission) {
    if (classification.intent === "question") {
      try {
        const answer = await answerDepartmentQuestion({ department, lead, thread, mission: activeMission, question: userText });
        const responseMessage = reply(answer.text, "question", activeMission.id);
        store.updateDepartmentMessageMission(ownerMessage.id, activeMission.id);
        departmentAudit("question_answered", department.id, activeMission.id, { toolsUsed: answer.toolsUsed });
        res.json({ message: ownerMessage, responseMessage, classification, mission: activeMission, ...departmentThreadPayload(department.id) });
      } catch (error) {
        const responseMessage = reply(`目前無法整理回答：${(error as Error).message}`, "system", activeMission.id);
        res.json({ message: ownerMessage, responseMessage, classification, mission: activeMission, ...departmentThreadPayload(department.id) });
      }
      return;
    }
    if (classification.intent === "mission_update" && classification.changeImpact === "major") {
      pendingMissionReplans.set(activeMission.id, { message: userText, attachmentIds, sourceMessageId: ownerMessage.id });
      store.updateDepartmentMessageMission(ownerMessage.id, activeMission.id);
      departmentAudit("mission_updated", department.id, activeMission.id, { action: "major_change_queued", message: userText });
      const responseMessage = reply("重大修改已保留；目前步驟完成後會在安全檢查點重新規劃，不會丟棄正在執行的成果。", "mission_update", activeMission.id);
      res.json({ message: ownerMessage, responseMessage, classification, mission: activeMission, ...departmentThreadPayload(department.id) });
      return;
    }
    activeMission.ownerGuidance = [activeMission.ownerGuidance, userText].filter(Boolean).join("\n\n").slice(0, 6_000);
    activeMission.attachmentIds = [...new Set([...(activeMission.attachmentIds ?? []), ...attachmentIds])];
    activeMission.sourceMessageId = ownerMessage.id;
    store.saveDepartmentMission(activeMission);
    store.updateDepartmentMessageMission(ownerMessage.id, activeMission.id);
    departmentAudit(classification.intent === "approval" ? "approval" : "mission_updated", department.id, activeMission.id, {
      intent: classification.intent,
      changeImpact: classification.changeImpact,
      message: userText,
    });
    const responseMessage = reply(
      classification.intent === "follow_up_mission"
        ? "目前 Mission 尚在執行；這項新工作已保存在部門對話。請先讓目前工作完成，或明確說明要把它改成目前 Mission 的調整。"
        : "補充內容已加入目前 Mission，會在下一個安全步驟交給相關成員。",
      classification.intent,
      activeMission.id,
    );
    broadcastMission(activeMission);
    res.json({ message: ownerMessage, responseMessage, classification, mission: activeMission, ...departmentThreadPayload(department.id) });
    return;
  }

  if (classification.intent === "question") {
    try {
      const answer = await answerDepartmentQuestion({ department, lead, thread, mission: latestCompletedMission, question: userText });
      const responseMessage = reply(answer.text, "question", latestCompletedMission?.id ?? null);
      if (latestCompletedMission) store.updateDepartmentMessageMission(ownerMessage.id, latestCompletedMission.id);
      departmentAudit("question_answered", department.id, latestCompletedMission?.id ?? null, { toolsUsed: answer.toolsUsed });
      res.json({ message: ownerMessage, responseMessage, classification, mission: latestCompletedMission, ...departmentThreadPayload(department.id) });
    } catch (error) {
      const responseMessage = reply(`目前無法整理回答：${(error as Error).message}`);
      res.json({ message: ownerMessage, responseMessage, classification, ...departmentThreadPayload(department.id) });
    }
    return;
  }

  const eligibility = missionDepartmentEligibility(lead);
  if (!eligibility.members) {
    const responseMessage = reply(`目前無法開始新 Mission：${eligibility.error || "部門不可用"}`);
    res.status(409).json({ error: responseMessage.text, message: ownerMessage, responseMessage, ...departmentThreadPayload(department.id) });
    return;
  }
  const criteria = normalizeAcceptanceCriteria(req.body?.acceptanceCriteria);
  const acceptanceCriteria = criteria.length > 0
    ? criteria
    : ["完成交辦目標、進行合理驗證，並在部門最終報告中說明結果與剩餘風險"];
  const launched = launchDepartmentMission(lead, eligibility.members, userText, acceptanceCriteria, {
    attachmentIds,
    parentMissionId: latestCompletedMission?.id ?? null,
    sourceMessageId: ownerMessage.id,
  });
  if (!launched.mission || launched.error) {
    const responseMessage = reply(launched.error || "無法啟動 Department Mission");
    res.status(500).json({ error: responseMessage.text, message: ownerMessage, responseMessage, ...departmentThreadPayload(department.id) });
    return;
  }
  store.updateDepartmentMessageMission(ownerMessage.id, launched.mission.id);
  const responseMessage = reply(`已建立 Mission 並交由 ${lead.runner.name} 依部門職務規劃執行。`, "follow_up_mission", launched.mission.id);
  res.status(202).json({
    message: { ...ownerMessage, missionId: launched.mission.id, deliveryStatus: "delivered" },
    responseMessage,
    classification,
    mission: launched.mission,
    ...departmentThreadPayload(department.id),
  });
});

app.post("/api/assignments", async (req, res) => {
  const objective = collaborationText(req.body?.objective, 4_000);
  if (!objective) {
    res.status(400).json({ error: "請輸入要交辦的工作" });
    return;
  }
  const preferredWorkspace = collaborationText(req.body?.preferredWorkspace, 1_000) || null;
  const runtime = resolveDecisionRuntime(req.body?.decisionProvider, req.body?.decisionModel, preferredWorkspace);
  if ("error" in runtime) {
    res.status(503).json({ error: runtime.error });
    return;
  }
  const decisionProvider = runtime.provider;
  const decisionModel = runtime.model;
  const requestedCriteria = normalizeAcceptanceCriteria(req.body?.acceptanceCriteria);
  const acceptanceCriteria = requestedCriteria.length > 0
    ? requestedCriteria
    : ["完成交辦目標、進行合理驗證，並在部門最終報告中說明結果與剩餘風險"];
  if (Array.isArray(req.body?.clarifications) && req.body.clarifications.length > 3) {
    res.status(400).json({ error: "部門判斷最多接受三輪澄清；請重新整理交辦目標後再試" });
    return;
  }
  const clarifications = normalizeAssignmentClarifications(req.body?.clarifications);
  const eligible = new Map<string, { coordinator: Worker; members: Worker[] }>();
  const candidates: AssignmentDecisionCandidate[] = [];
  for (const department of departments.values()) {
    const departmentMembers = [...workers.values()].filter((worker) => worker.departmentId === department.id);
    const coordinator = workers.get(department.leadWorkerId) ?? departmentMembers[0];
    if (!coordinator) continue;
    const availability = missionDepartmentEligibility(coordinator);
    if (!availability.members) continue;
    eligible.set(department.id, { coordinator, members: availability.members });
    candidates.push({
      departmentId: department.id,
      departmentName: department.name,
      workspacePath: department.workspacePath,
      leadWorkerId: coordinator.id,
      purpose: department.purpose,
      members: availability.members.map((member) => ({
        workerId: member.id,
        name: member.runner.name,
        role: member.persona?.role ?? null,
        instructions: member.persona?.instructions ?? null,
        provider: member.runner.provider,
      })),
    });
  }
  if (candidates.length === 0) {
    res.status(409).json({ error: "目前沒有可接單的部門；請先處理進行中的 Mission、登入 provider，或解除等待中的權限" });
    return;
  }
  const decisionUsage = await usageRegistry.refresh(decisionProvider, true);
  const decisionUsageError = usageBlockReason(decisionProvider, decisionUsage, decisionModel);
  if (decisionUsageError) {
    res.status(409).json({ error: `${providerLabel(decisionProvider)} 無法進行部門判斷：${decisionUsageError}`, usage: decisionUsage });
    return;
  }
  const prompt = assignmentDecisionPrompt({ objective, acceptanceCriteria, preferredWorkspace, candidates, clarifications });
  const decisionWorkspace = candidates.find((candidate) => preferredWorkspace && sameWorkspacePath(candidate.workspacePath, preferredWorkspace))?.workspacePath
    ?? candidates[0].workspacePath;
  let decisionText: string;
  try {
    decisionText = (await runDetachedTurn(decisionProvider, decisionWorkspace, decisionModel, undefined, null, prompt, 60_000, { kind: "no_tools" })).text;
  } catch (error) {
    res.status(502).json({ error: `決策模型無法完成部門判斷：${(error as Error).message}` });
    return;
  }
  let decision = parseAssignmentDecision(decisionText, candidates);
  if (!decision) {
    try {
      const repairPrompt = `${prompt}\n\nYour previous response did not match the required marked JSON schema. Return one corrected <assignment_decision> block only.`;
      decisionText = (await runDetachedTurn(decisionProvider, decisionWorkspace, decisionModel, undefined, null, repairPrompt, 60_000, { kind: "no_tools" })).text;
      decision = parseAssignmentDecision(decisionText, candidates);
    } catch {
      decision = null;
    }
  }
  if (!decision) {
    res.status(502).json({ error: "決策模型未回傳有效的部門判斷格式，未派出任何工作" });
    return;
  }
  if (decision.confidence < 0.7 || decision.clarificationQuestion) {
    if (clarifications.length >= 3) {
      res.status(409).json({ error: "決策模型在三輪澄清後仍無法可靠選擇部門，未派出任何工作" });
      return;
    }
    res.status(200).json({
      clarification: {
        question: decision.clarificationQuestion || "請再補充這項工作應涵蓋的對象、範圍或預期成果。",
        confidence: decision.confidence,
        reasons: decision.reasons,
      },
    });
    return;
  }
  const selectedCandidate = candidates.find((candidate) => candidate.departmentId === decision.departmentId)!;
  const route = {
    departmentId: selectedCandidate.departmentId,
    departmentName: selectedCandidate.departmentName,
    workspacePath: selectedCandidate.workspacePath,
    leadWorkerId: selectedCandidate.leadWorkerId,
    confidence: decision.confidence,
    reasons: decision.reasons,
    decisionProvider,
    decisionModel,
  };
  const selected = eligible.get(route.departmentId);
  if (!selected) {
    res.status(409).json({ error: "路由完成後部門狀態已改變，請重新交辦" });
    return;
  }
  const usage = await usageRegistry.refresh(selected.coordinator.runner.provider, true);
  const usageError = usageBlockReason(selected.coordinator.runner.provider, usage, null);
  if (usageError) {
    res.status(409).json({ error: `${providerLabel(selected.coordinator.runner.provider)} 無法開始工作：${usageError}`, route, usage });
    return;
  }
  const finalEligibility = missionDepartmentEligibility(selected.coordinator);
  if (!finalEligibility.members) {
    res.status(409).json({ error: finalEligibility.error || "路由完成後部門狀態已改變，請重新交辦", route });
    return;
  }
  const launched = launchDepartmentMission(selected.coordinator, finalEligibility.members, objective, acceptanceCriteria);
  if (!launched.mission || launched.error) {
    res.status(500).json({ error: launched.error || "無法啟動部門工作", route, mission: launched.mission });
    return;
  }
  res.status(202).json({ route, mission: launched.mission });
});

function bossTaskMessage(
  role: BossTaskMessageRole,
  text: string,
  attachmentIds: string[] = [],
  clientMessageId: string | null = null,
  idempotencyKey: string | null = null,
  createdAt = new Date().toISOString(),
) {
  return {
    id: randomUUID(),
    role,
    text: collaborationText(text, 40_000),
    attachmentIds: [...new Set(attachmentIds)],
    clientMessageId,
    idempotencyKey,
    createdAt,
  };
}

function bossTaskCandidates(): AssignmentDecisionCandidate[] {
  const candidates: AssignmentDecisionCandidate[] = [];
  for (const department of departments.values()) {
    const members = [...workers.values()].filter((worker) => worker.departmentId === department.id);
    const lead = workers.get(department.leadWorkerId) ?? members[0];
    if (!lead || members.length === 0) continue;
    candidates.push({
      departmentId: department.id,
      departmentName: department.name,
      workspacePath: department.workspacePath,
      leadWorkerId: lead.id,
      purpose: department.purpose,
      members: members.map((member) => ({
        workerId: member.id,
        name: member.runner.name,
        role: member.persona?.role ?? null,
        instructions: member.persona?.instructions ?? null,
        provider: member.runner.provider,
      })),
    });
  }
  return candidates;
}

function persistBossTask(task: BossTask, created = false): void {
  task.updatedAt = new Date().toISOString();
  store.saveBossTask(task);
  broadcastBossTask(task, created);
}

async function decideBossTask(task: BossTask): Promise<void> {
  const candidates = bossTaskCandidates();
  if (candidates.length === 0) {
    task.status = "needs_attention";
    task.error = "目前沒有可用的部門；請先建立具有職務的部門";
    task.messages.push(bossTaskMessage("system", task.error));
    persistBossTask(task);
    return;
  }
  const usage = await usageRegistry.refresh(task.decisionProvider, true);
  const usageError = usageBlockReason(task.decisionProvider, usage, task.decisionModel);
  if (usageError) {
    task.status = "needs_attention";
    task.error = `${providerLabel(task.decisionProvider)} 無法進行任務判斷：${usageError}`;
    task.messages.push(bossTaskMessage("system", task.error));
    persistBossTask(task);
    return;
  }
  const clarificationBudget = bossTaskClarificationBudget(task);
  const prompt = bossTaskDecisionPrompt({ task, candidates });
  const workspace = candidates.find((candidate) => sameWorkspacePath(candidate.workspacePath, task.workspacePath))?.workspacePath
    ?? candidates[0].workspacePath;
  let output = "";
  try {
    output = (await runDetachedTurn(task.decisionProvider, workspace, task.decisionModel, undefined, null, prompt, 60_000, { kind: "no_tools" })).text;
    let decision = parseBossTaskDecision(output, candidates);
    const clarificationPastBudget = decision?.status === "clarification" && clarificationBudget.remaining === 0;
    if (!decision || clarificationPastBudget) {
      const reason = clarificationPastBudget
        ? "You asked another clarification question, but the clarification budget is exhausted."
        : explainBossTaskDecisionFailure(output, candidates) ?? "The response did not match the required format.";
      const repair = `${prompt}\n\nYour previous response was invalid: ${reason}${clarificationPastBudget ? " You must produce a ready execution graph from the existing answers." : ""} Return one corrected <boss_task_decision> block only.`;
      output = (await runDetachedTurn(task.decisionProvider, workspace, task.decisionModel, undefined, null, repair, 60_000, { kind: "no_tools" })).text;
      decision = parseBossTaskDecision(output, candidates);
    }
    if (!decision || (decision.status === "clarification" && clarificationBudget.remaining === 0)) {
      throw new Error("決策模型無法依現有資訊建立有效的跨部門計畫");
    }
    task.error = null;
    if (decision.status === "clarification") {
      task.status = "needs_input";
      task.messages.push(bossTaskMessage("decision_model", decision.question));
      persistBossTask(task);
      return;
    }
    const byDepartment = new Map(candidates.map((candidate) => [candidate.departmentId, candidate]));
    task.stages = decision.stages.map((stage) => ({
      ...stage,
      executionMode: decision.executionMode,
      departmentName: byDepartment.get(stage.departmentId)?.departmentName ?? stage.departmentId,
      status: "pending" as const,
      missionId: null,
      report: null,
    }));
    task.executionMode = decision.executionMode;
    task.status = "ready";
    task.messages.push(bossTaskMessage(
      "system",
      decision.executionMode === "research"
        ? `已選擇快速研究路徑：${decision.summary}\n\n${task.stages[0].departmentName} · ${task.stages[0].title}`
        : `已完成探索並建立跨部門計畫：${decision.summary}\n\n${task.stages.map((stage, index) => `${index + 1}. ${stage.departmentName} · ${stage.title}`).join("\n")}`,
    ));
    persistBossTask(task);
    advanceBossTask(task);
  } catch (error) {
    task.status = "failed";
    task.error = (error as Error).message || "無法完成 Boss Task 判斷";
    task.messages.push(bossTaskMessage("system", task.error));
    persistBossTask(task);
  }
}

function missionReport(mission: DepartmentMission): string {
  for (let index = mission.steps.length - 1; index >= 0; index -= 1) {
    const result = mission.steps[index]?.result;
    if (result) return result;
  }
  return mission.planSummary || "部門 Mission 已完成，但沒有可用的文字報告。";
}

function advanceBossTask(task: BossTask): void {
  for (const stage of task.stages) {
    if (!stage.missionId || stage.status === "completed" || stage.status === "failed" || stage.status === "cancelled") continue;
    const mission = store.getDepartmentMission(stage.missionId);
    if (!mission) continue;
    if (mission.status === "completed") {
      stage.status = "completed";
      stage.report = collaborationText(missionReport(mission), 12_000);
      task.messages.push(bossTaskMessage("system", `${stage.departmentName} 已完成「${stage.title}」，交付內容已傳給後續部門。`));
    } else if (mission.status === "needs_attention") {
      const newlyBlocked = stage.status !== "needs_attention";
      stage.status = "needs_attention";
      task.status = "needs_attention";
      task.error = `${stage.departmentName} 的「${stage.title}」需要你處理：${mission.error || "等待決定"}`;
      if (newlyBlocked) task.messages.push(bossTaskMessage("system", task.error));
      persistBossTask(task);
      return;
    } else if (mission.status === "failed" || mission.status === "cancelled") {
      stage.status = mission.status;
      task.status = mission.status === "cancelled" ? "cancelled" : "failed";
      task.error = `${stage.departmentName} 的「${stage.title}」${mission.status === "cancelled" ? "已取消" : "失敗"}：${mission.error || ""}`.trim();
      task.messages.push(bossTaskMessage("system", task.error));
      persistBossTask(task);
      return;
    } else {
      stage.status = "running";
      task.status = "running";
      task.error = null;
    }
  }
  if (task.stages.length > 0 && task.stages.every((stage) => stage.status === "completed")) {
    task.status = "completed";
    task.error = null;
    task.completedAt = new Date().toISOString();
    task.finalReport = bossTaskFinalReport(task);
    task.messages.push(bossTaskMessage("report", task.finalReport));
    persistBossTask(task);
    return;
  }
  if (task.stages.some((stage) => stage.status === "running" || stage.status === "needs_attention")) {
    persistBossTask(task);
    return;
  }
  const completedIds = new Set(task.stages.filter((stage) => stage.status === "completed").map((stage) => stage.id));
  const next = task.stages.find((stage) => stage.status === "pending" && stage.dependsOn.every((id) => completedIds.has(id)));
  if (!next) {
    task.status = "failed";
    task.error = "跨部門計畫沒有可執行的下一階段";
    task.messages.push(bossTaskMessage("system", task.error));
    persistBossTask(task);
    return;
  }
  const department = departments.get(next.departmentId);
  const lead = department ? workers.get(department.leadWorkerId) : null;
  if (!department || !lead) {
    task.status = "needs_attention";
    task.error = `找不到「${next.departmentName}」的部門主管`;
    task.messages.push(bossTaskMessage("system", task.error));
    persistBossTask(task);
    return;
  }
  const eligibility = missionDepartmentEligibility(lead);
  if (!eligibility.members) {
    task.status = "needs_attention";
    task.error = `${next.departmentName} 暫時無法開始：${eligibility.error || "部門不可用"}`;
    task.messages.push(bossTaskMessage("system", task.error));
    persistBossTask(task);
    return;
  }
  const upstream = task.stages
    .filter((stage) => next.dependsOn.includes(stage.id) && stage.report)
    .map((stage) => `## ${stage.departmentName} · ${stage.title}\n${stage.report}`)
    .join("\n\n")
    .slice(0, 24_000);
  const objective = `${next.objective}\n\nBoss Task：${task.objective}${upstream ? `\n\n上游部門交付：\n${upstream}` : ""}`.slice(0, 30_000);
  const launched = launchDepartmentMission(lead, eligibility.members, objective, next.acceptanceCriteria, {
    attachmentIds: task.attachmentIds ?? [],
    executionMode: next.executionMode ?? task.executionMode ?? "project",
    origin: "boss",
  });
  if (!launched.mission || launched.error) {
    task.status = "needs_attention";
    task.error = launched.error || `無法啟動 ${next.departmentName}`;
    task.messages.push(bossTaskMessage("system", task.error));
    persistBossTask(task);
    return;
  }
  next.status = "running";
  next.missionId = launched.mission.id;
  task.status = "running";
  task.error = null;
  task.messages.push(bossTaskMessage("system", `已交給 ${next.departmentName}：${next.title}`));
  persistBossTask(task);
}

function advanceBossTasksForMission(missionId: string): void {
  for (const task of store.listRunningBossTasks()) {
    if (task.stages.some((stage) => stage.missionId === missionId)) advanceBossTask(task);
  }
}

app.get("/api/boss-tasks", (req, res) => {
  const requested = collaborationText(req.query.workspacePath, 1_000);
  let workspacePath: string | undefined;
  if (requested) {
    try { workspacePath = normalizeManagedWorkspacePath(requested); }
    catch (error) { res.status(400).json({ error: (error as Error).message }); return; }
  }
  res.json({ bossTasks: store.listBossTasks(workspacePath).map(bossTaskForDisplay) });
});

app.get("/api/boss-tasks/:id", (req, res) => {
  const task = store.getBossTask(req.params.id);
  if (!task) { res.status(404).json({ error: "找不到 Boss Task" }); return; }
  res.json({ bossTask: bossTaskForDisplay(task) });
});

app.post("/api/boss-tasks", async (req, res) => {
  const objective = collaborationText(req.body?.message, 4_000);
  if (!objective) { res.status(400).json({ error: "請輸入要交辦的工作" }); return; }
  const clientMessageId = collaborationText(req.body?.clientMessageId, 200) || null;
  const idempotencyKey = collaborationText(req.body?.idempotencyKey, 200) || clientMessageId;
  if (idempotencyKey) {
    const existing = store.listBossTasks().find((task) => task.idempotencyKey === idempotencyKey);
    if (existing) {
      res.json({ bossTask: bossTaskForDisplay(existing), duplicate: true });
      return;
    }
  }
  let workspacePath: string;
  try { workspacePath = normalizeManagedWorkspacePath(req.body?.workspacePath || config.targetRepoPath); }
  catch (error) { res.status(400).json({ error: (error as Error).message }); return; }
  const runtime = resolveDecisionRuntime(req.body?.decisionProvider, req.body?.decisionModel, workspacePath);
  if ("error" in runtime) {
    res.status(503).json({ error: runtime.error });
    return;
  }
  const decisionProvider = runtime.provider;
  const decisionModel = runtime.model;
  let images;
  let documents;
  try {
    images = parseMessageImages(req.body?.images);
    documents = parseMessageDocuments(req.body?.documents);
  } catch (error) {
    if (error instanceof MessageImageValidationError || error instanceof MessageDocumentValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }
  const attachmentRecordsForPersist = persistAttachments(images, documents, res);
  if (!attachmentRecordsForPersist) return;
  const attachmentIds = attachmentRecordsForPersist.map((attachment) => attachment.id);
  const now = new Date().toISOString();
  const task: BossTask = {
    id: randomUUID(),
    title: objective.slice(0, 120),
    archivedAt: null,
    workspacePath,
    decisionProvider,
    decisionModel,
    objective,
    acceptanceCriteria: normalizeAcceptanceCriteria(req.body?.acceptanceCriteria),
    attachmentIds,
    clientMessageId,
    idempotencyKey,
    status: "discovering",
    messages: [bossTaskMessage("boss", objective, attachmentIds, clientMessageId, idempotencyKey)],
    stages: [],
    finalReport: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
  if (!store.saveBossTask(task)) { res.status(500).json({ error: "無法保存 Boss Task" }); return; }
  broadcastBossTask(task, true);
  await decideBossTask(task);
  res.status(201).json({ bossTask: bossTaskForDisplay(task) });
});

app.patch("/api/boss-tasks/:id", (req, res) => {
  const task = store.getBossTask(req.params.id);
  if (!task) { res.status(404).json({ error: "找不到 Boss Task" }); return; }
  const patchError = applyBossTaskRecordPatch(task, req.body ?? {});
  if (patchError) {
    res.status(patchError.includes("不能封存") ? 409 : 400).json({ error: patchError });
    return;
  }
  persistBossTask(task);
  res.json({ bossTask: bossTaskForDisplay(task) });
});

app.delete("/api/boss-tasks/:id", (req, res) => {
  const task = store.getBossTask(req.params.id);
  if (!task) { res.status(404).json({ error: "找不到 Boss Task" }); return; }
  if (!["completed", "failed", "cancelled"].includes(task.status)) {
    res.status(409).json({ error: "進行中或等待處理的 Boss Task 不能刪除" });
    return;
  }
  if (!store.deleteBossTask(task.id)) {
    res.status(500).json({ error: "無法刪除 Boss Task" });
    return;
  }
  broadcast({ type: "boss_task_deleted", bossTaskId: task.id });
  res.json({ ok: true, bossTaskId: task.id });
});

app.post("/api/boss-tasks/:id/messages", async (req, res) => {
  const task = store.getBossTask(req.params.id);
  if (!task) { res.status(404).json({ error: "找不到 Boss Task" }); return; }
  const idempotencyKey = collaborationText(req.body?.idempotencyKey, 200)
    || collaborationText(req.body?.clientMessageId, 200)
    || null;
  if (idempotencyKey && task.messages.some((entry) => entry.idempotencyKey === idempotencyKey)) {
    res.json({ bossTask: bossTaskForDisplay(task), duplicate: true });
    return;
  }
  const clientMessageId = collaborationText(req.body?.clientMessageId, 200) || null;
  const message = collaborationText(req.body?.message, 4_000);
  let images;
  let documents;
  try {
    images = parseMessageImages(req.body?.images);
    documents = parseMessageDocuments(req.body?.documents);
  } catch (error) {
    if (error instanceof MessageImageValidationError || error instanceof MessageDocumentValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }
  if (!message && images.length === 0 && documents.length === 0) {
    res.status(400).json({ error: "請輸入回覆內容或加入附件" });
    return;
  }
  if (matchNativeCommand(message) === "clean") {
    const bossDepartments = bossTaskDepartments(task);
    if (bossDepartments.length === 0) {
      res.status(400).json({ error: "這個 Boss Task 沒有可重建工作階段的部門" });
      return;
    }
    const preflightError = await cleanBossTaskPreflightError(bossDepartments);
    if (preflightError) {
      res.status(409).json({ error: preflightError });
      return;
    }
    const outcome = cleanBossTask(task, bossDepartments);
    const failed = outcome.results.filter((result) => !result.ok);
    task.messages.push(bossTaskMessage(
      "system",
      failed.length > 0
        ? `工作階段部分重建失敗：${failed.map((result) => result.name).join("、")}`
        : "已清除 Boss Task 與所屬部門的工作階段，所有成員記憶重新開始。",
      [],
      null,
      null,
      task.historyClearedAt ? timestampAfter(task.historyClearedAt) : undefined,
    ));
    persistBossTask(task);
    res.status(failed.length > 0 ? 207 : 200).json({ bossTask: bossTaskForDisplay(task), results: outcome.results });
    return;
  }
  if (task.status !== "needs_input" && task.status !== "needs_attention" && task.status !== "completed" && task.status !== "failed") {
    res.status(409).json({ error: "目前階段正在執行；完成或需要補充時才能送出新指示" });
    return;
  }
  const attachmentRecordsForPersist = persistAttachments(images, documents, res);
  if (!attachmentRecordsForPersist) return;
  const attachmentIds = attachmentRecordsForPersist.map((attachment) => attachment.id);
  task.attachmentIds = [...new Set([...(task.attachmentIds ?? []), ...attachmentIds])];
  task.messages.push(bossTaskMessage(
    "boss",
    message || "請依附加檔案處理後續工作",
    attachmentIds,
    clientMessageId,
    idempotencyKey,
  ));
  if (task.status === "needs_attention") {
    const blockedMission = task.stages
      .filter((stage) => stage.missionId)
      .map((stage) => store.getDepartmentMission(stage.missionId!))
      .find((mission) => mission?.status === "needs_attention");
    if (blockedMission) {
      task.messages.push(bossTaskMessage("system", "指示已保存在 Boss Task；此中斷屬於進行中的部門 Mission，請從跨部門階段開啟該 Mission 後選擇重試、重新指派或接受風險。"));
      persistBossTask(task);
      res.json({ bossTask: bossTaskForDisplay(task) });
      return;
    }
    task.status = "ready";
    task.error = null;
    persistBossTask(task);
    advanceBossTask(task);
    res.json({ bossTask: bossTaskForDisplay(task) });
    return;
  }
  if (task.status === "completed" || task.status === "failed") {
    task.stages = [];
    task.finalReport = null;
    task.completedAt = null;
  }
  task.status = "discovering";
  task.error = null;
  persistBossTask(task);
  await decideBossTask(task);
  res.json({ bossTask: bossTaskForDisplay(task) });
});

app.post("/api/workers/:bossId/missions/prepare", async (req, res) => {
  const boss = workers.get(req.params.bossId);
  if (!boss) {
    res.status(404).json({ error: "找不到部門主管 NPC" });
    return;
  }
  const objective = collaborationText(req.body?.objective, 4_000);
  const requestedCriteria = normalizeAcceptanceCriteria(req.body?.acceptanceCriteria);
  const acceptanceCriteria = requestedCriteria.length > 0
    ? requestedCriteria
    : ["完成交辦目標、進行合理驗證，並在部門最終報告中說明結果與剩餘風險"];
  if (!objective) {
    res.status(400).json({ error: "請填寫 Department Mission 目標" });
    return;
  }
  let images;
  let documents;
  try {
    images = parseMessageImages(req.body?.images);
    documents = parseMessageDocuments(req.body?.documents);
  } catch (error) {
    if (error instanceof MessageImageValidationError || error instanceof MessageDocumentValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }
  const attachmentRecordsForPersist = persistAttachments(images, documents, res);
  if (!attachmentRecordsForPersist) return;
  const attachmentIds = attachmentRecordsForPersist.map((attachment) => attachment.id);
  const parentMissionId = collaborationText(req.body?.parentMissionId, 200) || null;
  let sourceMessageId: string | null = null;
  if (boss.departmentId) {
    const thread = ensureDepartmentThread(boss.departmentId);
    const clientMessageId = collaborationText(req.body?.clientMessageId, 200) || randomUUID();
    const idempotencyKey = collaborationText(req.body?.idempotencyKey, 200) || clientMessageId;
    const existing = store.getDepartmentMessageByIdempotency(idempotencyKey);
    const sourceMessage = existing ?? appendDepartmentMessage({
      threadId: thread.id,
      role: "owner",
      intent: "follow_up_mission",
      text: objective,
      attachmentIds,
      missionId: null,
      deliveryStatus: "pending",
      clientMessageId,
      idempotencyKey,
      classification: {
        intent: "follow_up_mission",
        confidence: 1,
        reason: "由相容的舊版 prepare API 明確交辦新工作",
        changeImpact: "none",
        clarificationQuestion: null,
      },
    });
    sourceMessageId = sourceMessage.id;
  }
  const eligibility = missionDepartmentEligibility(boss);
  if (!eligibility.members) {
    res.status(409).json({ error: eligibility.error });
    return;
  }
  for (const provider of new Set([boss.runner.provider])) {
    const usage = await usageRegistry.refresh(provider, true);
    const usageError = usageBlockReason(provider, usage, null);
    if (usageError) {
      res.status(409).json({ error: `${providerLabel(provider)} 無法開始 Mission：${usageError}`, usage });
      return;
    }
  }
  for (const [token, prepared] of preparedMissions) {
    if (prepared.expiresAt < Date.now()) preparedMissions.delete(token);
  }
  const missionToken = randomUUID();
  preparedMissions.set(missionToken, {
    bossWorkerId: boss.id,
    workspacePath: boss.runner.workspacePath,
    objective,
    acceptanceCriteria,
    attachmentIds,
    parentMissionId,
    sourceMessageId,
    memberStates: eligibility.members.map((member) => ({
      id: member.id,
      sessionId: member.runner.getPersistenceState().sessionId,
      historyLength: member.history.length,
    })),
    expiresAt: Date.now() + 120_000,
  });
  res.json({
    missionToken,
    boss: workerSummary(boss),
    members: eligibility.members.map(workerSummary),
    objective,
    acceptanceCriteria,
    maxCorrections: 2,
    warnings: [
      "這次交辦就是工作授權；部門主管會以唯讀模式完成分工後直接開始，不再要求你核准一般計畫。",
      "NPC 會依各自職務執行，部門一次只跑一個步驟，最後由主管彙整成一份報告。",
      "Execute 使用各 NPC 原本的權限與核准設定；Consult／Review 固定唯讀。",
      "Review 最多自動退回修正兩輪，超過後會停下來請你決定。",
      "Mission 不會自動 commit、push、merge、tag、publish 或 release。",
    ],
  });
});

app.post("/api/workers/:bossId/missions", async (req, res) => {
  const boss = workers.get(req.params.bossId);
  const token = String(req.body?.missionToken ?? "");
  const prepared = preparedMissions.get(token);
  preparedMissions.delete(token);
  if (!boss || !prepared || prepared.bossWorkerId !== boss.id || prepared.expiresAt < Date.now()) {
    res.status(409).json({ error: "Mission 確認已過期，請重新檢查" });
    return;
  }
  if (req.body?.warningAcknowledged !== true) {
    res.status(400).json({ error: "必須先確認 Mission 權限與 Git 邊界" });
    return;
  }
  const eligibility = missionDepartmentEligibility(boss);
  if (!eligibility.members || !sameWorkspacePath(boss.runner.workspacePath, prepared.workspacePath)) {
    res.status(409).json({ error: eligibility.error || "部門主管已離開原部門" });
    return;
  }
  const stateChanged = prepared.memberStates.some((snapshot) => {
    const member = workers.get(snapshot.id);
    return !member || member.runner.getPersistenceState().sessionId !== snapshot.sessionId || member.history.length !== snapshot.historyLength;
  });
  if (stateChanged) {
    res.status(409).json({ error: "檢查後部門 NPC 狀態已改變，請重新確認" });
    return;
  }
  const launched = launchDepartmentMission(boss, eligibility.members, prepared.objective, prepared.acceptanceCriteria, {
    attachmentIds: prepared.attachmentIds,
    parentMissionId: prepared.parentMissionId,
    sourceMessageId: prepared.sourceMessageId,
  });
  if (!launched.mission || launched.error) {
    res.status(500).json({ error: launched.error || "無法啟動 Department Mission", mission: launched.mission });
    return;
  }
  if (prepared.sourceMessageId) store.updateDepartmentMessageMission(prepared.sourceMessageId, launched.mission.id);
  res.status(202).json({ mission: launched.mission });
});

app.get("/api/missions", (req, res) => {
  const requested = String(req.query.workspacePath ?? "").trim();
  let workspacePath: string | undefined;
  if (requested) {
    try { workspacePath = normalizeManagedWorkspacePath(requested); }
    catch (error) { res.status(400).json({ error: (error as Error).message }); return; }
  }
  res.json({ missions: store.listDepartmentMissions(workspacePath) });
});

app.get("/api/missions/:id", (req, res) => {
  const mission = store.getDepartmentMission(req.params.id);
  if (!mission) { res.status(404).json({ error: "找不到 Department Mission" }); return; }
  res.json({ mission });
});

app.post("/api/missions/:id/follow-up", async (req, res) => {
  const mission = activeMissions.get(req.params.id) ?? store.getDepartmentMission(req.params.id);
  if (!mission) { res.status(404).json({ error: "找不到 Department Mission" }); return; }
  if (missionLocksWorkspace(mission)) {
    res.status(409).json({ error: "Mission 尚未結束，請先在目前步驟或決策卡繼續處理" });
    return;
  }
  const question = collaborationText(req.body?.question, 4_000);
  if (!question) { res.status(400).json({ error: "請輸入要追問部門的內容" }); return; }
  const department = mission.departmentId ? departments.get(mission.departmentId) : undefined;
  const lead = workers.get(department?.leadWorkerId ?? mission.bossWorkerId);
  if (!lead || (mission.departmentId && lead.departmentId !== mission.departmentId)) {
    res.status(409).json({ error: "部門主管已不存在或已離開部門" });
    return;
  }
  const running = workspaceMission(mission.workspacePath, mission.departmentId);
  if (running && running.id !== mission.id) {
    res.status(409).json({ error: "部門正在執行新的 Mission，完成後才能追問舊報告" });
    return;
  }
  if (!providerReady(lead.runner.provider)) {
    res.status(503).json({ error: `${providerLabel(lead.runner.provider)} 尚未登入`, auth: authStates[lead.runner.provider] });
    return;
  }
  try {
    if (department) {
      const thread = ensureDepartmentThread(department.id);
      const answer = await answerDepartmentQuestion({ department, lead, thread, mission, question });
      const responseMessage = appendDepartmentMessage({
        threadId: thread.id,
        role: "department",
        intent: "question",
        text: answer.text,
        attachmentIds: [],
        missionId: mission.id,
        deliveryStatus: "delivered",
        clientMessageId: null,
        idempotencyKey: null,
        classification: null,
      });
      departmentAudit("question_answered", department.id, mission.id, { toolsUsed: answer.toolsUsed, legacyEndpoint: true });
      res.json({ ok: true, answer: answer.text, responseMessage });
      return;
    }
    const capabilities = lead.runner.provider === "codex"
      ? codexCapabilitiesFor(mission.workspacePath).getState()
      : claudeCapabilitiesFor(mission.workspacePath).getState();
    const allowedTools = readOnlyMcpToolNames(capabilities);
    const answer = await runDetachedTurn(
      lead.runner.provider,
      mission.workspacePath,
      lead.runner.getModel() ?? null,
      undefined,
      lead.persona,
      `${missionFollowUpPrompt(mission, question)}

可使用的已驗證唯讀 MCP 工具：${JSON.stringify(allowedTools)}`,
      60_000,
      { kind: "read_only_query", allowedTools },
    );
    res.json({ ok: true, answer: answer.text });
  } catch (error) {
    const message = (error as Error).message || "無法送出部門追問";
    res.status(500).json({ error: message });
  }
});

app.post("/api/missions/:id/approve-plan", (req, res) => {
  const mission = activeMissions.get(req.params.id) ?? store.getDepartmentMission(req.params.id);
  if (!mission) { res.status(404).json({ error: "找不到 Department Mission" }); return; }
  if (mission.status !== "needs_attention" || mission.attentionReason !== "plan_approval" || mission.steps.length === 0) {
    res.status(409).json({ error: "這個 Mission 沒有等待核准的計畫" });
    return;
  }
  const first = mission.steps[0];
  const assignee = workers.get(first.assigneeWorkerId);
  if (!assignee || assignee.runner.busy || !providerReady(assignee.runner.provider)) {
    res.status(409).json({ error: "第一位執行 NPC 目前無法開始，請稍後再核准" });
    return;
  }
  mission.planApprovedAt = new Date().toISOString();
  mission.attentionReason = null;
  mission.error = null;
  activeMissions.set(mission.id, mission);
  store.saveDepartmentMission(mission);
  broadcastMission(mission);
  dispatchMissionStep(mission, 0);
  res.status(202).json({ mission });
});

function retryMissionPlanning(mission: DepartmentMission): string | null {
  const boss = workers.get(mission.bossWorkerId);
  if (!boss) return "部門主管 NPC 已不存在";
  if (boss.runner.busy || handoffInProgress(boss) || collaborationInProgress(boss.id)) return "部門主管正在執行其他工作";
  if (!providerReady(boss.runner.provider)) return `${providerLabel(boss.runner.provider)} 尚未登入`;
  const members = missionMembers(mission);
  mission.status = "planning";
  mission.attentionReason = null;
  mission.error = null;
  mission.formatRepairCount = 0;
  mission.steps = [];
  mission.currentStepIndex = null;
  activeMissions.set(mission.id, mission);
  store.saveDepartmentMission(mission);
  broadcastMission(mission);
  const prompt = missionPlanningPrompt({
    missionId: mission.id,
    bossWorkerId: mission.bossWorkerId,
    objective: mission.objective,
    acceptanceCriteria: mission.acceptanceCriteria,
    workspacePath: mission.workspacePath,
    members: members.map((member) => ({
      id: member.id,
      name: member.runner.name,
      role: member.persona?.role || null,
      provider: member.runner.provider,
    })),
    attachments: resolveAttachmentMetadata(mission.attachmentIds ?? []),
    executionMode: mission.executionMode ?? "project",
  });
  const attachments = attachmentRepository.load(mission.attachmentIds ?? []);
  try {
    sendMissionRunner(
      mission,
      boss,
      prompt,
      `交給部門 · 重新規劃：${mission.objective}`,
      attachments.images,
      attachments.documents,
      { executionProfile: "read_only_collaboration" },
    );
    return null;
  } catch (error) {
    pauseMission(mission, (error as Error).message || "無法重新啟動 Mission 規劃");
    return mission.error;
  }
}

app.post("/api/missions/:id/resolve", (req, res) => {
  const mission = activeMissions.get(req.params.id) ?? store.getDepartmentMission(req.params.id);
  if (!mission) { res.status(404).json({ error: "找不到 Department Mission" }); return; }
  if (!(["needs_attention", "failed"] as DepartmentMission["status"][]).includes(mission.status) || mission.attentionReason === "plan_approval") {
    res.status(409).json({ error: "這個 Mission 目前沒有可處理的中斷" });
    return;
  }
  const reserved = workspaceMission(mission.workspacePath, mission.departmentId);
  if (mission.status === "failed" && reserved && reserved.id !== mission.id) {
    res.status(409).json({ error: "同一工作位置已有進行中的 Department Mission" });
    return;
  }
  const action = String(req.body?.action ?? "");
  const guidance = collaborationText(req.body?.guidance, 2_000);
  if (guidance) mission.ownerGuidance = guidance;
  if (action === "retry" && mission.steps.length === 0) {
    const error = retryMissionPlanning(mission);
    if (error) { res.status(409).json({ error }); return; }
    res.status(202).json({ mission });
    return;
  }
  const currentIndex = mission.currentStepIndex;
  const current = currentIndex == null ? null : mission.steps[currentIndex];
  if (!current || currentIndex == null) {
    res.status(409).json({ error: "Mission 找不到可恢復的步驟" });
    return;
  }
  if (action === "accept_risk") {
    if (current.kind !== "review" || !current.reviewResult) {
      res.status(409).json({ error: "只有已有結果的 Review 才能接受風險繼續" });
      return;
    }
    current.status = "completed";
    mission.attentionReason = null;
    mission.error = guidance ? `老闆接受風險：${guidance}` : "老闆已接受目前 Review 風險";
    store.saveDepartmentMission(mission);
    broadcastMission(mission);
    completeMissionStep(mission, currentIndex);
    res.status(202).json({ mission });
    return;
  }
  let targetIndex = currentIndex;
  if (action === "retry_execute" || action === "guide") {
    if (current.kind === "review") {
      const executeIndex = precedingExecuteIndex(mission, currentIndex);
      if (executeIndex == null) { res.status(409).json({ error: "找不到可重試的 Execute 步驟" }); return; }
      targetIndex = executeIndex;
      current.status = "pending";
      current.completedAt = null;
    } else if (current.kind !== "execute") {
      res.status(409).json({ error: "目前步驟不能退回 Execute" });
      return;
    }
  } else if (action === "reassign") {
    const workerId = String(req.body?.workerId ?? "");
    const replacement = workers.get(workerId);
    if (!replacement || !sameWorkspacePath(replacement.runner.workspacePath, mission.workspacePath)) {
      res.status(409).json({ error: "只能重新指派給同部門 NPC" });
      return;
    }
    const preceding = current.kind === "review" ? precedingExecuteIndex(mission, currentIndex) : null;
    if (preceding != null && mission.steps[preceding]?.assigneeWorkerId === workerId) {
      res.status(409).json({ error: "Review 必須由與 Execute 不同的 NPC 負責" });
      return;
    }
    current.assigneeWorkerId = workerId;
  } else if (action !== "retry") {
    res.status(400).json({ error: "不支援的 Mission 處理方式" });
    return;
  }
  const target = mission.steps[targetIndex];
  target.status = "pending";
  target.completedAt = null;
  target.formatRepairCount = 0;
  mission.attentionReason = null;
  mission.error = null;
  mission.completedAt = null;
  activeMissions.set(mission.id, mission);
  store.saveDepartmentMission(mission);
  broadcastMission(mission);
  dispatchMissionStep(mission, targetIndex, current.kind === "review" ? current.reviewResult : null);
  res.status(202).json({ mission });
});

app.post("/api/missions/:id/cancel", (req, res) => {
  const mission = activeMissions.get(req.params.id) ?? store.getDepartmentMission(req.params.id);
  if (!mission) { res.status(404).json({ error: "找不到 Department Mission" }); return; }
  if (!missionLocksWorkspace(mission)) { res.status(409).json({ error: "Mission 已經結束" }); return; }
  activeMissions.delete(mission.id);
  missionActivities.delete(mission.id);
  stopMissionRunners(mission.id, true);
  mission.status = "cancelled";
  mission.error = null;
  mission.completedAt = new Date().toISOString();
  store.saveDepartmentMission(mission);
  pendingMissionReplans.delete(mission.id);
  updateDepartmentThreadMission(mission.departmentId, null);
  departmentAudit("mission_cancelled", mission.departmentId, mission.id);
  broadcastMission(mission);
  advanceBossTasksForMission(mission.id);
  res.json({ mission });
});

app.post("/api/missions/:id/retry-review", (req, res) => {
  const mission = activeMissions.get(req.params.id) ?? store.getDepartmentMission(req.params.id);
  if (!mission) { res.status(404).json({ error: "找不到 Department Mission" }); return; }
  const stepIndex = mission.currentStepIndex;
  const step = stepIndex == null ? null : mission.steps[stepIndex];
  if (mission.status !== "needs_attention" || !step || step.kind !== "review") {
    res.status(409).json({ error: "只有等待決定的 Review 可以重新檢查" });
    return;
  }
  if (stepIndex == null) { res.status(409).json({ error: "Mission 找不到 Review 步驟" }); return; }
  activeMissions.set(mission.id, mission);
  mission.correctionCount = 0;
  mission.error = null;
  step.status = "pending";
  dispatchMissionStep(mission, stepIndex);
  res.status(202).json({ mission });
});

type PreparedCollaboration = {
  sourceWorkerId: string;
  targetWorkerId: string;
  sourceSessionId: string;
  targetSessionId: string;
  sourceHistoryLength: number;
  targetHistoryLength: number;
  mode: "consult" | "review";
  objective: string;
  acceptanceCriteria: string[];
  expiresAt: number;
};
const preparedCollaborations = new Map<string, PreparedCollaboration>();

function collaborationEligibility(source: Worker, target: Worker): string | null {
  if (source.id === target.id) return "來源與目標 NPC 必須不同";
  if (!sameWorkspacePath(source.runner.workspacePath, target.runner.workspacePath)) return "Phase 1 只支援相同工作位置的 NPC 協作";
  if (workspaceMission(source.runner.workspacePath, source.departmentId)) return "部門正在執行 Department Mission，暫時不能開始單次協作";
  if (source.runner.busy || handoffInProgress(source) || collaborationInProgress(source.id)) return "來源 NPC 正在工作、交接或協作中";
  if (target.runner.busy || handoffInProgress(target) || collaborationInProgress(target.id)) return "目標 NPC 正在工作、交接或協作中";
  if (handoffActivityBlock(source.history)) return "來源 NPC 尚有待處理的權限或背景 Agent";
  if (handoffActivityBlock(target.history)) return "目標 NPC 尚有待處理的權限或背景 Agent";
  if (!providerReady(target.runner.provider)) return `${providerLabel(target.runner.provider)} 尚未登入`;
  if (activeCollaborations.size >= MAX_ACTIVE_COLLABORATIONS) return "目前協作工作已達上限";
  return null;
}

app.post("/api/workers/:sourceId/collaborations/prepare", async (req, res) => {
  const source = workers.get(req.params.sourceId);
  const target = workers.get(String(req.body?.targetWorkerId ?? ""));
  if (!source || !target) {
    res.status(404).json({ error: "找不到來源或目標 NPC" });
    return;
  }
  const mode = normalizeCollaborationMode(req.body?.mode);
  const objective = collaborationText(req.body?.objective, 4_000);
  const acceptanceCriteria = normalizeAcceptanceCriteria(req.body?.acceptanceCriteria);
  if (!mode || !objective) {
    res.status(400).json({ error: "請選擇協作模式並填寫目標" });
    return;
  }
  const eligibilityError = collaborationEligibility(source, target);
  if (eligibilityError) {
    res.status(409).json({ error: eligibilityError });
    return;
  }
  const usage = await usageRegistry.refresh(target.runner.provider, true);
  const usageError = usageBlockReason(target.runner.provider, usage, target.runner.getModel() ?? null);
  if (usageError) {
    res.status(409).json({ error: `目標 NPC 無法開始協作：${usageError}`, usage });
    return;
  }
  for (const [token, prepared] of preparedCollaborations) {
    if (prepared.expiresAt < Date.now()) preparedCollaborations.delete(token);
  }
  const collaborationToken = randomUUID();
  preparedCollaborations.set(collaborationToken, {
    sourceWorkerId: source.id,
    targetWorkerId: target.id,
    sourceSessionId: source.runner.getPersistenceState().sessionId,
    targetSessionId: target.runner.getPersistenceState().sessionId,
    sourceHistoryLength: source.history.length,
    targetHistoryLength: target.history.length,
    mode,
    objective,
    acceptanceCriteria,
    expiresAt: Date.now() + 120_000,
  });
  res.json({
    collaborationToken,
    source: workerSummary(source),
    target: workerSummary(target),
    mode,
    objective,
    acceptanceCriteria,
    usage,
    warnings: [
      "目標 NPC 會以 provider 原生唯讀模式執行，不能修改 repository。",
      "目標完成後，結果會自動交回來源 NPC，並以來源 NPC 的正常權限繼續原始任務。",
      "需要指令、檔案或登入核准時，仍會透過現有介面停下來詢問你；不會自動 commit、push 或提高權限。",
      "Repository 與對話內容視為不受信任資料，結果仍需人工確認。",
    ],
  });
});

app.post("/api/workers/:sourceId/collaborations", async (req, res) => {
  const source = workers.get(req.params.sourceId);
  const token = String(req.body?.collaborationToken ?? "");
  const prepared = preparedCollaborations.get(token);
  preparedCollaborations.delete(token);
  if (!source || !prepared || prepared.sourceWorkerId !== source.id || prepared.expiresAt < Date.now()) {
    res.status(409).json({ error: "協作確認已過期，請重新檢查" });
    return;
  }
  const target = workers.get(prepared.targetWorkerId);
  if (!target) {
    res.status(404).json({ error: "目標 NPC 已不存在" });
    return;
  }
  if (
    source.runner.getPersistenceState().sessionId !== prepared.sourceSessionId ||
    target.runner.getPersistenceState().sessionId !== prepared.targetSessionId ||
    source.history.length !== prepared.sourceHistoryLength ||
    target.history.length !== prepared.targetHistoryLength
  ) {
    res.status(409).json({ error: "檢查後 NPC 狀態已改變，請重新確認" });
    return;
  }
  const eligibilityError = collaborationEligibility(source, target);
  if (eligibilityError) {
    res.status(409).json({ error: eligibilityError });
    return;
  }
  if (req.body?.warningAcknowledged !== true) {
    res.status(400).json({ error: "必須先確認唯讀協作限制" });
    return;
  }
  const usage = await usageRegistry.refresh(target.runner.provider, true);
  const usageError = usageBlockReason(target.runner.provider, usage, target.runner.getModel() ?? null);
  if (usageError) {
    res.status(409).json({ error: `目標 NPC 無法開始協作：${usageError}`, usage });
    return;
  }
  const now = new Date().toISOString();
  const gitState = await workspaceGitState(source.runner.workspacePath);
  const finalEligibilityError = collaborationEligibility(source, target);
  const preparedStateChanged =
    source.runner.getPersistenceState().sessionId !== prepared.sourceSessionId ||
    target.runner.getPersistenceState().sessionId !== prepared.targetSessionId ||
    source.history.length !== prepared.sourceHistoryLength ||
    target.history.length !== prepared.targetHistoryLength;
  if (finalEligibilityError || preparedStateChanged) {
    res.status(409).json({ error: finalEligibilityError || "啟動協作前 NPC 狀態已改變，請重新確認" });
    return;
  }
  const task: CollaborationTask = {
    id: randomUUID(),
    sourceWorkerId: source.id,
    targetWorkerId: target.id,
    workspacePath: source.runner.workspacePath,
    mode: prepared.mode,
    objective: prepared.objective,
    acceptanceCriteria: prepared.acceptanceCriteria,
    status: "running",
    sourceContext: {
      sourceName: source.runner.name,
      sourceRole: source.persona?.role || null,
      recentConversation: collaborationConversation(source.history),
      gitState,
    },
    baseCommit: gitState.match(/HEAD:\s*([^\s]+)/)?.[1] ?? null,
    result: null,
    continuationResult: null,
    error: null,
    createdAt: now,
    startedAt: now,
    completedAt: null,
    adoptedAt: null,
    handledAt: null,
  };
  activeCollaborations.set(task.id, task);
  if (!store.saveCollaborationTask(task)) {
    activeCollaborations.delete(task.id);
    res.status(500).json({ error: "無法保存協作任務" });
    return;
  }
  broadcastCollaboration(task, true);
  const prompt = collaborationPrompt({
    taskId: task.id,
    mode: task.mode,
    sourceName: source.runner.name,
    sourceRole: source.persona?.role || null,
    objective: task.objective,
    acceptanceCriteria: task.acceptanceCriteria,
    recentConversation: String(task.sourceContext.recentConversation ?? ""),
    gitState,
  });
  record(target, { type: "user_message", text: `NPC 協作 · ${task.mode === "review" ? "Review" : "Consult"}：${task.objective}` });
  try {
    target.runner.send(prompt, [], [], { executionProfile: "read_only_collaboration" });
  } catch (error) {
    finishCollaboration(target, { type: "error", message: (error as Error).message || "無法啟動協作" });
    res.status(500).json({ error: (error as Error).message || "無法啟動協作", collaboration: task });
    return;
  }
  broadcast({ type: "worker_status", workerId: target.id, busy: true });
  res.status(202).json({ collaboration: task });
});

app.get("/api/collaborations", (req, res) => {
  const workerId = String(req.query.workerId ?? "");
  if (workerId && !workers.has(workerId)) {
    res.status(404).json({ error: "unknown worker" });
    return;
  }
  res.json({ collaborations: workerId ? store.listCollaborationTasks(workerId) : store.listRecentCollaborationTasks() });
});

app.get("/api/collaborations/:id", (req, res) => {
  const task = activeCollaborations.get(req.params.id) ?? store.getCollaborationTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: "找不到協作任務" });
    return;
  }
  res.json({ collaboration: task });
});

app.post("/api/collaborations/:id/cancel", (req, res) => {
  const task = activeCollaborations.get(req.params.id);
  if (!task) {
    res.status(409).json({ error: "協作任務已結束或不存在" });
    return;
  }
  const activeWorkerId = collaborationActiveWorkerId(task);
  task.status = "cancelled";
  task.error = null;
  task.completedAt = new Date().toISOString();
  activeCollaborations.delete(task.id);
  store.saveCollaborationTask(task);
  if (activeWorkerId) workers.get(activeWorkerId)?.runner.interrupt();
  broadcastCollaboration(task);
  res.json({ collaboration: task });
});

app.post("/api/collaborations/:id/adopt", (req, res) => {
  const task = store.getCollaborationTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: "找不到協作任務" });
    return;
  }
  if (task.adoptedAt) {
    res.json({ collaboration: task });
    return;
  }
  if (task.status !== "completed" || !task.result) {
    res.status(409).json({ error: "只有舊版已完成但尚未交回的協作結果可以手動交回" });
    return;
  }
  const source = workers.get(task.sourceWorkerId);
  const target = workers.get(task.targetWorkerId);
  if (!source || !target) {
    res.status(409).json({ error: "來源或目標 NPC 已不存在" });
    return;
  }
  if (source.runner.busy || handoffInProgress(source) || collaborationInProgress(source.id) || missionInProgress(source.id)) {
    res.status(409).json({ error: "來源 NPC 正在工作，暫時無法交回結果" });
    return;
  }
  if (!providerReady(source.runner.provider)) {
    res.status(503).json({ error: `${source.runner.provider}_not_authenticated`, auth: authStates[source.runner.provider] });
    return;
  }
  const message = adoptedCollaborationMessage(task, target.runner.name);
  record(source, { type: "user_message", text: message });
  try {
    source.runner.send(message);
  } catch (error) {
    record(source, { type: "error", message: (error as Error).message || "無法交回協作結果" });
    res.status(500).json({ error: (error as Error).message || "無法交回協作結果" });
    return;
  }
  task.adoptedAt = new Date().toISOString();
  store.saveCollaborationTask(task);
  broadcastCollaboration(task);
  broadcast({ type: "worker_status", workerId: source.id, busy: true });
  res.json({ collaboration: task });
});

app.post("/api/collaborations/:id/handled", (req, res) => {
  const task = store.getCollaborationTask(req.params.id);
  if (!task || !["completed", "failed", "cancelled"].includes(task.status)) {
    res.status(409).json({ error: "協作任務尚未結束或不存在" });
    return;
  }
  task.handledAt ??= new Date().toISOString();
  store.saveCollaborationTask(task);
  broadcastCollaboration(task);
  res.json({ collaboration: task });
});

type PreparedHandoff = {
  workerId: string;
  fromProvider: ProviderId;
  sourceSessionId: string;
  historyLength: number;
  toProvider: ProviderId;
  toModel: string | null;
  expiresAt: number;
};
const preparedHandoffs = new Map<string, PreparedHandoff>();

app.post("/api/workers/:id/handoff/prepare", async (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) {
    res.status(404).json({ error: "unknown worker" });
    return;
  }
  const toProvider: ProviderId = req.body?.toProvider === "codex" ? "codex" : "claude";
  const toModel = typeof req.body?.toModel === "string" && req.body.toModel.trim() ? req.body.toModel.trim() : null;
  if (toModel && !validModel(toProvider, toModel)) {
    res.status(400).json({ error: "目標模型名稱格式無效" });
    return;
  }
  if (toProvider === worker.runner.provider) {
    res.status(400).json({ error: "已經是目前的 LLM" });
    return;
  }
  if (worker.runner.busy || handoffInProgress(worker) || collaborationInProgress(worker.id) || missionInProgress(worker.id)) {
    res.status(409).json({ error: "NPC 正在工作或交接中，請完成後再切換" });
    return;
  }
  const activityBlock = handoffActivityBlock(worker.history);
  if (activityBlock) {
    res.status(409).json({ error: activityBlock });
    return;
  }
  if (!providerReady(toProvider)) {
    res.status(409).json({ error: `無法切換至 ${providerLabel(toProvider)}：尚未登入`, auth: authStates[toProvider] });
    return;
  }
  const usage = await usageRegistry.refresh(toProvider, true);
  const usageError = usageBlockReason(toProvider, usage, toModel);
  if (usageError) {
    res.status(409).json({ error: `無法切換至 ${providerLabel(toProvider)}：${usageError}`, usage });
    return;
  }
  const handoffToken = randomUUID();
  for (const [existingToken, existing] of preparedHandoffs) {
    if (existing.expiresAt < Date.now()) preparedHandoffs.delete(existingToken);
  }
  preparedHandoffs.set(handoffToken, {
    workerId: worker.id,
    fromProvider: worker.runner.provider,
    sourceSessionId: worker.runner.getPersistenceState().sessionId,
    historyLength: worker.history.length,
    toProvider,
    toModel,
    expiresAt: Date.now() + 120_000,
  });
  res.json({
    handoffToken,
    fromProvider: worker.runner.provider,
    toProvider,
    toModel,
    usage,
    hasHistory: worker.history.some((event) => event.type === "user_message"),
    warnings: [
      "這會建立新的目標 LLM session，不是搬移原生 session。",
      "MCP、工具進度、背景 Agent 與待核准操作不會直接繼承。",
      "交接摘要可能遺漏或誤解細節，重要決策請再次確認。",
      "整理與接手都會消耗 LLM 工作能量。",
    ],
  });
});

app.post("/api/workers/:id/handoff", async (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) {
    res.status(404).json({ error: "unknown worker" });
    return;
  }
  const token = String(req.body?.handoffToken ?? "");
  const prepared = preparedHandoffs.get(token);
  preparedHandoffs.delete(token);
  if (!prepared || prepared.workerId !== worker.id || prepared.expiresAt < Date.now()) {
    res.status(409).json({ error: "切換確認已過期，請重新檢查工作能量" });
    return;
  }
  if (worker.runner.provider !== prepared.fromProvider || worker.runner.getPersistenceState().sessionId !== prepared.sourceSessionId || worker.history.length !== prepared.historyLength) {
    res.status(409).json({ error: "準備完成後工作狀態已改變，請重新檢查並確認交接" });
    return;
  }
  if (req.body?.warningAcknowledged !== true) {
    res.status(400).json({ error: "必須先確認跨 LLM 交接風險" });
    return;
  }
  if (worker.runner.busy || collaborationInProgress(worker.id) || missionInProgress(worker.id)) {
    res.status(409).json({ error: "NPC 正在工作，不能開始交接" });
    return;
  }
  const id = randomUUID();
  const progress: HandoffProgress = {
    id,
    fromProvider: worker.runner.provider,
    toProvider: prepared.toProvider,
    toModel: prepared.toModel,
    stage: "checking",
    message: "正在確認工作狀態",
    source: null,
    error: null,
  };
  setHandoff(worker, progress);
  if (!worker.history.some((event) => event.type === "user_message")) {
    await performProviderHandoff(worker, progress);
    if (worker.handoff?.stage === "failed") {
      res.status(500).json({ error: worker.handoff.error || "無法切換 LLM", handoff: worker.handoff });
      return;
    }
    res.json({ handoff: worker.handoff, worker: workerSummary(worker) });
    return;
  }
  void performProviderHandoff(worker, progress);
  res.status(202).json({ handoff: progress });
});

app.get("/api/workers/:id/handoffs", (req, res) => {
  if (!workers.has(req.params.id)) {
    res.status(404).json({ error: "unknown worker" });
    return;
  }
  res.json({ handoffs: store.listProviderHandoffs(req.params.id) });
});

app.patch("/api/workers/:id/workspace", (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) {
    res.status(404).json({ error: "unknown worker" });
    return;
  }
  if (worker.runner.busy || handoffInProgress(worker) || collaborationInProgress(worker.id) || missionInProgress(worker.id)) {
    res.status(409).json({ error: "NPC 執行中，不能切換工作位置" });
    return;
  }

  try {
    const workspacePath = normalizeWorkspacePath(req.body?.workspacePath);
    if (workspacePath === worker.runner.workspacePath) {
      res.json({ ...workerSummary(worker), conversationReset: false });
      return;
    }

    const provider = worker.runner.provider;
    const previousDepartmentId = worker.departmentId;
    const name = worker.runner.name;
    const model = worker.runner.getModel();
    const conversationReset = worker.history.some((event) => event.type === "user_message");
    worker.runner.stop();
    worker.history = [];
    store.clearWorkerEvents(worker.id);
    worker.runner = createRunner(worker, provider, workspacePath);
    worker.runner.name = name;
    if (model && validModel(provider, model)) worker.runner.setModel(model);
    if (providerReady(provider)) worker.runner.warmup();
    const now = new Date().toISOString();
    const newDepartment: Department = {
      id: randomUUID(), name: `${basename(workspacePath) || "個人"}部門`, purpose: "個人工作部門",
      workspacePath, leadWorkerId: worker.id, memberWorkerIds: [worker.id], createdAt: now, updatedAt: now,
    };
    worker.departmentId = newDepartment.id;
    if (!store.saveDepartment(newDepartment) || !persistWorker(worker)) throw new Error("無法保存新的部門位置");
    departments.set(newDepartment.id, newDepartment);
    repairDepartmentAfterMemberLeaves(previousDepartmentId, worker.id);
    broadcast({ type: "department_created", department: newDepartment });
    if (provider === "claude") void claudeCapabilitiesFor(workspacePath).refresh();
    else void codexCapabilitiesFor(workspacePath).refresh();
    const summary = workerSummary(worker);
    broadcast({ type: "worker_updated", worker: summary, reset: true });
    res.json({ ...summary, conversationReset });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || "無法使用這個工作位置" });
  }
});

app.post("/api/workers/:id/activate", (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) {
    res.status(404).json({ error: "unknown worker" });
    return;
  }
  if (worker.runner.provider === "claude") {
    void claudeCapabilitiesFor(worker.runner.workspacePath).refresh();
  } else {
    void codexCapabilitiesFor(worker.runner.workspacePath).refresh();
  }
  if (providerReady(worker.runner.provider) && !worker.runner.busy) worker.runner.warmup();
  res.json({ ok: true, workspacePath: worker.runner.workspacePath });
});

app.delete("/api/workers/:id", async (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) {
    res.status(404).json({ error: "unknown worker" });
    return;
  }
  if (handoffInProgress(worker) || collaborationInProgress(worker.id) || missionInProgress(worker.id)) {
    res.status(409).json({ error: "NPC 正在進行 LLM 交接、協作或部門 Mission，暫時不能移除" });
    return;
  }
  worker.runner.stop();
  const avatarId = worker.avatarId;
  const departmentId = worker.departmentId;
  workers.delete(worker.id);
  store.deleteWorker(worker.id);
  repairDepartmentAfterMemberLeaves(departmentId, worker.id);
  broadcast({ type: "worker_removed", workerId: worker.id });
  res.json({ ok: true });
  if (avatarId) await deleteAvatarIfUnused(avatarId);
});

app.post("/api/workers/:id/message", (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) {
    res.status(404).json({ error: "unknown worker" });
    return;
  }
  if (!providerReady(worker.runner.provider)) {
    const provider = worker.runner.provider;
    res.status(503).json({ error: `${provider}_not_authenticated`, auth: authStates[provider] });
    return;
  }
  if (worker.runner.busy) {
    res.status(409).json({ error: "worker busy" });
    return;
  }
  if (handoffInProgress(worker)) {
    res.status(409).json({ error: "NPC 正在進行 LLM 交接，請等待完成" });
    return;
  }
  if (collaborationInProgress(worker.id) || missionInProgress(worker.id)) {
    res.status(409).json({ error: "NPC 正在進行協作或部門 Mission，請等待完成" });
    return;
  }
  const message = String(req.body?.message ?? "").trim();
  let images: ReturnType<typeof parseMessageImages>;
  let documents: ReturnType<typeof parseMessageDocuments>;
  try {
    images = parseMessageImages(req.body?.images);
    documents = parseMessageDocuments(req.body?.documents);
  } catch (error) {
    const detail = error instanceof MessageImageValidationError || error instanceof MessageDocumentValidationError
      ? error.message
      : "附件無效";
    res.status(400).json({ error: detail });
    return;
  }
  if (!message && images.length === 0 && documents.length === 0) {
    res.status(400).json({ error: "message or attachment required" });
    return;
  }
  if (matchNativeCommand(message) === "clean") {
    const result = cleanWorkerAndAnnounce(worker);
    if (!result.ok) {
      res.status(409).json({ error: result.error });
      return;
    }
    res.json({ ok: true, cleaned: true });
    return;
  }
  const imageLabels = images.map((image, index) => `[Image #${index + 1}: ${image.name}]`).join(" ");
  const documentLabels = documents.map((document, index) => `[Document #${index + 1}: ${document.name}]`).join(" ");
  record(worker, { type: "user_message", text: [message, imageLabels, documentLabels].filter(Boolean).join("\n") });
  try {
    worker.runner.send(message, images, documents);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "無法傳送附件訊息";
    record(worker, { type: "error", message: detail });
    res.status(500).json({ error: detail });
    return;
  }
  broadcast({ type: "worker_status", workerId: worker.id, busy: true });
  res.json({ ok: true });
});

app.post("/api/workers/:id/approvals/:approvalId", (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) {
    res.status(404).json({ error: "unknown worker" });
    return;
  }
  const requested = String(req.body?.decision ?? "");
  const decision = requested === "allow_once" || requested === "allow_session" || requested === "deny"
    ? requested
    : null;
  if (!decision) {
    res.status(400).json({ error: "unknown approval decision" });
    return;
  }
  if (!worker.runner.resolveApproval(req.params.approvalId, decision)) {
    res.status(409).json({ error: "核准要求已失效或已處理" });
    return;
  }
  res.json({ ok: true });
});

app.post("/api/missions/:id/approvals/:approvalId", (req, res) => {
  const mission = activeMissions.get(req.params.id) ?? store.getDepartmentMission(req.params.id);
  if (!mission) {
    res.status(404).json({ error: "找不到 Department Mission" });
    return;
  }
  const requested = String(req.body?.decision ?? "");
  const decision = requested === "allow_once" || requested === "allow_session" || requested === "deny"
    ? requested
    : null;
  if (!decision) {
    res.status(400).json({ error: "unknown approval decision" });
    return;
  }
  for (const [key, handle] of missionRunners) {
    if (!key.startsWith(`${mission.id}\0`)) continue;
    if (!handle.runner.resolveApproval(req.params.approvalId, decision)) continue;
    res.json({ ok: true });
    return;
  }
  res.status(409).json({ error: "核准要求已失效、已處理，或任務 session 已中止" });
});

app.post("/internal/claude-approval", async (req, res) => {
  const header = String(req.headers.authorization ?? "");
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || token.length > 100) {
    res.status(401).json({ message: "Invalid approval bridge token" });
    return;
  }
  for (const worker of workers.values()) {
    const pending = worker.runner.handleApprovalBridge(token, req.body);
    if (!pending) continue;
    try {
      res.json(await pending);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message || "Approval bridge failed" });
    }
    return;
  }
  for (const handle of missionRunners.values()) {
    const pending = handle.runner.handleApprovalBridge(token, req.body);
    if (!pending) continue;
    try {
      res.json(await pending);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message || "Approval bridge failed" });
    }
    return;
  }
  res.status(404).json({ message: "Approval bridge is no longer active" });
});

app.post("/api/workers/:id/model", (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) {
    res.status(404).json({ error: "unknown worker" });
    return;
  }
  if (!providerReady(worker.runner.provider)) {
    const provider = worker.runner.provider;
    res.status(503).json({ error: `${provider}_not_authenticated`, auth: authStates[provider] });
    return;
  }
  if (worker.runner.busy || handoffInProgress(worker) || collaborationInProgress(worker.id) || missionInProgress(worker.id)) {
    res.status(409).json({ error: "worker busy" });
    return;
  }
  const model = String(req.body?.model ?? "");
  if (model && !validModel(worker.runner.provider, model)) {
    res.status(400).json({ error: "unknown model" });
    return;
  }
  worker.runner.setModel(model || undefined);
  worker.runner.warmup();
  persistWorker(worker);
  broadcast({ type: "worker_updated", worker: workerSummary(worker) });
  res.json({ ok: true });
});

async function departmentCleanPreflightError(members: Worker[]): Promise<string | null> {
  const blocked = members.filter((worker) =>
    worker.runner.busy || handoffInProgress(worker) || collaborationInProgress(worker.id),
  );
  if (blocked.length > 0) {
    return `以下 NPC 正在工作，不能重建：${blocked.map((worker) => worker.runner.name).join("、")}`;
  }
  const providerErrors: string[] = [];
  for (const provider of new Set(members.map((member) => member.runner.provider))) {
    if (!providerReady(provider)) providerErrors.push(`${providerLabel(provider)} 尚未登入`);
    else {
      const usage = await usageRegistry.refresh(provider, true);
      const usageError = usageBlockReason(provider, usage, null);
      if (usageError) providerErrors.push(`${providerLabel(provider)}：${usageError}`);
    }
  }
  return providerErrors.length > 0 ? providerErrors.join("；") : null;
}

type DepartmentCleanResult = {
  ok: boolean;
  results: Array<{ workerId: string; name: string; ok: boolean; error: string | null }>;
  historyClearedAt: string | null;
};

function cleanDepartment(department: Department, members: Worker[]): DepartmentCleanResult {
  const results = members.map((worker) => {
    const result = cleanWorkerAndAnnounce(worker);
    return { workerId: worker.id, name: worker.runner.name, ok: result.ok, error: result.ok ? null : result.error };
  });
  departmentAudit("session_reset", department.id, null, {
    requestedWorkerIds: members.map((worker) => worker.id),
    results,
  });
  const failed = results.filter((result) => !result.ok);
  let historyClearedAt: string | null = null;
  if (failed.length === 0) {
    const thread = ensureDepartmentThread(department.id);
    historyClearedAt = new Date().toISOString();
    thread.activeMissionId = null;
    thread.summary = "";
    thread.historyClearedAt = historyClearedAt;
    thread.updatedAt = historyClearedAt;
    store.saveDepartmentThread(thread);
    broadcast({ type: "department_thread_updated", thread });
  }
  return { ok: failed.length === 0, results, historyClearedAt };
}

function bossTaskDepartments(task: BossTask): Department[] {
  const ids = [...new Set(task.stages.map((stage) => stage.departmentId))];
  return ids.flatMap((id) => {
    const department = departments.get(id);
    return department ? [department] : [];
  });
}

function departmentMembers(department: Department): Worker[] {
  return department.memberWorkerIds.flatMap((id) => {
    const worker = workers.get(id);
    return worker ? [worker] : [];
  });
}

async function cleanBossTaskPreflightError(bossDepartments: Department[]): Promise<string | null> {
  for (const department of bossDepartments) {
    const activeMission = workspaceMission(department.workspacePath, department.id);
    if (activeMission) return `${department.name} 仍有進行中或待決定的 Mission，不能重建工作階段`;
  }
  const members = bossDepartments.flatMap((department) => departmentMembers(department));
  if (members.length === 0) return "這個 Boss Task 沒有可重建工作階段的部門成員";
  return departmentCleanPreflightError(members);
}

type BossTaskCleanResult = {
  ok: boolean;
  results: Array<{ workerId: string; name: string; ok: boolean; error: string | null }>;
};

function cleanBossTask(task: BossTask, bossDepartments: Department[]): BossTaskCleanResult {
  const results: BossTaskCleanResult["results"] = [];
  for (const department of bossDepartments) {
    const members = departmentMembers(department);
    if (members.length === 0) continue;
    results.push(...cleanDepartment(department, members).results);
  }
  if (results.length > 0 && results.every((result) => result.ok)) {
    task.historyClearedAt = new Date().toISOString();
  }
  return { ok: results.every((result) => result.ok), results };
}

app.post("/api/departments/:departmentId/sessions/reset", async (req, res) => {
  const department = departments.get(req.params.departmentId);
  if (!department) { res.status(404).json({ error: "找不到部門" }); return; }
  const activeMission = workspaceMission(department.workspacePath, department.id);
  if (activeMission) {
    res.status(409).json({ error: "部門仍有進行中或待決定的 Mission，不能重建工作階段", mission: activeMission });
    return;
  }
  const requestedIds = Array.isArray(req.body?.workerIds)
    ? new Set(req.body.workerIds.map(String))
    : null;
  const members = department.memberWorkerIds
    .filter((id) => !requestedIds || requestedIds.has(id))
    .flatMap((id) => {
      const worker = workers.get(id);
      return worker ? [worker] : [];
    });
  if (members.length === 0) { res.status(400).json({ error: "沒有可重建工作階段的部門成員" }); return; }
  const preflightError = await departmentCleanPreflightError(members);
  if (preflightError) {
    res.status(409).json({ error: preflightError });
    return;
  }
  const preview = members.map((worker) => ({
    workerId: worker.id,
    name: worker.runner.name,
    provider: worker.runner.provider,
    model: worker.runner.getModel() ?? null,
  }));
  if (req.body?.confirm !== true) {
    res.json({
      requiresConfirmation: true,
      members: preview,
      preserved: ["Boss 任務與其 Mission 詳情", "附件", "稽核紀錄"],
      discarded: ["部門畫面上的舊對話與 Mission", "每位 NPC 的原生 LLM 對話上下文"],
    });
    return;
  }
  const outcome = cleanDepartment(department, members);
  const failed = outcome.results.filter((result) => !result.ok);
  res.status(failed.length > 0 ? 207 : 200).json({
    ok: outcome.ok,
    results: outcome.results,
    retryWorkerIds: failed.map((result) => result.workerId),
    historyClearedAt: outcome.historyClearedAt,
  });
});

app.post("/api/workers/:id/model/fresh", (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) {
    res.status(404).json({ error: "unknown worker" });
    return;
  }
  const provider = worker.runner.provider;
  if (!providerReady(provider)) {
    res.status(503).json({ error: `${provider}_not_authenticated`, auth: authStates[provider] });
    return;
  }
  if (worker.runner.busy || handoffInProgress(worker) || collaborationInProgress(worker.id) || missionInProgress(worker.id)) {
    res.status(409).json({ error: "worker busy" });
    return;
  }
  const model = String(req.body?.model ?? "");
  if (model && !validModel(provider, model)) {
    res.status(400).json({ error: "unknown model" });
    return;
  }

  const workspacePath = worker.runner.workspacePath;
  const fresh = replaceWithFreshSession(
    worker,
    model || undefined,
    () => createRunner(worker, provider, workspacePath),
    () => persistWorker(worker),
    (runner) => store.saveProviderCheckpoint(
      worker.id,
      provider,
      workspacePath,
      runner.getModel() ?? null,
      runner.getPersistenceState(),
    ),
  );
  if (!fresh) {
    res.status(500).json({ error: "無法儲存新的模型工作階段，已保留原工作階段" });
    return;
  }

  fresh.warmup();
  broadcast({ type: "worker_updated", worker: workerSummary(worker) });
  res.json({ ok: true });
});

app.post("/api/workers/:id/provider/fresh", (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) {
    res.status(404).json({ error: "unknown worker" });
    return;
  }
  const sourceProvider = worker.runner.provider;
  const targetProvider = req.body?.provider === "claude" || req.body?.provider === "codex"
    ? req.body.provider as ProviderId
    : null;
  if (!targetProvider || targetProvider === sourceProvider) {
    res.status(400).json({ error: "unknown target provider" });
    return;
  }
  if (!providerReady(targetProvider)) {
    res.status(503).json({ error: `${targetProvider}_not_authenticated`, auth: authStates[targetProvider] });
    return;
  }
  if (worker.runner.busy || handoffInProgress(worker) || collaborationInProgress(worker.id) || missionInProgress(worker.id)) {
    res.status(409).json({ error: "worker busy" });
    return;
  }
  const model = String(req.body?.model ?? "");
  if (model && !validModel(targetProvider, model)) {
    res.status(400).json({ error: "unknown model" });
    return;
  }

  const workspacePath = worker.runner.workspacePath;
  const previousHandoff = worker.handoff;
  worker.handoff = null;
  const fresh = replaceWithFreshSession(
    worker,
    model || undefined,
    () => createRunner(worker, targetProvider, workspacePath),
    () => persistWorker(worker),
    (runner) => store.saveProviderCheckpoint(
      worker.id,
      runner.provider,
      workspacePath,
      runner.getModel() ?? null,
      runner.getPersistenceState(),
    ),
    () => store.deleteProviderCheckpoint(worker.id, sourceProvider),
  );
  if (!fresh) {
    worker.handoff = previousHandoff;
    persistWorker(worker);
    res.status(500).json({ error: "無法切換新的 LLM 工作階段，已保留原工作階段" });
    return;
  }

  fresh.warmup();
  broadcast({ type: "worker_updated", worker: workerSummary(worker) });
  if (targetProvider === "claude") void claudeCapabilitiesFor(workspacePath).refresh();
  else void codexCapabilitiesFor(workspacePath).refresh();
  res.json({ ok: true });
});

const personaSuggestionsInProgress = new Set<string>();

app.post("/api/workers/:id/persona/suggest", async (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) {
    res.status(404).json({ error: "找不到這位 NPC" });
    return;
  }
  const provider = worker.runner.provider;
  if (!providerReady(provider)) {
    res.status(503).json({ error: `${providerLabel(provider)} 尚未登入，登入後才能由 AI 產生人設`, auth: authStates[provider] });
    return;
  }
  if (personaSuggestionsInProgress.has(worker.id)) {
    res.status(409).json({ error: "這位 NPC 的 AI 人設正在產生中" });
    return;
  }

  const members = [...workers.values()]
    .filter((member) => sameWorkspacePath(member.runner.workspacePath, worker.runner.workspacePath))
    .map((member) => ({ name: member.runner.name, role: member.persona?.role || null }));
  const prompt = personaSuggestionPrompt({
    workerName: worker.runner.name,
    workspacePath: worker.runner.workspacePath,
    members,
  });

  personaSuggestionsInProgress.add(worker.id);
  try {
    const result = await runDetachedTurn(
      provider,
      worker.runner.workspacePath,
      worker.runner.getModel() ?? null,
      undefined,
      null,
      prompt,
      60_000,
    );
    const persona = parsePersonaSuggestion(result.text);
    if (!persona) {
      res.status(502).json({ error: "AI 回傳的人設格式不完整，請再產生一次" });
      return;
    }
    res.json({ persona });
  } catch (error) {
    res.status(502).json({ error: (error as Error).message || "AI 暫時無法產生人設" });
  } finally {
    personaSuggestionsInProgress.delete(worker.id);
  }
});

app.post("/api/workers/:id/persona", (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) {
    res.status(404).json({ error: "unknown worker" });
    return;
  }
  if (worker.runner.busy || handoffInProgress(worker) || collaborationInProgress(worker.id) || missionInProgress(worker.id)) {
    res.status(409).json({ error: "worker busy" });
    return;
  }
  worker.persona = normalizePersona(req.body?.persona);
  // Re-spawn so the new persona is injected via --append-system-prompt. The
  // conversation is preserved because the CLI resumes the same session id;
  // a signed-out provider simply stores it until it next starts.
  worker.runner.stop();
  if (providerReady(worker.runner.provider)) worker.runner.warmup();
  persistWorker(worker);
  broadcast({ type: "worker_updated", worker: workerSummary(worker) });
  res.json({ ok: true, persona: worker.persona });
});

app.post("/api/workers/:id/auto-approve", (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) {
    res.status(404).json({ error: "unknown worker" });
    return;
  }
  const mode = req.body?.mode;
  if (mode !== "off" && mode !== "safe" && mode !== "full") {
    res.status(400).json({ error: "mode 必須是 off、safe 或 full" });
    return;
  }
  worker.autoApproveMode = mode;
  // No restart needed — both ClaudeSession and CodexSession read this live
  // on the next approval request, so switching modes takes effect on the
  // worker's very next tool call.
  persistWorker(worker);
  broadcast({ type: "worker_updated", worker: workerSummary(worker) });
  res.json({ ok: true, autoApproveMode: worker.autoApproveMode });
});

app.get("/api/persona-templates", (_req, res) => {
  res.json({ templates: store.listPersonaTemplates() });
});

app.post("/api/persona-templates", (req, res) => {
  const normalized = normalizePersonaTemplate(req.body);
  if (!normalized) {
    res.status(400).json({ error: "範本需要名稱，且至少要有職務或指示" });
    return;
  }
  const template: PersonaTemplate = {
    id: normalized.id ?? randomUUID(),
    name: normalized.name,
    role: normalized.role,
    instructions: normalized.instructions,
  };
  store.savePersonaTemplate(template);
  res.json({ ok: true, template, templates: store.listPersonaTemplates() });
});

app.delete("/api/persona-templates/:id", (req, res) => {
  store.deletePersonaTemplate(req.params.id);
  res.json({ ok: true, templates: store.listPersonaTemplates() });
});

/** Restart idle workers so their next message picks up provider configuration. */
function restartIdleWorkers(provider?: ProviderId, workspacePath?: string): void {
  for (const worker of workers.values()) {
    if (
      (!provider || worker.runner.provider === provider) &&
      (!workspacePath || sameWorkspacePath(worker.runner.workspacePath, workspacePath)) &&
      providerReady(worker.runner.provider) &&
      !worker.runner.busy
    ) {
      worker.runner.stop();
      worker.runner.warmup();
    }
  }
}

type McpReloadSummary = { reloaded: number; deferred: number; failed: number };

async function reloadMcpWorkers(provider: ProviderId, workspacePath: string): Promise<McpReloadSummary> {
  const matching = [
    ...[...workers.values()].map((worker) => ({ id: worker.id, runner: worker.runner })),
    ...[...missionRunners.entries()].map(([id, handle]) => ({ id: `mission:${id}`, runner: handle.runner })),
  ].filter(({ runner }) =>
    runner.provider === provider
    && sameWorkspacePath(runner.workspacePath, workspacePath)
    && providerReady(runner.provider),
  );
  const summary: McpReloadSummary = { reloaded: 0, deferred: 0, failed: 0 };
  await Promise.all(matching.map(async ({ id, runner }) => {
    try {
      const result = await runner.reloadMcp();
      summary[result]++;
    } catch (error) {
      summary.failed++;
      console.warn(`MCP reload failed for ${id}:`, (error as Error).message);
    }
  }));

  if (provider === "codex") {
    const available = matching.find(({ runner }) => !runner.busy);
    if (available) {
      try {
        const result = await (available.runner as CodexSession).listMcpServerTools();
        if (result.ok) codexCapabilitiesFor(workspacePath).mergeMcpTools(result.servers);
        else codexCapabilitiesFor(workspacePath).markMcpToolsUnavailable();
      } catch {
        codexCapabilitiesFor(workspacePath).markMcpToolsUnavailable();
      }
    }
  }
  return summary;
}

function stopProviderWorkers(provider: ProviderId): void {
  for (const worker of workers.values()) {
    if (worker.runner.provider !== provider) continue;
    const wasBusy = worker.runner.busy;
    if (wasBusy) worker.runner.interrupt();
    else worker.runner.stop();
    if (wasBusy) {
      broadcast({ type: "worker_status", workerId: worker.id, busy: false });
    }
  }
  for (const [key, handle] of missionRunners) {
    if (handle.runner.provider !== provider) continue;
    if (handle.runner.busy) handle.runner.interrupt();
    else handle.runner.stop();
    missionRunners.delete(key);
  }
}

async function refreshOneAuth(provider: ProviderId): Promise<ProviderAuthState> {
  const wasReady = providerReady(provider);
  authStates[provider] = { ...authStates[provider], status: "checking", error: null };
  broadcast({ type: "auth_updated", auth: authStates[provider] });
  const next = await authProviders[provider].checkAuth();
  const becameReady = !wasReady && next.status === "authenticated";
  authStates[provider] = next;
  broadcast({ type: "auth_updated", auth: next });
  if (next.status === "authenticated") void usageRegistry.refresh(provider);
  if (
    wasReady &&
    (next.status === "unauthenticated" || next.status === "cli_missing")
  ) {
    stopProviderWorkers(provider);
  }
  if (becameReady) {
    restartIdleWorkers(provider);
    for (const workspacePath of recentWorkspacePaths()) {
      if (provider === "claude") void claudeCapabilitiesFor(workspacePath).refresh();
      else void codexCapabilitiesFor(workspacePath).refresh();
    }
  }
  return next;
}

async function refreshAuth(provider?: ProviderId): Promise<ProviderAuthState[]> {
  if (provider) return [await refreshOneAuth(provider)];
  return Promise.all((Object.keys(authProviders) as ProviderId[]).map(refreshOneAuth));
}

// Refreshes only the workspace a mutation just touched. This used to fan
// out across every known workspace (Claude's `-s user`-scoped servers are
// visible from all of them), but once refresh() started also health-checking
// each server via `mcp get`, that fan-out measured 15-70+s combined across
// several real workspaces — making add/remove/login/logout feel stuck even
// though the mutation itself had already succeeded. Other, currently
// inactive workspaces' cached capabilities go stale until they're next
// refreshed (switching to them, or "重新讀取"), which is an acceptable
// trade-off for keeping the workspace the user is actually looking at
// responsive. Callers should fire this in the background
// (`void refreshAffectedWorkspace(...).catch(() => {})`) rather than await
// it before responding; the result still reaches clients via the existing
// "capabilities_updated" WS broadcast.
function refreshAffectedWorkspace(provider: ProviderId, workspacePath: string): Promise<void> {
  return provider === "codex"
    ? codexCapabilitiesFor(workspacePath).refresh()
    : claudeCapabilitiesFor(workspacePath).refresh();
}

const externalMcpSyncs = new Map<string, Promise<void>>();

function synchronizeExternalMcpChange(change: McpConfigChange): Promise<void> {
  const workspacePaths = change.workspacePath ? [change.workspacePath] : recentWorkspacePaths();
  const syncs = workspacePaths.map((workspacePath) => {
    const key = `${change.provider}\0${workspacePath}`;
    const previous = externalMcpSyncs.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        await refreshAffectedWorkspace(change.provider, workspacePath);
        const reload = await reloadMcpWorkers(change.provider, workspacePath);
        console.info(
          `MCP configuration synchronized (${change.provider}, ${change.scope}): `
          + `${reload.reloaded} reloaded, ${reload.deferred} deferred, ${reload.failed} failed`,
        );
      })
      .catch((error) => {
        console.warn(`MCP configuration synchronization failed (${change.provider}):`, (error as Error).message);
      })
      .finally(() => {
        if (externalMcpSyncs.get(key) === next) externalMcpSyncs.delete(key);
      });
    externalMcpSyncs.set(key, next);
    return next;
  });
  return Promise.all(syncs).then(() => {});
}

app.post("/api/mcp", async (req, res) => {
  const provider: ProviderId = req.body?.provider === "codex" ? "codex" : "claude";
  let workspacePath: string;
  try {
    workspacePath = normalizeManagedWorkspacePath(req.body?.workspacePath);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || "無法使用這個工作位置" });
    return;
  }
  const name = String(req.body?.name ?? "").trim();
  if (!/^[\w.-]+$/.test(name)) {
    res.status(400).json({ error: "名稱只能用英數、-、_、." });
    return;
  }
  const scope: "local" | "project" | "user" =
    req.body?.scope === "project" || req.body?.scope === "user" ? req.body.scope : "local";
  const mode: "form" | "json" = req.body?.mode === "json" ? "json" : "form";

  if (mode === "json") {
    if (provider === "codex") {
      res.status(400).json({ error: "Codex 不支援用 JSON 新增 MCP server" });
      return;
    }
    const json = String(req.body?.json ?? "").trim();
    if (!json) {
      res.status(400).json({ error: "缺少 JSON 內容" });
      return;
    }
    try {
      JSON.parse(json);
    } catch {
      res.status(400).json({ error: "JSON 格式不正確" });
      return;
    }
    try {
      const { stdout } = await execCli(config.claudeBin, buildClaudeMcpAddArgs({ name, scope, mode: "json", json }), {
        cwd: workspacePath,
        timeout: 30000,
      });
      void refreshAffectedWorkspace(provider, workspacePath).catch(() => {});
      const reload = await reloadMcpWorkers(provider, workspacePath);
      res.json({ ok: true, message: stdout.trim(), reload });
    } catch (err: any) {
      res.status(500).json({ error: (err.stderr || err.message || "").trim().slice(0, 500) });
    }
    return;
  }

  const transport: "stdio" | "sse" | "http" =
    req.body?.transport === "http" || req.body?.transport === "sse" ? req.body.transport : "stdio";
  const target = String(req.body?.target ?? "").trim();
  const env: string[] = Array.isArray(req.body?.env) ? req.body.env.map(String) : [];
  const headers: string[] = Array.isArray(req.body?.headers) ? req.body.headers.map(String) : [];
  // Advanced, optional OAuth fields — plain strings, never a client secret
  // (see the comment on ClaudeMcpAddInput for why that one's excluded).
  const callbackPort = String(req.body?.callbackPort ?? "").trim();
  const clientId = String(req.body?.clientId ?? "").trim();
  const oauthClientId = String(req.body?.oauthClientId ?? "").trim();
  const oauthResource = String(req.body?.oauthResource ?? "").trim();

  if (transport === "stdio") {
    if (headers.length > 0) {
      res.status(400).json({ error: "stdio 伺服器不支援 header" });
      return;
    }
    if (!env.every((entry) => /^[\w.]+=.*/.test(entry))) {
      res.status(400).json({ error: "環境變數格式需為 KEY=VALUE" });
      return;
    }
  } else {
    if (env.length > 0) {
      res.status(400).json({ error: "http/sse 伺服器不支援環境變數" });
      return;
    }
    if (!headers.every((entry) => /^[^:\r\n]+:\s*.+/.test(entry))) {
      res.status(400).json({ error: "Header 格式需為 Name: value" });
      return;
    }
  }
  if (!target) {
    res.status(400).json({ error: "缺少 URL 或指令" });
    return;
  }

  let localArgv: string[] = [];
  if (transport === "stdio") {
    try {
      localArgv = parseCommandLine(target);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message || "MCP 指令格式不正確" });
      return;
    }
  } else if (!/^https?:\/\//.test(target)) {
    res.status(400).json({ error: "URL 需以 http:// 或 https:// 開頭" });
    return;
  }

  let args: string[];
  if (provider === "codex") {
    if (headers.length > 0) {
      res.status(400).json({ error: "Codex 遠端 MCP 請使用 OAuth 或 bearer-token-env-var，介面不保存 token" });
      return;
    }
    if (transport === "sse") {
      res.status(400).json({ error: "Codex 不支援 SSE transport" });
      return;
    }
    args = buildCodexMcpAddArgs({
      name,
      transport: transport === "http" ? "http" : "stdio",
      target: transport === "http" ? target : undefined,
      localArgv: transport === "stdio" ? localArgv : undefined,
      env,
      oauthClientId: transport === "http" ? oauthClientId || undefined : undefined,
      oauthResource: transport === "http" ? oauthResource || undefined : undefined,
    });
  } else {
    args = buildClaudeMcpAddArgs({
      name,
      scope,
      mode: "form",
      transport,
      target: transport !== "stdio" ? target : undefined,
      localArgv: transport === "stdio" ? localArgv : undefined,
      env,
      headers,
      callbackPort: transport !== "stdio" ? callbackPort || undefined : undefined,
      clientId: transport !== "stdio" ? clientId || undefined : undefined,
    });
  }

  try {
    const { stdout } = await execCli(provider === "codex" ? config.codexBin : config.claudeBin, args, {
      cwd: workspacePath,
      timeout: 30000,
    });
    void refreshAffectedWorkspace(provider, workspacePath).catch(() => {});
    const reload = await reloadMcpWorkers(provider, workspacePath);
    res.json({ ok: true, message: stdout.trim(), reload });
  } catch (err: any) {
    res.status(500).json({ error: (err.stderr || err.message || "").trim().slice(0, 500) });
  }
});

app.post("/api/mcp/refresh", async (req, res) => {
  const provider: ProviderId = req.body?.provider === "codex" ? "codex" : "claude";
  let workspacePath: string;
  try {
    workspacePath = normalizeManagedWorkspacePath(req.body?.workspacePath);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || "無法使用這個工作位置" });
    return;
  }
  if (provider === "codex") await codexCapabilitiesFor(workspacePath).refresh();
  else await claudeCapabilitiesFor(workspacePath).refresh();
  const reload = await reloadMcpWorkers(provider, workspacePath);
  res.json({
    ok: true,
    reload,
    capabilities: provider === "codex"
      ? codexCapabilitiesFor(workspacePath).getState()
      : claudeCapabilitiesFor(workspacePath).getState(),
  });
});

// Claude has no CLI-level way to list a connected MCP server's tools (see
// the RunnerEvent "meta" comment in claudeRunner.ts), so this is Codex-only
// in practice — the frontend never calls it for a Claude workspace, but this
// still answers defensively rather than 404ing on a Claude request.
app.post("/api/mcp/tools", async (req, res) => {
  const provider: ProviderId = req.body?.provider === "codex" ? "codex" : "claude";
  let workspacePath: string;
  try {
    workspacePath = normalizeManagedWorkspacePath(req.body?.workspacePath);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || "無法使用這個工作位置" });
    return;
  }
  if (provider !== "codex") {
    res.json({ ok: true, capabilities: claudeCapabilitiesFor(workspacePath).getState() });
    return;
  }
  const registry = codexCapabilitiesFor(workspacePath);
  const worker = [...workers.values()].find(
    (candidate) => candidate.runner.provider === "codex" && candidate.runner.workspacePath === workspacePath,
  );
  if (!worker) {
    res.json({ ok: true, capabilities: registry.getState(), unavailable: true, reason: "no_active_worker" });
    return;
  }
  const result = await (worker.runner as CodexSession).listMcpServerTools();
  if (result.ok) registry.mergeMcpTools(result.servers);
  else registry.markMcpToolsUnavailable();
  res.json({ ok: true, capabilities: registry.getState() });
});

app.delete("/api/mcp/:name", async (req, res) => {
  const provider: ProviderId = req.query.provider === "codex" ? "codex" : "claude";
  let workspacePath: string;
  try {
    workspacePath = normalizeManagedWorkspacePath(req.query.workspacePath);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || "無法使用這個工作位置" });
    return;
  }
  const name = req.params.name;
  if (!/^[\w.-]+$/.test(name)) {
    res.status(400).json({ error: "這個 server 不能從這裡移除（可能是 claude.ai 帳號層級的連接器）" });
    return;
  }
  const scope = req.query.scope === "local" || req.query.scope === "project" || req.query.scope === "user"
    ? req.query.scope
    : undefined;
  try {
    const args = provider === "codex" ? ["mcp", "remove", name] : buildClaudeMcpRemoveArgs(name, scope);
    const { stdout } = await execCli(provider === "codex" ? config.codexBin : config.claudeBin, args, {
      cwd: workspacePath,
      timeout: 30000,
    });
    void refreshAffectedWorkspace(provider, workspacePath).catch(() => {});
    const reload = await reloadMcpWorkers(provider, workspacePath);
    res.json({ ok: true, message: stdout.trim(), reload });
  } catch (err: any) {
    res.status(500).json({ error: (err.stderr || err.message || "").trim().slice(0, 500) });
  }
});

// `claude mcp login`/`codex mcp login` open the user's system browser and
// wait for them to authorize — an unbounded, user-paced duration. This does
// not block the HTTP response; completion is reported later via the
// "mcp_login_result" WS broadcast (see mcpLoginTracker above).
app.post("/api/mcp/login", (req, res) => {
  const provider: ProviderId = req.body?.provider === "codex" ? "codex" : "claude";
  let workspacePath: string;
  try {
    workspacePath = normalizeManagedWorkspacePath(req.body?.workspacePath);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || "無法使用這個工作位置" });
    return;
  }
  // Unlike remove, login is a safe/reversible auth-only action — and
  // claude.ai account-level connectors (names with spaces, e.g. "claude.ai
  // Notion") are exactly the servers most likely to need it, so login is
  // not restricted to the `^[\w.-]+$` name pattern used for structural
  // changes.
  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "缺少 server 名稱" });
    return;
  }
  const { state, alreadyRunning } = mcpLoginTracker.start(provider, workspacePath, name);
  res.json({ ok: true, started: true, alreadyRunning, state });
});

app.post("/api/mcp/login/cancel", (req, res) => {
  const provider: ProviderId = req.body?.provider === "codex" ? "codex" : "claude";
  let workspacePath: string;
  try {
    workspacePath = normalizeManagedWorkspacePath(req.body?.workspacePath);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || "無法使用這個工作位置" });
    return;
  }
  const name = String(req.body?.name ?? "").trim();
  res.json({ ok: mcpLoginTracker.cancel(provider, workspacePath, name) });
});

// Lets the Modal re-align its "waiting for browser authorization" spinner
// after a page reload, since that pending state otherwise only lives in the
// tracker's in-memory Map.
app.get("/api/mcp/login", (req, res) => {
  const provider: ProviderId = req.query.provider === "codex" ? "codex" : "claude";
  let workspacePath: string;
  try {
    workspacePath = normalizeManagedWorkspacePath(req.query.workspacePath);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || "無法使用這個工作位置" });
    return;
  }
  const name = String(req.query.name ?? "").trim();
  res.json({ state: mcpLoginTracker.get(provider, workspacePath, name) ?? null });
});

app.post("/api/mcp/logout", async (req, res) => {
  const provider: ProviderId = req.body?.provider === "codex" ? "codex" : "claude";
  let workspacePath: string;
  try {
    workspacePath = normalizeManagedWorkspacePath(req.body?.workspacePath);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || "無法使用這個工作位置" });
    return;
  }
  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "缺少 server 名稱" });
    return;
  }
  try {
    const { stdout } = await execCli(provider === "codex" ? config.codexBin : config.claudeBin, ["mcp", "logout", name], {
      cwd: workspacePath,
      timeout: 30000,
    });
    void refreshAffectedWorkspace(provider, workspacePath).catch(() => {});
    const reload = await reloadMcpWorkers(provider, workspacePath);
    res.json({ ok: true, message: stdout.trim(), reload });
  } catch (err: any) {
    res.status(500).json({ error: (err.stderr || err.message || "").trim().slice(0, 500) });
  }
});

// `claude mcp reset-project-choices` only clears this project's remembered
// approve/reject decisions for .mcp.json servers so the next interactive
// session re-prompts — it cannot itself approve a pending server headlessly
// (that is an interactive-TUI-only action).
app.post("/api/mcp/reset-project-choices", async (req, res) => {
  let workspacePath: string;
  try {
    workspacePath = normalizeManagedWorkspacePath(req.body?.workspacePath);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || "無法使用這個工作位置" });
    return;
  }
  try {
    const { stdout } = await execCli(config.claudeBin, ["mcp", "reset-project-choices"], {
      cwd: workspacePath,
      timeout: 15000,
    });
    await claudeCapabilitiesFor(workspacePath).refresh();
    res.json({ ok: true, message: stdout.trim() || "已清除本專案核准記憶，下次互動式 session 會重新詢問" });
  } catch (err: any) {
    res.status(500).json({ error: (err.stderr || err.message || "").trim().slice(0, 500) });
  }
});

// `claude mcp add-from-claude-desktop` only works on macOS/WSL (the CLI
// itself enforces this); the frontend gates the button on `system.platform`
// as a first-pass check, but this endpoint still lets the CLI's own error
// surface through if it's called somewhere unsupported.
app.post("/api/mcp/import-from-claude-desktop", async (req, res) => {
  let workspacePath: string;
  try {
    workspacePath = normalizeManagedWorkspacePath(req.body?.workspacePath);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || "無法使用這個工作位置" });
    return;
  }
  const scope: "local" | "project" | "user" =
    req.body?.scope === "project" || req.body?.scope === "user" ? req.body.scope : "local";
  try {
    const { stdout } = await execCli(config.claudeBin, ["mcp", "add-from-claude-desktop", "-s", scope], {
      cwd: workspacePath,
      timeout: 30000,
    });
    await claudeCapabilitiesFor(workspacePath).refresh();
    const reload = await reloadMcpWorkers("claude", workspacePath);
    res.json({ ok: true, message: stdout.trim() || "已從 Claude Desktop 匯入 MCP servers", reload });
  } catch (err: any) {
    res.status(500).json({ error: (err.stderr || err.message || "").trim().slice(0, 500) });
  }
});

app.post("/api/workers/:id/interrupt", (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) {
    res.status(404).json({ error: "unknown worker" });
    return;
  }
  if (handoffInProgress(worker)) {
    res.status(409).json({ error: "LLM 交接不能從一般中止按鈕取消，請等待交接完成或回滾" });
    return;
  }
  if (collaborationInProgress(worker.id) || missionInProgress(worker.id)) {
    res.status(409).json({ error: missionInProgress(worker.id) ? "Department Mission 請從 Mission 面板取消" : "協作任務請從協作面板取消" });
    return;
  }
  worker.runner.interrupt();
  broadcast({ type: "worker_status", workerId: worker.id, busy: false });
  res.json({ ok: true });
});

for (const savedWorker of store.loadWorkers(MAX_HISTORY).slice(0, MAX_WORKERS)) {
  createWorker(undefined, undefined, savedWorker.provider, savedWorker.workspacePath, savedWorker, null, null, { warmup: true });
}
if (workers.size === 0 && config.targetRepoConfigured) {
  createWorker(undefined, undefined, "claude", config.targetRepoPath, undefined, null, null, { warmup: true });
}

const workflowWatcher = new WorkflowLibraryWatcher(recentWorkspacePaths, ({ workspacePath, provider, revision }) => {
  broadcast({ type: "workflow_library_updated", workspacePath, provider, revision });
  if (provider === "claude") {
    void claudeCapabilitiesFor(workspacePath).refreshCommands(true);
    restartIdleWorkers("claude", workspacePath);
  } else {
    // Codex skills aren't cached in a capability registry (they're read fresh
    // from disk per invocation, see the /api/skills routes above) — restarting
    // idle workers is the only thing an external skill-file edit needs here.
    restartIdleWorkers("codex", workspacePath);
  }
});
workflowWatcher.start();

// Provider CLIs and project files can change MCP configuration while Pixel
// Crew remains open. Keep capability caches and long-lived sessions derived
// from that source of truth, instead of requiring a new conversation.
const mcpConfigWatcher = new McpConfigWatcher(
  recentWorkspacePaths,
  synchronizeExternalMcpChange,
);
mcpConfigWatcher.start();

void Promise.all(recentWorkspacePaths().flatMap((workspacePath) => [
  claudeCapabilitiesFor(workspacePath).refresh(),
  codexCapabilitiesFor(workspacePath).refresh(),
])).then(() => {
  restartIdleWorkers();
});
void refreshAuth();
const usageRefreshTimer = setInterval(() => {
  void usageRegistry.refreshAll(true);
}, 5 * 60_000);
usageRefreshTimer.unref();

if (config.production && existsSync(config.webDistPath)) {
  app.use(express.static(config.webDistPath, {
    index: false,
    etag: true,
    maxAge: "1h",
    setHeaders(res, path) {
      if (path.endsWith("index.html")) res.setHeader("Cache-Control", "no-store");
      else if (/[\\/]assets[\\/]/.test(path)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    },
  }));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/internal/") || req.path === "/healthz") {
      next();
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(join(config.webDistPath, "index.html"));
  });
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`pixel-crew received ${signal}; shutting down`);
  clearInterval(usageRefreshTimer);
  workflowWatcher.stop();
  mcpConfigWatcher.stop();
  for (const worker of workers.values()) worker.runner.stop();
  for (const handle of missionRunners.values()) handle.runner.stop();
  missionRunners.clear();
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolveClose) => wss.close(() => resolveClose()));
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  store.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).then(() => { process.exitCode = 0; });
  });
}

// Node terminates the process on both of these by default, with no
// diagnostic trail beyond whatever generic message it prints — every NPC
// would just disconnect at once with no indication why. Log the actual
// cause, then shut down as gracefully as the crashed state allows (stop
// worker subprocesses, close the DB) before exiting non-zero. Continuing to
// run after either of these is explicitly unsafe (the process may be in an
// inconsistent state), so this is a diagnostic improvement, not an attempt
// to recover and keep serving.
process.on("uncaughtException", (error) => {
  console.error("[fatal] uncaught exception:", error);
  void shutdown("uncaughtException").finally(() => process.exit(1));
});
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandled rejection:", reason);
  void shutdown("unhandledRejection").finally(() => process.exit(1));
});

server.listen(config.port, config.host, () => {
  console.log(`pixel-crew server listening on http://${config.host}:${config.port}`);
  console.log(`target repo: ${config.targetRepoPath}`);
  console.log(`local database: ${config.dbPath}`);
  if (config.production && !existsSync(config.webDistPath)) {
    console.warn(`web build not found at ${config.webDistPath}; run npm run build first`);
  }
});
