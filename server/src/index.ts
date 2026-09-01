import express, { type Response } from "express";
// Patches Express's router so a rejected promise inside an async route
// handler is forwarded to next(err) instead of becoming an unhandled
// rejection — Express 4 does not do this on its own, and previously an
// error deep in any single request (malformed body, unexpected null, ...)
// crashed the entire process via process.on("unhandledRejection") below,
// taking every other worker's run down with it. Must be imported before any
// app.get/post/... route registration.
import "express-async-errors";
import { PreparedTokenStore } from "./preparedTokens.js";
import cors, { type CorsOptions } from "cors";
import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { release as osRelease, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "./config.js";
import { configuredDefaultModels } from "./defaultModels.js";
import { readWorkspaceGitSummary } from "./workspaceGit.js";
import { appendRuntimeLog } from "./runtimeLog.js";
import { ClaudeSession, type RunnerEvent } from "./claudeRunner.js";
import { claudeChildEnv } from "./claudeEnv.js";
import {
  isEphemeralWorkerName, parseWarroomResult, sanitizeCustomStances, warroomModels, warroomOpeningPrompt, warroomRebuttalPrompt,
  warroomSynthesisPrompt, warroomStances, type WarRoomDifficulty, type WarRoomResult, type WarRoomStance,
} from "./warroom.js";
import { costMicrosForTurnEnd } from "./costTracking.js";
import { executionBudgetFor, normalizeExecutionProfile } from "./executionBudget.js";
import { buildClaudeMcpAddArgs, buildClaudeMcpRemoveArgs, CapabilityRegistry } from "./capabilities.js";
import { buildCodexMcpAddArgs, CodexCapabilityRegistry, DEFAULT_CODEX_SLASH_COMMANDS, isValidCodexCommandName, MAX_CUSTOM_CODEX_SLASH_COMMANDS } from "./codexCapabilities.js";
import { McpLoginTracker } from "./mcpLogin.js";
import { LocalStore, type PersistedWorker, type ResumeCandidate } from "./store.js";
import { ClaudeAuthProvider } from "./providers/claudeAuth.js";
import { CodexAuthProvider } from "./providers/codexAuth.js";
import { AccountRegistry } from "./accountRegistry.js";
import { CodexAccountLoginTracker, type CodexAccountLoginMode } from "./codexAccountLogin.js";
import { ClaudeLoginTracker } from "./claudeAccountLogin.js";
import { migrateAmbientCodexHome } from "./codexHomeMigration.js";
import { migrateAmbientClaudeHome } from "./claudeHomeMigration.js";
import { CodexSession, codexChildEnv } from "./codexRunner.js";
import type { AgentSession, MessageDocument, MessageImage } from "./providers/session.js";
import type { AgentAuthProvider, ProviderAuthState, ProviderId } from "./providers/types.js";
import { UpdateChecker, readCurrentVersion } from "./updateCheck.js";
import { registerWorkflowLibraryRoutes } from "./workflowLibraryRoutes.js";
import { isAllowedLocalRequest, isAllowedLoopbackOrigin } from "./localAccess.js";
import { WorkflowLibraryWatcher } from "./workflowWatcher.js";
import { AvatarStore, AvatarValidationError } from "./avatarStore.js";
import { captureWebShot, shutdownWebShot } from "./webShot.js";
import { ensurePrivateDirectorySync } from "./platform/fileProtection.js";
import { writeBackupExport } from "./backupTransport.js";
import { registerBackupImportTransport } from "./backupImportTransport.js";
import { commitBackupRestore } from "./backupRestoreCommit.js";
import { registerOperationalSettingsRoutes } from "./operationalSettingsRoutes.js";
import { registerReportingRoutes } from "./reportingRoutes.js";
import { registerScheduleRoutes } from "./scheduleRoutes.js";
import { registerAccountRoutes } from "./accountRoutes.js";
import { registerApprovalRoutes } from "./approvalRoutes.js";
import { VoiceModelManager } from "./voice/voiceModel.js";
import { VoiceEngineServer } from "./voice/voiceEngineServer.js";
import { VoiceTranscriber, resolveWhisperBinary } from "./voice/voiceTranscribe.js";
import { registerVoiceRoutes } from "./voice/voiceRoutes.js";
import {
  readAndClearRestoreMarker,
} from "./backupImport.js";
import { AccountUsageRegistry, ProviderUsageRegistry } from "./providerUsage.js";
import {
  composePersonaPrompt,
  normalizePersona,
  normalizePersonaTemplate,
  parsePersonaSuggestion,
  personaSuggestionPrompt,
  type Persona,
  type PersonaTemplate,
} from "./persona.js";
import {
  addMemoryNote,
  composeMemorySection,
  composeOutboxSection,
  deleteExtras,
  getExtras,
  removeMemoryNote,
  setDailyBudget,
} from "./workerExtras.js";
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
import { localDay } from "./dayReport.js";
import { decideBrainSwap, BRAIN_SWAP_THRESHOLD_TOKENS } from "./brainSwap.js";
import { AppSettingsStore } from "./appSettings.js";
import { setLang, t, tc } from "./i18n.js";
import { accumulateSwallowedText, parseLimitReset } from "./limitResume.js";
import { composeConsultAsk, composeConsultDigest, composeConsultSection, selectConsultTargets } from "./consult.js";

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
  // frame-src 放行本機轉接站(8790) 以便遠端存取設定精靈能內嵌在 App modal；
  // 遠端經轉接站進來時精靈是同源('self')，不受此影響。
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; font-src 'self' data:; frame-src 'self' http://localhost:8790 http://127.0.0.1:8790");
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
    res.status(503).json({ error: t("還原正在進行中") });
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
const appSettings = new AppSettingsStore(config.dataDirectory);
setLang(appSettings.get().lang);

function persistAttachments(
  images: MessageImage[],
  documents: MessageDocument[],
  res: Response,
): AttachmentRecord[] | null {
  try {
    return attachmentRepository.persist(images, documents);
  } catch (error) {
    console.error("附件保存失敗", error);
    res.status(500).json({ error: t("附件保存失敗，請稍後重試") });
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
const updateChecker = new UpdateChecker(readCurrentVersion(), (info) => {
  broadcast({ type: "update_info", updateInfo: info });
});
updateChecker.start();
migrateAmbientCodexHome(config.defaultCodexHome);
migrateAmbientClaudeHome(config.defaultClaudeHome);
const authProviders: Record<ProviderId, AgentAuthProvider> = {
  claude: new ClaudeAuthProvider(config.defaultClaudeHome),
  codex: new CodexAuthProvider(config.defaultCodexHome),
};
const authStates: Record<ProviderId, ProviderAuthState> = {
  claude: initialAuthState(authProviders.claude),
  codex: initialAuthState(authProviders.codex),
};
const providerInstaller = new ProviderInstaller(async (provider) => {
  await refreshOneAuth(provider);
});
// One registry shared by both providers' named accounts — see accountRegistry.ts.
const accountRegistry = new AccountRegistry(
  (id) => store.getAccount(id),
  (provider, homeDir) => provider === "codex" ? new CodexAuthProvider(homeDir) : new ClaudeAuthProvider(homeDir),
);
const usageRegistry = new ProviderUsageRegistry(
  store,
  (usage) => {
    broadcast({ type: "usage_updated", provider: usage.provider, usage });
  },
  (provider) => authStates[provider].status,
);
const accountUsageRegistry = new AccountUsageRegistry(
  () => store.listAccounts(),
  (accountId) => accountRegistry.stateFor(accountId)?.status ?? null,
  (accountId, usage) => {
    broadcast({ type: "account_usage_updated", accountId, usage });
  },
);
const codexAccountLoginTracker = new CodexAccountLoginTracker(async (state) => {
  broadcast({
    type: "account_login_result",
    accountId: state.accountId,
    ok: state.status === "succeeded",
    status: state.status,
    message: state.message,
  });
  if (state.status === "succeeded") {
    const auth = await accountRegistry.refresh(state.accountId);
    if (auth) {
      broadcast({ type: "account_auth_updated", accountId: state.accountId, auth });
      if (auth.status === "authenticated") {
        restartIdleWorkersForAccount(state.accountId);
        void accountUsageRegistry.refresh(state.accountId, true);
      }
    }
  }
}, undefined, undefined, undefined, (state) => {
  // Fallback link for when codex's own browser auto-open doesn't actually
  // open anything — without this the URL only ever exists in this process's
  // stdout, and the owner has no way to reach it short of a terminal.
  broadcast({ type: "account_login_url", accountId: state.accountId, loginUrl: state.loginUrl });
});
// Mirrors codexAccountLoginTracker for named Claude accounts — a second
// ClaudeLoginTracker instance, separate from defaultClaudeLoginTracker below
// (same split as Codex's default-slot vs named-account trackers).
const claudeAccountLoginTracker = new ClaudeLoginTracker(async (state) => {
  broadcast({
    type: "account_login_result",
    accountId: state.accountId,
    ok: state.status === "succeeded",
    status: state.status,
    message: state.message,
  });
  if (state.status === "succeeded") {
    const auth = await accountRegistry.refresh(state.accountId);
    if (auth) {
      broadcast({ type: "account_auth_updated", accountId: state.accountId, auth });
      if (auth.status === "authenticated") {
        restartIdleWorkersForAccount(state.accountId);
        void accountUsageRegistry.refresh(state.accountId, true);
      }
    }
  }
}, undefined, undefined, undefined, (state) => {
  broadcast({ type: "account_login_url", accountId: state.accountId, loginUrl: state.loginUrl, status: state.status });
});
function accountLoginTrackerFor(provider: ProviderId): CodexAccountLoginTracker | ClaudeLoginTracker {
  return provider === "codex" ? codexAccountLoginTracker : claudeAccountLoginTracker;
}
// The "default" Codex slot (workers with no accountId) isn't a row in
// accounts — it's Pixel Crew's own managed replacement for the ambient
// $CODEX_HOME login, always at config.defaultCodexHome. Separate tracker
// instance (rather than overloading codexAccountLoginTracker with a magic
// accountId) so its callback can plug into the existing authStates.codex /
// refreshOneAuth machinery instead of the per-named-account registry.
const DEFAULT_CODEX_LOGIN_ID = "default";
const defaultCodexLoginTracker = new CodexAccountLoginTracker(async (state) => {
  broadcast({
    type: "codex_default_login_result",
    ok: state.status === "succeeded",
    status: state.status,
    message: state.message,
  });
  if (state.status === "succeeded") await refreshOneAuth("codex");
}, undefined, undefined, undefined, (state) => {
  broadcast({ type: "codex_default_login_url", loginUrl: state.loginUrl });
});
// Mirrors defaultCodexLoginTracker, for Claude's default (no-account) slot.
const DEFAULT_CLAUDE_LOGIN_ID = "default";
const defaultClaudeLoginTracker = new ClaudeLoginTracker(async (state) => {
  broadcast({
    type: "claude_default_login_result",
    ok: state.status === "succeeded",
    status: state.status,
    message: state.message,
  });
  if (state.status === "succeeded") await refreshOneAuth("claude");
}, undefined, undefined, undefined, (state) => {
  broadcast({ type: "claude_default_login_url", loginUrl: state.loginUrl, status: state.status });
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
const providerDefaultModels = configuredDefaultModels(undefined, undefined, config.defaultCodexHome);

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
    providerDefaultModels,
    // 前端 CTX 量條的 100% 基準；單一事實來源在 brainSwap.ts，避免 web 端硬編漂移。
    brainSwapThresholdTokens: BRAIN_SWAP_THRESHOLD_TOKENS,
  };
}

type Worker = {
  id: string;
  runner: AgentSession;
  history: RunnerEvent[];
  // 圓桌／委派成員只存在於本次流程；不得因共用 event hook 又被寫回 SQLite。
  persistent: boolean;
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
  // null = shared/global default login for this worker's provider (legacy
  // behavior, still the default for every worker). Otherwise refers to a row
  // in the provider-agnostic `accounts` table whose `provider` must match
  // runner.provider.
  accountId: string | null;
  resumeCandidate: ResumeCandidate | null;
};

const workers = new Map<string, Worker>();

// 舊版的共用 turn_end hook 會把 persist:false 的短命 worker 又存回 SQLite。
// 服務重啟後，這些 worker 不可能再接回原本的編排 promise，會永遠顯示成閒置。
// 在載入 department / worker 前先清掉，讓部門成員快取也不會含有孤兒資料。
const staleEphemeralWorkerIds = store.loadWorkers(0)
  .filter((worker) => isEphemeralWorkerName(worker.name))
  .map((worker) => worker.id);
for (const workerId of staleEphemeralWorkerIds) store.deleteWorker(workerId);
if (staleEphemeralWorkerIds.length > 0) {
  console.warn(`[startup] removed ${staleEphemeralWorkerIds.length} stale ephemeral worker(s) from an interrupted run`);
}

// /api/workers/:id/* 路由開頭的共用樣板：查 worker、不存在回 404。
// 呼叫端寫 `const worker = requireWorker(res, req.params.id); if (!worker) return;`
function requireWorker(res: Response, id: string): Worker | null {
  const worker = workers.get(id);
  if (!worker) {
    res.status(404).json({ error: "unknown worker" });
    return null;
  }
  return worker;
}
const departments = new Map<string, Department>(store.listDepartments().map((department) => [department.id, department]));
const activeCollaborations = new Map<string, CollaborationTask>();
const collaborationActivities = new Map<string, MissionActivity>();
const activeMissions = new Map<string, DepartmentMission>(
  store.listReservedDepartmentMissions().map((mission) => [mission.id, mission]),
);
const missionActivities = new Map<string, MissionActivity>();
// How long a Mission/collaboration turn may stay open waiting for a
// background "async agent" tool call's closing event before it's treated as
// stuck. See the missionActivityTimeoutSweep below.
const MISSION_ASYNC_AGENT_TIMEOUT_MS = 15 * 60_000;
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
    accountId: w.accountId,
    persona: w.persona,
    autoApproveMode: w.autoApproveMode,
    handoff: w.handoff,
    resumeCandidate: w.resumeCandidate,
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
  if (!store.saveDepartmentThread(thread)) throw new Error(t("無法建立部門對話"));
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
  if (!store.saveDepartmentMessage(message)) throw new Error(t("無法保存部門訊息"));
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
    if (client.readyState !== WebSocket.OPEN) continue;
    // A single client's send failure (socket closing mid-send, etc.) must
    // never become an uncaughtException that takes down every worker's run.
    try {
      client.send(raw);
    } catch (error) {
      console.error("[broadcast] client.send failed:", error);
    }
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

// A worker with its own assigned account is gated on that account's auth
// state instead of the shared/global one; every worker with no account
// assigned keeps using the process-wide authStates as before.
function workerAuthState(worker: Worker): ProviderAuthState {
  if (worker.accountId) {
    const account = store.getAccount(worker.accountId);
    if (account?.provider === worker.runner.provider) {
      return accountRegistry.stateFor(worker.accountId) ?? authStates[worker.runner.provider];
    }
  }
  return authStates[worker.runner.provider];
}

function workerProviderReady(worker: Worker): boolean {
  return workerAuthState(worker).status === "authenticated";
}

function homeForWorker(worker: Worker): string {
  const fallback = worker.runner.provider === "codex" ? config.defaultCodexHome : config.defaultClaudeHome;
  if (!worker.accountId) return fallback;
  const account = store.getAccount(worker.accountId);
  return account && account.provider === worker.runner.provider ? account.homeDir : fallback;
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
    }, key, config.defaultClaudeHome);
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
    }, key, store, config.defaultCodexHome);
    codexCapabilityRegistries.set(key, registry);
  }
  return registry;
}

function persistWorker(worker: Worker): boolean {
  // 任一共用 hook 就算漏做判斷，也不能把短命 worker 重新寫回資料庫。
  if (!worker.persistent) return true;
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
    accountId: worker.accountId,
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

// See missionActivityTimeoutSweep: a collaboration turn kept open waiting for
// a background agent's closing event that never arrives must not stay stuck.
function timeoutCollaboration(taskId: string): void {
  collaborationActivities.delete(taskId);
  const task = activeCollaborations.get(taskId);
  if (!task) return;
  task.status = "failed";
  task.error = t("背景代理任務超過 {minutes} 分鐘未回報完成", {
    minutes: String(Math.round(MISSION_ASYNC_AGENT_TIMEOUT_MS / 60_000)),
  });
  task.completedAt = new Date().toISOString();
  activeCollaborations.delete(taskId);
  store.saveCollaborationTask(task);
  broadcastCollaboration(task);
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
    task.error = collaborationText(message, 2_000) || t("協作執行失敗");
    task.completedAt = now;
    activeCollaborations.delete(task.id);
    collaborationActivities.delete(task.id);
    store.saveCollaborationTask(task);
    broadcastCollaboration(task);
  };

  if (task.status === "returning") {
    if (event.type === "error" || event.isError) {
      task.continuationResult = collaborationText(event.type === "error" ? event.message : event.resultText, 40_000) || null;
      fail(event.type === "error" ? event.message : event.resultText || t("來源 NPC 接續工作失敗"));
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
    fail(event.type === "error" ? event.message : event.resultText || t("目標 NPC 協作失敗"));
    return;
  }

  const result = parseCollaborationResult(event.resultText || "");
  if (!result) {
    fail(t("目標 NPC 沒有回傳協作結果"));
    return;
  }
  task.result = result;
  const source = workers.get(task.sourceWorkerId);
  const target = workers.get(task.targetWorkerId);
  if (!source || !target) {
    fail(t("來源或目標 NPC 已不存在，無法自動交回結果"));
    return;
  }
  if (!sameWorkspacePath(source.runner.workspacePath, task.workspacePath) || !sameWorkspacePath(target.runner.workspacePath, task.workspacePath)) {
    fail(t("NPC 工作位置已改變，無法自動交回結果"));
    return;
  }
  if (source.runner.busy || handoffInProgress(source)) {
    fail(t("來源 NPC 狀態已改變，無法自動接續工作"));
    return;
  }
  if (!workerProviderReady(source)) {
    fail(t("{provider} 尚未登入，無法自動接續工作", { provider: providerLabel(source.runner.provider) }));
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
    record(source, { type: "error", message: (error as Error).message || t("無法自動交回協作結果") });
    // record(error) owns the failure transition while the task is returning.
  }
}

function missionMembers(mission: DepartmentMission): Worker[] {
  const eligible = [...workers.values()].filter((worker) => mission.departmentId
    ? worker.departmentId === mission.departmentId
    : sameWorkspacePath(worker.runner.workspacePath, mission.workspacePath));
  if (!mission.memberWorkerIds || mission.memberWorkerIds.length === 0) return eligible;
  const selected = new Set(mission.memberWorkerIds);
  return eligible.filter((worker) => selected.has(worker.id));
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
  mission.error = collaborationText(message, 2_000) || t("Department Mission 執行失敗");
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
  mission.error = collaborationText(message, 2_000) || t("Department Mission 需要你決定後續");
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
    pauseMission(mission, t("Mission 指派的 NPC 已不存在，請重新指派"), "member_unavailable");
    return;
  }
  if (!sameWorkspacePath(assignee.runner.workspacePath, mission.workspacePath)) {
    pauseMission(mission, t("Mission 指派的 NPC 已離開原部門，請重新指派"), "member_unavailable");
    return;
  }
  if (assignee.runner.busy || handoffInProgress(assignee) || collaborationInProgress(assignee.id)) {
    pauseMission(mission, t("{name} 正在執行其他工作，請稍後重試或重新指派", { name: assignee.runner.name }), "member_unavailable");
    return;
  }
  if (!workerProviderReady(assignee)) {
    pauseMission(mission, t("{provider} 尚未登入，請登入後重試或重新指派", { provider: providerLabel(assignee.runner.provider) }), "member_unavailable");
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
      t("部門工作 · {title}（{n}/{total}）", { title: step.title, n: stepIndex + 1, total: mission.steps.length }),
      stepAttachments.images,
      stepAttachments.documents,
      executionOptions,
    );
    attachmentRepository.markDelivery(stepAttachmentIds, mission.id, assignee.id, "delivered");
  } catch (error) {
    const message = (error as Error).message || t("無法啟動 Mission 步驟");
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
    pauseMission(mission, t("部門成員狀態已改變，無法重新規劃"), "member_unavailable");
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
    objective: t("{objective}\n\n老闆要求調整：{message}\n\n已完成、不得默默丟棄的工作：{completed}", {
      objective: mission.objective,
      message: update.message,
      completed: JSON.stringify(completedContext),
    }).slice(0, 12_000),
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
      t("部門工作 · 依老闆修改重新規劃：{message}", { message: update.message }),
      attachments.images,
      attachments.documents,
      { executionProfile: "read_only_collaboration" },
    );
    attachmentRepository.markDelivery(mission.attachmentIds ?? [], mission.id, lead.id, "delivered");
  } catch (error) {
    const message = (error as Error).message || t("無法啟動重新規劃");
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
    pauseMission(mission, event.type === "error" ? event.message : event.resultText || t("Mission 步驟失敗"));
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
      mission.maxPlanSteps,
    );
    if (!parsed.plan) {
      if ((mission.formatRepairCount ?? 0) < 1) {
        mission.formatRepairCount = 1;
        mission.error = t("計畫格式不完整，正在要求主管只修復輸出格式");
        store.saveDepartmentMission(mission);
        broadcastMission(mission);
        const repair = missionFormatRepairPrompt("plan", output);
        try {
          sendMissionRunner(
            mission,
            worker,
            repair,
            t("部門工作 · 修復計畫輸出格式"),
            [],
            [],
            { executionProfile: "read_only_collaboration" },
          );
        } catch (error) {
          appendMissionExecutionEvent(mission, worker.id, null, { type: "error", message: (error as Error).message || t("無法修復 Mission 計畫格式") });
          pauseMission(mission, (error as Error).message || t("無法修復 Mission 計畫格式"));
        }
        return;
      }
      mission.status = "needs_attention";
      mission.attentionReason = "step_failed";
      mission.error = parsed.error || t("Mission 計畫格式仍然無效，請重試規劃或取消");
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
      title: t("向老闆提交部門報告"),
      objective: t("整合所有成員的執行、Consult 與 Review 結果，提交一份包含結論、驗收狀態、主要交付、驗證、風險與待決事項的最終報告"),
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
    failMission(mission, t("Mission 找不到目前步驟"));
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
        mission.error = t("專家結果格式不完整，正在要求只修復輸出格式");
        store.saveDepartmentMission(mission);
        broadcastMission(mission);
        const repair = missionFormatRepairPrompt(step.kind, output);
        try {
          sendMissionRunner(
            mission,
            worker,
            repair,
            t("部門工作 · 修復 {kind} 輸出格式", { kind: step.kind === "consult" ? "Consult" : "Review" }),
            [],
            [],
            { executionProfile: "read_only_collaboration" },
          );
        } catch (error) {
          appendMissionExecutionEvent(mission, worker.id, step.id, { type: "error", message: (error as Error).message || t("無法修復專家結果格式") });
          pauseMission(mission, (error as Error).message || t("無法修復專家結果格式"));
        }
        return;
      }
      step.status = "failed";
      mission.status = "needs_attention";
      mission.attentionReason = "step_failed";
      mission.error = t("專家 NPC 兩次都沒有回傳結構化 Consult／Review 結果");
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
        mission.error = t("快速 Review 無法確認結果，需要你補充資訊或重新檢查");
        store.saveDepartmentMission(mission);
        broadcastMission(mission);
      }
      return;
    }
    if (review.verdict === "changes_requested") {
      if (mission.correctionCount >= mission.maxCorrections) {
        mission.status = "needs_attention";
        mission.attentionReason = "correction_limit";
        mission.error = t("Review 已退回 {n} 次，需要你決定後續", { n: mission.correctionCount + 1 });
        store.saveDepartmentMission(mission);
        broadcastMission(mission);
        return;
      }
      const executeIndex = precedingExecuteIndex(mission, stepIndex);
      if (executeIndex == null) {
        failMission(mission, t("Review 找不到可退回修正的 Execute 步驟"));
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
      mission.error = t("Review 無法確認通過，需要你補充資訊或重新檢查");
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
  // A single worker's malformed/unexpected event must never become an
  // uncaughtException that takes the whole process (and every other running
  // worker) down with it — isolate the failure to this one event instead.
  try {
    recordUnsafe(worker, event);
  } catch (error) {
    console.error(`[record] failed to process event for worker ${worker.id}:`, error);
    recordRuntimeFailure(`record() failed for worker ${worker.id} (event ${event.type})`, error);
  }
}

function recordUnsafe(worker: Worker, event: RunnerEvent): void {
  if (event.at == null) event.at = Date.now(); // 事件發生時間：這裡是唯一蓋章點，持久化＋廣播都帶著走
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
  if (worker.persistent && event.type !== "tool_call_output_delta") {
    store.appendEvent(worker.id, event, MAX_HISTORY);
  }
  if (event.type === "meta" && worker.runner.provider === "claude") {
    claudeCapabilitiesFor(worker.runner.workspacePath).mergeWorkerMeta(event);
  }
  if (worker.persistent && (event.type === "turn_end" || event.type === "error")) persistWorker(worker);
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
    if (costMicros > 0 && worker.persistent) {
      store.logDailyCost(localDay(), worker.id, worker.runner.name ?? "", costMicros);
      // 每日預算：這一筆讓今日花費「跨過」上限時，往聊天串塞一則醒目提示。
      // 之後的新訊息會被 /message 入口擋下，明天日期一換自動恢復。
      const budget = getExtras(worker.id).dailyBudgetUsd;
      if (budget != null) {
        const spentUsd = todayCostUsd(worker.id);
        if (spentUsd >= budget && spentUsd - costMicros / 1_000_000 < budget) {
          // 延到本回合的 hook（協作/作戰室裁決、warroom 等待者）跑完再記這則預算提示，
          // 否則這筆合成 error 會在遞迴 record 裡先觸發 finishCollaboration，用預算訊息蓋掉真正結果。
          const noticeText = t("💸 已達今日預算上限：今天已花 ${spent}（上限 ${cap}）。今天不再接受新指示，明天自動恢復；可到 📊營運 調整上限。", {
            spent: spentUsd.toFixed(2),
            cap: budget.toFixed(2),
          });
          queueMicrotask(() => {
            if (workers.has(worker.id)) record(worker, { type: "error", message: noticeText });
          });
        }
      }
    }
    broadcast({ type: "stats_updated", stats: { completedTurns, totalCostUsd } });
  }
  const collaborationTerminal = collaborationEventIsTerminal(worker, event);
  broadcast({ type: "event", workerId: worker.id, event });
  if ((event.type === "turn_end" || event.type === "error") && collaborationTerminal) finishCollaboration(worker, event);
  warroomRecordHook(worker, event);
  brainSwapHook(worker, event);
  limitResumeHook(worker, event);
}

function todayCostUsd(workerId: string): number {
  const day = localDay();
  return store.listDailyCosts(day)
    .filter((row) => row.day === day && row.workerId === workerId)
    .reduce((sum, row) => sum + row.costUsd, 0);
}

// ── CTX 高水位自動換腦 ──────────────────────────────────────────────────────
// turn_end 的 contextTokens（最後一次 API 呼叫的真實 context 佔用）超過門檻時，
// 先叫 NPC 把工作狀態寫成交接摘要，摘要回來後換一顆全新 session、把摘要餵進去。
// 這樣不會等到 CLI 強制壓縮把細節壓丟。圓桌(🏛)/研究員(🔍)是短命工，不換。
// 決策規則（門檻／冷卻／永久停用）抽在 brainSwap.ts 的 decideBrainSwap；
// 這裡只維護狀態集合並執行 IO。
const brainSwapPending = new Set<string>();
const brainSwapLastAt = new Map<string, number>();
const brainSwapCooldownNoted = new Set<string>();
// 換完腦後「連續」數回合 context 都超標＝固定底盤本身快吃滿視窗，換幾次都一樣。
// 這種 worker 直接停用自動換腦（交給 CLI 自己壓縮），重啟伺服器才重新評估。
const brainSwapDisabled = new Set<string>();
// 距上次換腦後連續超標的 turn_end 數（含本回合）；低於門檻或換腦完成時清零。
// 只用一次尖峰不會停用，避免 host 一接手就被交辦超重工作時被誤判成底盤肥。
const brainSwapOverflowStreak = new Map<string, number>();

function brainSwapHook(worker: Worker, event: RunnerEvent): void {
  if (!appSettings.get().brainSwapEnabled) {
    // ⚙ 功能關掉自動換腦：清掉進行到一半的換腦流程，交給 CLI 自己壓縮。
    brainSwapPending.delete(worker.id);
    return;
  }
  const isTurnEnd = event.type === "turn_end";
  if (isTurnEnd && event.type === "turn_end") {
    const ctx = event.contextTokens;
    const over = typeof ctx === "number" && ctx >= BRAIN_SWAP_THRESHOLD_TOKENS;
    brainSwapOverflowStreak.set(worker.id, over ? (brainSwapOverflowStreak.get(worker.id) ?? 0) + 1 : 0);
  }
  const decision = decideBrainSwap({
    event,
    provider: worker.runner.provider,
    workerName: worker.runner.name ?? "",
    pending: brainSwapPending.has(worker.id),
    disabled: brainSwapDisabled.has(worker.id),
    // 原邏輯只在 turn_end 觸發路徑上才查這些進行中狀態；其餘事件不用查。
    engaged: isTurnEnd && (handoffInProgress(worker) || collaborationInProgress(worker.id) || missionInProgress(worker.id)),
    sessionTurns: isTurnEnd ? worker.runner.getPersistenceState().completedTurns : 0,
    lastSwapAt: brainSwapLastAt.get(worker.id) ?? null,
    cooldownNoted: brainSwapCooldownNoted.has(worker.id),
    overflowStreak: brainSwapOverflowStreak.get(worker.id) ?? 0,
    now: Date.now(),
  });
  if (decision.action === "ignore") return;
  if (decision.action === "clear_pending" || decision.action === "abort_swap") {
    brainSwapPending.delete(worker.id);
    return;
  }
  if (decision.action === "disable") {
    brainSwapDisabled.add(worker.id);
    record(worker, { type: "user_message", text: decision.message });
    return;
  }
  if (decision.action === "cooldown") {
    if (decision.message) {
      brainSwapCooldownNoted.add(worker.id);
      record(worker, { type: "user_message", text: decision.message });
    }
    return;
  }
  if (decision.action === "complete_swap") {
    // 摘要回合結束 → 執行換腦
    brainSwapPending.delete(worker.id);
    const summary = decision.summary;
    const provider = worker.runner.provider;
    const workspacePath = worker.runner.workspacePath;
    const model = worker.runner.getModel() ?? undefined;
    const fresh = replaceWithFreshSession(
      worker,
      model,
      () => createRunner(worker, provider, workspacePath),
      () => persistWorker(worker),
      (runner) => store.saveProviderCheckpoint(worker.id, provider, workspacePath, runner.getModel() ?? null, runner.getPersistenceState()),
    );
    if (!fresh) {
      record(worker, { type: "error", message: t("自動換腦失敗：無法建立新工作階段，維持原 session") });
      return;
    }
    brainSwapLastAt.set(worker.id, Date.now());
    brainSwapCooldownNoted.delete(worker.id);
    brainSwapOverflowStreak.delete(worker.id); // 全新 session＝重新起算連續超標
    broadcast({ type: "worker_updated", worker: workerSummary(worker) });
    setTimeout(() => {
      if (worker.runner.busy) return;
      record(worker, { type: "user_message", text: t("🧠 自動換腦完成：交接摘要已送進全新工作階段") });
      try {
        worker.runner.send(t("（系統自動換腦）你前一個工作階段的 context 已滿。以下是它留下的交接摘要，請讀完後簡短回覆「已接手」，之後依摘要繼續服務：\n\n{summary}", { summary }), [], []);
        broadcast({ type: "worker_status", workerId: worker.id, busy: true });
      } catch { /* 送不進去就留著摘要在紀錄裡，使用者可手動接 */ }
    }, 300);
    return;
  }

  // decision.action === "start_swap"：先請 NPC 寫交接摘要
  brainSwapPending.add(worker.id);
  const announcement = decision.message;
  setTimeout(() => {
    if (!brainSwapPending.has(worker.id)) return;
    if (worker.runner.busy) { brainSwapPending.delete(worker.id); return; } // 使用者搶先發話，等下個回合再觸發
    record(worker, { type: "user_message", text: announcement });
    try {
      worker.runner.send(t("【系統通知】你的 context 已接近上限，即將換到全新的工作階段（自動換腦）。請把「進行中的工作與狀態、重要結論、待辦事項、使用者的偏好與約定」整理成一份簡潔的交接摘要（markdown、800 字內）。下一個你會以這份摘要為唯一起點，請確保它自足。只輸出摘要本身，不要開場白。"), [], []);
      broadcast({ type: "worker_status", workerId: worker.id, busy: true });
    } catch {
      brainSwapPending.delete(worker.id);
    }
  }, 400);
}

// ── 撞用量上限自動恢復 ──────────────────────────────────────────────────────
// 回合因訂閱用量上限失敗（訊息帶 "resets 2:50pm"）→ 排一次性計時器，重置時刻
// 過後叫 NPC 繼續被中斷的工作。單發 setTimeout、fire 前多重守門，無輪詢；
// 重啟時不自動重送，改由持久化的 resume candidate 交給使用者決定。
const limitResumeTimers = new Map<string, NodeJS.Timeout>();
// 前端排隊訊息撞上限會被吞：/message 送出時記下「開啟這回合的聊天指示」，回合
// 正常結束就清掉；撞上限失敗則累積進 limitSwallowedTexts，重置後連同原文重新
// 交付（只叫 NPC「繼續」時，CLI 可能根本沒把失敗回合的訊息留進 session）。
const limitTurnText = new Map<string, string>();
const limitSwallowedTexts = new Map<string, string[]>();

function limitResumeHook(worker: Worker, event: RunnerEvent): void {
  const text = event.type === "turn_end" && event.isError ? event.resultText
    : event.type === "error" ? event.message
    : null;
  if (event.type === "turn_end" && !event.isError) {
    // 成功回合＝先前被中斷的工作已交付（含 resume 重送成功、或使用者接手後完成），
    // 連同累積清單一起清掉，才不會之後又被重送一次。
    limitTurnText.delete(worker.id);
    limitSwallowedTexts.delete(worker.id);
    if (worker.resumeCandidate?.resetAt) {
      store.deleteResumeCandidate(worker.id);
      worker.resumeCandidate = null;
    }
  }
  if (!text) return;
  if (!appSettings.get().limitResumeEnabled) { limitTurnText.delete(worker.id); return; }
  const name = worker.runner.name ?? "";
  if (name.startsWith("🏛") || name.startsWith("🔍")) return; // 短命工不排，任務由發起方重試
  const resetAt = parseLimitReset(text, new Date());
  if (!resetAt) {
    // 非上限的失敗才丟掉開場指示，且只在「回合真的以錯誤收場」時；中途的 error 事件
    // （預算通知、協作自動返回失敗等）不能把還沒累積的開場指示提前抹掉。
    if (event.type === "turn_end") limitTurnText.delete(worker.id);
    return;
  }
  const opening = limitTurnText.get(worker.id);
  if (opening) {
    limitSwallowedTexts.set(worker.id, accumulateSwallowedText(limitSwallowedTexts.get(worker.id) ?? [], opening));
    limitTurnText.delete(worker.id);
  }
  const fireAt = resetAt.getTime() + 3 * 60_000; // 過重置點 3 分鐘再戳，避免踩線又失敗
  const taskText = (limitSwallowedTexts.get(worker.id) ?? []).at(-1) ?? lastUnfinishedTask(worker.history);
  if (taskText) {
    worker.resumeCandidate = { workerId: worker.id, taskText, sessionId: worker.runner.getPersistenceState().sessionId, interruptedAt: new Date().toISOString(), resetAt: new Date(fireAt).toISOString() };
    store.saveResumeCandidate(worker.resumeCandidate);
  }
  const existing = limitResumeTimers.get(worker.id);
  if (existing) clearTimeout(existing);
  const fireLabel = new Date(fireAt).toTimeString().slice(0, 5);
  record(worker, { type: "user_message", text: t("⏰ 撞到用量上限，已排 {time} 自動繼續（⚙ 功能可關閉；伺服器重啟會取消這次排程）", { time: fireLabel }) });
  const timer = setTimeout(() => {
    limitResumeTimers.delete(worker.id);
    // 累積清單不在守門前銷毀：worker 沒了才清，其餘早退情形（功能關閉／使用者接手）保留，
    // 待成功回合（含使用者接手完成、或下次重送成功）在 hook 開頭統一清除，才不會遺失指示。
    if (!workers.has(worker.id)) { limitSwallowedTexts.delete(worker.id); return; }
    if (!appSettings.get().limitResumeEnabled) return;
    if (worker.runner.busy) return; // 已在忙＝使用者或其他機制已接手，成功回合會清掉累積
    const swallowed = limitSwallowedTexts.get(worker.id) ?? [];
    record(worker, { type: "user_message", text: t("⏰ 用量上限已重置，自動繼續先前被中斷的工作") });
    const prompt = swallowed.length > 0
      ? t("【系統通知】剛才你的回合因為訂閱用量上限中斷，現在上限已重置。中斷期間收到的下列指示可能沒有被處理（依先後排序），請逐一檢查、把沒完成的完成並回報：\n{list}", {
          list: swallowed.map((item, index) => `${index + 1}. ${item}`).join("\n"),
        })
      : t("【系統通知】剛才你的回合因為訂閱用量上限中斷，現在上限已重置。請檢查上一回合做到哪裡，接著把被中斷的工作完成並回報。");
    try {
      worker.runner.send(prompt, [], []);
      broadcast({ type: "worker_status", workerId: worker.id, busy: true });
    } catch { /* 送不進去就算了，聊天紀錄已有提示，使用者可手動接 */ }
  }, Math.max(fireAt - Date.now(), 1000));
  limitResumeTimers.set(worker.id, timer);
}

// 移除 worker（或 /clean 重置 session）時，清掉所有 per-worker 的 hook 狀態與待觸發計時器，
// 避免 Map 隨建立/刪除累積、以及清除後的舊指示被排程注入乾淨 session。
function clearWorkerHookState(workerId: string): void {
  const timer = limitResumeTimers.get(workerId);
  if (timer) { clearTimeout(timer); limitResumeTimers.delete(workerId); }
  limitTurnText.delete(workerId);
  limitSwallowedTexts.delete(workerId);
  brainSwapPending.delete(workerId);
  brainSwapLastAt.delete(workerId);
  brainSwapCooldownNoted.delete(workerId);
  brainSwapDisabled.delete(workerId);
  brainSwapOverflowStreak.delete(workerId);
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
  accountId: string | null = null,
): Worker {
  const workerProvider = persisted?.provider ?? provider;
  const workerWorkspace = registryKey(persisted?.workspacePath || workspacePath || config.targetRepoPath);
  const id = persisted?.id ?? randomUUID();
  const worker: Worker = {
    id,
    runner: null as unknown as AgentSession,
    history: persisted?.events ?? [],
    persistent: options.persist !== false,
    colorIndex: persisted?.colorIndex ?? workerCounter % 6,
    avatarId: persisted?.avatarId ?? null,
    avatarKind: persisted?.avatarKind ?? (persisted?.avatarId ? "custom" : "preset"),
    avatarPresetId: AVATAR_PRESET_IDS.has(persisted?.avatarPresetId ?? "") ? persisted!.avatarPresetId : "classic",
    persona: persisted?.persona ?? initialPersona,
    autoApproveMode: persisted?.autoApproveMode ?? "off",
    handoff: persisted ? store.loadLatestFailedHandoff(id) : null,
    departmentId: persisted?.departmentId ?? departmentId,
    accountId: persisted?.accountId ?? accountId,
    resumeCandidate: persisted ? store.getResumeCandidate(id) : null,
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
  if (options.warmup === true && workerProviderReady(worker)) runner.warmup();
  if (options.persist !== false) {
    if (!persisted && !worker.departmentId) {
      const departmentId = randomUUID();
      const now = new Date().toISOString();
      worker.departmentId = departmentId;
      const department: Department = {
        id: departmentId,
        name: t("{name}部門", { name: basename(workerWorkspace) || t("個人") }),
        purpose: t("個人工作部門"),
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
    if (!worker.resumeCandidate) {
      const taskText = lastUnfinishedTask(worker.history);
      if (taskText) {
        worker.resumeCandidate = { workerId: id, taskText, sessionId: worker.runner.getPersistenceState().sessionId, interruptedAt: new Date().toISOString(), resetAt: null };
        store.saveResumeCandidate(worker.resumeCandidate);
      }
    }
    record(worker, { type: "error", message: t("伺服器已重啟，上一個未完成的回合已中止") });
  }
  if (!persisted && options.broadcast !== false) broadcast({ type: "worker_added", worker: workerSummary(worker) });
  return worker;
}

// Persona ＋ 長期記憶合成一份 system prompt。🏛/🔍 開頭的是短命工（圓桌、研究員），
// 不給記憶區塊——它們活不到下一次 spawn，注入只是浪費 token 還可能誤存記憶。
function composeWorkerPrompt(worker: Worker): string {
  const name = worker.runner.name ?? "";
  const ephemeral = isEphemeralWorkerName(name);
  return [
    composePersonaPrompt(worker.persona),
    ephemeral ? "" : composeMemorySection(worker.id),
    ephemeral ? "" : composeOutboxSection(),
    // 小隊商量：只注入給「有隊員的部門隊長」。隊長自助 curl 發起，隊員意見彙整後自動送回。
    ephemeral ? "" : composeConsultSection({
      workerId: worker.id,
      port: config.port,
      department: worker.departmentId ? departments.get(worker.departmentId) : null,
      workerName: (id) => workers.get(id)?.runner.name,
    }),
  ].filter(Boolean).join("\n\n");
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
        () => composeWorkerPrompt(worker),
        () => worker.autoApproveMode,
        initialState,
        () => homeForWorker(worker),
      )
    : new ClaudeSession(
        (event) => record(worker, event),
        workspacePath,
        () => claudeCapabilitiesFor(workspacePath).getAllowedTools(),
        () => composeWorkerPrompt(worker),
        () => worker.autoApproveMode,
        initialState,
        () => homeForWorker(worker),
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
  clearWorkerHookState(worker.id); // 取消待觸發的自動繼續計時器，別把清除前的舊指示注入乾淨 session
  broadcast({ type: "worker_updated", worker: workerSummary(worker), reset: true });
  const announcement = t("已清除工作階段，NPC 記憶重新開始。");
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
        () => composeWorkerPrompt(worker),
        () => worker.autoApproveMode,
        checkpoint ? { sessionId: checkpoint.sessionId, completedTurns: checkpoint.completedTurns } : undefined,
        () => homeForWorker(worker),
      )
    : new ClaudeSession(
        onEvent,
        mission.workspacePath,
        () => claudeCapabilitiesFor(mission.workspacePath).getAllowedTools(),
        () => composeWorkerPrompt(worker),
        () => worker.autoApproveMode,
        checkpoint ? { sessionId: checkpoint.sessionId, completedTurns: checkpoint.completedTurns } : undefined,
        () => homeForWorker(worker),
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
  if (explicitModel && !validModel(explicitProvider ?? "claude", explicitModel)) return { error: t("決策模型格式無效") };
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
    if (!providerReady(explicitProvider)) return { error: t("{provider} 尚未登入，無法進行部門判斷", { provider: providerLabel(explicitProvider) }) };
    if (explicitModel) return { provider: explicitProvider, model: explicitModel };
    const model = runtimeModels(explicitProvider)[0];
    return model
      ? { provider: explicitProvider, model }
      : { error: t("{provider} 目前沒有可用的決策模型", { provider: providerLabel(explicitProvider) }) };
  }
  if (explicitModel) {
    for (const provider of ["claude", "codex"] as const) {
      if (providerReady(provider) && runtimeModels(provider).includes(explicitModel)) return { provider, model: explicitModel };
    }
    return { error: t("指定的決策模型目前不在任何已登入 provider 的可用清單中") };
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
  return { error: t("Claude 與 Codex 目前都無法進行部門判斷；請先登入至少一個 provider") };
}

function normalizeWorkspacePath(input: unknown): string {
  return canonicalWorkspacePath(input, config.targetRepoPath);
}

function normalizeManagedWorkspacePath(input: unknown): string {
  const canonical = normalizeWorkspacePath(input);
  const managedPaths = [config.targetRepoPath, ...[...workers.values()].map((worker) => worker.runner.workspacePath)];
  const managed = managedPaths.some((path) => sameWorkspace(path, canonical));
  if (!managed) throw new Error(t("只能管理目前已加入 Pixel Crew 的工作資料夾"));
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

function lastUnfinishedTask(events: RunnerEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.type === "user_message") return event.text.trim().slice(0, 12_000) || null;
  }
  return null;
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
  if (pendingApprovals.size) return t("仍有等待處理的權限確認，請先允許或拒絕");
  if (openAgents.size) return t("仍有背景 Agent 執行中，請等待完成或先中止任務");
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
    return t("目前工作位置不是可讀取的 Git repository，請接手後自行確認檔案狀態。");
  }
}

function detachedRunner(
  provider: ProviderId,
  workspacePath: string,
  model: string | null,
  initialState: { sessionId: string; completedTurns: number } | undefined,
  onEvent: (event: RunnerEvent) => void,
  persona: Persona | null,
  homeDir?: string,
): AgentSession {
  const runner: AgentSession = provider === "codex"
    ? new CodexSession(onEvent, workspacePath, () => composePersonaPrompt(persona), () => "off", initialState, () => homeDir ?? config.defaultCodexHome)
    : new ClaudeSession(onEvent, workspacePath, () => [], () => composePersonaPrompt(persona), () => "off", initialState, () => homeDir ?? config.defaultClaudeHome);
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
  homeDir?: string,
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
      else if (!state) rejectPromise(new Error(t("無法建立 LLM 交接工作階段")));
      else resolvePromise({ text, state, toolCalls: [...toolCalls.values()] });
    };
    runner = detachedRunner(provider, workspacePath, model, initialState, (event) => {
      if (event.type === "text_delta") streamedText += event.text;
      else if (event.type === "tool_call_start") {
        if (policy.kind === "no_tools") {
          finish(new Error(t("這個模型回合不得使用工具")));
          return;
        }
        if (policy.kind === "read_only_query") {
          const decision = queryToolPolicy(event.name, allowedQueryTools);
          if (!decision.allowed) {
            finish(new Error(t("唯讀查詢已拒絕 {name}：{reason}", { name: event.name, reason: decision.reason })));
            return;
          }
        }
        toolCalls.set(event.id, { id: event.id, name: event.name, isError: null });
      }
      else if (event.type === "tool_call_result") {
        const existing = toolCalls.get(event.id);
        if (existing) toolCalls.set(event.id, { ...existing, isError: event.isError });
      }
      else if (event.type === "approval_requested" && policy.kind !== "read_only_query") finish(new Error(t("交接整理意外要求工具權限")));
      else if (event.type === "error") finish(new Error(event.message));
      else if (event.type === "turn_end") {
        if (event.isError) finish(new Error(event.resultText || t("LLM 交接回合失敗")));
        else {
          const result = (event.resultText || streamedText).trim();
          if (!result) finish(new Error(t("LLM 沒有回傳交接內容")));
          else finish(undefined, result);
        }
      }
    }, persona, homeDir);
    timer = setTimeout(() => finish(new Error(t("LLM 交接逾時"))), timeoutMs);
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
        throw new Error(t("無法保存原本的 LLM 工作階段"));
      }
      const targetModel = progress.toModel || null;
      const targetRunner = createRunner(worker, progress.toProvider, workspacePath);
      targetRunner.name = sourceName;
      if (targetModel) targetRunner.setModel(targetModel);
      worker.runner = targetRunner;
      if (providerReady(progress.toProvider)) targetRunner.warmup();
      const completed = { ...progress, stage: "completed" as const, message: t("{provider} 已切換", { provider: providerLabel(progress.toProvider) }), source: null, error: null };
      worker.handoff = completed;
      if (!persistWorker(worker)) throw new Error(t("無法保存新的 LLM 工作階段"));
      if (!store.saveProviderHandoff(worker.id, completed, null)) throw new Error(t("無法保存 LLM 切換紀錄"));
      broadcast({ type: "worker_updated", worker: workerSummary(worker) });
      if (progress.toProvider === "claude") void claudeCapabilitiesFor(workspacePath).refresh();
      else void codexCapabilitiesFor(workspacePath).refresh();
      return;
    }

    const gitState = await workspaceGitState(workspacePath);
    const localSummary = buildLocalHandoff(worker.history, gitState);
    source = "agent";
    setHandoff(worker, { ...progress, stage: "summarizing", message: t("請 {provider} 整理工作大綱", { provider: providerLabel(sourceProvider) }), source: null });
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
      if (!summary) throw new Error(t("來源 LLM 沒有回傳有效的交接格式"));
    } catch (error) {
      source = "local_fallback";
      summary = localSummary;
      setHandoff(worker, { ...progress, stage: "fallback", message: t("來源 LLM 無法整理，改用本機任務紀錄：{error}", { error: (error as Error).message }), source });
    }

    if (!store.saveProviderCheckpoint(worker.id, sourceProvider, workspacePath, sourceModel, sourceState)) {
      throw new Error(t("無法保存原本的 LLM 工作階段"));
    }
    setHandoff(worker, { ...progress, stage: "bootstrapping", message: t("{provider} 正在讀取交接資料", { provider: providerLabel(progress.toProvider) }), source });
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
      throw new Error(t("無法保存目標 LLM 工作階段"));
    }

    const targetRunner = createRunner(worker, progress.toProvider, workspacePath, targetResult.state);
    targetRunner.name = sourceName;
    if (targetModel) targetRunner.setModel(targetModel);
    worker.runner = targetRunner;
    if (providerReady(progress.toProvider)) targetRunner.warmup();
    const completed = { ...progress, stage: "completed" as const, message: t("{provider} 已接手", { provider: providerLabel(progress.toProvider) }), source, error: null };
    worker.handoff = completed;
    if (!persistWorker(worker)) throw new Error(t("無法保存新的 LLM 工作階段"));
    if (!store.saveProviderHandoff(worker.id, completed, summary)) throw new Error(t("無法保存 LLM 交接紀錄"));
    record(worker, { type: "user_message", text: t("LLM 交接：{from} → {to}", { from: providerLabel(sourceProvider), to: providerLabel(progress.toProvider) }) });
    record(worker, { type: "text_delta", text: t("{summary}\n\n**接手確認**\n{result}", { summary: summaryMarkdown(summary), result: targetResult.text }) });
    record(worker, { type: "turn_end", resultText: t("{summary}\n\n接手確認：{result}", { summary: summaryMarkdown(summary), result: targetResult.text }), costUsd: 0, durationMs: 0, isError: false, permissionDenials: [] });
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
    const failed = { ...progress, stage: "failed" as const, message: t("交接失敗，已恢復原本的 LLM"), source, error: (error as Error).message };
    worker.handoff = failed;
    persistWorker(worker);
    store.saveProviderHandoff(worker.id, failed, summary);
    if (hasHistory) {
      record(worker, { type: "user_message", text: t("LLM 交接：{from} → {to}", { from: providerLabel(sourceProvider), to: providerLabel(progress.toProvider) }) });
      record(worker, { type: "error", message: t("交接失敗，已恢復 {provider}：{error}", { provider: providerLabel(sourceProvider), error: (error as Error).message }) });
    }
    broadcast({ type: "worker_updated", worker: workerSummary(worker) });
  }
}

// 初始 snapshot 瘦身：**保留完整訊息筆數**（日誌照樣看得到），只把單筆超大的工具
// 輸出/輸入等內容截短。真正把歷史脹到十幾 MB 的是少數幾筆巨大的工具輸出（單筆可達
// 200KB+ 的檔案內容/截圖等），不是訊息「數量」。截短後手機收得動，完整內容仍保存在
// 本機 SQLite。另設一個很寬鬆的筆數上限當保險絲，避免極端情況整包無界成長。
const SNAPSHOT_MAX_EVENTS = 800;        // 每 worker 最多送這麼多筆（對齊 turn 邊界）
const SNAPSHOT_MAX_FIELD_CHARS = 6_000; // 單一欄位序列化長度上限，超過就截短
// 預算守門：初始 snapshot 曾肥到 18.7MB 讓手機卡死在「尋找AI隊員」，瘦身到 4.85MB
// 才勉強打平。之後任何改動把它推回 5MB 以上，就在這裡大聲告警抓回歸。
const SNAPSHOT_BUDGET_BYTES = 5 * 1024 * 1024;
let snapshotBudgetWarnedAt = 0;

function clampField(value: unknown): unknown {
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return value;
  }
  if (s == null || s.length <= SNAPSHOT_MAX_FIELD_CHARS) return value;
  return s.slice(0, SNAPSHOT_MAX_FIELD_CHARS) + `…（省略 ${s.length - SNAPSHOT_MAX_FIELD_CHARS} 字；完整內容保存於本機）`;
}

// 只截「內容型」的大欄位，事件的結構與型別（type/id/name…）保持不變，前端照常渲染。
function trimEventForSnapshot(ev: RunnerEvent): RunnerEvent {
  switch (ev.type) {
    case "tool_call_result":
      return { ...ev, output: clampField(ev.output) };
    case "tool_call_start":
      return { ...ev, input: clampField(ev.input) };
    case "tool_call_output_delta":
      return ev.delta.length > SNAPSHOT_MAX_FIELD_CHARS ? { ...ev, delta: String(clampField(ev.delta)) } : ev;
    case "text_delta":
    case "thinking_delta":
      return ev.text.length > SNAPSHOT_MAX_FIELD_CHARS ? { ...ev, text: String(clampField(ev.text)) } : ev;
    default:
      return ev;
  }
}

function snapshotHistory(history: RunnerEvent[]): RunnerEvent[] {
  let events = history;
  if (events.length > SNAPSHOT_MAX_EVENTS) {
    const windowStart = events.length - SNAPSHOT_MAX_EVENTS;
    // 從視窗起點往後找第一個 turn 開頭（user_message），讓前端重建完整的 turn，不會
    // 拿到半截 turn；找不到（單一超長 turn）就用尾段，前端會安全略過孤兒事件。
    let start = windowStart;
    for (let i = windowStart; i < events.length; i++) {
      if (events[i]?.type === "user_message") { start = i; break; }
    }
    events = events.slice(start);
  }
  return events.map(trimEventForSnapshot);
}

wss.on("connection", (socket) => {
  // A client that drops mid-handshake (page reload, laptop sleep/wake, a
  // network blip) emits 'error' with no listener otherwise — that's an
  // uncaughtException that used to take the entire server, and every running
  // worker, down with it. A routine disconnect must stay routine.
  socket.on("error", (error) => {
    console.error("[wss] client socket error:", error);
  });
  for (const task of store.listBossTasksByStatus(["ready", "running"])) {
    // One malformed persisted boss task must not crash-loop the server on
    // every reconnect (crash → supervisor restart → client reconnects →
    // same bad task → crash again).
    try {
      advanceBossTask(task);
    } catch (error) {
      console.error(`[wss] advanceBossTask failed for task ${task.id}:`, error);
    }
  }
  const snapshotPayload =
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
      accounts: store.listAccounts().map((account) => ({
        ...account,
        auth: accountRegistry.stateFor(account.id),
      })),
      providerUsage: usageRegistry.getStates(),
      accountUsage: accountUsageRegistry.getStates(),
      capabilitiesByWorkspace: capabilitiesSnapshot(),
      collaborations: store.listRecentCollaborationTasks(),
      missions: store.listDepartmentMissions(),
      bossTasks: store.listBossTasks().map(bossTaskForDisplay),
      departments: store.listDepartments(),
      workers: [...workers.values()].map((w) => ({
        ...workerSummary(w),
        events: snapshotHistory(w.history),
      })),
    });
  const snapshotBytes = Buffer.byteLength(snapshotPayload);
  if (snapshotBytes > SNAPSHOT_BUDGET_BYTES && Date.now() - snapshotBudgetWarnedAt > 60_000) {
    snapshotBudgetWarnedAt = Date.now(); // 重連風暴時最多每分鐘喊一次，避免洗版
    console.warn(`[snapshot] 初始 snapshot ${(snapshotBytes / 1024 / 1024).toFixed(2)}MB 超過 ${SNAPSHOT_BUDGET_BYTES / 1024 / 1024}MB 預算——手機連線會卡，請回頭瘦身（參考上次 18.7→4.85MB 的作法）`);
  }
  try {
    socket.send(snapshotPayload);
  } catch (error) {
    console.error("[wss] failed to send initial snapshot:", error);
  }
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
    res.status(404).json({ error: t("找不到部門") });
    return;
  }
  const name = normalizeDepartmentName(req.body?.name);
  if (!name) {
    res.status(400).json({ error: t("請輸入部門名稱") });
    return;
  }
  const updated: Department = {
    ...department,
    name,
    updatedAt: new Date().toISOString(),
  };
  if (!store.saveDepartment(updated)) {
    res.status(500).json({ error: t("無法儲存部門名稱") });
    return;
  }
  departments.set(updated.id, updated);
  broadcast({ type: "department_updated", department: updated });
  res.json({ department: updated });
});

app.get("/api/workspaces", (_req, res) => {
  res.json({ defaultPath: config.targetRepoPath, paths: recentWorkspacePaths() });
});

app.get("/api/workspaces/git", async (req, res) => {
  try {
    const workspacePath = normalizeManagedWorkspacePath(req.query.workspacePath);
    res.json(await readWorkspaceGitSummary(workspacePath));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || t("無法讀取工作位置的 Git 狀態") });
  }
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
    res.status(400).json({ error: (error as Error).message || t("無法使用這個工作位置") });
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
      .json({ error: t("無法開啟系統資料夾選擇器，請改用絕對路徑") });
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
    res.status(400).json({ error: (error as Error).message || t("無法讀取房間能力") });
  }
});

registerWorkflowLibraryRoutes({
  app,
  normalizeWorkspacePath: normalizeManagedWorkspacePath,
  restartIdleWorkers,
  claudeCapabilitiesFor,
  scanWorkflowLibrary: () => workflowWatcher.scanNow(),
});

app.get("/api/auth", (_req, res) => {
  res.json({ auth: Object.values(authStates) });
});

app.get("/api/usage", (_req, res) => {
  res.json({ usage: usageRegistry.getStates(), accountUsage: accountUsageRegistry.getStates() });
});

app.post("/api/usage/refresh", async (_req, res) => {
  const [usage, accountUsage] = await Promise.all([
    usageRegistry.refreshAll(true),
    accountUsageRegistry.refreshAll(true),
  ]);
  res.json({ usage, accountUsage });
});

// ── 優雅重啟 ────────────────────────────────────────────────────────────────
// NPC 都跑在本 process 底下，直接殺 8787 會把觸發者自己的回合砍斷（result
// 還沒送到 UI 就死了）。所以改成掛旗標等空檔：每 5 秒檢查一次，等到沒有任何
// NPC 在忙（含交接/協作/任務）才啟動脫離的 relauncher，接著走完整 shutdown；
// 舊服務會先收掉所有子程序與資料庫連線，新背景服務才接手。
let restartPending = false;
let restartFailure: string | null = null;
let restartTimer: ReturnType<typeof setInterval> | null = null;

// dev（tsx watch, cwd=server/）跟正式版（node server/dist/index.js, cwd=release
// 根目錄）下 process.cwd() 不一致；下面重啟/遠端存取用到的檔案
// （restart-pixel-crew.*, _tsproxy*)都跟 server/ 同層，改用本檔自身位置鎖定，
// 不依賴呼叫者怎麼設 cwd（server/src/index.ts 與 server/dist/index.js 都在
// server/ 底下同一層，往上兩層即為該層根目錄）。
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function failServerRestart(message: string): void {
  if (restartTimer) {
    clearInterval(restartTimer);
    restartTimer = null;
  }
  restartPending = false;
  restartFailure = message;
  console.error(`[restart] ${message}`);
}

function finishServerRestart(): void {
  // The restart response has already reached the browser. Use the same orderly
  // path as normal shutdown so provider children, Mission runners, sockets,
  // and the SQLite handle are all released before the replacement starts.
  const timer = setTimeout(() => exitAfterShutdown("planned restart", 0), 800);
  timer.unref();
}

function launchRestartHelper(command: string, args: string[]): void {
  try {
    const launcher = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    let started = false;
    launcher.once("spawn", () => {
      started = true;
      finishServerRestart();
    });
    launcher.once("error", (error) => {
      if (!started) failServerRestart(t("無法啟動重啟工具：{message}", { message: error.message }));
      else console.error("[restart] 重啟工具在啟動後發生錯誤:", error);
    });
    launcher.unref();
  } catch (error) {
    failServerRestart(t("無法啟動重啟工具：{message}", { message: (error as Error).message }));
  }
}

function performServerRestart(): void {
  if (process.platform !== "win32") {
    console.log("[restart] 所有 NPC 空檔，重啟中…");
    if (process.env.PIXEL_CREW_SUPERVISED === "1") {
      // macOS 的 menu bar launcher 監督中：直接退出，由它偵測結束後重生。
      finishServerRestart();
      return;
    }
    // 無監督（手動 node 啟動）：detached shell 等 3 秒（讓觸發者的回合落地、
    // 連接埠釋放）後用同一組 argv/cwd 重啟自己。
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const relaunch = [process.execPath, ...process.argv.slice(1)].map(quote).join(" ");
    launchRestartHelper("/bin/sh", ["-c", `sleep 3; exec ${relaunch}`]);
    return;
  }
  // 注意：不能把「含內層引號的整串指令」丟給 cmd /c——node spawn 會把引號轉義成
  // \" ，cmd 解析不了，start 那段會無聲失敗（實測驗證過）。所以改成直接執行
  // restart-pixel-crew.cmd：單一路徑參數不會被轉爛，start 的引號由 .cmd 內部
  // 的 cmd 自己解析。該 script 保留短暫等待與 8787 殘留程序清理，再啟動背景服務。
  const script = join(REPO_ROOT, "restart-pixel-crew.cmd");
  if (!existsSync(script)) {
    failServerRestart(t("找不到重啟工具，已取消重啟"));
    return;
  }
  console.log("[restart] 所有 NPC 空檔，重啟中…");
  // windowsHide 配 detached 在 Windows 會被忽略（node 已知問題），直接 spawn cmd
  // 會讓 relauncher 黑窗在畫面上閃 3-4 秒。優先走 wscript+vbs（Run 視窗樣式 0 =
  // 完全隱藏，與 dc-voice-bot run-bot-hidden.vbs 同招）；vbs 不在才退回舊路徑。
  const hiddenLauncher = join(REPO_ROOT, "restart-pixel-crew-hidden.vbs");
  if (existsSync(hiddenLauncher)) {
    launchRestartHelper("wscript.exe", [hiddenLauncher]);
  } else {
    launchRestartHelper("cmd.exe", ["/c", script]);
  }
}

app.post("/api/restart-server", (_req, res) => {
  if (restartPending) {
    res.json({ ok: true, message: t("已在等待空檔重啟") });
    return;
  }
  if (process.platform === "win32" && !existsSync(join(REPO_ROOT, "restart-pixel-crew.cmd"))) {
    res.status(503).json({ error: t("找不到重啟工具，請重新安裝 Pixel Crew") });
    return;
  }
  restartPending = true;
  restartFailure = null;
  console.log("[restart] 已排程：等所有 NPC 空檔後重啟");
  restartTimer = setInterval(() => {
    const anyBusy = [...workers.values()].some((w) => workerSummary(w).busy);
    if (anyBusy) return;
    clearInterval(restartTimer!);
    restartTimer = null;
    performServerRestart();
  }, 5000);
  res.json({ ok: true, message: t("將在所有 NPC 空檔時自動重啟背景服務") });
});

app.get("/api/restart-server/status", (_req, res) => {
  res.json({ pending: restartPending, error: restartFailure });
});

// Windows' normal launcher deliberately runs without a persistent console or
// reliable tray icon. Give the local UI a first-class stop control instead of
// asking the owner to hunt down a Node process. Reply before tearing down the
// listener so apiRequest receives a deterministic acknowledgement.
app.post("/api/shutdown-server", (_req, res) => {
  if (process.platform !== "win32") {
    res.status(409).json({ error: t("背景服務關閉目前只適用 Windows") });
    return;
  }
  res.json({ ok: true });
  const timer = setTimeout(() => exitAfterShutdown("owner requested shutdown", 0), 200);
  timer.unref();
});

// ── 遠端存取／手機控制（轉接站 sidecar）─────────────────────────────────────
// 分工刻意：驗證/公開切換都在轉接站(_tsproxy.mjs, 8790)，本體只負責「把它拉起來」。
const TSPROXY_PORT = 8790;
// The relay is deliberately detached so it survives a UI/server restart.  Keep a
// tiny local startup log as well: otherwise a macOS launch failure (for example a
// port conflict or a missing executable) is discarded with stdio: "ignore" and
// the UI can only say "relay not started".
const TSPROXY_START_LOG = join(REPO_ROOT, "_tsproxy.startup.log");
function writeTsproxyStartupLog(message: string, append = false) {
  try {
    writeFileSync(TSPROXY_START_LOG, `${new Date().toISOString()} ${message}\n`, {
      encoding: "utf8", mode: 0o600, flag: append ? "a" : "w",
    });
  } catch { /* Diagnostic logging must never prevent the app from starting. */ }
}
function tsproxyStartupDetail() {
  try {
    return readFileSync(TSPROXY_START_LOG, "utf8").trim().split("\n").slice(-3).join(" ").slice(-700);
  } catch { return ""; }
}
function tsproxyRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = netConnect({ host: "127.0.0.1", port: TSPROXY_PORT });
    let settled = false;
    const done = (v: boolean) => { if (settled) return; settled = true; try { sock.destroy(); } catch { /* noop */ } resolve(v); };
    sock.setTimeout(1000);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

app.get("/api/remote-access/status", async (_req, res) => {
  res.json({ running: await tsproxyRunning(), port: TSPROXY_PORT, platform: process.platform });
});

app.post("/api/remote-access/start", async (_req, res) => {
  if (await tsproxyRunning()) { res.json({ ok: true, running: true, already: true }); return; }
  try {
    writeTsproxyStartupLog("Starting relay");
    if (process.platform === "win32") {
      // Windows：用隱藏視窗的 vbs 拉起（不彈黑窗）。
      const vbs = join(REPO_ROOT, "_tsproxy_launch.vbs");
      if (!existsSync(vbs)) { res.status(404).json({ ok: false, error: t("找不到 _tsproxy_launch.vbs") }); return; }
      spawn("wscript.exe", [vbs], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } else {
      // macOS / Linux：直接用當前 node 執行檔跑 _tsproxy.mjs，detached 讓它獨立存活。
      const mjs = join(REPO_ROOT, "_tsproxy.mjs");
      if (!existsSync(mjs)) { res.status(404).json({ ok: false, error: t("找不到 _tsproxy.mjs") }); return; }
      const child = spawn(process.execPath, [mjs], {
        detached: true, stdio: "ignore", cwd: REPO_ROOT,
        env: { ...process.env, PC_TSPROXY_LOG: TSPROXY_START_LOG },
      });
      child.once("error", (err) => writeTsproxyStartupLog(`Could not launch relay: ${err.message}`, true));
      child.unref();
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
    return;
  }
  // 等它綁定連接埠（最多 ~4 秒）
  let running = false;
  for (let i = 0; i < 10 && !running; i++) {
    await new Promise((r) => setTimeout(r, 400));
    running = await tsproxyRunning();
  }
  res.json({
    ok: running,
    running,
    error: running ? undefined : (tsproxyStartupDetail() || t("轉接站啟動失敗，請稍後再試")),
  });
});

// 同源代理：把前端對 /api/remote-access/api/* 的呼叫轉發到轉接站 8790 的 /__gate/api/*。
// 前端只碰本體同源 API（不受 CSP/cookie/登入頁影響）；8787→8790 是 127.0.0.1 直連，
// 轉接站據此視為本機（等同 owner）放行，無需在瀏覽器端處理通行碼。
function proxyToTsproxy(method: string, apiPath: string, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    const payload = Buffer.from(body || "");
    const r = httpRequest(
      {
        host: "127.0.0.1", port: TSPROXY_PORT, method,
        path: "/__gate/api/" + apiPath,
        headers: { "Content-Type": "application/json", "Content-Length": payload.length },
        timeout: 40000,
      },
      (up) => {
        let b = ""; up.on("data", (c) => (b += c));
        up.on("end", () => resolve({ status: up.statusCode || 502, text: b }));
      },
    );
    r.on("error", (e) => resolve({ status: 502, text: JSON.stringify({ error: (e as Error).message }) }));
    r.on("timeout", () => { r.destroy(); resolve({ status: 504, text: JSON.stringify({ error: "轉接站無回應" }) }); });
    if (payload.length) r.write(payload);
    r.end();
  });
}

app.get("/api/remote-access/state", async (_req, res) => {
  if (!(await tsproxyRunning())) { res.status(503).json({ error: "轉接站未啟動", running: false }); return; }
  const up = await proxyToTsproxy("GET", "state", "");
  res.status(up.status).type("application/json").send(up.text);
});

app.post("/api/remote-access/api/*", async (req, res) => {
  const name = String((req.params as Record<string, string>)[0] || "").replace(/[^a-z/]/gi, "");
  if (!name) { res.status(400).json({ error: "bad api path" }); return; }
  if (!(await tsproxyRunning())) { res.status(503).json({ error: "轉接站未啟動" }); return; }
  const up = await proxyToTsproxy("POST", name, JSON.stringify(req.body ?? {}));
  res.status(up.status).type("application/json").send(up.text);
});

// ── 成本日報與一日回放 ───────────────────────────────────────────────────────
registerReportingRoutes({
  app,
  store,
  workerIds: () => workers.keys(),
  workerName: (workerId) => workers.get(workerId)?.runner.name,
  dailyBudget: (workerId) => getExtras(workerId).dailyBudgetUsd,
});

// ── 排程任務設定；實際觸發迴圈保留在下方程序組裝層 ───────────────────────────
registerScheduleRoutes({ app, store, workerExists: (workerId) => workers.has(workerId) });

// ── 全域功能開關與本機診斷 ────────────────────────────────────────────────────
registerOperationalSettingsRoutes({ app, appSettings, store, localDay, setLang });

// 每 30 秒掃一次：到點、今天沒跑過、NPC 空檔 → 送出排程指示。
// NPC 在忙就先不標記，30 秒後再試（同一天內補跑）。
setInterval(() => {
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const today = localDay(now);
  for (const schedule of store.listSchedules()) {
    if (!schedule.enabled || schedule.lastRunDay === today || schedule.time > hhmm) continue;
    const worker = workers.get(schedule.workerId);
    if (!worker) continue;
    if (!workerProviderReady(worker)) continue;
    // 無人看管風險口（作戰室裁決 P1）：⚡無限制模式跳過所有審批，不給自動排程觸發。
    // 標記為今天已處理＋留一則說明，避免每 30 秒重試洗版。
    if (worker.autoApproveMode === "invincible") {
      store.markScheduleRun(schedule.id, today);
      record(worker, { type: "error", message: t("⏰ 排程（每日 {time}）未執行：此 NPC 處於⚡無限制模式（跳過所有審批），無人看管時段不自動執行。審批改為「完全信任」或「安全」後，明天起自動恢復。", { time: schedule.time }) });
      continue;
    }
    if (worker.runner.busy || handoffInProgress(worker) || collaborationInProgress(worker.id) || missionInProgress(worker.id)) continue;
    store.markScheduleRun(schedule.id, today);
    record(worker, { type: "user_message", text: t("⏰ 排程任務（每日 {time}）：{prompt}", { time: schedule.time, prompt: schedule.prompt }) });
    try {
      worker.runner.send(t("【排程任務，每日 {time} 自動觸發】{prompt}", { time: schedule.time, prompt: schedule.prompt }), [], []);
      broadcast({ type: "worker_status", workerId: worker.id, busy: true });
    } catch { /* 送失敗就等明天；user_message 已留在紀錄裡可追查 */ }
  }
}, 30_000);

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
    res.status(400).json({ error: t("不支援的 AI provider") });
    return;
  }
  res.json({ install: providerInstaller.get(provider) });
});

app.post("/api/providers/:provider/install", (req, res) => {
  if (!isAllowedLoopbackOrigin(req.headers.origin)) {
    res.status(403).json({ error: t("安裝只能從本機 Pixel Crew 介面啟動") });
    return;
  }
  const provider = requestedProvider(req.params.provider);
  if (!provider) {
    res.status(400).json({ error: t("不支援的 AI provider") });
    return;
  }
  if (authStates[provider].status === "authenticated") {
    res.status(409).json({ error: t("{provider} 已經可以使用", { provider: authStates[provider].displayName }) });
    return;
  }
  res.status(202).json({ install: providerInstaller.start(provider) });
});

app.post("/api/workers", (req, res) => {
  if (workers.size >= MAX_WORKERS) {
    res.status(409).json({ error: t("NPC 已達上限（最多 {max} 位）", { max: MAX_WORKERS }) });
    return;
  }
  const provider: ProviderId = req.body?.provider === "codex" ? "codex" : "claude";
  const accountId = typeof req.body?.accountId === "string" && req.body.accountId ? req.body.accountId : null;
  if (accountId) {
    const account = store.getAccount(accountId);
    if (!account || account.provider !== provider) {
      res.status(400).json({ error: t("找不到指定的帳號") });
      return;
    }
  }
  try {
    const workspacePath = normalizeWorkspacePath(req.body?.workspacePath);
    if (workspaceMission(workspacePath)) {
      res.status(409).json({ error: t("這個部門正在執行 Department Mission，暫時不能加入新 NPC") });
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
      accountId,
    );
    if (provider === "claude") void claudeCapabilitiesFor(workspacePath).refresh();
    else void codexCapabilitiesFor(workspacePath).refresh();
    res.json(workerSummary(worker));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || t("無法使用這個工作位置") });
  }
});

registerAccountRoutes({
  app,
  store,
  dataDirectory: config.dataDirectory,
  accountAuth: (accountId) => accountRegistry.stateFor(accountId),
  busyWorkerNames: (accountId) => [...workers.values()]
    .filter((worker) => worker.accountId === accountId && worker.runner.busy)
    .map((worker) => worker.runner.name),
  cancelAccountLogin: (provider, accountId) => accountLoginTrackerFor(provider).cancel(accountId),
  invalidateAccountAuth: (accountId) => accountRegistry.invalidate(accountId),
  onAccountDeleted: (accountId, orphanedWorkerIds) => {
    accountUsageRegistry.remove(accountId);
    for (const workerId of orphanedWorkerIds) {
      const worker = workers.get(workerId);
      if (!worker) continue;
      worker.accountId = null;
      broadcast({ type: "worker_updated", worker: workerSummary(worker) });
    }
  },
  refreshAccountAuth: (accountId) => accountRegistry.refresh(accountId),
  onAccountAuthUpdated: (accountId, auth) => {
    broadcast({ type: "account_auth_updated", accountId, auth });
    void accountUsageRegistry.refresh(accountId, true);
    if (auth.status === "authenticated") {
      restartIdleWorkersForAccount(accountId);
    }
  },
  startCodexLogin: (accountId, homeDir, mode, apiKey) => codexAccountLoginTracker.start(accountId, homeDir, mode, apiKey),
  startClaudeLogin: (accountId, homeDir) => claudeAccountLoginTracker.start(accountId, homeDir),
  accountLoginState: (provider, accountId) => accountLoginTrackerFor(provider).get(accountId),
  submitClaudeLoginCode: (accountId, code) => claudeAccountLoginTracker.submitCode(accountId, code),
});

// Separate namespace from /api/accounts/:id/login — the default slot isn't
// a row in accounts, so there's no :id to look up.
app.post("/api/auth/codex/login", (req, res) => {
  const mode: CodexAccountLoginMode = req.body?.mode === "api-key" ? "api-key" : "oauth";
  const apiKey = mode === "api-key" ? String(req.body?.apiKey ?? "").trim() : undefined;
  if (mode === "api-key" && !apiKey) { res.status(400).json({ error: t("請輸入 API key") }); return; }
  const { state, alreadyRunning } = defaultCodexLoginTracker.start(DEFAULT_CODEX_LOGIN_ID, config.defaultCodexHome, mode, apiKey);
  res.status(alreadyRunning ? 200 : 202).json({ state });
});

app.get("/api/auth/codex/login", (_req, res) => {
  res.json({ state: defaultCodexLoginTracker.get(DEFAULT_CODEX_LOGIN_ID) ?? null });
});

app.post("/api/auth/codex/login/cancel", (_req, res) => {
  res.json({ ok: defaultCodexLoginTracker.cancel(DEFAULT_CODEX_LOGIN_ID) });
});

// Claude's default-slot login. No api-key mode (claude auth login has no
// equivalent to `codex login --with-api-key`) and an extra step: the owner
// pastes back the code shown after authorizing in the browser.
app.post("/api/auth/claude/login", (_req, res) => {
  const { state, alreadyRunning } = defaultClaudeLoginTracker.start(DEFAULT_CLAUDE_LOGIN_ID, config.defaultClaudeHome);
  res.status(alreadyRunning ? 200 : 202).json({ state });
});

app.get("/api/auth/claude/login", (_req, res) => {
  res.json({ state: defaultClaudeLoginTracker.get(DEFAULT_CLAUDE_LOGIN_ID) ?? null });
});

app.post("/api/auth/claude/login/code", (req, res) => {
  const code = String(req.body?.code ?? "").trim();
  if (!code) { res.status(400).json({ error: t("請輸入驗證碼") }); return; }
  const ok = defaultClaudeLoginTracker.submitCode(DEFAULT_CLAUDE_LOGIN_ID, code);
  if (!ok) { res.status(409).json({ error: t("目前沒有等待驗證碼的登入流程") }); return; }
  res.json({ ok: true });
});

app.post("/api/auth/claude/login/cancel", (_req, res) => {
  res.json({ ok: defaultClaudeLoginTracker.cancel(DEFAULT_CLAUDE_LOGIN_ID) });
});

app.patch("/api/workers/:id/account", (req, res) => {
  const worker = requireWorker(res, req.params.id);
  if (!worker) return;
  if (worker.runner.busy) {
    res.status(409).json({ error: t("NPC 忙碌中，請等目前回合結束再切換帳號") });
    return;
  }
  // Switching accounts only takes effect on the session's next restart, at
  // which point it can't resume the old thread under the new account's home
  // directory (thread/conversation history is scoped per CODEX_HOME /
  // CLAUDE_CONFIG_DIR) and silently starts a blank one. Rather than let that
  // happen as a surprising side effect of switching, require the owner to
  // explicitly clear the session first.
  if (worker.runner.getPersistenceState().completedTurns > 0) {
    res.status(409).json({ error: t("這位 NPC 已有對話紀錄，請先清除工作階段再切換帳號") });
    return;
  }
  const raw = req.body?.accountId;
  const accountId = raw === null || raw === undefined || raw === "" ? null : String(raw);
  if (accountId) {
    const account = store.getAccount(accountId);
    if (!account || account.provider !== worker.runner.provider) {
      res.status(400).json({ error: t("找不到指定的帳號") });
      return;
    }
  }
  worker.accountId = accountId;
  persistWorker(worker);
  broadcast({ type: "worker_updated", worker: workerSummary(worker) });
  res.json({ ok: true });
});

type PreparedDepartment = {
  provider: ProviderId;
  workspacePath: string;
  purpose: string;
  plan: DepartmentPlan;
  workerCount: number;
};
const preparedDepartments = new PreparedTokenStore<PreparedDepartment>(5 * 60_000);

app.post("/api/departments/plan", async (req, res) => {
  const provider: ProviderId = req.body?.provider === "codex" ? "codex" : "claude";
  const purpose = normalizeDepartmentPurpose(req.body?.purpose);
  const count = Number(req.body?.count);
  if (!purpose) {
    res.status(400).json({ error: t("請輸入部門用途，例如：產品開發、QA 或資安稽核") });
    return;
  }
  if (!Number.isInteger(count) || count < 1 || count > MAX_WORKERS - workers.size) {
    res.status(400).json({ error: t("NPC 數量需為 1 到 {max} 位", { max: Math.max(0, MAX_WORKERS - workers.size) }) });
    return;
  }
  if (!providerReady(provider)) {
    res.status(503).json({ error: t("{provider} 尚未登入，登入後才能規劃部門", { provider: providerLabel(provider) }), auth: authStates[provider] });
    return;
  }
  try {
    const workspacePath = normalizeWorkspacePath(req.body?.workspacePath);
    if (workspaceMission(workspacePath)) {
      res.status(409).json({ error: t("這個工作位置正在執行部門工作，暫時不能建立新部門") });
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
      res.status(502).json({ error: t("AI 回傳的部門名單不完整或名稱重複，請重新規劃") });
      return;
    }
    const planToken = preparedDepartments.issue({
      provider,
      workspacePath,
      purpose,
      plan,
      workerCount: workers.size,
    });
    res.json({ planToken, provider, workspacePath, purpose, plan });
  } catch (error) {
    res.status(502).json({ error: (error as Error).message || t("AI 暫時無法規劃部門") });
  }
});

app.post("/api/departments", (req, res) => {
  const token = String(req.body?.planToken ?? "");
  const prepared = preparedDepartments.peek(token);
  if (!prepared) {
    res.status(409).json({ error: t("部門規劃已過期，請重新產生") });
    return;
  }
  if (workers.size !== prepared.workerCount || workers.size + prepared.plan.members.length > MAX_WORKERS) {
    res.status(409).json({ error: t("NPC 名單已變動，請重新規劃部門") });
    return;
  }
  if (workspaceMission(prepared.workspacePath)) {
    res.status(409).json({ error: t("這個工作位置正在執行部門工作") });
    return;
  }
  const requestedMembers: unknown[] = Array.isArray(req.body?.members) ? req.body.members as unknown[] : prepared.plan.members;
  if (requestedMembers.length !== prepared.plan.members.length) {
    res.status(400).json({ error: t("編輯後的 NPC 數量必須與 AI 規劃一致") });
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
    res.status(400).json({ error: t("請確認每位 NPC 都有不重複的姓名、職位與個性") });
    return;
  }
  const unavailableProvider = normalizedMembers.find((member) => !providerReady(member.provider))?.provider;
  if (unavailableProvider) {
    res.status(503).json({ error: t("{provider} 尚未登入", { provider: providerLabel(unavailableProvider) }) });
    return;
  }
  const leadIndex = Number(req.body?.leadIndex ?? 0);
  if (!Number.isInteger(leadIndex) || leadIndex < 0 || leadIndex >= normalizedMembers.length) {
    res.status(400).json({ error: t("請指定一位部門主管") });
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
    name: normalizeDepartmentName(req.body?.name) || t("{name}部門", { name: prepared.purpose.slice(0, 20) }),
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
    res.status(500).json({ error: t("部門建立失敗，沒有新增任何 NPC") });
    return;
  }
  departments.set(department.id, department);
  preparedDepartments.discard(token);
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
    res.status(409).json({ error: t("人員清單已變動，請重試") });
    return;
  }
  if (!store.saveWorkerOrder(order as string[])) {
    res.status(500).json({ error: t("無法儲存人員順序") });
    return;
  }
  const reordered = (order as string[]).map((id) => [id, workers.get(id)!] as const);
  workers.clear();
  for (const [id, worker] of reordered) workers.set(id, worker);
  broadcast({ type: "workers_reordered", order });
  res.json({ order });
});

app.patch("/api/workers/:id", (req, res) => {
  const worker = requireWorker(res, req.params.id);
  if (!worker) return;
  if (handoffInProgress(worker) || collaborationInProgress(worker.id) || missionInProgress(worker.id)) {
    res.status(409).json({ error: t("NPC 正在進行 LLM 交接、協作或部門 Mission，暫時不能改名") });
    return;
  }
  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: t("名稱不能是空白") });
    return;
  }
  if (name.length > 24) {
    res.status(400).json({ error: t("名稱最多 24 個字元") });
    return;
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    res.status(400).json({ error: t("名稱包含不支援的控制字元") });
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
      res.status(404).json({ error: t("找不到角色圖片") });
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
    res.status(500).json({ error: t("無法讀取角色圖片") });
  }
});

// OUTBOX 成品匣：列出各 NPC 工作區 outbox/ 裡的完成品（交付物的前門，不用翻聊天記錄考古）。
app.get("/api/outbox", (_req, res) => {
  // 多個 NPC 可能共用同一工作區（部門）：以 outbox 目錄去重，擁有者名單合併顯示。
  const byDir = new Map<string, { dir: string; workerId: string; owners: string[] }>();
  for (const worker of workers.values()) {
    const ws = worker.runner.workspacePath;
    if (!ws) continue;
    const dir = join(ws, "outbox");
    const name = worker.runner.name ?? worker.id;
    const hit = byDir.get(dir);
    if (hit) { if (!hit.owners.includes(name)) hit.owners.push(name); continue; }
    byDir.set(dir, { dir, workerId: worker.id, owners: [name] });
  }
  const items: Array<{ workerId: string; owners: string; name: string; size: number; mtime: number }> = [];
  for (const { dir, workerId, owners } of byDir.values()) {
    if (!existsSync(dir)) continue;
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      try {
        const st = statSync(join(dir, ent.name));
        items.push({ workerId, owners: owners.join("、"), name: ent.name, size: st.size, mtime: st.mtimeMs });
      } catch { /* 檔案可能剛被移走，跳過即可 */ }
    }
  }
  items.sort((a, b) => b.mtime - a.mtime);
  res.json({ items: items.slice(0, 300) });
});

// 成品匣單檔取用。檔名只允許純檔名（防路徑穿越）；html 一律附件下載避免同源 XSS。
app.get("/api/outbox/file", (req, res) => {
  const workerId = typeof req.query.worker === "string" ? req.query.worker : "";
  const name = typeof req.query.name === "string" ? req.query.name : "";
  const worker = workers.get(workerId);
  if (!worker || !name || /[\\/]/.test(name) || name.includes("..")) { res.status(400).json({ error: t("無效請求") }); return; }
  const full = join(worker.runner.workspacePath, "outbox", name);
  let st: ReturnType<typeof statSync>;
  try { st = statSync(full); } catch { res.status(404).json({ error: t("檔案不存在") }); return; }
  if (!st.isFile()) { res.status(404).json({ error: t("檔案不存在") }); return; }
  if (st.size > 100 * 1024 * 1024) { res.status(413).json({ error: t("檔案過大，請直接到工作區 outbox 資料夾開啟") }); return; }
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const inlineTypes: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    pdf: "application/pdf", txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8",
    log: "text/plain; charset=utf-8", csv: "text/plain; charset=utf-8", json: "text/plain; charset=utf-8",
  };
  const type = inlineTypes[ext];
  const encodedName = encodeURIComponent(name);
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Content-Type", type ?? "application/octet-stream");
  res.set("Content-Disposition", `${type ? "inline" : "attachment"}; filename*=UTF-8''${encodedName}`);
  res.send(readFileSync(full));
});

// 工作小窗 Tier 3：NPC 上網查時，小窗向這裡要真實瀏覽器截圖。純顯示、不回餵模型＝零 token。
app.get("/api/webshot", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  if (!q.trim()) { res.status(400).json({ error: "缺少查詢字 q" }); return; }
  try {
    const buf = await captureWebShot(q);
    res.set({
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    });
    res.send(buf);
  } catch (error) {
    console.warn("webshot failed:", (error as Error).message);
    res.status(502).json({ error: "截圖失敗" });
  }
});

app.put("/api/workers/:id/avatar", async (req, res) => {
  const worker = requireWorker(res, req.params.id);
  if (!worker) return;
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
      res.status(500).json({ error: t("無法將角色圖片寫入本機資料庫") });
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
    res.status(500).json({ error: t("無法儲存角色圖片") });
  }
});

async function exportBackup(res: express.Response, password?: string): Promise<void> {
  await writeBackupExport({
    response: res, dataDirectory: config.dataDirectory, dbPath: config.dbPath, avatarDir: config.avatarDir,
    id: randomUUID(), password, flush: () => store.flush(), checkpoint: () => store.checkpoint(),
  });
}

app.get("/api/backup/export", async (_req, res) => { await exportBackup(res); });
app.post("/api/backup/export", async (req, res) => {
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!password) { res.status(400).json({ error: t("請輸入備份密碼") }); return; }
  try { await exportBackup(res, password); }
  catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

const voiceModelManager = new VoiceModelManager(config.voiceModelsDir);
const voiceEngineServer = new VoiceEngineServer(
  resolveWhisperBinary([...new Set([config.whisperServerBin, "whisper-server"])]),
  config.voiceServerPort,
  () => voiceModelManager.modelPath,
);
const voiceTranscriber = new VoiceTranscriber(voiceEngineServer);
registerVoiceRoutes({ app, modelManager: voiceModelManager, transcriber: voiceTranscriber });

registerBackupImportTransport({
  app,
  dataDirectory: config.dataDirectory,
  createPending(stagingDir) {
    const token = randomUUID();
    pendingImports.set(token, { stagingDir, createdAt: Date.now() });
    setTimeout(() => discardPendingImport(token), 10 * 60_000).unref();
    return token;
  },
  discardPending: discardPendingImport,
});

app.post("/api/backup/import/commit", async (req, res) => {
  const importToken = req.body?.importToken;
  const pending = typeof importToken === "string" ? pendingImports.get(importToken) : undefined;
  await commitBackupRestore({
    response: res, importToken, confirmPhrase: req.body?.confirmPhrase, pending, maintenance: maintenanceMode,
    setMaintenance: (value) => { maintenanceMode = value; },
    stopWorkers: () => { for (const worker of workers.values()) worker.runner.stop(); for (const client of wss.clients) client.terminate(); },
    flush: () => store.flush(), checkpoint: () => store.checkpoint(), closeStore: () => store.close(),
    discardPending: discardPendingImport, dataDirectory: config.dataDirectory, dbPath: config.dbPath, avatarDir: config.avatarDir,
    exit: (code) => process.exit(code),
  });
});

app.put("/api/workers/:id/avatar-preset", (req, res) => {
  const worker = requireWorker(res, req.params.id);
  if (!worker) return;
  const presetId = typeof req.body?.presetId === "string" ? req.body.presetId.trim() : "";
  if (!AVATAR_PRESET_IDS.has(presetId)) {
    res.status(400).json({ error: t("未知的官方角色") });
    return;
  }
  const previousKind = worker.avatarKind;
  const previousPresetId = worker.avatarPresetId;
  worker.avatarKind = "preset";
  worker.avatarPresetId = presetId;
  if (!persistWorker(worker)) {
    worker.avatarKind = previousKind;
    worker.avatarPresetId = previousPresetId;
    res.status(500).json({ error: t("無法更新本機角色設定") });
    return;
  }
  const summary = workerSummary(worker);
  broadcast({ type: "worker_updated", worker: summary });
  res.json(summary);
});

app.post("/api/workers/:id/avatar/custom", (req, res) => {
  const worker = requireWorker(res, req.params.id);
  if (!worker) return;
  if (!worker.avatarId) {
    res.status(409).json({ error: t("尚未上傳自訂角色") });
    return;
  }
  const previousKind = worker.avatarKind;
  worker.avatarKind = "custom";
  if (!persistWorker(worker)) {
    worker.avatarKind = previousKind;
    res.status(500).json({ error: t("無法更新本機角色設定") });
    return;
  }
  const summary = workerSummary(worker);
  broadcast({ type: "worker_updated", worker: summary });
  res.json(summary);
});

app.delete("/api/workers/:id/avatar", async (req, res) => {
  const worker = requireWorker(res, req.params.id);
  if (!worker) return;
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
    res.status(500).json({ error: t("無法更新本機角色設定") });
    return;
  }
  const summary = workerSummary(worker);
  broadcast({ type: "worker_updated", worker: summary });
  res.json(summary);
  if (previousId) await deleteAvatarIfUnused(previousId);
});

app.patch("/api/workers/:id/provider", (req, res) => {
  const worker = requireWorker(res, req.params.id);
  if (!worker) return;
  const provider: ProviderId = req.body?.provider === "codex" ? "codex" : "claude";
  if (provider === worker.runner.provider) {
    res.json(workerSummary(worker));
    return;
  }
  res.status(409).json({ error: t("切換 LLM 必須先檢查工作能量並確認交接風險，請使用交接流程") });
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
};
const preparedMissions = new PreparedTokenStore<PreparedMission>(120_000);

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
    executionProfile?: DepartmentMission["executionProfile"];
    maxAgents?: number;
    maxPlanSteps?: number;
  } = {},
): { mission?: DepartmentMission; error?: string } {
  const now = new Date().toISOString();
  const attachmentIds = [...new Set(options.attachmentIds ?? [])];
  const requestedBudget = options.executionProfile ? executionBudgetFor(options.executionProfile) : null;
  const cappedMembers = [boss, ...members.filter((member) => member.id !== boss.id)]
    .slice(0, Math.max(1, Math.min(options.maxAgents ?? requestedBudget?.maxAgents ?? members.length, requestedBudget?.maxAgents ?? members.length)));
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
    executionProfile: requestedBudget?.profile ?? "standard",
    maxPlanSteps: Math.max(2, Math.min(options.maxPlanSteps ?? requestedBudget?.maxMissionSteps ?? 4, requestedBudget?.maxMissionSteps ?? 4)),
    memberWorkerIds: cappedMembers.map((member) => member.id),
  };
  activeMissions.set(mission.id, mission);
  if (!store.saveDepartmentMission(mission)) {
    activeMissions.delete(mission.id);
    return { error: t("無法保存 Department Mission") };
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
    members: cappedMembers.map((member) => ({
      id: member.id,
      name: member.runner.name,
      role: member.persona?.role || null,
      provider: member.runner.provider,
    })),
    attachments: attachmentMetadata,
    executionMode: mission.executionMode ?? "project",
    maxPlanSteps: mission.maxPlanSteps,
  });
  const planningAttachments = attachmentRepository.load(attachmentIds);
  attachmentRepository.markDelivery(attachmentIds, mission.id, boss.id, "pending");
  try {
    sendMissionRunner(
      mission,
      boss,
      prompt,
      t("老闆交辦 · AI 依職務分工：{objective}", { objective: mission.objective }),
      planningAttachments.images,
      planningAttachments.documents,
      { executionProfile: "read_only_collaboration" },
    );
    attachmentRepository.markDelivery(attachmentIds, mission.id, boss.id, "delivered");
  } catch (error) {
    const message = (error as Error).message || t("無法啟動 Mission 規劃");
    attachmentRepository.markDelivery(attachmentIds, mission.id, boss.id, "failed", message);
    appendMissionExecutionEvent(mission, boss.id, null, { type: "error", message });
    failMission(mission, message);
    return { mission, error: message };
  }
  return { mission };
}

function missionDepartmentEligibility(boss: Worker): { members?: Worker[]; error?: string } {
  if (workspaceMission(boss.runner.workspacePath, boss.departmentId)) return { error: t("這個部門已有進行中或待決定的 Mission") };
  const members = [...workers.values()].filter((worker) => boss.departmentId
    ? worker.departmentId === boss.departmentId
    : sameWorkspacePath(worker.runner.workspacePath, boss.runner.workspacePath));
  if (members.length < 1) return { error: t("部門目前沒有可執行工作的 NPC") };
  if (boss.runner.busy || handoffInProgress(boss) || collaborationInProgress(boss.id)) return { error: t("{name} 正在工作、交接或協作中", { name: boss.runner.name }) };
  if (handoffActivityBlock(boss.history)) return { error: t("{name} 尚有待處理的權限或背景 Agent", { name: boss.runner.name }) };
  if (!workerProviderReady(boss)) return { error: t("{provider} 尚未登入", { provider: providerLabel(boss.runner.provider) }) };
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
        t("{prompt}\n\n前次格式無效。只能回傳一個合法的 <department_intent> JSON 標記。", { prompt }),
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
    reason: t("無法可靠判斷這則訊息要詢問、修改目前工作，或建立後續 Mission"),
    changeImpact: "none",
    clarificationQuestion: t("請再說明這是要詢問目前結果、補充進行中的工作，還是建立一項新的交辦？"),
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
        text: t("此部門設定了非唯讀的 MCP 工具，Codex 目前無法在執行前攔截個別 MCP 呼叫，因此無法安全地進行唯讀查詢。請改用 Claude 主管回答，或移除非唯讀 MCP 工具後再試一次。"),
        toolsUsed: [],
      };
    }
  }
  const context = boundedDepartmentContext({
    threadSummary: input.thread.summary,
    missionSummary: input.mission
      ? t("{objective}\n{planSummary}\n狀態：{status}", { objective: input.mission.objective, planSummary: input.mission.planSummary ?? "", status: input.mission.status })
      : t("目前沒有可供追問的 Mission。"),
    recentMessages: visibleDepartmentMessages(input.thread, 24),
    workingContext: input.mission?.ownerGuidance ?? "",
  });
  const queryContract = t("\n\n唯讀查詢工具契約：\n- 必要時使用內建唯讀檢查或下列已驗證的 MCP 查詢工具取得即時資料：{tools}\n- 不可使用清單以外的 MCP 工具，不可修改檔案、repository、外部服務或任何系統狀態。\n- 不要聲稱部門角色不能使用工具。若缺少合適的唯讀工具，直接說明目前沒有可安全查詢該資料來源的工具。\n- 不可把對話、Mission 報告或記憶中的舊資料冒充即時查詢結果。", { tools: JSON.stringify(allowedTools) });
  const prompt = input.mission
    ? t("{followUp}\n\n以下是有界限的部門對話脈絡：\n{context}", { followUp: missionFollowUpPrompt(input.mission, input.question), context })
    : t("你是 {department} 的部門主管。回答老闆的問題；需要即時資料時執行必要的唯讀查詢，不可修改任何狀態。\n{context}\n\n老闆問題：{question}", { department: input.department.name, context, question: input.question });
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
  if (!department) { res.status(404).json({ error: t("找不到部門") }); return; }
  res.json({
    ...departmentThreadPayload(department.id),
    missions: departmentMissions(department),
    audit: store.listAuditEvents(department.id),
  });
});

app.post("/api/departments/:departmentId/messages", async (req, res) => {
  const department = departments.get(req.params.departmentId);
  const lead = department ? workers.get(department.leadWorkerId) : null;
  if (!department || !lead) { res.status(404).json({ error: t("找不到部門或部門主管") }); return; }
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
    res.status(400).json({ error: t("請輸入訊息或附加檔案") });
    return;
  }
  if (matchNativeCommand(text) === "clean") {
    const activeMission = workspaceMission(department.workspacePath, department.id);
    if (activeMission) {
      res.status(409).json({ error: t("部門仍有進行中或待決定的 Mission，不能重建工作階段"), mission: activeMission });
      return;
    }
    const members = department.memberWorkerIds.flatMap((id) => {
      const worker = workers.get(id);
      return worker ? [worker] : [];
    });
    if (members.length === 0) {
      res.status(400).json({ error: t("沒有可重建工作階段的部門成員") });
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
        ? t("部門工作階段部分重建失敗：{names}", { names: failed.map((result) => result.name).join("、") })
        : t("已清除部門工作階段，所有成員記憶重新開始。"),
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
  const userText = text || t("請依附件處理：{names}", { names: attachmentRecords.map((attachment) => attachment.name).join("、") });
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
    res.status(500).json({ error: t("無法保存部門訊息") });
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
      classification.clarificationQuestion || t("這項指示仍有歧義，請說明你希望詢問、修改目前工作，或建立新交辦。"),
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
        const responseMessage = reply(t("目前無法整理回答：{error}", { error: (error as Error).message }), "system", activeMission.id);
        res.json({ message: ownerMessage, responseMessage, classification, mission: activeMission, ...departmentThreadPayload(department.id) });
      }
      return;
    }
    if (classification.intent === "mission_update" && classification.changeImpact === "major") {
      pendingMissionReplans.set(activeMission.id, { message: userText, attachmentIds, sourceMessageId: ownerMessage.id });
      store.updateDepartmentMessageMission(ownerMessage.id, activeMission.id);
      departmentAudit("mission_updated", department.id, activeMission.id, { action: "major_change_queued", message: userText });
      const responseMessage = reply(t("重大修改已保留；目前步驟完成後會在安全檢查點重新規劃，不會丟棄正在執行的成果。"), "mission_update", activeMission.id);
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
        ? t("目前 Mission 尚在執行；這項新工作已保存在部門對話。請先讓目前工作完成，或明確說明要把它改成目前 Mission 的調整。")
        : t("補充內容已加入目前 Mission，會在下一個安全步驟交給相關成員。"),
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
      const responseMessage = reply(t("目前無法整理回答：{error}", { error: (error as Error).message }));
      res.json({ message: ownerMessage, responseMessage, classification, ...departmentThreadPayload(department.id) });
    }
    return;
  }

  const eligibility = missionDepartmentEligibility(lead);
  if (!eligibility.members) {
    const responseMessage = reply(t("目前無法開始新 Mission：{error}", { error: eligibility.error || t("部門不可用") }));
    res.status(409).json({ error: responseMessage.text, message: ownerMessage, responseMessage, ...departmentThreadPayload(department.id) });
    return;
  }
  const criteria = normalizeAcceptanceCriteria(req.body?.acceptanceCriteria);
  const acceptanceCriteria = criteria.length > 0
    ? criteria
    : [t("完成交辦目標、進行合理驗證，並在部門最終報告中說明結果與剩餘風險")];
  const launched = launchDepartmentMission(lead, eligibility.members, userText, acceptanceCriteria, {
    attachmentIds,
    parentMissionId: latestCompletedMission?.id ?? null,
    sourceMessageId: ownerMessage.id,
  });
  if (!launched.mission || launched.error) {
    const responseMessage = reply(launched.error || t("無法啟動 Department Mission"));
    res.status(500).json({ error: responseMessage.text, message: ownerMessage, responseMessage, ...departmentThreadPayload(department.id) });
    return;
  }
  store.updateDepartmentMessageMission(ownerMessage.id, launched.mission.id);
  const responseMessage = reply(t("已建立 Mission 並交由 {name} 依部門職務規劃執行。", { name: lead.runner.name }), "follow_up_mission", launched.mission.id);
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
    res.status(400).json({ error: t("請輸入要交辦的工作") });
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
    : [t("完成交辦目標、進行合理驗證，並在部門最終報告中說明結果與剩餘風險")];
  if (Array.isArray(req.body?.clarifications) && req.body.clarifications.length > 3) {
    res.status(400).json({ error: t("部門判斷最多接受三輪澄清；請重新整理交辦目標後再試") });
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
    res.status(409).json({ error: t("目前沒有可接單的部門；請先處理進行中的 Mission、登入 provider，或解除等待中的權限") });
    return;
  }
  const decisionUsage = await usageRegistry.refresh(decisionProvider, true);
  const decisionUsageError = usageBlockReason(decisionProvider, decisionUsage, decisionModel);
  if (decisionUsageError) {
    res.status(409).json({ error: t("{provider} 無法進行部門判斷：{error}", { provider: providerLabel(decisionProvider), error: decisionUsageError }), usage: decisionUsage });
    return;
  }
  const prompt = assignmentDecisionPrompt({ objective, acceptanceCriteria, preferredWorkspace, candidates, clarifications });
  const decisionWorkspace = candidates.find((candidate) => preferredWorkspace && sameWorkspacePath(candidate.workspacePath, preferredWorkspace))?.workspacePath
    ?? candidates[0].workspacePath;
  let decisionText: string;
  try {
    decisionText = (await runDetachedTurn(decisionProvider, decisionWorkspace, decisionModel, undefined, null, prompt, 60_000, { kind: "no_tools" })).text;
  } catch (error) {
    res.status(502).json({ error: t("決策模型無法完成部門判斷：{error}", { error: (error as Error).message }) });
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
    res.status(502).json({ error: t("決策模型未回傳有效的部門判斷格式，未派出任何工作") });
    return;
  }
  if (decision.confidence < 0.7 || decision.clarificationQuestion) {
    if (clarifications.length >= 3) {
      res.status(409).json({ error: t("決策模型在三輪澄清後仍無法可靠選擇部門，未派出任何工作") });
      return;
    }
    res.status(200).json({
      clarification: {
        question: decision.clarificationQuestion || t("請再補充這項工作應涵蓋的對象、範圍或預期成果。"),
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
    res.status(409).json({ error: t("路由完成後部門狀態已改變，請重新交辦") });
    return;
  }
  const usage = await usageRegistry.refresh(selected.coordinator.runner.provider, true);
  const usageError = usageBlockReason(selected.coordinator.runner.provider, usage, null);
  if (usageError) {
    res.status(409).json({ error: t("{provider} 無法開始工作：{error}", { provider: providerLabel(selected.coordinator.runner.provider), error: usageError }), route, usage });
    return;
  }
  const finalEligibility = missionDepartmentEligibility(selected.coordinator);
  if (!finalEligibility.members) {
    res.status(409).json({ error: finalEligibility.error || t("路由完成後部門狀態已改變，請重新交辦"), route });
    return;
  }
  const launched = launchDepartmentMission(selected.coordinator, finalEligibility.members, objective, acceptanceCriteria);
  if (!launched.mission || launched.error) {
    res.status(500).json({ error: launched.error || t("無法啟動部門工作"), route, mission: launched.mission });
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
    task.error = t("目前沒有可用的部門；請先建立具有職務的部門");
    task.messages.push(bossTaskMessage("system", task.error));
    persistBossTask(task);
    return;
  }
  const usage = await usageRegistry.refresh(task.decisionProvider, true);
  const usageError = usageBlockReason(task.decisionProvider, usage, task.decisionModel);
  if (usageError) {
    task.status = "needs_attention";
    task.error = t("{provider} 無法進行任務判斷：{error}", { provider: providerLabel(task.decisionProvider), error: usageError });
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
    let decision = parseBossTaskDecision(output, candidates, task.executionBudget ?? normalizeExecutionProfile(task.executionProfile));
    const clarificationPastBudget = decision?.status === "clarification" && clarificationBudget.remaining === 0;
    if (!decision || clarificationPastBudget) {
      const reason = clarificationPastBudget
        ? "You asked another clarification question, but the clarification budget is exhausted."
        : explainBossTaskDecisionFailure(output, candidates, task.executionBudget ?? normalizeExecutionProfile(task.executionProfile)) ?? "The response did not match the required format.";
      const repair = `${prompt}\n\nYour previous response was invalid: ${reason}${clarificationPastBudget ? " You must produce a ready execution graph from the existing answers." : ""} Return one corrected <boss_task_decision> block only.`;
      output = (await runDetachedTurn(task.decisionProvider, workspace, task.decisionModel, undefined, null, repair, 60_000, { kind: "no_tools" })).text;
      decision = parseBossTaskDecision(output, candidates, task.executionBudget ?? normalizeExecutionProfile(task.executionProfile));
    }
    if (!decision || (decision.status === "clarification" && clarificationBudget.remaining === 0)) {
      throw new Error(t("決策模型無法依現有資訊建立有效的跨部門計畫"));
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
        ? t("已選擇快速研究路徑：{summary}\n\n{department} · {title}", { summary: decision.summary, department: task.stages[0].departmentName, title: task.stages[0].title })
        : t("已完成探索並建立跨部門計畫：{summary}\n\n{stages}", {
            summary: decision.summary,
            stages: task.stages.map((stage, index) => `${index + 1}. ${stage.departmentName} · ${stage.title}`).join("\n"),
          }),
    ));
    persistBossTask(task);
    advanceBossTask(task);
  } catch (error) {
    task.status = "failed";
    task.error = (error as Error).message || t("無法完成 Boss Task 判斷");
    task.messages.push(bossTaskMessage("system", task.error));
    persistBossTask(task);
  }
}

function missionReport(mission: DepartmentMission): string {
  for (let index = mission.steps.length - 1; index >= 0; index -= 1) {
    const result = mission.steps[index]?.result;
    if (result) return result;
  }
  return mission.planSummary || t("部門 Mission 已完成，但沒有可用的文字報告。");
}

function advanceBossTask(task: BossTask): void {
  for (const stage of task.stages) {
    if (!stage.missionId || stage.status === "completed" || stage.status === "failed" || stage.status === "cancelled") continue;
    const mission = store.getDepartmentMission(stage.missionId);
    if (!mission) continue;
    if (mission.status === "completed") {
      stage.status = "completed";
      stage.report = collaborationText(missionReport(mission), 12_000);
      task.messages.push(bossTaskMessage("system", t("{department} 已完成「{title}」，交付內容已傳給後續部門。", { department: stage.departmentName, title: stage.title })));
    } else if (mission.status === "needs_attention") {
      const newlyBlocked = stage.status !== "needs_attention";
      stage.status = "needs_attention";
      task.status = "needs_attention";
      task.error = t("{department} 的「{title}」需要你處理：{error}", { department: stage.departmentName, title: stage.title, error: mission.error || t("等待決定") });
      if (newlyBlocked) task.messages.push(bossTaskMessage("system", task.error));
      persistBossTask(task);
      return;
    } else if (mission.status === "failed" || mission.status === "cancelled") {
      stage.status = mission.status;
      task.status = mission.status === "cancelled" ? "cancelled" : "failed";
      task.error = t("{department} 的「{title}」{status}：{error}", {
        department: stage.departmentName,
        title: stage.title,
        status: mission.status === "cancelled" ? t("已取消") : t("失敗"),
        error: mission.error || "",
      }).trim();
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
    task.error = t("跨部門計畫沒有可執行的下一階段");
    task.messages.push(bossTaskMessage("system", task.error));
    persistBossTask(task);
    return;
  }
  const department = departments.get(next.departmentId);
  const lead = department ? workers.get(department.leadWorkerId) : null;
  if (!department || !lead) {
    task.status = "needs_attention";
    task.error = t("找不到「{department}」的部門主管", { department: next.departmentName });
    task.messages.push(bossTaskMessage("system", task.error));
    persistBossTask(task);
    return;
  }
  const eligibility = missionDepartmentEligibility(lead);
  if (!eligibility.members) {
    task.status = "needs_attention";
    task.error = t("{department} 暫時無法開始：{error}", { department: next.departmentName, error: eligibility.error || t("部門不可用") });
    task.messages.push(bossTaskMessage("system", task.error));
    persistBossTask(task);
    return;
  }
  const upstream = task.stages
    .filter((stage) => next.dependsOn.includes(stage.id) && stage.report)
    .map((stage) => `## ${stage.departmentName} · ${stage.title}\n${stage.report}`)
    .join("\n\n")
    .slice(0, 24_000);
  const objective = t("{objective}\n\nBoss Task：{taskObjective}{upstream}", {
    objective: next.objective,
    taskObjective: task.objective,
    upstream: upstream ? t("\n\n上游部門交付：\n{upstream}", { upstream }) : "",
  }).slice(0, 30_000);
  const launched = launchDepartmentMission(lead, eligibility.members, objective, next.acceptanceCriteria, {
    attachmentIds: task.attachmentIds ?? [],
    executionMode: next.executionMode ?? task.executionMode ?? "project",
    origin: "boss",
    executionProfile: task.executionProfile,
    maxAgents: task.executionBudget?.maxAgents,
    maxPlanSteps: task.executionBudget?.maxMissionSteps,
  });
  if (!launched.mission || launched.error) {
    task.status = "needs_attention";
    task.error = launched.error || t("無法啟動 {department}", { department: next.departmentName });
    task.messages.push(bossTaskMessage("system", task.error));
    persistBossTask(task);
    return;
  }
  next.status = "running";
  next.missionId = launched.mission.id;
  task.status = "running";
  task.error = null;
  task.messages.push(bossTaskMessage("system", t("已交給 {department}：{title}", { department: next.departmentName, title: next.title })));
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
  if (!task) { res.status(404).json({ error: t("找不到 Boss Task") }); return; }
  res.json({ bossTask: bossTaskForDisplay(task) });
});

app.post("/api/boss-tasks", async (req, res) => {
  const objective = collaborationText(req.body?.message, 4_000);
  if (!objective) { res.status(400).json({ error: t("請輸入要交辦的工作") }); return; }
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
  const executionProfile = normalizeExecutionProfile(req.body?.executionProfile);
  const executionBudget = executionBudgetFor(executionProfile, {
    maxAgents: req.body?.maxAgents,
    maxMissionSteps: req.body?.maxMissionSteps,
  });
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
    executionProfile,
    executionBudget,
    messages: [bossTaskMessage("boss", objective, attachmentIds, clientMessageId, idempotencyKey)],
    stages: [],
    finalReport: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
  if (!store.saveBossTask(task)) { res.status(500).json({ error: t("無法保存 Boss Task") }); return; }
  broadcastBossTask(task, true);
  await decideBossTask(task);
  res.status(201).json({ bossTask: bossTaskForDisplay(task) });
});

app.patch("/api/boss-tasks/:id", (req, res) => {
  const task = store.getBossTask(req.params.id);
  if (!task) { res.status(404).json({ error: t("找不到 Boss Task") }); return; }
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
  if (!task) { res.status(404).json({ error: t("找不到 Boss Task") }); return; }
  if (!["completed", "failed", "cancelled"].includes(task.status)) {
    res.status(409).json({ error: t("進行中或等待處理的 Boss Task 不能刪除") });
    return;
  }
  if (!store.deleteBossTask(task.id)) {
    res.status(500).json({ error: t("無法刪除 Boss Task") });
    return;
  }
  broadcast({ type: "boss_task_deleted", bossTaskId: task.id });
  res.json({ ok: true, bossTaskId: task.id });
});

app.post("/api/boss-tasks/:id/restart", async (req, res) => {
  const task = store.getBossTask(req.params.id);
  if (!task) { res.status(404).json({ error: t("找不到 Boss Task") }); return; }
  if (task.archivedAt) { res.status(409).json({ error: t("封存的 Boss Task 不能重新交辦") }); return; }
  if (task.status === "discovering" || task.status === "synthesizing") { res.status(409).json({ error: t("Boss 正在整理交辦內容，請稍後再重開") }); return; }
  const restartScope = bossTaskRestartScope(task);
  const preflightError = restartScope.members.length > 0
    ? await scopedRestartPreflightError(restartScope.members, restartScope.activeMissions)
    : null;
  if (preflightError) { res.status(409).json({ error: preflightError }); return; }
  const preview = {
    requiresConfirmation: true,
    missions: restartScope.activeMissions.map((mission) => ({ id: mission.id, objective: mission.objective })),
    departments: restartScope.departments.map(({ department }) => ({ id: department.id, name: department.name })),
    members: restartScope.members.map((member) => ({ workerId: member.id, name: member.runner.name, provider: member.runner.provider, model: member.runner.getModel() ?? null })),
    preserved: [t("附件"), t("稽核紀錄")],
  };
  if (req.body?.confirm !== true) { res.json(preview); return; }
  for (const mission of restartScope.activeMissions) cancelMissionForScopedRestart(mission);
  const outcomes = restartScope.departments.map(({ department, members }) => cleanDepartment(department, members));
  const failed = outcomes.flatMap((outcome) => outcome.results).filter((result) => !result.ok);
  if (failed.length > 0) {
    task.status = "needs_attention";
    task.error = t("部分 NPC 無法重建，Boss Task 尚未重新派工");
    task.messages.push(bossTaskMessage("system", task.error));
    persistBossTask(task);
    res.status(500).json({ error: t("部分 NPC 無法重建，Boss Task 沒有重新派工"), results: failed });
    return;
  }
  const clearedAt = new Date().toISOString();
  task.historyClearedAt = clearedAt;
  task.stages = [];
  task.finalReport = null;
  task.completedAt = null;
  task.status = "discovering";
  task.error = null;
  task.messages.push(bossTaskMessage("system", t("已清空原本交辦並重新規劃；附件與稽核紀錄已保留。"), [], null, null, timestampAfter(clearedAt)));
  persistBossTask(task);
  await decideBossTask(task);
  res.json({ bossTask: bossTaskForDisplay(task), ...preview });
});

app.post("/api/boss-tasks/:id/messages", async (req, res) => {
  const task = store.getBossTask(req.params.id);
  if (!task) { res.status(404).json({ error: t("找不到 Boss Task") }); return; }
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
    res.status(400).json({ error: t("請輸入回覆內容或加入附件") });
    return;
  }
  if (matchNativeCommand(message) === "clean") {
    const bossDepartments = bossTaskDepartments(task);
    if (bossDepartments.length === 0) {
      res.status(400).json({ error: t("這個 Boss Task 沒有可重建工作階段的部門") });
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
        ? t("工作階段部分重建失敗：{names}", { names: failed.map((result) => result.name).join("、") })
        : t("已清除 Boss Task 與所屬部門的工作階段，所有成員記憶重新開始。"),
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
    res.status(409).json({ error: t("目前階段正在執行；完成或需要補充時才能送出新指示") });
    return;
  }
  const attachmentRecordsForPersist = persistAttachments(images, documents, res);
  if (!attachmentRecordsForPersist) return;
  const attachmentIds = attachmentRecordsForPersist.map((attachment) => attachment.id);
  task.attachmentIds = [...new Set([...(task.attachmentIds ?? []), ...attachmentIds])];
  task.messages.push(bossTaskMessage(
    "boss",
    message || t("請依附加檔案處理後續工作"),
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
      task.messages.push(bossTaskMessage("system", t("指示已保存在 Boss Task；此中斷屬於進行中的部門 Mission，請從跨部門階段開啟該 Mission 後選擇重試、重新指派或接受風險。")));
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
    res.status(404).json({ error: t("找不到部門主管 NPC") });
    return;
  }
  const objective = collaborationText(req.body?.objective, 4_000);
  const requestedCriteria = normalizeAcceptanceCriteria(req.body?.acceptanceCriteria);
  const acceptanceCriteria = requestedCriteria.length > 0
    ? requestedCriteria
    : [t("完成交辦目標、進行合理驗證，並在部門最終報告中說明結果與剩餘風險")];
  if (!objective) {
    res.status(400).json({ error: t("請填寫 Department Mission 目標") });
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
        reason: t("由相容的舊版 prepare API 明確交辦新工作"),
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
      res.status(409).json({ error: t("{provider} 無法開始 Mission：{error}", { provider: providerLabel(provider), error: usageError }), usage });
      return;
    }
  }
  const missionToken = preparedMissions.issue({
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
  });
  res.json({
    missionToken,
    boss: workerSummary(boss),
    members: eligibility.members.map(workerSummary),
    objective,
    acceptanceCriteria,
    maxCorrections: 2,
    warnings: [
      t("這次交辦就是工作授權；部門主管會以唯讀模式完成分工後直接開始，不再要求你核准一般計畫。"),
      t("NPC 會依各自職務執行，部門一次只跑一個步驟，最後由主管彙整成一份報告。"),
      t("Execute 使用各 NPC 原本的權限與核准設定；Consult／Review 固定唯讀。"),
      t("Review 最多自動退回修正兩輪，超過後會停下來請你決定。"),
      t("Mission 不會自動 commit、push、merge、tag、publish 或 release。"),
    ],
  });
});

app.post("/api/workers/:bossId/missions", async (req, res) => {
  const boss = workers.get(req.params.bossId);
  const token = String(req.body?.missionToken ?? "");
  const prepared = preparedMissions.take(token);
  if (!boss || !prepared || prepared.bossWorkerId !== boss.id) {
    res.status(409).json({ error: t("Mission 確認已過期，請重新檢查") });
    return;
  }
  if (req.body?.warningAcknowledged !== true) {
    res.status(400).json({ error: t("必須先確認 Mission 權限與 Git 邊界") });
    return;
  }
  const eligibility = missionDepartmentEligibility(boss);
  if (!eligibility.members || !sameWorkspacePath(boss.runner.workspacePath, prepared.workspacePath)) {
    res.status(409).json({ error: eligibility.error || t("部門主管已離開原部門") });
    return;
  }
  const stateChanged = prepared.memberStates.some((snapshot) => {
    const member = workers.get(snapshot.id);
    return !member || member.runner.getPersistenceState().sessionId !== snapshot.sessionId || member.history.length !== snapshot.historyLength;
  });
  if (stateChanged) {
    res.status(409).json({ error: t("檢查後部門 NPC 狀態已改變，請重新確認") });
    return;
  }
  const launched = launchDepartmentMission(boss, eligibility.members, prepared.objective, prepared.acceptanceCriteria, {
    attachmentIds: prepared.attachmentIds,
    parentMissionId: prepared.parentMissionId,
    sourceMessageId: prepared.sourceMessageId,
  });
  if (!launched.mission || launched.error) {
    res.status(500).json({ error: launched.error || t("無法啟動 Department Mission"), mission: launched.mission });
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
  if (!mission) { res.status(404).json({ error: t("找不到 Department Mission") }); return; }
  res.json({ mission });
});

app.post("/api/missions/:id/follow-up", async (req, res) => {
  const mission = activeMissions.get(req.params.id) ?? store.getDepartmentMission(req.params.id);
  if (!mission) { res.status(404).json({ error: t("找不到 Department Mission") }); return; }
  if (missionLocksWorkspace(mission)) {
    res.status(409).json({ error: t("Mission 尚未結束，請先在目前步驟或決策卡繼續處理") });
    return;
  }
  const question = collaborationText(req.body?.question, 4_000);
  if (!question) { res.status(400).json({ error: t("請輸入要追問部門的內容") }); return; }
  const department = mission.departmentId ? departments.get(mission.departmentId) : undefined;
  const lead = workers.get(department?.leadWorkerId ?? mission.bossWorkerId);
  if (!lead || (mission.departmentId && lead.departmentId !== mission.departmentId)) {
    res.status(409).json({ error: t("部門主管已不存在或已離開部門") });
    return;
  }
  const running = workspaceMission(mission.workspacePath, mission.departmentId);
  if (running && running.id !== mission.id) {
    res.status(409).json({ error: t("部門正在執行新的 Mission，完成後才能追問舊報告") });
    return;
  }
  if (!workerProviderReady(lead)) {
    res.status(503).json({ error: t("{provider} 尚未登入", { provider: providerLabel(lead.runner.provider) }), auth: authStates[lead.runner.provider] });
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
      t("{prompt}\n\n可使用的已驗證唯讀 MCP 工具：{tools}", { prompt: missionFollowUpPrompt(mission, question), tools: JSON.stringify(allowedTools) }),
      60_000,
      { kind: "read_only_query", allowedTools },
    );
    res.json({ ok: true, answer: answer.text });
  } catch (error) {
    const message = (error as Error).message || t("無法送出部門追問");
    res.status(500).json({ error: message });
  }
});

app.post("/api/missions/:id/approve-plan", (req, res) => {
  const mission = activeMissions.get(req.params.id) ?? store.getDepartmentMission(req.params.id);
  if (!mission) { res.status(404).json({ error: t("找不到 Department Mission") }); return; }
  if (mission.status !== "needs_attention" || mission.attentionReason !== "plan_approval" || mission.steps.length === 0) {
    res.status(409).json({ error: t("這個 Mission 沒有等待核准的計畫") });
    return;
  }
  const first = mission.steps[0];
  const assignee = workers.get(first.assigneeWorkerId);
  if (!assignee || assignee.runner.busy || !workerProviderReady(assignee)) {
    res.status(409).json({ error: t("第一位執行 NPC 目前無法開始，請稍後再核准") });
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
  if (!boss) return t("部門主管 NPC 已不存在");
  if (boss.runner.busy || handoffInProgress(boss) || collaborationInProgress(boss.id)) return t("部門主管正在執行其他工作");
  if (!workerProviderReady(boss)) return t("{provider} 尚未登入", { provider: providerLabel(boss.runner.provider) });
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
      t("交給部門 · 重新規劃：{objective}", { objective: mission.objective }),
      attachments.images,
      attachments.documents,
      { executionProfile: "read_only_collaboration" },
    );
    return null;
  } catch (error) {
    pauseMission(mission, (error as Error).message || t("無法重新啟動 Mission 規劃"));
    return mission.error;
  }
}

app.post("/api/missions/:id/resolve", (req, res) => {
  const mission = activeMissions.get(req.params.id) ?? store.getDepartmentMission(req.params.id);
  if (!mission) { res.status(404).json({ error: t("找不到 Department Mission") }); return; }
  if (!(["needs_attention", "failed"] as DepartmentMission["status"][]).includes(mission.status) || mission.attentionReason === "plan_approval") {
    res.status(409).json({ error: t("這個 Mission 目前沒有可處理的中斷") });
    return;
  }
  const reserved = workspaceMission(mission.workspacePath, mission.departmentId);
  if (mission.status === "failed" && reserved && reserved.id !== mission.id) {
    res.status(409).json({ error: t("同一工作位置已有進行中的 Department Mission") });
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
    res.status(409).json({ error: t("Mission 找不到可恢復的步驟") });
    return;
  }
  if (action === "accept_risk") {
    if (current.kind !== "review" || !current.reviewResult) {
      res.status(409).json({ error: t("只有已有結果的 Review 才能接受風險繼續") });
      return;
    }
    current.status = "completed";
    mission.attentionReason = null;
    mission.error = guidance ? t("老闆接受風險：{guidance}", { guidance }) : t("老闆已接受目前 Review 風險");
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
      if (executeIndex == null) { res.status(409).json({ error: t("找不到可重試的 Execute 步驟") }); return; }
      targetIndex = executeIndex;
      current.status = "pending";
      current.completedAt = null;
    } else if (current.kind !== "execute") {
      res.status(409).json({ error: t("目前步驟不能退回 Execute") });
      return;
    }
  } else if (action === "reassign") {
    const workerId = String(req.body?.workerId ?? "");
    const replacement = workers.get(workerId);
    if (!replacement || !sameWorkspacePath(replacement.runner.workspacePath, mission.workspacePath)) {
      res.status(409).json({ error: t("只能重新指派給同部門 NPC") });
      return;
    }
    const preceding = current.kind === "review" ? precedingExecuteIndex(mission, currentIndex) : null;
    if (preceding != null && mission.steps[preceding]?.assigneeWorkerId === workerId) {
      res.status(409).json({ error: t("Review 必須由與 Execute 不同的 NPC 負責") });
      return;
    }
    current.assigneeWorkerId = workerId;
  } else if (action !== "retry") {
    res.status(400).json({ error: t("不支援的 Mission 處理方式") });
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
  if (!mission) { res.status(404).json({ error: t("找不到 Department Mission") }); return; }
  if (!missionLocksWorkspace(mission)) { res.status(409).json({ error: t("Mission 已經結束") }); return; }
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
  if (!mission) { res.status(404).json({ error: t("找不到 Department Mission") }); return; }
  const stepIndex = mission.currentStepIndex;
  const step = stepIndex == null ? null : mission.steps[stepIndex];
  if (mission.status !== "needs_attention" || !step || step.kind !== "review") {
    res.status(409).json({ error: t("只有等待決定的 Review 可以重新檢查") });
    return;
  }
  if (stepIndex == null) { res.status(409).json({ error: t("Mission 找不到 Review 步驟") }); return; }
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
};
const preparedCollaborations = new PreparedTokenStore<PreparedCollaboration>(120_000);

function collaborationEligibility(source: Worker, target: Worker): string | null {
  if (source.id === target.id) return t("來源與目標 NPC 必須不同");
  if (!sameWorkspacePath(source.runner.workspacePath, target.runner.workspacePath)) return t("Phase 1 只支援相同工作位置的 NPC 協作");
  if (workspaceMission(source.runner.workspacePath, source.departmentId)) return t("部門正在執行 Department Mission，暫時不能開始單次協作");
  if (source.runner.busy || handoffInProgress(source) || collaborationInProgress(source.id)) return t("來源 NPC 正在工作、交接或協作中");
  if (target.runner.busy || handoffInProgress(target) || collaborationInProgress(target.id)) return t("目標 NPC 正在工作、交接或協作中");
  if (handoffActivityBlock(source.history)) return t("來源 NPC 尚有待處理的權限或背景 Agent");
  if (handoffActivityBlock(target.history)) return t("目標 NPC 尚有待處理的權限或背景 Agent");
  if (!workerProviderReady(source) || !workerProviderReady(target)) return t("{provider} 尚未登入", { provider: providerLabel(!workerProviderReady(source) ? source.runner.provider : target.runner.provider) });
  if (activeCollaborations.size >= MAX_ACTIVE_COLLABORATIONS) return t("目前協作工作已達上限");
  return null;
}

app.post("/api/workers/:sourceId/collaborations/prepare", async (req, res) => {
  const source = workers.get(req.params.sourceId);
  const target = workers.get(String(req.body?.targetWorkerId ?? ""));
  if (!source || !target) {
    res.status(404).json({ error: t("找不到來源或目標 NPC") });
    return;
  }
  const mode = normalizeCollaborationMode(req.body?.mode);
  const objective = collaborationText(req.body?.objective, 4_000);
  const acceptanceCriteria = normalizeAcceptanceCriteria(req.body?.acceptanceCriteria);
  if (!mode || !objective) {
    res.status(400).json({ error: t("請選擇協作模式並填寫目標") });
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
    res.status(409).json({ error: t("目標 NPC 無法開始協作：{error}", { error: usageError }), usage });
    return;
  }
  const collaborationToken = preparedCollaborations.issue({
    sourceWorkerId: source.id,
    targetWorkerId: target.id,
    sourceSessionId: source.runner.getPersistenceState().sessionId,
    targetSessionId: target.runner.getPersistenceState().sessionId,
    sourceHistoryLength: source.history.length,
    targetHistoryLength: target.history.length,
    mode,
    objective,
    acceptanceCriteria,
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
      t("目標 NPC 會以 provider 原生唯讀模式執行，不能修改 repository。"),
      t("目標完成後，結果會自動交回來源 NPC，並以來源 NPC 的正常權限繼續原始任務。"),
      t("需要指令、檔案或登入核准時，仍會透過現有介面停下來詢問你；不會自動 commit、push 或提高權限。"),
      t("Repository 與對話內容視為不受信任資料，結果仍需人工確認。"),
    ],
  });
});

app.post("/api/workers/:sourceId/collaborations", async (req, res) => {
  const source = workers.get(req.params.sourceId);
  const token = String(req.body?.collaborationToken ?? "");
  const prepared = preparedCollaborations.take(token);
  if (!source || !prepared || prepared.sourceWorkerId !== source.id) {
    res.status(409).json({ error: t("協作確認已過期，請重新檢查") });
    return;
  }
  const target = workers.get(prepared.targetWorkerId);
  if (!target) {
    res.status(404).json({ error: t("目標 NPC 已不存在") });
    return;
  }
  if (
    source.runner.getPersistenceState().sessionId !== prepared.sourceSessionId ||
    target.runner.getPersistenceState().sessionId !== prepared.targetSessionId ||
    source.history.length !== prepared.sourceHistoryLength ||
    target.history.length !== prepared.targetHistoryLength
  ) {
    res.status(409).json({ error: t("檢查後 NPC 狀態已改變，請重新確認") });
    return;
  }
  const eligibilityError = collaborationEligibility(source, target);
  if (eligibilityError) {
    res.status(409).json({ error: eligibilityError });
    return;
  }
  if (req.body?.warningAcknowledged !== true) {
    res.status(400).json({ error: t("必須先確認唯讀協作限制") });
    return;
  }
  const usage = await usageRegistry.refresh(target.runner.provider, true);
  const usageError = usageBlockReason(target.runner.provider, usage, target.runner.getModel() ?? null);
  if (usageError) {
    res.status(409).json({ error: t("目標 NPC 無法開始協作：{error}", { error: usageError }), usage });
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
    res.status(409).json({ error: finalEligibilityError || t("啟動協作前 NPC 狀態已改變，請重新確認") });
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
    res.status(500).json({ error: t("無法保存協作任務") });
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
  record(target, { type: "user_message", text: t("NPC 協作 · {kind}：{objective}", { kind: task.mode === "review" ? "Review" : "Consult", objective: task.objective }) });
  try {
    target.runner.send(prompt, [], [], { executionProfile: "read_only_collaboration" });
  } catch (error) {
    finishCollaboration(target, { type: "error", message: (error as Error).message || t("無法啟動協作") });
    res.status(500).json({ error: (error as Error).message || t("無法啟動協作"), collaboration: task });
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
    res.status(404).json({ error: t("找不到協作任務") });
    return;
  }
  res.json({ collaboration: task });
});

app.post("/api/collaborations/:id/cancel", (req, res) => {
  const task = activeCollaborations.get(req.params.id);
  if (!task) {
    res.status(409).json({ error: t("協作任務已結束或不存在") });
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
    res.status(404).json({ error: t("找不到協作任務") });
    return;
  }
  if (task.adoptedAt) {
    res.json({ collaboration: task });
    return;
  }
  if (task.status !== "completed" || !task.result) {
    res.status(409).json({ error: t("只有舊版已完成但尚未交回的協作結果可以手動交回") });
    return;
  }
  const source = workers.get(task.sourceWorkerId);
  const target = workers.get(task.targetWorkerId);
  if (!source || !target) {
    res.status(409).json({ error: t("來源或目標 NPC 已不存在") });
    return;
  }
  if (source.runner.busy || handoffInProgress(source) || collaborationInProgress(source.id) || missionInProgress(source.id)) {
    res.status(409).json({ error: t("來源 NPC 正在工作，暫時無法交回結果") });
    return;
  }
  if (!workerProviderReady(source)) {
    res.status(503).json({ error: `${source.runner.provider}_not_authenticated`, auth: authStates[source.runner.provider] });
    return;
  }
  const message = adoptedCollaborationMessage(task, target.runner.name);
  record(source, { type: "user_message", text: message });
  try {
    source.runner.send(message);
  } catch (error) {
    record(source, { type: "error", message: (error as Error).message || t("無法交回協作結果") });
    res.status(500).json({ error: (error as Error).message || t("無法交回協作結果") });
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
    res.status(409).json({ error: t("協作任務尚未結束或不存在") });
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
};
const preparedHandoffs = new PreparedTokenStore<PreparedHandoff>(120_000);

app.post("/api/workers/:id/handoff/prepare", async (req, res) => {
  const worker = requireWorker(res, req.params.id);
  if (!worker) return;
  const toProvider: ProviderId = req.body?.toProvider === "codex" ? "codex" : "claude";
  const toModel = typeof req.body?.toModel === "string" && req.body.toModel.trim() ? req.body.toModel.trim() : null;
  if (toModel && !validModel(toProvider, toModel)) {
    res.status(400).json({ error: t("目標模型名稱格式無效") });
    return;
  }
  if (toProvider === worker.runner.provider) {
    res.status(400).json({ error: t("已經是目前的 LLM") });
    return;
  }
  if (worker.runner.busy || handoffInProgress(worker) || collaborationInProgress(worker.id) || missionInProgress(worker.id)) {
    res.status(409).json({ error: t("NPC 正在工作或交接中，請完成後再切換") });
    return;
  }
  const activityBlock = handoffActivityBlock(worker.history);
  if (activityBlock) {
    res.status(409).json({ error: activityBlock });
    return;
  }
  if (!providerReady(toProvider)) {
    res.status(409).json({ error: t("無法切換至 {provider}：尚未登入", { provider: providerLabel(toProvider) }), auth: authStates[toProvider] });
    return;
  }
  const usage = await usageRegistry.refresh(toProvider, true);
  const usageError = usageBlockReason(toProvider, usage, toModel);
  if (usageError) {
    res.status(409).json({ error: t("無法切換至 {provider}：{error}", { provider: providerLabel(toProvider), error: usageError }), usage });
    return;
  }
  const handoffToken = preparedHandoffs.issue({
    workerId: worker.id,
    fromProvider: worker.runner.provider,
    sourceSessionId: worker.runner.getPersistenceState().sessionId,
    historyLength: worker.history.length,
    toProvider,
    toModel,
  });
  res.json({
    handoffToken,
    fromProvider: worker.runner.provider,
    toProvider,
    toModel,
    usage,
    hasHistory: worker.history.some((event) => event.type === "user_message"),
    warnings: [
      t("這會建立新的目標 LLM session，不是搬移原生 session。"),
      t("MCP、工具進度、背景 Agent 與待核准操作不會直接繼承。"),
      t("交接摘要可能遺漏或誤解細節，重要決策請再次確認。"),
      t("整理與接手都會消耗 LLM 工作能量。"),
    ],
  });
});

app.post("/api/workers/:id/handoff", async (req, res) => {
  const worker = requireWorker(res, req.params.id);
  if (!worker) return;
  const token = String(req.body?.handoffToken ?? "");
  const prepared = preparedHandoffs.take(token);
  if (!prepared || prepared.workerId !== worker.id) {
    res.status(409).json({ error: t("切換確認已過期，請重新檢查工作能量") });
    return;
  }
  if (worker.runner.provider !== prepared.fromProvider || worker.runner.getPersistenceState().sessionId !== prepared.sourceSessionId || worker.history.length !== prepared.historyLength) {
    res.status(409).json({ error: t("準備完成後工作狀態已改變，請重新檢查並確認交接") });
    return;
  }
  if (req.body?.warningAcknowledged !== true) {
    res.status(400).json({ error: t("必須先確認跨 LLM 交接風險") });
    return;
  }
  if (worker.runner.busy || collaborationInProgress(worker.id) || missionInProgress(worker.id)) {
    res.status(409).json({ error: t("NPC 正在工作，不能開始交接") });
    return;
  }
  const id = randomUUID();
  const progress: HandoffProgress = {
    id,
    fromProvider: worker.runner.provider,
    toProvider: prepared.toProvider,
    toModel: prepared.toModel,
    stage: "checking",
    message: t("正在確認工作狀態"),
    source: null,
    error: null,
  };
  setHandoff(worker, progress);
  if (!worker.history.some((event) => event.type === "user_message")) {
    await performProviderHandoff(worker, progress);
    if (worker.handoff?.stage === "failed") {
      res.status(500).json({ error: worker.handoff.error || t("無法切換 LLM"), handoff: worker.handoff });
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
  const worker = requireWorker(res, req.params.id);
  if (!worker) return;
  if (worker.runner.busy || handoffInProgress(worker) || collaborationInProgress(worker.id) || missionInProgress(worker.id)) {
    res.status(409).json({ error: t("NPC 執行中，不能切換工作位置") });
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
  if (workerProviderReady(worker)) worker.runner.warmup();
    const now = new Date().toISOString();
    const newDepartment: Department = {
      id: randomUUID(), name: t("{name}部門", { name: basename(workspacePath) || t("個人") }), purpose: t("個人工作部門"),
      workspacePath, leadWorkerId: worker.id, memberWorkerIds: [worker.id], createdAt: now, updatedAt: now,
    };
    worker.departmentId = newDepartment.id;
    if (!store.saveDepartment(newDepartment) || !persistWorker(worker)) throw new Error(t("無法保存新的部門位置"));
    departments.set(newDepartment.id, newDepartment);
    repairDepartmentAfterMemberLeaves(previousDepartmentId, worker.id);
    broadcast({ type: "department_created", department: newDepartment });
    if (provider === "claude") void claudeCapabilitiesFor(workspacePath).refresh();
    else void codexCapabilitiesFor(workspacePath).refresh();
    const summary = workerSummary(worker);
    broadcast({ type: "worker_updated", worker: summary, reset: true });
    res.json({ ...summary, conversationReset });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || t("無法使用這個工作位置") });
  }
});

app.post("/api/workers/:id/activate", (req, res) => {
  const worker = requireWorker(res, req.params.id);
  if (!worker) return;
  if (worker.runner.provider === "claude") {
    void claudeCapabilitiesFor(worker.runner.workspacePath).refresh();
  } else {
    void codexCapabilitiesFor(worker.runner.workspacePath).refresh();
  }
  if (workerProviderReady(worker) && !worker.runner.busy) worker.runner.warmup();
  res.json({ ok: true, workspacePath: worker.runner.workspacePath });
});

app.delete("/api/workers/:id", async (req, res) => {
  const worker = requireWorker(res, req.params.id);
  if (!worker) return;
  if (handoffInProgress(worker) || collaborationInProgress(worker.id) || missionInProgress(worker.id)) {
    res.status(409).json({ error: t("NPC 正在進行 LLM 交接、協作或部門 Mission，暫時不能移除") });
    return;
  }
  worker.runner.stop();
  const avatarId = worker.avatarId;
  const departmentId = worker.departmentId;
  workers.delete(worker.id);
  store.deleteWorker(worker.id);
  deleteExtras(worker.id);
  clearWorkerHookState(worker.id);
  repairDepartmentAfterMemberLeaves(departmentId, worker.id);
  broadcast({ type: "worker_removed", workerId: worker.id });
  res.json({ ok: true });
  if (avatarId) await deleteAvatarIfUnused(avatarId);
});

// ============ War Room（作戰室）orchestrator ============
// 一場「真辯論（表態→反駁 2 輪）＋依難度配模型＋主持裁決」的顧問議會。peers 是可見的臨時 worker
// （名字以 🏛 U+1F3DB 開頭，前端會把它們拉到會議桌圍坐；persist:false），跑完寬限期自動刪除。
// 若 server 非正常重啟，啟動時也會清除上次殘留的短命 worker。turn_end 透過 record() 裡的
// warroomRecordHook 接回，用來 await 各成員發言完成。
const WARROOM_GRACE_MS = 45_000;
// hard 模式原本單輪可等 4 分鐘，兩輪＋主持＋格式重試理論上會拖很久。整場封頂，才能保證
// 前端不會無限顯示「開會中」；前端 timeout 會比這個再多保留一分鐘收 HTTP 回應。
const WARROOM_TOTAL_TIMEOUT_MS = 12 * 60_000;
type WarroomWaiter = (event: RunnerEvent) => void;
const warroomWaiters = new Map<string, WarroomWaiter>();

function warroomTimeoutError(): Error {
  return new Error(t("作戰室整場討論超過 {minutes} 分鐘，已自動散會；請縮小主題後再試。", {
    minutes: String(WARROOM_TOTAL_TIMEOUT_MS / 60_000),
  }));
}

function warroomTurnTimeout(turnTimeoutMs: number, deadlineAt: number): number {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw warroomTimeoutError();
  return Math.min(turnTimeoutMs, remainingMs);
}

async function waitForWarroomWarmup(ms: number, deadlineAt: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, warroomTurnTimeout(ms, deadlineAt)));
  warroomTurnTimeout(1, deadlineAt);
}

function warroomRecordHook(worker: Worker, event: RunnerEvent): void {
  if (event.type !== "turn_end" && event.type !== "error") return;
  const waiter = warroomWaiters.get(worker.id);
  if (waiter) waiter(event);
}

function awaitWorkerTurn(workerId: string, timeoutMs: number): { wait: Promise<RunnerEvent>; cancel: (message: string) => void } {
  let resolveWait: (event: RunnerEvent) => void = () => undefined;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const finish: WarroomWaiter = (event) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    warroomWaiters.delete(workerId);
    resolveWait(event);
  };
  const wait = new Promise<RunnerEvent>((resolve) => {
    resolveWait = resolve;
    timer = setTimeout(() => {
      warroomWaiters.delete(workerId);
      finish({ type: "error", message: t("作戰室成員逾時") });
    }, timeoutMs);
  });
  warroomWaiters.set(workerId, finish);
  return { wait, cancel: (message) => finish({ type: "error", message }) };
}

function warroomSend(worker: Worker, prompt: string, timeoutMs: number): Promise<RunnerEvent> {
  record(worker, { type: "user_message", text: prompt });
  const waited = awaitWorkerTurn(worker.id, timeoutMs);
  try {
    worker.runner.send(prompt, [], []);
  } catch (error) {
    waited.cancel(error instanceof Error ? error.message : t("傳送失敗"));
    broadcast({ type: "worker_status", workerId: worker.id, busy: false });
    return waited.wait;
  }
  broadcast({ type: "worker_status", workerId: worker.id, busy: true });
  return waited.wait;
}

function warroomEventText(event: RunnerEvent): string {
  // isError 的 turn_end（額度已滿、供應商故障…）不算發言——否則錯誤訊息會被當成「裁決」
  // 存進報告、回報 host（實際發生過：整份裁決只有一句 "You've hit your session limit"）。
  if (event.type !== "turn_end" || event.isError) return "";
  return event.resultText || "";
}

// 累加成本用：從一個 turn_end 事件取出這回合花的錢（micro-USD），沿用既有的計價函式。
function warroomEventCost(provider: ProviderId, event: RunnerEvent): number {
  return event.type === "turn_end" ? costMicrosForTurnEnd(provider, event) : 0;
}

function deleteWarroomPeer(id: string): void {
  const worker = workers.get(id);
  if (!worker) return;
  warroomWaiters.get(id)?.({ type: "error", message: t("作戰室已結束") });
  try { worker.runner.stop(); } catch { /* ignore */ }
  const departmentId = worker.departmentId;
  workers.delete(id);
  clearWorkerHookState(id);
  store.deleteWorker(id);
  repairDepartmentAfterMemberLeaves(departmentId, id);
  broadcast({ type: "worker_removed", workerId: id });
}

async function runWarroom(topic: string, difficulty: WarRoomDifficulty, workspacePath: string, provider: ProviderId, accountId: string | null, customStances: WarRoomStance[] = []): Promise<WarRoomResult> {
  const { peer: peerModel, lead: leadModel } = warroomModels(provider, difficulty);
  const timeoutMs = difficulty === "hard" ? 240_000 : 150_000;
  const deadlineAt = Date.now() + WARROOM_TOTAL_TIMEOUT_MS;
  const created: Worker[] = [];
  let costMicros = 0;
  let completed = false;
  // 上桌人數與輪數隨難度伸縮：簡單 2 人 1 輪（快又省）、中等 3 人 2 輪、困難 4 人（含查證方）2 輪。
  // 使用者有自訂角色（⚙ 面板）就用自訂的，輪數仍照難度。
  const stances = customStances.length >= 2 ? customStances : warroomStances(difficulty);
  const rounds = difficulty === "simple" ? 1 : 2;
  try {
    for (const stance of stances) {
      if (workers.size >= MAX_WORKERS) break;
      const peer = createWorker(`\u{1F3DB}${stance.name}`, peerModel, provider, workspacePath, undefined, null, null, { warmup: true, persist: false, broadcast: true }, accountId);
      // 「安全」自動核准：讓臨時成員能自己跑唯讀工具（WebSearch/Read…）查證即時資料、不彈確認窗，
      // 但寫檔/危險指令仍會被擋——議會只該查證，不該動手改東西。
      peer.autoApproveMode = "safe";
      created.push(peer);
    }
    if (created.length === 0) throw new Error(t("無法建立作戰室成員（可能已達 NPC 上限）"));
    const peers = created.slice();
    await waitForWarroomWarmup(1_500, deadlineAt); // 讓 peers 暖機到位再開講
    // 第 1 輪：各自鮮明表態
    const r1 = await Promise.allSettled(peers.map((worker, i) =>
      warroomSend(worker, warroomOpeningPrompt({ topic, stanceBrief: stances[i].brief }), warroomTurnTimeout(timeoutMs, deadlineAt))));
    const r1texts = r1.map((s) => s.status === "fulfilled" ? warroomEventText(s.value) : "");
    for (const s of r1) if (s.status === "fulfilled") costMicros += warroomEventCost(provider, s.value);
    // 全員第一輪都沒能發言（額度滿、供應商掛…）→ 整場中止，別拿空辯論去「裁決」。
    // 丟錯誤會讓外層 500 回報、不存檔、不回報 host，前端会看到明確錯誤而不是垃圾結論。
    if (r1texts.every((text) => !text.trim())) {
      throw new Error(t("作戰室成員全數未能發言（可能是使用額度已滿或供應商故障），本場中止。請稍後再試。"));
    }
    warroomTurnTimeout(1, deadlineAt);
    // 第 2 輪：看到彼此意見後互相反駁（真辯論）。簡單題只跑 1 輪，直接拿表態去裁決。
    let r2texts: string[] = peers.map(() => "");
    if (rounds >= 2) {
      const others = peers.map((_, i) => t("【{name}】\n{text}", { name: stances[i].name, text: r1texts[i] || t("(無)") })).join("\n\n");
      const r2 = await Promise.allSettled(peers.map((worker, i) =>
        warroomSend(worker, warroomRebuttalPrompt({ stanceBrief: stances[i].brief, othersDebate: others }), warroomTurnTimeout(timeoutMs, deadlineAt))));
      r2texts = r2.map((s) => s.status === "fulfilled" ? warroomEventText(s.value) : "");
      for (const s of r2) if (s.status === "fulfilled") costMicros += warroomEventCost(provider, s.value);
      warroomTurnTimeout(1, deadlineAt);
    }
    const debate = peers.map((_, i) => t("## {name}\n【立場】{r1}{rebuttal}", {
      name: stances[i].name,
      r1: r1texts[i],
      rebuttal: r2texts[i] ? t("\n【反駁】{r2}", { r2: r2texts[i] }) : "",
    })).join("\n\n");
    // 主持裁決（可見的臨時 lead，用較強模型）
    let result: WarRoomResult | null = null;
    if (workers.size < MAX_WORKERS) {
      const lead = createWorker("\u{1F3DB}主持", leadModel, provider, workspacePath, undefined, null, null, { warmup: true, persist: false, broadcast: true }, accountId);
      lead.autoApproveMode = "safe";
      created.push(lead);
      await waitForWarroomWarmup(1_200, deadlineAt);
      const ev = await warroomSend(lead, warroomSynthesisPrompt({ topic, debate }), warroomTurnTimeout(timeoutMs, deadlineAt));
      costMicros += warroomEventCost(provider, ev);
      result = parseWarroomResult(warroomEventText(ev));
      if (result && !result.structured) { // 議會裁決：格式重試一次就好、有上限
        const retry = await warroomSend(lead, t("上一則沒有照 <warroom_result>{...}</warroom_result> 的 JSON 格式輸出。請只重輸出那段結構化 JSON，不要多寫任何字。"), warroomTurnTimeout(timeoutMs, deadlineAt));
        costMicros += warroomEventCost(provider, retry);
        const retried = parseWarroomResult(warroomEventText(retry));
        if (retried?.structured) result = retried;
      }
    }
    if (!result) result = parseWarroomResult(debate) ?? { verdict: debate, consensus: [], disputes: [], actions: [], metrics: [], charts: [], structured: false };
    if (provider === "claude") result.costUsd = costMicros / 1_000_000;
    completed = true;
    return result;
  } finally {
    // 正常完成才留一小段時間讓畫面播放散會；失敗／整場逾時則立即中止並清掉，避免留下
    // 仍在跑的 CLI session 或卡在桌上的 NPC。server 非正常重啟則由 startup sweep 接手。
    const ids = created.map((worker) => worker.id);
    if (!completed) {
      for (const id of ids) deleteWarroomPeer(id);
    } else {
      setTimeout(() => { for (const id of ids) deleteWarroomPeer(id); }, WARROOM_GRACE_MS);
    }
  }
}

// 把裁決整理成「回報給 host（召集者／最終大腦）」的訊息，讓它接手執行。
// 刻意走「精簡版」：host（常駐 NPC）的對話史往往很長，每貼一次全文裁決都要讓它重讀整段
// 歷史來處理，非常燒 token（實際發生過：一個上午就吃掉半個 5 小時窗）。完整裁決本來就
// 自動存檔（.warroom/ 的 md+json、結果卡、📜歷史都有），這裡只給摘要＋檔案路徑，
// host 判斷需要細節時再自己讀檔——把「全文進對話」改成「指針進對話」。
function formatWarroomVerdictForHost(topic: string, result: WarRoomResult, hostName: string, reportPath: string | null): string {
  const p1 = result.actions.filter((a) => a.priority === "P1").map((a) => `- [P1] ${a.title}`).join("\n");
  return t("【作戰室裁決回報・精簡版】主題：{topic}\n\n", { topic }) +
    t("最終裁決（摘要）：{verdict}{ellipsis}\n\n", {
      verdict: result.verdict.slice(0, 600),
      ellipsis: result.verdict.length > 600 ? "…" : "",
    }) +
    (p1 ? t("P1 行動：\n{p1}\n\n", { p1 }) : "") +
    t("完整內容（共識/分歧/數據/圖表）不貼進對話以節省 token——已存檔：{reportPath}，", { reportPath: reportPath ?? t("（工作區 .warroom/）") }) +
    t("結果卡與 📜 歷史也看得到。請你（{hostName}）接手：可執行的就讀檔細看再動工（高風險先確認），純諮詢的就簡短總結重點給使用者。", { hostName });
}

function warroomReportMarkdown(topic: string, difficulty: WarRoomDifficulty, result: WarRoomResult): string {
  const charts = result.charts.map((c) =>
    `- **${c.title}**（${c.type}${c.unit ? `，${c.unit}` : ""}）：${c.labels.map((l, i) => `${l}=${c.values[i]}`).join("、")}`
  ).join("\n");
  const metrics = result.metrics.map((m) => `- **${m.label}**：${m.value}${m.note ? `（${m.note}）` : ""}`).join("\n");
  const consensus = result.consensus.map((c) => `- ${c}`).join("\n");
  const disputes = result.disputes.map((d) => `- **${d.point}** → ${d.ruling}`).join("\n");
  const actions = result.actions.map((a) => `- **[${a.priority}]** ${a.title}${a.how ? `\n  - ${a.how}` : ""}`).join("\n");
  return t("# 作戰室裁決\n\n**主題**：{topic}\n**難度／模型**：{difficulty}\n**時間**：{time}\n\n", { topic, difficulty, time: new Date().toISOString() }) +
    t("## 最終裁決\n{verdict}\n\n", { verdict: result.verdict }) +
    (metrics ? t("## 關鍵數字\n{metrics}\n\n", { metrics }) : "") +
    (charts ? t("## 圖表數據\n{charts}\n\n", { charts }) : "") +
    (consensus ? t("## 共識\n{consensus}\n\n", { consensus }) : "") +
    (disputes ? t("## 分歧與裁決\n{disputes}\n\n", { disputes }) : "") +
    (actions ? t("## 可執行下一步\n{actions}\n", { actions }) : "");
}

// 自動存檔：把裁決寫到工作區底下 .warroom/（工作區相對路徑，任何專案通用，不寫死桌面）。
// 只保留最近 WARROOM_KEEP 份，其餘自動刪除——問完不需要的舊報告會自然被清掉，不會無限累積。
const WARROOM_KEEP = 30;
function saveWarroomReport(topic: string, difficulty: WarRoomDifficulty, result: WarRoomResult, workspacePath: string): string | null {
  try {
    const dir = join(workspacePath, ".warroom");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(dir, `warroom-${stamp}.md`);
    writeFileSync(file, warroomReportMarkdown(topic, difficulty, result), "utf-8");
    // 同名 .json 存結構化裁決：歷史面板讀它就能用「跟結束彈窗同一套卡片」渲染，保證兩邊長一樣。
    writeFileSync(file.replace(/\.md$/, ".json"), JSON.stringify({ topic, difficulty, result }), "utf-8");
    // 檔名是 warroom-<ISO時間>.md，字典排序＝時間排序；砍掉最舊的（連同 .json），只留最近 N 份。
    const files = readdirSync(dir).filter((f) => f.startsWith("warroom-") && f.endsWith(".md")).sort();
    for (const old of files.slice(0, Math.max(0, files.length - WARROOM_KEEP))) {
      try { rmSync(join(dir, old)); } catch { /* ignore */ }
      try { rmSync(join(dir, old.replace(/\.md$/, ".json"))); } catch { /* ignore */ }
    }
    return file;
  } catch { return null; }
}

// 難度自動分級：用便宜模型快速判斷 simple/medium/hard，讓簡單題別浪費強模型（省 token）。
async function triageDifficulty(topic: string, workspacePath: string, provider: ProviderId, homeDir: string): Promise<WarRoomDifficulty> {
  try {
    const { text } = await runDetachedTurn(provider, workspacePath, warroomModels(provider, "simple").peer, undefined, null,
      t("判斷這個討論主題的難度，只回一個英文單詞：simple（常識/簡單）、medium（需要一些分析）、hard（架構/專業/多方權衡）。規則：只要主題涉及「即時資訊」（今日行情、天氣、新聞、現價…需要上網查證的），至少回 medium，不可回 simple——因為查證需要較可靠的模型執行。不要多寫。\n主題：{topic}", { topic }),
      30_000, { kind: "no_tools" }, homeDir);
    const lowered = text.toLowerCase();
    if (lowered.includes("hard")) return "hard";
    if (lowered.includes("simple")) return "simple";
    return "medium";
  } catch { return "medium"; }
}

function postToHost(hostWorkerId: string | null, message: string): void {
  if (!hostWorkerId) return;
  const host = workers.get(hostWorkerId);
  if (!host || host.runner.busy) return;
  record(host, { type: "user_message", text: message });
  try {
    host.runner.send(message, [], []);
    broadcast({ type: "worker_status", workerId: host.id, busy: true });
  } catch { /* host 忙碌或送失敗就略過 */ }
}

app.post("/api/warroom", async (req, res) => {
  const topic = String(req.body?.topic ?? "").trim();
  if (!topic) { res.status(400).json({ error: t("請提供討論主題") }); return; }
  const requested = String(req.body?.difficulty);
  const hostWorkerId = typeof req.body?.hostWorkerId === "string" ? req.body.hostWorkerId : null;
  const host = hostWorkerId ? workers.get(hostWorkerId) : null;
  if (!host) { res.status(400).json({ error: t("請從目前 NPC 開啟作戰室") }); return; }
  let workspacePath: string;
  try { workspacePath = normalizeWorkspacePath(req.body?.workspacePath ?? config.targetRepoPath); }
  catch { workspacePath = config.targetRepoPath; }
  if (!sameWorkspacePath(host.runner.workspacePath, workspacePath)) {
    res.status(400).json({ error: t("作戰室必須使用目前 NPC 的工作區") });
    return;
  }
  const provider = host.runner.provider;
  if (!workerProviderReady(host)) {
    res.status(503).json({ error: `${provider}_not_authenticated`, auth: workerAuthState(host) });
    return;
  }
  // "auto"（或沒指定）→ 自動分級；指定 simple/medium/hard 就照指定。
  const difficulty: WarRoomDifficulty = ["simple", "medium", "hard"].includes(requested)
    ? (requested as WarRoomDifficulty)
    : await triageDifficulty(topic, workspacePath, provider, homeForWorker(host));
  const customStances = sanitizeCustomStances(req.body?.stances);
  try {
    const result = await runWarroom(topic, difficulty, workspacePath, provider, host.accountId, customStances);
    const reportPath = saveWarroomReport(topic, difficulty, result, workspacePath); // 自動存檔（人不在也拿得到）
    // 閉環：把「精簡版」裁決貼回召集者（host NPC＝持久大腦），它接手執行；細節靠檔案指針。
    postToHost(hostWorkerId, formatWarroomVerdictForHost(topic, result, workers.get(hostWorkerId ?? "")?.runner.name ?? t("你"), reportPath));
    res.json({ ok: true, result, difficulty });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : t("作戰室執行失敗") });
  }
});

// ===== 作戰室歷史：列出／讀取／刪除 .warroom/ 裡的報告（讓使用者在 app 內回看過往裁決） =====
// 檔名嚴格白名單（warroom-<時間戳>.md），杜絕路徑穿越。
const WARROOM_FILE_PATTERN = /^warroom-[\w.-]+\.md$/;

function warroomDir(rawWorkspacePath: unknown): string {
  let workspacePath: string;
  try { workspacePath = normalizeWorkspacePath(rawWorkspacePath ?? config.targetRepoPath); }
  catch { workspacePath = config.targetRepoPath; }
  return join(workspacePath, ".warroom");
}

app.get("/api/warroom/history", (req, res) => {
  const dir = warroomDir(req.query.workspacePath);
  try {
    if (!existsSync(dir)) { res.json({ ok: true, reports: [] }); return; }
    const reports = readdirSync(dir)
      .filter((f) => WARROOM_FILE_PATTERN.test(f))
      .sort()
      .reverse() // 新的在前
      .map((file) => {
        let topic = ""; let difficulty = "";
        try {
          const head = readFileSync(join(dir, file), "utf-8").slice(0, 600);
          // Reports may have been saved under either language (t() renders the
          // header at write time), so the parser must accept both labels.
          topic = head.match(/\*\*(?:主題|Topic)\*\*[：:]\s*(.+)/)?.[1]?.trim() ?? "";
          difficulty = head.match(/\*\*(?:難度／模型|Difficulty\/Model)\*\*[：:]\s*(.+)/)?.[1]?.trim() ?? "";
        } catch { /* 讀不到就留空 */ }
        return { file, topic, difficulty };
      });
    res.json({ ok: true, reports });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : t("讀取歷史失敗") });
  }
});

app.get("/api/warroom/history/:file", (req, res) => {
  const file = String(req.params.file);
  if (!WARROOM_FILE_PATTERN.test(file)) { res.status(400).json({ error: t("無效的報告檔名") }); return; }
  const path = join(warroomDir(req.query.workspacePath), file);
  try {
    const content = readFileSync(path, "utf-8");
    // 有同名 .json 就一併回傳結構化裁決，讓前端用結果卡渲染；沒有（舊報告）就退回純文字。
    let report: unknown = null;
    try { report = JSON.parse(readFileSync(path.replace(/\.md$/, ".json"), "utf-8")); } catch { /* 舊報告沒有 json */ }
    res.json({ ok: true, content, report });
  }
  catch { res.status(404).json({ error: t("找不到這份報告") }); }
});

app.delete("/api/warroom/history/:file", (req, res) => {
  const file = String(req.params.file);
  if (!WARROOM_FILE_PATTERN.test(file)) { res.status(400).json({ error: t("無效的報告檔名") }); return; }
  const path = join(warroomDir(req.query.workspacePath), file);
  try {
    rmSync(path);
    try { rmSync(path.replace(/\.md$/, ".json")); } catch { /* ignore */ }
    res.json({ ok: true });
  }
  catch { res.status(404).json({ error: t("刪除失敗或檔案不存在") }); }
});

// ===== 委派（Delegate）：派工給一個「可見的臨時 NPC」查/分析，結果回傳給 host、NPC 用完即刪。 =====
// 跟作戰室同一套精神：工作在委派對象的 context 做，只有結果回到 host，省 host 的 context。
async function runDelegate(task: string, workspacePath: string): Promise<string> {
  if (workers.size >= MAX_WORKERS) throw new Error(t("已達 NPC 上限，無法派工"));
  const worker = createWorker("\u{1F50D}研究員", "sonnet", "claude", workspacePath, undefined, null, null, { warmup: true, persist: false, broadcast: true });
  worker.autoApproveMode = "safe"; // 研究員可自行跑唯讀工具（WebSearch/Read）查證，不彈確認窗
  try {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const ev = await warroomSend(worker, t("【委派任務】{task}\n\n請用你的知識完成後，精簡回報結果與理由（3-6 點）。", { task }), 240_000);
    return warroomEventText(ev) || t("(逾時或無結果)");
  } finally {
    const id = worker.id;
    setTimeout(() => deleteWarroomPeer(id), 30_000);
  }
}

app.post("/api/delegate", async (req, res) => {
  if (!providerReady("claude")) {
    res.status(503).json({ error: "claude_not_authenticated", auth: authStates.claude });
    return;
  }
  const task = String(req.body?.task ?? "").trim();
  if (!task) { res.status(400).json({ error: t("請提供委派任務") }); return; }
  const hostWorkerId = typeof req.body?.hostWorkerId === "string" ? req.body.hostWorkerId : null;
  let workspacePath: string;
  try { workspacePath = normalizeWorkspacePath(req.body?.workspacePath ?? config.targetRepoPath); }
  catch { workspacePath = config.targetRepoPath; }
  try {
    const result = await runDelegate(task, workspacePath);
    postToHost(hostWorkerId, t("【委派結果回報】任務：{task}\n\n{result}\n\n以上是你派出的研究員回報的結果（它已下班）。請你據此接手。", { task, result }));
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : t("委派執行失敗") });
  }
});

// ===== 小隊商量（Consult）：隊長自助發問，隊員各自作答後彙整回隊長。 =====
// 防迴圈：題目明講「只給意見、不要再發起商量」；每個部門同時只跑一場（進行中一律 409）。
const consultPending = new Set<string>();

async function runConsult(dept: Department, lead: Worker, question: string): Promise<void> {
  // 隊員篩選（忙碌／⚡無限制模式／今日預算已滿的不參戰）抽在 consult.ts；
  // 這裡負責實際送訊息與回投。
  const { targetIds, skipped } = selectConsultTargets(lead.id, dept.memberWorkerIds, (id) => {
    const mate = workers.get(id);
    if (!mate) return null;
    return {
      name: mate.runner.name,
      busy: mate.runner.busy,
      autoApproveMode: mate.autoApproveMode,
      dailyBudgetUsd: () => getExtras(mate.id).dailyBudgetUsd,
      todayCostUsd: () => todayCostUsd(mate.id),
    };
  });
  const targets = targetIds.flatMap((id) => {
    const mate = workers.get(id);
    return mate ? [mate] : [];
  });
  const ask = composeConsultAsk(lead.runner.name, question);
  const results = await Promise.allSettled(targets.map((mate) => warroomSend(mate, ask, 240_000)));
  const replies = targets.map((mate, i) => {
    const settled = results[i];
    return {
      name: mate.runner.name,
      text: settled.status === "fulfilled" ? warroomEventText(settled.value) : "",
    };
  });
  const digest = composeConsultDigest(question, replies, skipped);
  // 隊長可能正在跟使用者講話：等它這回合結束再送，回報才不會被丟掉
  if (workers.get(lead.id)?.runner.busy) await awaitWorkerTurn(lead.id, 120_000);
  postToHost(lead.id, digest);
}

app.post("/api/workers/:id/consult", (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) { res.status(404).json({ error: "worker not found" }); return; }
  const dept = worker.departmentId ? departments.get(worker.departmentId) : null;
  if (!dept || dept.leadWorkerId !== worker.id) { res.status(403).json({ error: t("只有部門/小隊的隊長可以發起商量") }); return; }
  const question = String(req.body?.question ?? "").trim();
  if (!question) { res.status(400).json({ error: t("請提供要商量的問題") }); return; }
  if (consultPending.has(dept.id)) { res.status(409).json({ error: t("這個小隊已有一場商量進行中，等回報送達後再發起") }); return; }
  consultPending.add(dept.id);
  runConsult(dept, worker, question)
    .catch(() => { /* 個別失敗已反映在 digest；這裡只保底不讓 unhandled rejection 炸掉 */ })
    .finally(() => consultPending.delete(dept.id));
  res.json({ ok: true, note: t("已把問題發給隊員，回覆彙整後會以【隊員商量回報】訊息送回給你。請先結束這回合等回報。") });
});

app.post("/api/workers/:id/message", (req, res) => {
  const worker = requireWorker(res, req.params.id);
  if (!worker) return;
  if (!workerProviderReady(worker)) {
    res.status(503).json({ error: `${worker.runner.provider}_not_authenticated`, auth: workerAuthState(worker) });
    return;
  }
  if (worker.runner.busy) {
    res.status(409).json({ error: "worker busy" });
    return;
  }
  if (handoffInProgress(worker)) {
    res.status(409).json({ error: t("NPC 正在進行 LLM 交接，請等待完成") });
    return;
  }
  if (collaborationInProgress(worker.id) || missionInProgress(worker.id)) {
    res.status(409).json({ error: t("NPC 正在進行協作或部門 Mission，請等待完成") });
    return;
  }
  {
    const budget = getExtras(worker.id).dailyBudgetUsd;
    if (budget != null) {
      const spentUsd = todayCostUsd(worker.id);
      if (spentUsd >= budget) {
        res.status(409).json({
          error: t("💸 {name} 今天已花 ${spent}，達到每日上限 ${cap}。明天自動恢復，或到 📊營運 調高上限。", {
            name: worker.runner.name,
            spent: spentUsd.toFixed(2),
            cap: budget.toFixed(2),
          }),
        });
        return;
      }
    }
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
      : t("附件無效");
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
  if (worker.resumeCandidate) {
    store.deleteResumeCandidate(worker.id);
    worker.resumeCandidate = null;
  }
  const imageLabels = images.map((image, index) => `[Image #${index + 1}: ${image.name}]`).join(" ");
  const documentLabels = documents.map((document, index) => `[Document #${index + 1}: ${document.name}]`).join(" ");
  record(worker, { type: "user_message", text: [message, imageLabels, documentLabels].filter(Boolean).join("\n") });
  try {
    worker.runner.send(message, images, documents);
  } catch (error) {
    const detail = error instanceof Error ? error.message : t("無法傳送附件訊息");
    record(worker, { type: "error", message: detail });
    res.status(500).json({ error: detail });
    return;
  }
  limitTurnText.set(worker.id, [message, imageLabels, documentLabels].filter(Boolean).join("\n"));
  broadcast({ type: "worker_status", workerId: worker.id, busy: true });
  res.json({ ok: true });
});

app.post("/api/workers/:id/resume-candidate", (req, res) => {
  const worker = requireWorker(res, req.params.id);
  if (!worker) return;
  const candidate = worker.resumeCandidate;
  if (!candidate) { res.status(410).json({ error: t("沒有等待恢復的工作") }); return; }
  if (!workerProviderReady(worker) || worker.runner.busy || handoffInProgress(worker) || collaborationInProgress(worker.id) || missionInProgress(worker.id)) {
    res.status(409).json({ error: t("NPC 目前無法恢復此工作") }); return;
  }
  if (candidate.resetAt && new Date(candidate.resetAt).getTime() > Date.now()) { res.status(409).json({ error: t("此工作需等用量重置後才能繼續") }); return; }
  const prompt = t("【重新啟動後繼續原任務】伺服器重啟前的原始指示如下。請先檢查目前對話與工作區的實際進度，避免重複執行；然後從未完成處繼續，完成後回報。\n\n{task}", { task: candidate.taskText });
  record(worker, { type: "user_message", text: prompt });
  try {
    worker.runner.send(prompt, [], []);
    store.deleteResumeCandidate(worker.id);
    worker.resumeCandidate = null;
    broadcast({ type: "worker_updated", worker: workerSummary(worker) });
    broadcast({ type: "worker_status", workerId: worker.id, busy: true });
    res.json({ ok: true });
  } catch (error) {
    record(worker, { type: "error", message: (error as Error).message || t("無法恢復工作") });
    res.status(500).json({ error: (error as Error).message || t("無法恢復工作") });
  }
});

app.delete("/api/workers/:id/resume-candidate", (req, res) => {
  const worker = requireWorker(res, req.params.id);
  if (!worker) return;
  store.deleteResumeCandidate(worker.id);
  worker.resumeCandidate = null;
  record(worker, { type: "user_message", text: t("已停止恢復重啟前未完成的工作") });
  broadcast({ type: "worker_updated", worker: workerSummary(worker) });
  res.status(204).end();
});

registerApprovalRoutes({
  app,
  resolveWorkerApproval: (workerId, approvalId, decision) => {
    const worker = workers.get(workerId);
    if (!worker) return "not_found";
    return worker.runner.resolveApproval(approvalId, decision) ? "resolved" : "unavailable";
  },
  resolveMissionApproval: (missionId, approvalId, decision) => {
    const mission = activeMissions.get(missionId) ?? store.getDepartmentMission(missionId);
    if (!mission) return "not_found";
    for (const [key, handle] of missionRunners) {
      if (key.startsWith(`${mission.id}\0`) && handle.runner.resolveApproval(approvalId, decision)) return "resolved";
    }
    return "unavailable";
  },
  findBridgeResponse: async (token, payload) => {
    for (const worker of workers.values()) {
      const pending = worker.runner.handleApprovalBridge(token, payload);
      if (pending) return { found: true, response: await pending };
    }
    for (const handle of missionRunners.values()) {
      const pending = handle.runner.handleApprovalBridge(token, payload);
      if (pending) return { found: true, response: await pending };
    }
    return { found: false };
  },
});

app.post("/api/workers/:id/model", (req, res) => {
  const worker = requireWorker(res, req.params.id);
  if (!worker) return;
  if (!workerProviderReady(worker)) {
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

async function departmentCleanPreflightError(members: Worker[], allowedBusyWorkerIds: ReadonlySet<string> = new Set()): Promise<string | null> {
  const blocked = members.filter((worker) =>
    (worker.runner.busy && !allowedBusyWorkerIds.has(worker.id)) || handoffInProgress(worker) || collaborationInProgress(worker.id),
  );
  if (blocked.length > 0) {
    return t("以下 NPC 正在工作，不能重建：{names}", { names: blocked.map((worker) => worker.runner.name).join("、") });
  }
  const providerErrors: string[] = [];
  for (const member of members) {
    if (!workerProviderReady(member)) providerErrors.push(t("{name} 的 {provider} 尚未登入", { name: member.runner.name, provider: providerLabel(member.runner.provider) }));
  }
  // Usage telemetry belongs to the shared/default login. A named account has
  // independent limits, so do not block it on the default account's snapshot.
  for (const provider of new Set(members.filter((member) => !member.accountId).map((member) => member.runner.provider))) {
    const usage = await usageRegistry.refresh(provider, true);
    const usageError = usageBlockReason(provider, usage, null);
    if (usageError) providerErrors.push(t("{provider}：{error}", { provider: providerLabel(provider), error: usageError }));
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

function cancelMissionForScopedRestart(mission: DepartmentMission): void {
  if (!missionLocksWorkspace(mission)) return;
  activeMissions.delete(mission.id);
  missionActivities.delete(mission.id);
  stopMissionRunners(mission.id, true);
  mission.status = "cancelled";
  mission.error = null;
  mission.completedAt = new Date().toISOString();
  store.saveDepartmentMission(mission);
  pendingMissionReplans.delete(mission.id);
  updateDepartmentThreadMission(mission.departmentId, null);
  departmentAudit("mission_cancelled_for_restart", mission.departmentId, mission.id);
  broadcastMission(mission);
}

function restartMissionMemberIds(missions: DepartmentMission[]): Set<string> {
  return new Set(missions.flatMap((mission) => [
    mission.bossWorkerId,
    ...(mission.memberWorkerIds ?? []),
    ...mission.steps.map((step) => step.assigneeWorkerId),
  ]));
}

type BossTaskRestartScope = {
  activeMissions: DepartmentMission[];
  departments: Array<{ department: Department; members: Worker[] }>;
  members: Worker[];
};

function bossTaskRestartScope(task: BossTask): BossTaskRestartScope {
  const missionById = new Map<string, DepartmentMission>();
  for (const stage of task.stages) {
    if (!stage.missionId || missionById.has(stage.missionId)) continue;
    const mission = activeMissions.get(stage.missionId) ?? store.getDepartmentMission(stage.missionId);
    if (mission) missionById.set(mission.id, mission);
  }
  const taskMissions = [...missionById.values()];
  const memberIdsByDepartment = new Map<string, Set<string>>();
  for (const mission of taskMissions) {
    if (!mission.departmentId) continue;
    const ids = memberIdsByDepartment.get(mission.departmentId) ?? new Set<string>();
    for (const id of restartMissionMemberIds([mission])) ids.add(id);
    memberIdsByDepartment.set(mission.departmentId, ids);
  }
  const claimedMemberIds = new Set<string>();
  const departmentsForTask = [...memberIdsByDepartment.entries()].flatMap(([departmentId, memberIds]) => {
    const department = departments.get(departmentId);
    if (!department) return [];
    const members = [...memberIds].flatMap((id) => {
      if (claimedMemberIds.has(id)) return [];
      const member = workers.get(id);
      if (!member) return [];
      claimedMemberIds.add(id);
      return [member];
    });
    return [{ department, members }];
  });
  return {
    activeMissions: taskMissions.filter((mission) => missionLocksWorkspace(mission)),
    departments: departmentsForTask,
    members: departmentsForTask.flatMap(({ members }) => members),
  };
}

async function scopedRestartPreflightError(members: Worker[], restarting: DepartmentMission[]): Promise<string | null> {
  const restartingIds = new Set(restarting.map((mission) => mission.id));
  const memberIds = new Set(members.map((member) => member.id));
  const conflict = [...activeMissions.values()].find((mission) =>
    !restartingIds.has(mission.id)
    && missionLocksWorkspace(mission)
    && [...restartMissionMemberIds([mission])].some((id) => memberIds.has(id)),
  );
  if (conflict) return t("{objective} 正在使用這些 NPC，不能清空重開", { objective: conflict.objective.slice(0, 120) });
  const scopedWorkerIds = restartMissionMemberIds(restarting);
  return departmentCleanPreflightError(members, scopedWorkerIds);
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
    if (activeMission) return t("{department} 仍有進行中或待決定的 Mission，不能重建工作階段", { department: department.name });
  }
  const members = bossDepartments.flatMap((department) => departmentMembers(department));
  if (members.length === 0) return t("這個 Boss Task 沒有可重建工作階段的部門成員");
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
  if (!department) { res.status(404).json({ error: t("找不到部門") }); return; }
  const activeMission = workspaceMission(department.workspacePath, department.id);
  const restartActiveMission = req.body?.restartActiveMission === true;
  if (activeMission && !restartActiveMission) {
    res.status(409).json({ error: t("部門仍有進行中或待決定的 Mission，不能重建工作階段"), mission: activeMission });
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
  if (members.length === 0) { res.status(400).json({ error: t("沒有可重建工作階段的部門成員") }); return; }
  if (activeMission && requestedIds) {
    res.status(400).json({ error: t("重開進行中的 Mission 時必須重建整個部門") });
    return;
  }
  const preflightError = activeMission
    ? await scopedRestartPreflightError(members, [activeMission])
    : await departmentCleanPreflightError(members);
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
      activeMission: activeMission ?? null,
      willCancelMission: Boolean(activeMission),
      preserved: [t("Boss 任務與其 Mission 詳情"), t("附件"), t("稽核紀錄")],
      discarded: [t("部門畫面上的舊對話與 Mission"), t("每位 NPC 的原生 LLM 對話上下文")],
    });
    return;
  }
  if (activeMission) cancelMissionForScopedRestart(activeMission);
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
  const worker = requireWorker(res, req.params.id);
  if (!worker) return;
  const provider = worker.runner.provider;
  if (!workerProviderReady(worker)) {
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
    res.status(500).json({ error: t("無法儲存新的模型工作階段，已保留原工作階段") });
    return;
  }

  fresh.warmup();
  broadcast({ type: "worker_updated", worker: workerSummary(worker) });
  res.json({ ok: true });
});

app.post("/api/workers/:id/provider/fresh", (req, res) => {
  const worker = requireWorker(res, req.params.id);
  if (!worker) return;
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
  // Named accounts are provider-specific. A fresh provider switch cannot
  // reuse (for example) a Claude account for Codex, so fall back to that
  // provider's managed default until the owner explicitly assigns one.
  const previousAccountId = worker.accountId;
  worker.accountId = null;
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
    worker.accountId = previousAccountId;
    worker.handoff = previousHandoff;
    persistWorker(worker);
    res.status(500).json({ error: t("無法切換新的 LLM 工作階段，已保留原工作階段") });
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
    res.status(404).json({ error: t("找不到這位 NPC") });
    return;
  }
  const provider = worker.runner.provider;
  if (!workerProviderReady(worker)) {
    res.status(503).json({ error: t("{provider} 尚未登入，登入後才能由 AI 產生人設", { provider: providerLabel(provider) }), auth: authStates[provider] });
    return;
  }
  if (personaSuggestionsInProgress.has(worker.id)) {
    res.status(409).json({ error: t("這位 NPC 的 AI 人設正在產生中") });
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
      res.status(502).json({ error: t("AI 回傳的人設格式不完整，請再產生一次") });
      return;
    }
    res.json({ persona });
  } catch (error) {
    res.status(502).json({ error: (error as Error).message || t("AI 暫時無法產生人設") });
  } finally {
    personaSuggestionsInProgress.delete(worker.id);
  }
});

app.post("/api/workers/:id/persona", (req, res) => {
  const worker = requireWorker(res, req.params.id);
  if (!worker) return;
  if (worker.runner.busy || handoffInProgress(worker) || collaborationInProgress(worker.id) || missionInProgress(worker.id)) {
    res.status(409).json({ error: "worker busy" });
    return;
  }
  worker.persona = normalizePersona(req.body?.persona);
  // Re-spawn so the new persona is injected via --append-system-prompt. The
  // conversation is preserved because the CLI resumes the same session id;
  // a signed-out provider simply stores it until it next starts.
  worker.runner.stop();
  if (workerProviderReady(worker)) worker.runner.warmup();
  persistWorker(worker);
  broadcast({ type: "worker_updated", worker: workerSummary(worker) });
  res.json({ ok: true, persona: worker.persona });
});

app.post("/api/workers/:id/auto-approve", (req, res) => {
  const worker = requireWorker(res, req.params.id);
  if (!worker) return;
  const mode = req.body?.mode;
  if (mode !== "off" && mode !== "safe" && mode !== "full" && mode !== "invincible") {
    res.status(400).json({ error: t("mode 必須是 off、safe、full 或 invincible") });
    return;
  }
  const prevMode = worker.autoApproveMode;
  worker.autoApproveMode = mode;
  // off/safe/full 之間切換不必重啟——核准橋在每次核准請求當下即時讀 mode。但無敵模式是在
  // spawn 時就以 --dangerously-skip-permissions 啟動且「不掛核准橋」，所以從無敵降級時，正在跑的
  // session 會繼續無條件放行到下一個 session 為止。降級＝收緊權限，必須立即生效：中斷當前回合
  // 並重生（CLI 以 --resume 續接同一對話，不遺失上下文），讓新模式的核准橋掛回來。
  if (prevMode === "invincible" && mode !== "invincible") {
    if (worker.runner.busy) worker.runner.interrupt(); else worker.runner.stop();
    if (workerProviderReady(worker)) worker.runner.warmup();
  }
  persistWorker(worker);
  broadcast({ type: "worker_updated", worker: workerSummary(worker) });
  res.json({ ok: true, autoApproveMode: worker.autoApproveMode });
});

// ── NPC 長期記憶＋每日預算（npc-extras，檔案儲存）───────────────────────────
// 記憶由兩邊寫入：使用者在人設面板手動增刪，或 NPC 依 system prompt 指示自己
// curl 進來。改動不重啟 session——新記憶在下一次 spawn 時進 system prompt，
// 本回合的對話上下文裡本來就有。
app.get("/api/workers/:id/extras", (req, res) => {
  if (!workers.has(req.params.id)) {
    res.status(404).json({ error: "unknown worker" });
    return;
  }
  res.json(getExtras(req.params.id));
});

app.post("/api/workers/:id/memory", (req, res) => {
  if (!workers.has(req.params.id)) {
    res.status(404).json({ error: "unknown worker" });
    return;
  }
  const result = addMemoryNote(req.params.id, req.body?.note);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ ok: true, ...getExtras(req.params.id) });
});

app.delete("/api/workers/:id/memory/:index", (req, res) => {
  if (!workers.has(req.params.id)) {
    res.status(404).json({ error: "unknown worker" });
    return;
  }
  if (!removeMemoryNote(req.params.id, Number(req.params.index))) {
    res.status(400).json({ error: t("沒有這則記憶") });
    return;
  }
  res.json({ ok: true, ...getExtras(req.params.id) });
});

app.post("/api/workers/:id/budget", (req, res) => {
  if (!workers.has(req.params.id)) {
    res.status(404).json({ error: "unknown worker" });
    return;
  }
  const result = setDailyBudget(req.params.id, req.body?.dailyUsd);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ ok: true, dailyBudgetUsd: result.dailyBudgetUsd });
});

app.get("/api/persona-templates", (_req, res) => {
  res.json({ templates: store.listPersonaTemplates() });
});

app.post("/api/persona-templates", (req, res) => {
  const normalized = normalizePersonaTemplate(req.body);
  if (!normalized) {
    res.status(400).json({ error: t("範本需要名稱，且至少要有職務或指示") });
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
      workerProviderReady(worker) &&
      !worker.runner.busy
    ) {
      worker.runner.stop();
      worker.runner.warmup();
    }
  }
}

/** Warm only workers that use a specific named account after its auth check succeeds. */
function restartIdleWorkersForAccount(accountId: string): void {
  for (const worker of workers.values()) {
    if (worker.accountId === accountId && workerProviderReady(worker) && !worker.runner.busy) {
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
    res.status(400).json({ error: (error as Error).message || t("無法使用這個工作位置") });
    return;
  }
  const name = String(req.body?.name ?? "").trim();
  if (!/^[\w.-]+$/.test(name)) {
    res.status(400).json({ error: t("名稱只能用英數、-、_、.") });
    return;
  }
  const scope: "local" | "project" | "user" =
    req.body?.scope === "project" || req.body?.scope === "user" ? req.body.scope : "local";
  const mode: "form" | "json" = req.body?.mode === "json" ? "json" : "form";

  if (mode === "json") {
    if (provider === "codex") {
      res.status(400).json({ error: t("Codex 不支援用 JSON 新增 MCP server") });
      return;
    }
    const json = String(req.body?.json ?? "").trim();
    if (!json) {
      res.status(400).json({ error: t("缺少 JSON 內容") });
      return;
    }
    try {
      JSON.parse(json);
    } catch {
      res.status(400).json({ error: t("JSON 格式不正確") });
      return;
    }
    try {
      const { stdout } = await execCli(config.claudeBin, buildClaudeMcpAddArgs({ name, scope, mode: "json", json }), {
        cwd: workspacePath,
        timeout: 30000,
        env: claudeChildEnv(process.env, config.defaultClaudeHome),
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
      res.status(400).json({ error: t("stdio 伺服器不支援 header") });
      return;
    }
    if (!env.every((entry) => /^[\w.]+=.*/.test(entry))) {
      res.status(400).json({ error: t("環境變數格式需為 KEY=VALUE") });
      return;
    }
  } else {
    if (env.length > 0) {
      res.status(400).json({ error: t("http/sse 伺服器不支援環境變數") });
      return;
    }
    if (!headers.every((entry) => /^[^:\r\n]+:\s*.+/.test(entry))) {
      res.status(400).json({ error: t("Header 格式需為 Name: value") });
      return;
    }
  }
  if (!target) {
    res.status(400).json({ error: t("缺少 URL 或指令") });
    return;
  }

  let localArgv: string[] = [];
  if (transport === "stdio") {
    try {
      localArgv = parseCommandLine(target);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message || t("MCP 指令格式不正確") });
      return;
    }
  } else if (!/^https?:\/\//.test(target)) {
    res.status(400).json({ error: t("URL 需以 http:// 或 https:// 開頭") });
    return;
  }

  let args: string[];
  if (provider === "codex") {
    if (headers.length > 0) {
      res.status(400).json({ error: t("Codex 遠端 MCP 請使用 OAuth 或 bearer-token-env-var，介面不保存 token") });
      return;
    }
    if (transport === "sse") {
      res.status(400).json({ error: t("Codex 不支援 SSE transport") });
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
      env: provider === "codex"
        ? codexChildEnv(process.env, config.defaultCodexHome)
        : claudeChildEnv(process.env, config.defaultClaudeHome),
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
    res.status(400).json({ error: (error as Error).message || t("無法使用這個工作位置") });
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
    res.status(400).json({ error: (error as Error).message || t("無法使用這個工作位置") });
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
    res.status(400).json({ error: (error as Error).message || t("無法使用這個工作位置") });
    return;
  }
  const name = req.params.name;
  if (!/^[\w.-]+$/.test(name)) {
    res.status(400).json({ error: t("這個 server 不能從這裡移除（可能是 claude.ai 帳號層級的連接器）") });
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
      env: provider === "codex"
        ? codexChildEnv(process.env, config.defaultCodexHome)
        : claudeChildEnv(process.env, config.defaultClaudeHome),
    });
    void refreshAffectedWorkspace(provider, workspacePath).catch(() => {});
    const reload = await reloadMcpWorkers(provider, workspacePath);
    res.json({ ok: true, message: stdout.trim(), reload });
  } catch (err: any) {
    res.status(500).json({ error: (err.stderr || err.message || "").trim().slice(0, 500) });
  }
});

// Codex's app-server never reports its own slash-command catalog (unlike
// Claude, which reports `slash_commands` live via a `system/init` event), so
// DEFAULT_CODEX_SLASH_COMMANDS in codexCapabilities.ts always drifts behind
// whatever Codex ships next. This lets users grow the list themselves without
// a Pixel Crew release. The list is global (not per-workspace, matching
// DEFAULT_CODEX_SLASH_COMMANDS's own scope), so every already-constructed
// per-workspace registry must be told about the change, not just whichever
// workspace happened to receive the request.
app.post("/api/codex/slash-commands", (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const existing = [...store.loadSlashCommandSeed("codex"), ...DEFAULT_CODEX_SLASH_COMMANDS, ...store.loadCustomCodexSlashCommands()];
  const error = isValidCodexCommandName(name, existing);
  if (error) {
    res.status(400).json({ error });
    return;
  }
  if (store.loadCustomCodexSlashCommands().length >= MAX_CUSTOM_CODEX_SLASH_COMMANDS) {
    res.status(400).json({ error: t("自訂指令數量已達上限（{max} 個）", { max: String(MAX_CUSTOM_CODEX_SLASH_COMMANDS) }) });
    return;
  }
  store.addCustomCodexSlashCommand(name);
  const commands = store.loadCustomCodexSlashCommands();
  for (const registry of codexCapabilityRegistries.values()) registry.setCustomSlashCommands(commands);
  res.json({ ok: true, commands });
});

app.delete("/api/codex/slash-commands/:name", (req, res) => {
  store.removeCustomCodexSlashCommand(req.params.name);
  const commands = store.loadCustomCodexSlashCommands();
  for (const registry of codexCapabilityRegistries.values()) registry.setCustomSlashCommands(commands);
  res.json({ ok: true, commands });
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
    res.status(400).json({ error: (error as Error).message || t("無法使用這個工作位置") });
    return;
  }
  // Unlike remove, login is a safe/reversible auth-only action — and
  // claude.ai account-level connectors (names with spaces, e.g. "claude.ai
  // Notion") are exactly the servers most likely to need it, so login is
  // not restricted to the `^[\w.-]+$` name pattern used for structural
  // changes.
  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: t("缺少 server 名稱") });
    return;
  }
  const { state, alreadyRunning } = mcpLoginTracker.start(
    provider, workspacePath, name,
    provider === "codex"
      ? codexChildEnv(process.env, config.defaultCodexHome)
      : claudeChildEnv(process.env, config.defaultClaudeHome),
  );
  res.json({ ok: true, started: true, alreadyRunning, state });
});

app.post("/api/mcp/login/cancel", (req, res) => {
  const provider: ProviderId = req.body?.provider === "codex" ? "codex" : "claude";
  let workspacePath: string;
  try {
    workspacePath = normalizeManagedWorkspacePath(req.body?.workspacePath);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || t("無法使用這個工作位置") });
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
    res.status(400).json({ error: (error as Error).message || t("無法使用這個工作位置") });
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
    res.status(400).json({ error: (error as Error).message || t("無法使用這個工作位置") });
    return;
  }
  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: t("缺少 server 名稱") });
    return;
  }
  try {
    const { stdout } = await execCli(provider === "codex" ? config.codexBin : config.claudeBin, ["mcp", "logout", name], {
      cwd: workspacePath,
      timeout: 30000,
      env: provider === "codex"
        ? codexChildEnv(process.env, config.defaultCodexHome)
        : claudeChildEnv(process.env, config.defaultClaudeHome),
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
    res.status(400).json({ error: (error as Error).message || t("無法使用這個工作位置") });
    return;
  }
  try {
    const { stdout } = await execCli(config.claudeBin, ["mcp", "reset-project-choices"], {
      cwd: workspacePath,
      timeout: 15000,
      env: claudeChildEnv(process.env, config.defaultClaudeHome),
    });
    await claudeCapabilitiesFor(workspacePath).refresh();
    res.json({ ok: true, message: stdout.trim() || t("已清除本專案核准記憶，下次互動式 session 會重新詢問") });
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
    res.status(400).json({ error: (error as Error).message || t("無法使用這個工作位置") });
    return;
  }
  const scope: "local" | "project" | "user" =
    req.body?.scope === "project" || req.body?.scope === "user" ? req.body.scope : "local";
  try {
    const { stdout } = await execCli(config.claudeBin, ["mcp", "add-from-claude-desktop", "-s", scope], {
      cwd: workspacePath,
      timeout: 30000,
      env: claudeChildEnv(process.env, config.defaultClaudeHome),
    });
    await claudeCapabilitiesFor(workspacePath).refresh();
    const reload = await reloadMcpWorkers("claude", workspacePath);
    res.json({ ok: true, message: stdout.trim() || t("已從 Claude Desktop 匯入 MCP servers"), reload });
  } catch (err: any) {
    res.status(500).json({ error: (err.stderr || err.message || "").trim().slice(0, 500) });
  }
});

app.post("/api/workers/:id/interrupt", (req, res) => {
  const worker = requireWorker(res, req.params.id);
  if (!worker) return;
  if (handoffInProgress(worker)) {
    res.status(409).json({ error: t("LLM 交接不能從一般中止按鈕取消，請等待交接完成或回滾") });
    return;
  }
  if (collaborationInProgress(worker.id) || missionInProgress(worker.id)) {
    res.status(409).json({ error: missionInProgress(worker.id) ? t("Department Mission 請從 Mission 面板取消") : t("協作任務請從協作面板取消") });
    return;
  }
  worker.runner.interrupt();
  broadcast({ type: "worker_status", workerId: worker.id, busy: false });
  res.json({ ok: true });
});

for (const savedWorker of store.loadWorkers(MAX_HISTORY)
  .filter((worker) => !isEphemeralWorkerName(worker.name))
  .slice(0, MAX_WORKERS)) {
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
  { codexHome: config.defaultCodexHome, claudeHome: config.defaultClaudeHome },
);
mcpConfigWatcher.start();

void Promise.all(recentWorkspacePaths().flatMap((workspacePath) => [
  claudeCapabilitiesFor(workspacePath).refresh(),
  codexCapabilitiesFor(workspacePath).refresh(),
])).then(() => {
  restartIdleWorkers();
});
void refreshAuth();
// Named accounts do not share the default provider state. Prime every saved
// account on startup so assigned NPCs become usable without requiring a
// manual refresh from the Accounts modal.
void Promise.all(store.listAccounts().map(async (account) => {
  const auth = await accountRegistry.refresh(account.id);
  if (!auth) return;
  broadcast({ type: "account_auth_updated", accountId: account.id, auth });
  if (auth.status === "authenticated") {
    restartIdleWorkersForAccount(account.id);
    void accountUsageRegistry.refresh(account.id, true);
  }
}));
const usageRefreshTimer = setInterval(() => {
  void usageRegistry.refreshAll(true);
  void accountUsageRegistry.refreshAll(true);
}, 5 * 60_000);
usageRefreshTimer.unref();

// A Mission/collaboration turn is deliberately kept open while a background
// "async agent" tool call is outstanding (see applyMissionActivityEvent), but
// the CLI's matching closing event is empirical and not guaranteed — if it
// never arrives, the turn (and the department's workspace lock, for
// Missions) would otherwise stay stuck forever with no user-visible error.
// Bound the wait and surface it instead of hanging indefinitely.
const missionActivityTimeoutSweep = setInterval(() => {
  const now = Date.now();
  for (const [missionId, activity] of missionActivities) {
    if (activity.openedAt == null || now - activity.openedAt < MISSION_ASYNC_AGENT_TIMEOUT_MS) continue;
    missionActivities.delete(missionId);
    const mission = activeMissions.get(missionId) ?? store.getDepartmentMission(missionId);
    if (!mission) continue;
    pauseMission(
      mission,
      t("背景代理任務超過 {minutes} 分鐘未回報完成，已暫停 Mission 等待你確認", {
        minutes: String(Math.round(MISSION_ASYNC_AGENT_TIMEOUT_MS / 60_000)),
      }),
    );
  }
  for (const [taskId, activity] of collaborationActivities) {
    if (activity.openedAt == null || now - activity.openedAt < MISSION_ASYNC_AGENT_TIMEOUT_MS) continue;
    timeoutCollaboration(taskId);
  }
}, 60_000);
missionActivityTimeoutSweep.unref();

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

// Terminal handler: any route error forwarded via next(err) (including async
// rejections, now caught by express-async-errors above) ends here instead of
// crashing the process. Must be registered after every other app.use/route.
app.use((err: unknown, _req: express.Request, res: Response, next: express.NextFunction) => {
  if (res.headersSent) { next(err); return; }
  console.error("[http] request handler error:", err);
  res.status(500).json({ error: t("伺服器發生未預期的錯誤") });
});

let shuttingDown = false;

function recordRuntimeFailure(event: string, error?: unknown): void {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : error;
  console.error(`[runtime] ${event}${detail ? `: ${detail}` : ""}`);
  appendRuntimeLog(config.dataDirectory, event, detail);
}

function exitAfterShutdown(reason: string, exitCode: number): void {
  // `wss.close()` can wait on an unhealthy websocket implementation. A fatal
  // path must still leave the process, otherwise tsx looks healthy while 8787
  // is already closed. The supervisor will then make a clean replacement.
  const forceExit = setTimeout(() => process.exit(exitCode), 3_000);
  forceExit.unref();
  void shutdown(reason)
    .catch((error) => recordRuntimeFailure(`shutdown failed after ${reason}`, error))
    .finally(() => {
      clearTimeout(forceExit);
      process.exit(exitCode);
    });
}

// A closed HTTP listener with a still-running Node process looks alive to npm
// and concurrently, but leaves the UI permanently retrying its WebSocket. Exit
// deliberately so the development supervisor can create a fresh listener.
server.on("close", () => {
  if (shuttingDown) {
    appendRuntimeLog(config.dataDirectory, "HTTP server closed during planned shutdown");
    return;
  }
  recordRuntimeFailure("HTTP server closed unexpectedly; restarting process");
  setImmediate(() => process.exit(1));
});

server.on("error", (error) => {
  if (shuttingDown) return;
  recordRuntimeFailure("HTTP listener error; shutting down", error);
  exitAfterShutdown("HTTP listener error", 1);
});

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`pixel-crew received ${signal}; shutting down`);
  clearInterval(usageRefreshTimer);
  clearInterval(missionActivityTimeoutSweep);
  workflowWatcher.stop();
  mcpConfigWatcher.stop();
  void shutdownWebShot();
  await voiceEngineServer.stop();
  for (const worker of workers.values()) worker.runner.stop();
  for (const handle of missionRunners.values()) handle.runner.stop();
  missionRunners.clear();
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolveClose) => wss.close(() => resolveClose()));
  // server.close() 只是不收新連線，會一直等瀏覽器的 keep-alive 連線自己斷——
  // 頁面開著就永遠等不完（Ctrl+C 曾因此完全沒反應）。先把現有連線全部切掉。
  server.closeAllConnections();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  store.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    exitAfterShutdown(signal, 0);
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
  recordRuntimeFailure("uncaught exception", error);
  exitAfterShutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (reason) => {
  recordRuntimeFailure("unhandled rejection", reason);
  exitAfterShutdown("unhandled rejection", 1);
});

server.listen(config.port, config.host, () => {
  appendRuntimeLog(config.dataDirectory, `HTTP server listening on ${config.host}:${config.port}`);
  console.log(`pixel-crew server listening on http://${config.host}:${config.port}`);
  console.log(`target repo: ${config.targetRepoPath}`);
  console.log(`local database: ${config.dbPath}`);
  if (config.production && !existsSync(config.webDistPath)) {
    console.warn(`web build not found at ${config.webDistPath}; run npm run build first`);
  }
});
