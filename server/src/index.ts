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
import { spawn, execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { release as osRelease, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { attachTerminalSocket } from "./terminal.js";
import { snapshotTerminalMuxDatabase, terminalMuxRequest } from "./terminalMuxClient.js";
import { stageTerminalPasteImages, terminalPathToken } from "./terminalPaste.js";
import { config } from "./config.js";
import { configuredDefaultModels } from "./defaultModels.js";
import { readWorkspaceGitSummary } from "./workspaceGit.js";
import { appendRuntimeLog } from "./runtimeLog.js";
import { ClaudeSession, type RunnerEvent } from "./claudeRunner.js";
import { claudeChildEnv } from "./claudeEnv.js";
import {
  isLegacyEphemeralWorkerName, parseWarroomResult, sanitizeCustomStances, warroomModels, warroomOpeningPrompt, warroomRebuttalPrompt,
  warroomSynthesisPrompt, warroomStances, type WarRoomDifficulty, type WarRoomResult, type WarRoomStance,
  warroomContextBrief, warroomHostConfidenceNote, warroomOthersDigest, warroomRebuttalNeeded, warroomReportExtras, parseWarroomPosition,
} from "./warroom.js";
import type { EphemeralWorkerKind } from "./warroom.js";
import { WarroomQueue, WARROOM_QUEUE_MAX_WAIT_MS } from "./warroomQueue.js";
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
import { bundledWindowsRoot, releaseVersion } from "./selfUpdate.js";
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
import { VoiceEngineInstaller } from "./voice/voiceEngineInstaller.js";
import { VoiceTranscriber, resolveWhisperBinary } from "./voice/voiceTranscribe.js";
import { registerVoiceRoutes } from "./voice/voiceRoutes.js";
import multer from "multer";
import { extractVideoFramesAndAudio, VideoProcessingError } from "./videoProcess.js";
import { downloadVideoFromUrl, isProbableVideoUrl, VideoDownloadError } from "./videoDownload.js";
import { coalesceDeltaEvents, snapshotHistory, trimEventForSnapshot } from "./snapshotHistory.js";
import { DeltaCoalescer } from "./deltaCoalescer.js";
import { wsPerMessageDeflate } from "./wsCompression.js";
import {
  readAndClearRestoreMarker,
} from "./backupImport.js";
import { AccountUsageRegistry, parseClaudeUsage, ProviderUsageRegistry, usageSourceFor } from "./providerUsage.js";
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
  addLesson,
  addMemoryNote,
  composeMemorySection,
  composeOutboxSection,
  deleteExtras,
  getExtras,
  removeMemoryNote,
  setDailyBudget,
  setWorkerGoal,
} from "./workerExtras.js";
import {
  addGlobalMemoryNote,
  composeGlobalMemorySection,
  listGlobalMemory,
  removeGlobalMemoryNote,
} from "./globalMemory.js";
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
  previewTerminalMissionSteps,
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
import { cleanWorkerSession, isClearCommand, matchNativeCommand, parseGoalCommand, type GoalCommand, type WorkerCleanDeps } from "./nativeCommands.js";
import {
  applyBossTaskRecordPatch,
  bossTaskDecisionPrompt,
  bossTaskClarificationBudget,
  bossTaskFinalReport,
  bossTaskAcceptancePrompt,
  parseBossTaskAcceptanceVerdicts,
  explainBossTaskDecisionFailure,
  parseBossTaskDecision,
  reconcileBossTaskStall,
  type BossTask,
  type BossTaskAcceptanceVerdict,
  type BossTaskMessage,
  type BossTaskMessageRole,
} from "./bossTask.js";
import { resolveOutboxFile } from "./outboxFile.js";
import {
  expertAdvisorPrompt,
  ADVISOR_VARIETY_LENSES,
  parseAdvisorResult,
  explainAdvisorFailure,
} from "./expertAdvisor.js";
import {
  autopilotNextPrompt,
  clampAutopilotSteps,
  clampAutopilotMinutes,
  parseAutopilotDecision,
  type AutopilotHistoryEntry,
} from "./autopilot.js";
import {
  AUTOPILOT_RESOLVE_MAX_ATTEMPTS,
  autopilotAnswerPrompt,
  autopilotResolvePrompt,
  parseAutopilotAnswerDecision,
  parseAutopilotResolveDecision,
} from "./autopilotResolve.js";
import { AutopilotStateStore } from "./autopilotState.js";
import {
  BossDispatchRetryTracker,
  BOSS_DISPATCH_RETRY_MAX_ATTEMPTS,
  dispatchRetryAction,
  isPreDispatchStall,
  runnableNextStage,
} from "./bossDispatchRetry.js";
import {
  DeptCreateRetryTracker,
  DEPT_CREATE_RETRY_MAX_ATTEMPTS,
  bootRebuildKind,
  deptCreateRetryAction,
  deptCreateStallKind,
} from "./bossDeptCreateRetry.js";
import {
  UsageRetryTracker,
  USAGE_RETRY_MAX_PROBES,
  usageRetryAction,
  usageStallKind,
} from "./bossUsageRetry.js";
import { BackoffRetryTracker } from "./backoffRetry.js";
import {
  MISSION_STEP_RETRY_MAX_ATTEMPTS,
  MISSION_STEP_RETRY_POLICY,
  missionStepRetryAction,
  type MissionStepRetryPayload,
} from "./missionStepRetry.js";
import {
  BossTaskWorkCounter,
  restartBlockedByActiveWork,
  synthesizingZombieAction,
} from "./bossTaskReconcile.js";
import {
  clampWorkerAutopilotMinutes,
  clampWorkerAutopilotSteps,
  appendWorkerAutopilotRetro,
  autopilotContextFromHistory,
  explainWorkerAutopilotFailure,
  parseWorkerAutopilotDecision,
  workerAutopilotNextPrompt,
  workerAutopilotProgressGuard,
  workerAutopilotPlanProgressGuard,
  workerAutopilotRepairPrompt,
  workerAutopilotSweepAction,
  workerAutopilotExplorePrompt,
  parseExplorationFindings,
  parseAutopilotAskOptions,
  workerAutopilotStallSignals,
  workerAutopilotStepActivity,
  workerAutopilotIdleStreak,
  latestOwnerInstruction,
  WORKER_AUTOPILOT_IDLE_STOP,
  workerAutopilotStepNotice,
  workerAutopilotStopNote,
  workerAutopilotShouldAutoPick,
  workerAutopilotAutoPickPrompt,
  workerAutopilotChoiceNotice,
  workerAutopilotPausedNote,
  workerAutopilotSwapCarryNote,
  lastTurnWasSystem,
  workerAutopilotInstructionWithCriterion,
  isWorkerAutopilotPlanEmpty,
  mergeWorkerAutopilotPlan,
  seedWorkerAutopilotPlan,
  WORKER_AUTOPILOT_RETRY_POLICY,
  WORKER_AUTOPILOT_MAX_EXPLORE_PER_STEP,
  WorkerAutopilotRetroStore,
  WorkerAutopilotStateStore,
  WorkerAutopilotPlanStore,
  type PersistedWorkerAutopilotState,
  type WorkerAutopilotContext,
  type WorkerAutopilotRetro,
  type WorkerAutopilotPlan,
  type WorkerAutopilotDecision,
  type WorkerAutopilotFinding,
} from "./workerAutopilot.js";
import { PendingSelfInstallStore, evaluateBootResolution } from "./selfEvolvePending.js";
import { planPromoteOnSuccess, checkRollbackReady } from "./selfInstallLifecycle.js";
import { classifySelfChangeCommits, describeSelfChangeRangeBlock, resolveSelfInstallRange, type PostInstallChecks, type SelfChangeCommit } from "./selfEvolveInstall.js";
import {
  OpenUserRequestStore,
  appendOpenRequest,
  listOpenRequests,
  pruneResolved,
  resolveOpenRequests,
  type OpenUserRequest,
} from "./openRequests.js";
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
import { decideBrainSwap, splitHandoffLesson, BRAIN_SWAP_THRESHOLD_TOKENS } from "./brainSwap.js";
import { AppSettingsStore } from "./appSettings.js";
import { setLang, t, tc } from "./i18n.js";
import { accumulateSwallowedText, parseLimitReset } from "./limitResume.js";
import { composeConsultAsk, composeConsultDigest, composeConsultSection, selectConsultTargets } from "./consult.js";
import { detectGarbledText, garbledTextError } from "./textIntegrity.js";

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
  // 壓縮 >1KB 的訊息（初始 snapshot 是大宗）；細節見 wsCompression.ts。
  perMessageDeflate: wsPerMessageDeflate,
  verifyClient(info, done) {
    done(!maintenanceMode && isAllowedLocalRequest(info.req.headers.host, info.origin));
  },
});
// 同一 worker 的高頻串流 delta 在 ~33ms 視窗內合併後才廣播（見 deltaCoalescer.ts）。任何非 delta
// 的廣播都會先 flush，順序不變；新連線組 snapshot 前也會 flush，避免重複文字。
const deltaCoalescer = new DeltaCoalescer((workerId, event) => sendToAllClients(JSON.stringify({ type: "event", workerId, event })));

const MAX_HISTORY = 2000;
const MAX_WORKERS = 20;
// 作戰室成員、委派研究員這類「用完即刪」的臨時 NPC 另有保留名額，不跟常駐 NPC 搶上限：
// 以前共用 20 人上限，辦公室 19 人時作戰室只開得出 1 位成員、沒有主持，還會把單人發言當裁決交出。
// 6 席＝作戰室最多 4 位成員＋1 位主持，再留 1 席給委派研究員。
const EPHEMERAL_HEADROOM = 6;
function persistentWorkerCount(): number {
  let count = 0;
  for (const worker of workers.values()) if (!worker.ephemeralKind) count += 1;
  return count;
}
// 已開場、但主持還沒上桌的作戰室替主持預留的席位。開場時只檢查「成員＋主持」夠不夠，
// 主持卻要等兩輪辯論後才建立；沒預留的話，這段期間另一場作戰室會把那席坐走，
// 先開的那場只能拿未整理的辯論原文當裁決。
let reservedEphemeralSeats = 0;
function ephemeralSeatsLeft(): number {
  return MAX_WORKERS + EPHEMERAL_HEADROOM - workers.size - reservedEphemeralSeats;
}
// 理論上最多能有幾個臨時席（所有臨時 NPC 都散場、只剩常駐 NPC 時）。作戰室需求超過這個數就永遠
// 等不到，直接報錯、不排隊。
function maxEphemeralSeats(): number {
  return MAX_WORKERS + EPHEMERAL_HEADROOM - persistentWorkerCount();
}
// 「為此交辦開專屬部門」建立的臨時團隊部門名稱前綴——用完即散；重啟時靠這個前綴清掉殘留。
const EPHEMERAL_DEPT_PREFIX = "臨時團隊·";
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
const updateChecker = new UpdateChecker(
  readCurrentVersion(),
  (info) => { broadcast({ type: "update_info", updateInfo: info }); },
  () => bundledWindowsRoot(process.platform, process.execPath, existsSync) !== null,
);
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
  (provider, homeDir, accountId) => usageSourceFor(provider).fetch(homeDir, accountId, store),
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
  claudeHomeMode: "legacy" | "managed";
  resumeCandidate: ResumeCandidate | null;
  // 編排器建立、跑完就該消失的短命 worker。以前是靠名字的 emoji 字首
  // （🏛／🔍）判斷，等於把協定藏在顯示字串裡：使用者一改名就失效，前端也
  // 被迫把 emoji 顯示在介面上。現在是明確欄位，前端用它決定要不要把這些
  // NPC 拉到會議桌圍坐。
  ephemeralKind: EphemeralWorkerKind | null;
};

const workers = new Map<string, Worker>();

// 舊版的共用 turn_end hook 會把 persist:false 的短命 worker 又存回 SQLite。
// 服務重啟後，這些 worker 不可能再接回原本的編排 promise，會永遠顯示成閒置。
// 在載入 department / worker 前先清掉，讓部門成員快取也不會含有孤兒資料。
// 這裡讀的是 SQLite 裡的舊資料列，沒有 ephemeralKind 欄位，只能靠舊版的
// 名字字首認出來。新版的短命 worker 一律 persist:false，不會走到這裡。
const staleEphemeralWorkerIds = store.loadWorkers(0)
  .filter((worker) => isLegacyEphemeralWorkerName(worker.name))
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
// 刪掉短命 worker 的資料列，但保留還被部門 Mission 當 boss 引用的那一列：
// department_missions.boss_worker_id 是 ON DELETE CASCADE，刪了會把封存的 Mission
// 紀錄一起銷毀，而交辦頁明說「封存會保留全部對話、部門階段與報告」。留下來的列帶著
// ephemeral_kind 標記，不會被還原成 NPC，也不佔滿編名額——它只是封存紀錄的外鍵錨點。
function deleteEphemeralWorkerRow(workerId: string): void {
  if (store.countMissionsByBossWorker(workerId) > 0) return;
  store.deleteWorker(workerId);
}
// 清掉上次中斷（例如崩潰/重啟在任務中途）留下的臨時團隊：短命部門用完即散，重啟不該殘留。
// 認法是成員持久化的 ephemeral_kind，不是部門名稱——名稱是使用者可改的顯示字串，拿它
// 當協定一改名就失效（見 warroom.ts 的同一個教訓）。名稱前綴只留作舊 DB 的相容退路。
const persistedWorkersAtStartup = store.loadWorkers(0);
const ephemeralWorkerIdsByDepartment = new Map<string, string[]>();
for (const worker of persistedWorkersAtStartup) {
  if (!worker.ephemeralKind || !worker.departmentId) continue;
  ephemeralWorkerIdsByDepartment.set(
    worker.departmentId,
    [...(ephemeralWorkerIdsByDepartment.get(worker.departmentId) ?? []), worker.id],
  );
}
const staleEphemeralDepartments = store.listDepartments().filter((department) =>
  ephemeralWorkerIdsByDepartment.has(department.id) || department.name.startsWith(EPHEMERAL_DEPT_PREFIX));
for (const department of staleEphemeralDepartments) {
  const memberIds = ephemeralWorkerIdsByDepartment.get(department.id)
    ?? persistedWorkersAtStartup.filter((worker) => worker.departmentId === department.id).map((worker) => worker.id);
  for (const workerId of memberIds) deleteEphemeralWorkerRow(workerId);
  store.deleteDepartment(department.id);
}
if (staleEphemeralDepartments.length > 0) {
  console.warn(`[startup] removed ${staleEphemeralDepartments.length} stale ephemeral department(s) from an interrupted run`);
}
const departments = new Map<string, Department>(store.listDepartments().map((department) => [department.id, department]));
const activeCollaborations = new Map<string, CollaborationTask>();
const collaborationActivities = new Map<string, MissionActivity>();
const activeMissions = new Map<string, DepartmentMission>(
  store.listReservedDepartmentMissions().map((mission) => [mission.id, mission]),
);
const missionActivities = new Map<string, MissionActivity>();
// 個別 worker（含 BOSS）的背景 Agent 追蹤：一個 NPC 在某回合用 Agent 工具開了背景代理
// （run_in_background）後，自己的 turn 會先 turn_end（busy 翻 false），但背景代理還在跑。
// 若只看 runner.busy，BOSS 旁會誤顯「待命」。沿用 Mission 那套 applyMissionActivityEvent：
// 背景 Agent 跨 turn_end 不清、只在收到非 async 的收尾結果／error 或逾時才銷號。這裡的偏誤
// 刻意倒向「寧可多顯一下執行中」——owner 只嫌過它誤顯待命，從不嫌它顯執行中。
const workerActivities = new Map<string, MissionActivity>();
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
// 交辦決策把某個 stage 標為 noReview（簡單、低風險的多步交付）時，記下它的 missionId；
// 規劃計畫解析完成後（finishMission）據此結構性剝掉所有 review 步驟，不靠規劃模型自律。
const noReviewMissions = new Set<string>();
// 換腦完成、交接摘要還沒送進新 session 的 worker：佇列排空要先讓路（摘要必須是新 session 的第一則）。
const pendingSwapSummaries = new Set<string>();
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
    busy: w.runner.busy || handoffBusy || collaborationIds.length > 0 || missionBusy || workerHasBackgroundAgents(w.id),
    // busy 只因背景代理在跑（本人沒在跑回合）：場景照樣顯執行中，但輸入框不顯「中止」——
    // 這時中止打不到任何東西，新訊息也會直接送出、不用排隊。
    backgroundOnly: workerHasBackgroundAgents(w.id) && !(w.runner.busy || handoffBusy || collaborationIds.length > 0 || missionBusy),
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
    ephemeralKind: w.ephemeralKind,
    autopilot: workerAutopilotSnapshot(w.id),
    collaborationIds,
    missionIds,
  };
}

function handoffInProgress(worker: Worker): boolean {
  return Boolean(worker.handoff && !["completed", "failed"].includes(worker.handoff.stage));
}

// 這個 worker 目前是否還掛著跑不停的背景 Agent（見 workerActivities / workerAsyncAgentHook）。
function workerHasBackgroundAgents(workerId: string): boolean {
  return (workerActivities.get(workerId)?.openAgentIds.length ?? 0) > 0;
}

// 把每個 RunnerEvent 餵進這顆 worker 的背景 Agent 追蹤。開了背景代理→turn_end 不清；收到非 async
// 收尾結果／error 或逾時才銷號。只有在「有無背景 Agent」的布林邊界真的翻轉時才廣播 worker_updated，
// 讓前端的 busy（含 BOSS 旁狀態）即時跟著亮／滅，又不會每個事件都洗一次廣播。
function workerAsyncAgentHook(worker: Worker, event: RunnerEvent): void {
  const before = workerHasBackgroundAgents(worker.id);
  const current = workerActivities.get(worker.id) ?? createMissionActivity();
  const { activity } = applyMissionActivityEvent(current, event);
  if (activity.openAgentIds.length > 0) workerActivities.set(worker.id, activity);
  else workerActivities.delete(worker.id);
  const after = activity.openAgentIds.length > 0;
  // turn_end 會讓所有在線前端把 busy 翻 false；背景代理還在跑時要緊接著補發一次，
  // 否則只有重新連線（拿 snapshot）的裝置顯示執行中，電腦和手機各說各話。
  if (before !== after || (after && event.type === "turn_end")) {
    broadcast({ type: "worker_updated", worker: workerSummary(worker) });
  }
}

// 換成全新工作階段時，舊 session 開的背景代理隨舊行程結束、不會再有 task_notification。
// 補記 subagent_done（寫進歷史，重整後重播也一致）並銷號，免得畫面留著已死的子代理、busy 卡到逾時。
function dropBackgroundAgents(worker: Worker): void {
  const open = workerActivities.get(worker.id)?.openAgentIds ?? [];
  for (const id of open) record(worker, { type: "subagent_done", id });
  workerActivities.delete(worker.id);
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
  // 先送出緩衝中的串流 delta，確保它們排在這則廣播之前（例如 worker_updated busy=false）。
  deltaCoalescer.flush();
  sendToAllClients(JSON.stringify(payload));
}

function broadcastWorkerEvent(workerId: string, event: RunnerEvent): void {
  deltaCoalescer.push(workerId, event);
}

function sendToAllClients(raw: string): void {
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

function homeForWorker(worker: Worker): string | null {
  // A pre-managed-accounts session must resume from the ambient Claude home
  // that created it. Forcing CLAUDE_CONFIG_DIR to the new private home makes
  // Claude see the old --resume id without its history.
  if (worker.runner.provider === "claude" && !worker.accountId && worker.claudeHomeMode === "legacy") return null;
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
    claudeHomeMode: worker.claudeHomeMode,
    ephemeralKind: worker.ephemeralKind,
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
  noReviewMissions.delete(mission.id); // 規劃前就失敗的 noReview mission 不會走到 finishMission 的清除點，這裡一併清掉避免殘留
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
  // 先對位再做前置檢查：pause 發生在檢查階段時（NPC 消失／忙碌／未登入…），人工解卡
  // （applyMissionResolution 的 retry／reassign）與自動重派讀的都是 currentStepIndex——
  // 不先更新會指著上一個已完成步，retry 變成重做完成步、reassign 改到錯的步（bd15861
  // 交互自審 #2 證實，先前行為就有、exhausted 引導訊息把人帶進這條路後危害放大）。
  if (step) mission.currentStepIndex = stepIndex;
  if (!step || !assignee) {
    pauseMission(mission, t("Mission 指派的 NPC 已不存在，請重新指派"), "member_unavailable");
    return;
  }
  if (!sameWorkspacePath(assignee.runner.workspacePath, mission.workspacePath)) {
    pauseMission(mission, t("Mission 指派的 NPC 已離開原部門，請重新指派"), "member_unavailable");
    return;
  }
  if (assignee.runner.busy || handoffInProgress(assignee) || collaborationInProgress(assignee.id)) {
    // 暫時性卡住（NPC 忙碌／交接／協作中）：登記自動重派，NPC 空出（turn_end／定期掃）就重走本函式，
    // 不用等人回覆。同函式上方兩種 member_unavailable（NPC 消失／離開部門）是永久性缺人，不登記。
    pauseMission(mission, t("{name} 正在執行其他工作，請稍後重試或重新指派", { name: assignee.runner.name }), "member_unavailable");
    missionStepRetry.note(mission.id, { stepIndex, assigneeWorkerId: step.assigneeWorkerId, pausedError: mission.error ?? "", priorReview }, Date.now());
    return;
  }
  if (!workerProviderReady(assignee)) {
    // 同款登記：登入是人工動作，但登入後也沒有任何機制回來重派——由掃描在 provider 恢復時接手。
    pauseMission(mission, t("{provider} 尚未登入，請登入後重試或重新指派", { provider: providerLabel(assignee.runner.provider) }), "member_unavailable");
    missionStepRetry.note(mission.id, { stepIndex, assigneeWorkerId: step.assigneeWorkerId, pausedError: mission.error ?? "", priorReview }, Date.now());
    return;
  }
  const now = new Date().toISOString();
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
        const repair = missionFormatRepairPrompt("plan", output, parsed.error);
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
    // noReview：交辦決策判定這是簡單、低風險的交付——結構性剝掉規劃模型排的所有 review 步驟（不靠它自律）。
    // review 一定緊接在某個 execute 之後，剝掉後至少仍留一個 execute。接著若只剩單一步驟，下方 synthesize
    // 的追加條件（steps.length > 1）自然不成立，等於連最後的彙整回合一起省掉。
    if (noReviewMissions.delete(mission.id)) {
      mission.steps = mission.steps.filter((step) => step.kind !== "review");
    }
    // 單步 mission 不再追加獨立的「彙整報告」回合——那一步的輸出本身就是交付物，
    // missionReport 會取最後一步結果當部門報告，省下一整輪重貼所有步驟結果的 LLM 呼叫。
    if (mission.executionMode !== "research" && mission.steps.length > 1) mission.steps.push({
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
  // 這回合結束、worker 空下來了 → 若它還有排隊，server 自己送出下一則（背景也照跑）。
  if (event.type === "turn_end" || event.type === "error") scheduleQueueDrain(worker);
  // `/usage` is handled by Claude inside its already-authenticated session.
  // `claude -p /usage` opens a different empty session, so only the completed
  // turn's own result is authoritative for this worker's assigned account.
  if (event.type === "turn_end" && worker.runner.provider === "claude") {
    const windows = parseClaudeUsage(event.resultText);
    if (windows.length > 0) {
      if (worker.accountId) accountUsageRegistry.report(worker.accountId, windows);
      else usageRegistry.report("claude", windows);
    }
  }
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
  broadcastWorkerEvent(worker.id, event);
  // 必須排在 event 廣播「之後」：turn_end 事件會讓前端把 busy 翻 false，這裡若還有背景 Agent
  // 就緊接著補一發 worker_updated(busy=true) 把它蓋回來，BOSS 旁才不會在背景代理還在跑時顯待命。
  workerAsyncAgentHook(worker, event);
  if ((event.type === "turn_end" || event.type === "error") && collaborationTerminal) finishCollaboration(worker, event);
  warroomRecordHook(worker, event);
  brainSwapHook(worker, event);
  limitResumeHook(worker, event);
  workerAutopilotHook(worker, event);
  bossDispatchRetryHook(event);
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
// 這樣不會等到 CLI 強制壓縮把細節壓丟。作戰室成員／研究員是短命工，不換。
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
    ephemeral: Boolean(worker.ephemeralKind),
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
    record(worker, { type: "user_message", text: decision.message, notice: true });
    return;
  }
  if (decision.action === "cooldown") {
    if (decision.message) {
      brainSwapCooldownNoted.add(worker.id);
      record(worker, { type: "user_message", text: decision.message, notice: true });
    }
    return;
  }
  if (decision.action === "complete_swap") {
    // 摘要回合結束 → 執行換腦。先把 NPC 夾帶的「一句可複用心法」切出來沉澱進 Playbook：
    // 換腦＝學習事件，每換一次腦這顆 NPC 就多學一條做事慣例（複利）。切不出來就只換腦、不學，
    // 餵進新 session 的永遠是乾淨的交接摘要本體（splitHandoffLesson 保證活命優先於學習）。
    brainSwapPending.delete(worker.id);
    const { summary, lesson } = splitHandoffLesson(decision.summary);
    // 誠實訊號：learnedLesson 只有在心法「真的落盤」時才非 null——被去重擋下
    // 或走「只換腦不學」活命分支（lesson 為 null）都維持 null，前端據此決定要不要閃「＋1 心法」。
    let learnedLesson: string | null = null;
    if (lesson) {
      const stored = addLesson(worker.id, lesson);
      if (stored.ok) {
        learnedLesson = stored.lesson;
        record(worker, { type: "user_message", system: true, text: t("🧠 換腦蒸餾出一條做事心法，已沉澱進長期記憶：{lesson}", { lesson: stored.lesson }) });
      }
    }
    // 只在 complete_swap 路徑發這個事件，不污染其他流程；前端拿 learned 決定閃現內容。
    broadcast({ type: "brain_swapped", workerId: worker.id, learned: learnedLesson != null, lesson: learnedLesson });
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
    dropBackgroundAgents(worker);
    broadcast({ type: "worker_updated", worker: workerSummary(worker) });
    // 交接摘要必須是新 session 收到的第一則訊息。掛 pending 旗標讓 drainWorkerQueue 先讓路
    //（同一個 turn_end 已排了 drain，不擋的話排隊訊息會搶先送進零上下文的新 session、摘要被 busy 丟棄）；
    // 若使用者搶先發話（busy），不再直接放棄，改為重試等它回合結束，重試耗盡才把摘要留在紀錄裡讓人手動接。
    pendingSwapSummaries.add(worker.id);
    let swapSendAttempts = 0;
    const trySendSummary = () => {
      if (!workers.has(worker.id)) { pendingSwapSummaries.delete(worker.id); return; }
      if (worker.runner.busy) {
        swapSendAttempts += 1;
        if (swapSendAttempts < 150) { setTimeout(trySendSummary, 2_000); return; }
        pendingSwapSummaries.delete(worker.id);
        record(worker, { type: "user_message", notice: true, text: t("🧠 自動換腦完成，但新工作階段持續忙碌，交接摘要未能自動送入。摘要保留如下，可貼給 NPC 手動接手：\n\n{summary}", { summary }) });
        scheduleQueueDrain(worker);
        return;
      }
      pendingSwapSummaries.delete(worker.id);
      record(worker, { type: "user_message", system: true, text: t("🧠 自動換腦完成：交接摘要已送進全新工作階段") });
      try {
        worker.runner.send(t("（系統自動換腦）你前一個工作階段的 context 已滿。以下是它留下的交接摘要，請讀完後簡短回覆「已接手」，之後依摘要繼續服務：\n\n{summary}", { summary }), [], []);
        broadcast({ type: "worker_status", workerId: worker.id, busy: true });
      } catch { /* 送不進去就留著摘要在紀錄裡，使用者可手動接 */ }
    };
    setTimeout(trySendSummary, 300);
    return;
  }

  // decision.action === "start_swap"：先請 NPC 寫交接摘要
  brainSwapPending.add(worker.id);
  const announcement = decision.message;
  // 循環開著：要求摘要保留循環目標與進度，新腦才知道自己在循環裡、做到哪。
  const loopState = workerAutopilotByWorker.get(worker.id);
  const loopCarry = loopState ? workerAutopilotSwapCarryNote(loopState.goal, workerAutopilotPlans[worker.id]) : "";
  setTimeout(() => {
    if (!brainSwapPending.has(worker.id)) return;
    if (worker.runner.busy) { brainSwapPending.delete(worker.id); return; } // 使用者搶先發話，等下個回合再觸發
    record(worker, { type: "user_message", system: true, text: announcement });
    try {
      worker.runner.send(t("【系統通知】你的 context 已接近上限，即將換到全新的工作階段（自動換腦）。請把「進行中的工作與狀態、重要結論、待辦事項、使用者的偏好與約定」整理成一份簡潔的交接摘要（markdown、800 字內）。下一個你會以這份摘要為唯一起點，請確保它自足。只輸出摘要本身，不要開場白。\n\n摘要寫完後，若這段工作讓你學到一條「下次換了腦也值得記得、可複用」的做事慣例或踩雷教訓，在最後另起一行用底下格式補一句（沒有就整段省略，別硬湊）：\n---LESSON---\n<一句話、動作導向、不含本次任務細節的可複用心法>") + loopCarry, [], []);
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
  if (worker.ephemeralKind) return; // 短命工不排，任務由發起方重試
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
  record(worker, { type: "user_message", text: t("⏰ 撞到用量上限，已排 {time} 自動繼續（⚙ 功能可關閉；伺服器重啟會取消這次排程）", { time: fireLabel }), notice: true });
  const timer = setTimeout(() => {
    limitResumeTimers.delete(worker.id);
    // 累積清單不在守門前銷毀：worker 沒了才清，其餘早退情形（功能關閉／使用者接手）保留，
    // 待成功回合（含使用者接手完成、或下次重送成功）在 hook 開頭統一清除，才不會遺失指示。
    if (!workers.has(worker.id)) { limitSwallowedTexts.delete(worker.id); return; }
    if (!appSettings.get().limitResumeEnabled) return;
    if (worker.runner.busy) return; // 已在忙＝使用者或其他機制已接手，成功回合會清掉累積
    const swallowed = limitSwallowedTexts.get(worker.id) ?? [];
    record(worker, { type: "user_message", system: true, text: t("⏰ 用量上限已重置，自動繼續先前被中斷的工作") });
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
  options: { warmup?: boolean; persist?: boolean; broadcast?: boolean; ephemeralKind?: EphemeralWorkerKind } = {},
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
    claudeHomeMode: persisted?.claudeHomeMode ?? "managed",
    resumeCandidate: persisted ? store.getResumeCandidate(id) : null,
    ephemeralKind: options.ephemeralKind ?? null,
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

// Persona ＋ 長期記憶合成一份 system prompt。短命工（作戰室成員、研究員）
// 不給記憶區塊——它們活不到下一次 spawn，注入只是浪費 token 還可能誤存記憶。
function composeWorkerPrompt(worker: Worker): string {
  const ephemeral = Boolean(worker.ephemeralKind);
  return [
    composePersonaPrompt(worker.persona),
    ephemeral ? "" : composeGlobalMemorySection(store, worker.id),
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
    createRunner: (provider, workspacePath) => {
      // /clean intentionally drops the native conversation. Switch before
      // warmup so the fresh Claude process is born in the managed home rather
      // than inheriting the legacy session's ambient home for one more turn.
      if (provider === "claude" && !worker.accountId) worker.claudeHomeMode = "managed";
      return createRunner(worker, provider, workspacePath);
    },
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
  // Goals belong to a conversation, unlike long-term memory notes and daily
  // budgets. A fresh `/clear` session must not inherit its old objective.
  setWorkerGoal(worker.id, null);
  clearWorkerHookState(worker.id); // 取消待觸發的自動繼續計時器，別把清除前的舊指示注入乾淨 session
  workerActivities.delete(worker.id); // 舊 session 的背景代理隨行程結束；歷史已清空，不必補記 subagent_done
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

function announceClaudeGoal(worker: Worker, command: GoalCommand): void {
  let resultText: string;
  if (command.type === "set") {
    const goal = setWorkerGoal(worker.id, command.objective);
    // Claude reads its appended system prompt at process start. Restart the
    // idle transport so the new goal applies to the very next turn while its
    // native conversation session is resumed intact.
    worker.runner.stop();
    worker.runner.warmup();
    resultText = t("已設定目標：{objective}", { objective: goal ?? command.objective });
  } else if (command.type === "clear") {
    const hadGoal = getExtras(worker.id).goal != null;
    setWorkerGoal(worker.id, null);
    worker.runner.stop();
    worker.runner.warmup();
    resultText = hadGoal ? t("已清除目標。") : t("目前沒有設定目標。");
  } else {
    const goal = getExtras(worker.id).goal;
    resultText = goal ? t("目前目標：{objective}（狀態：{status}）", { objective: goal, status: "active" }) : t("目前沒有設定目標。");
  }
  record(worker, { type: "text_delta", text: resultText });
  record(worker, {
    type: "turn_end",
    resultText,
    costUsd: 0,
    durationMs: 0,
    isError: false,
    permissionDenials: [],
  });
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
    const recent = store.listBossTasks(registryKey(preferredWorkspace)).find((task) =>
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

// 自動循環的「教練決策」要對準這位 NPC 指定的帳號，而不是共用登入——否則你把 NPC 設成某個
// 有 token 的帳號，決定「下一步做什麼」的那通模型呼叫卻跑在共用登入上，共用登入沒 token 就整個
// 循環卡死。共用登入可用時沿用原本的 provider/model 選法（不動模型行為、避免回歸）；只有共用
// 登入不可用、但 NPC 指定帳號可用時，才改用 NPC 自己的 provider/model 讓循環照常跑。
function resolveWorkerDecisionRuntime(worker: Worker): { provider: ProviderId; model: string } | { error: string } {
  const provider = worker.runner.provider;
  // 決策要用「這位 NPC 自己設定的模型」——而不是 resolveDecisionRuntime 依工作區挑的模型。後者會
  // 優先挑到工作區最近一張 BOSS 任務用的決策模型（例如工作區「測試」把 總管小揮 的決策挑成 fable），
  // 那可能是一個額度已用盡的模型（fable 在該帳號已耗盡 → out of credits），即使 NPC 明明設的是 opus。
  // 用 NPC 自己的模型既符合「決策繼承 NPC 模型」的設定，也吃對帳號對模型的額度。
  if (workerProviderReady(worker)) {
    const model = worker.runner.getModel();
    if (model && validModel(provider, model)) return { provider, model };
  }
  // NPC 沒設明確模型（繼承預設）時才回退到工作區啟發式；指定帳號可用但共用登入未登入時，
  // 退而用該 provider 的可用模型，不被共用登入狀態綁死。
  const base = resolveDecisionRuntime(undefined, undefined, worker.runner.workspacePath);
  if (!("error" in base)) return base;
  if (worker.accountId && workerProviderReady(worker)) {
    const fallback = resolveDecisionRuntime(provider, undefined, worker.runner.workspacePath);
    if (!("error" in fallback)) return fallback;
  }
  return base;
}

// 用量/受限判斷同樣要對準 NPC 的帳號：有指定帳號就看該帳號的即時工作能量，否則看共用登入。
function refreshWorkerDecisionUsage(worker: Worker, provider: ProviderId) {
  return worker.accountId
    ? accountUsageRegistry.refresh(worker.accountId, true)
    : usageRegistry.refresh(provider, true);
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

/** A terminal may outlive the worker that originally authorized its workspace.
 * Permit reconnecting only when the requested path matches that terminal's
 * durable mux record; never widen this into a general filesystem allowance. */
async function normalizeManagedTerminalWorkspacePath(input: unknown, terminalTabId: string): Promise<string> {
  const canonical = normalizeWorkspacePath(input);
  const managedPaths = [config.targetRepoPath, ...[...workers.values()].map((worker) => worker.runner.workspacePath)];
  if (managedPaths.some((path) => sameWorkspace(path, canonical))) return canonical;
  if (!/^terminal-[a-zA-Z0-9-]{8,120}$/.test(terminalTabId)) throw new Error(t("無效的終端分頁"));
  const record = await terminalMuxRequest({ type: "terminal_get", tabId: terminalTabId });
  if (typeof record.workspacePath === "string" && sameWorkspace(record.workspacePath, canonical)) return canonical;
  throw new Error(t("只能管理目前已加入 Pixel Crew 的工作資料夾"));
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
    const event = events[index];
    if (event.type === "turn_end" || event.type === "error") return false;
    // notice 型 user_message 是純系統通知，沒有真的送進 runner、不會有 turn_end 收尾——
    // 不能當成「開著的回合」，否則冷卻/排程通知會被誤判成未完成回合。
    if (event.type === "user_message" && !event.notice) return true;
  }
  return false;
}

function lastUnfinishedTask(events: RunnerEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    // 跳過 notice：它是系統通知不是任務原文，拿去當 resumeCandidate 會把「🧠 冷卻通知」重新送給 NPC。
    if (event.type === "user_message" && !event.notice) return event.text.trim().slice(0, 12_000) || null;
  }
  return null;
}

// 未完成回合的「權威收尾」：一個 worker 已經 idle（runner 不 busy）卻在 history 裡還掛著一個
// 開著的 turn（有 user_message、後面沒有 turn_end/error）時，補一個中止事件。
// 這是為了修「電腦還在跑、手機卻顯示工作階段已中止」的顯示 bug：以前完全靠前端在 snapshot 用
// `!busy && 最後一個 turn 還 running` 自己猜，一旦某條路徑（例如 stop()）把 busy 設成 false 卻沒往
// history 補 terminal 事件，前端就會誤報中止、而且各裝置狀態不一致。改由 server 在權威來源補齊，
// 讓所有裝置看到相同且正確的結果。故意「不」走 record()/recordUnsafe()——那會觸發 turn_end/error 的
// 各種 hook（佇列排空、換腦、成本統計），補一筆收尾不該誤觸發它們；這裡只寫 history＋SQLite＋廣播。
// idempotent：補完 hasUnfinishedTurn 就為 false，重複呼叫不會再補。
function reconcileDanglingTurn(worker: Worker): boolean {
  if (worker.runner.busy || !hasUnfinishedTurn(worker.history)) return false;
  const event: RunnerEvent = { type: "error", message: t("工作階段已中止；請重新下指令"), at: Date.now() };
  worker.history.push(event);
  if (worker.history.length > MAX_HISTORY) worker.history.splice(0, worker.history.length - MAX_HISTORY);
  if (worker.persistent) store.appendEvent(worker.id, event, MAX_HISTORY);
  broadcastWorkerEvent(worker.id, event);
  return true;
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
  | { kind: "read_only_query"; allowedTools: string[]; allowSafeShell?: boolean };

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
    const detachedSpawnStart = Date.now();
    let firstEventLogged = false;
    runner = detachedRunner(provider, workspacePath, model, initialState, (event) => {
      // 量測冷啟：spawn 到第一個事件＝CLI 啟動+init 的成本（只對決策用的 no_tools 呼叫落檔，避免噪音）。
      if (!firstEventLogged && policy.kind === "no_tools") {
        firstEventLogged = true;
        appendRuntimeLog(config.dataDirectory, "detached(no_tools) first event", { spawnToFirstMs: Date.now() - detachedSpawnStart, provider });
      }
      if (event.type === "text_delta") streamedText += event.text;
      else if (event.type === "tool_call_start") {
        if (policy.kind === "no_tools") {
          finish(new Error(t("這個模型回合不得使用工具")));
          return;
        }
        if (policy.kind === "read_only_query") {
          // 次級擋刀（縱深防禦）：runner 的核准橋是權威判定，這裡用同一把尺複判——Bash 帶出指令內容
          // 交 autoApprovalPolicy（allowSafeShell 時），確保安全 Bash 不被這層誤殺、危險 Bash 雙重擋下。
          const command = event.name === "Bash" && event.input && typeof event.input === "object"
            ? (event.input as Record<string, unknown>).command
            : undefined;
          const decision = queryToolPolicy(event.name, allowedQueryTools, {
            allowSafeShell: policy.allowSafeShell === true,
            command: typeof command === "string" ? command : undefined,
          });
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
        ? { executionProfile: "read_only_query", queryAllowedTools: policy.allowedTools, queryAllowSafeShell: policy.allowSafeShell === true }
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
    // 未結案使用者請求：從帳本取原文，餵進本機備援＋摘要後權威覆寫，確保逐字跨換腦、不被 LLM 壓縮掉。
    const openRequestTexts = listOpenRequests(openUserRequests, worker.id).map((entry) => entry.text);
    const localSummary = buildLocalHandoff(worker.history, gitState, openRequestTexts);
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
      // 權威覆寫：使用者未結案請求以帳本原文為準，不信任摘要 LLM 是否逐字複製（防漏／防壓縮）。
      summary.openUserRequests = openRequestTexts;
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
    record(worker, { type: "user_message", system: true, text: t("LLM 交接：{from} → {to}", { from: providerLabel(sourceProvider), to: providerLabel(progress.toProvider) }) });
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
      record(worker, { type: "user_message", system: true, text: t("LLM 交接：{from} → {to}", { from: providerLabel(sourceProvider), to: providerLabel(progress.toProvider) }) });
      record(worker, { type: "error", message: t("交接失敗，已恢復 {provider}：{error}", { provider: providerLabel(sourceProvider), error: (error as Error).message }) });
    }
    broadcast({ type: "worker_updated", worker: workerSummary(worker) });
  }
}

// 預算守門：初始 snapshot 曾肥到 18.7MB 讓手機卡死在「尋找AI隊員」，瘦身到 4.85MB
// 才勉強打平。之後任何改動把它推回 5MB 以上，就在這裡大聲告警抓回歸。
// snapshot 瘦身/裁切邏輯（含「至少保留最近 N 個完整 turn，日誌不空白」）已抽到
// snapshotHistory.ts，方便單元測試。
const SNAPSHOT_BUDGET_BYTES = 5 * 1024 * 1024;
let snapshotBudgetWarnedAt = 0;

// 初始 snapshot 瘦身：已結束（completed/failed/cancelled）的 Mission 去掉 executionEvents。
// 那是初始 snapshot 肥大的主因（實測 16MB，完成的量化 mission 單筆可達 1~2.5MB）；完成的
// Mission 的活動流前端會在你點開「部門討論與執行」時用 GET /api/missions/:id 單筆補抓
// （web 的 useWorkers.loadMissionActivity），snapshot 不必帶。進行中的
// Mission 保留事件（活著要看），只把單筆超大的工具輸出/輸入裁短。
function missionForSnapshot(mission: DepartmentMission): DepartmentMission {
  if (mission.status === "completed" || mission.status === "failed" || mission.status === "cancelled") {
    // 已結束：去掉活動流事件，並把中間步驟的原始輸出截成預覽（最終報告保留完整）。
    // 兩者都是隨 mission 數量無上限累積、會撐爆手機初始 snapshot 的元兇。
    return { ...mission, executionEvents: [], steps: previewTerminalMissionSteps(mission.steps ?? []) };
  }
  return {
    ...mission,
    executionEvents: (mission.executionEvents ?? []).map((entry) => ({ ...entry, event: trimEventForSnapshot(entry.event) })),
  };
}

wss.on("connection", (socket, request) => {
  // A client that drops mid-handshake (page reload, laptop sleep/wake, a
  // network blip) emits 'error' with no listener otherwise — that's an
  // uncaughtException that used to take the entire server, and every running
  // worker, down with it. A routine disconnect must stay routine.
  socket.on("error", (error) => {
    console.error("[wss] client socket error:", error);
  });
  // 遠端存取轉接站(_tsproxy)在升級請求注入 x-pc-access：分享訪客(shr)標為 guest。
  // 8787 只綁 127.0.0.1，公網流量必經轉接站，而轉接站會刪掉用戶端自帶的同名 header
  // 再蓋上驗證後的值，所以這個判定不可被偽造；本機直連(owner 在主機上)沒有此 header
  // ＝非訪客＝完整權限。
  const shareGuest = String(request.headers["x-pc-access"] ?? "") === "shr";
  // The black-window mode opens a second websocket for an explicit, raw shell.
  // Keep it separate from worker events so CLI output can never be mistaken for
  // an Agent event or become part of an NPC conversation. Share guests get the
  // live event stream but never the shell control channel.
  attachTerminalSocket(socket, normalizeManagedTerminalWorkspacePath, { shareGuest });
  for (const task of store.listBossTasksByStatus(["ready", "running"])) {
    // One malformed persisted boss task must not crash-loop the server on
    // every reconnect (crash → supervisor restart → client reconnects →
    // same bad task → crash again).
    try {
      advanceBossTask(task);
    } catch (error) {
      console.error(`[wss] advanceBossTask failed for task ${task.id}:`, error);
      quarantineAdvanceFailure(task, error);
    }
  }
  // 組 snapshot 前先把「idle 卻還掛著開著 turn」的 worker 權威收尾（見 reconcileDanglingTurn）：
  // 連上來的裝置會拿到一致狀態，已在線的裝置也會收到廣播同步——修掉「電腦還在跑但手機顯示已中止」。
  for (const worker of workers.values()) reconcileDanglingTurn(worker);
  // snapshot 取自 worker.history（已含緩衝中的 delta）；先把緩衝送出，否則這個新連線稍後
  // 會再收到同一段 delta、文字重複。flush 送到新 socket 的事件會被隨後的 snapshot 整個蓋掉。
  deltaCoalescer.flush();
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
      missions: store.listDepartmentMissions().map(missionForSnapshot),
      bossTasks: store.listBossTasks().map(bossTaskForDisplay),
      departments: store.listDepartments(),
      workers: [...workers.values()].map((w) => ({
        ...workerSummary(w),
        events: coalesceDeltaEvents(snapshotHistory(w.history)),
        queue: store.listQueue(w.id),
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

// The black-window tree belongs to the mux daemon, not to one browser tab.
// This also makes a normal web-server restart harmless to the engineer's
// page/pane topology.
app.get("/api/terminal-mux/layout", async (_req, res) => {
  // Unlike ordinary GETs, this route can start the daemon. Once restore has
  // released mux ownership, no request may recreate it before the DB swap.
  if (maintenanceMode) { res.status(503).json({ error: t("還原正在進行中") }); return; }
  try {
    const result = await terminalMuxRequest({ type: "layout_get" });
    res.json({ layout: typeof result.layout === "string" ? result.layout : null, version: typeof result.version === "number" ? result.version : 0 });
  } catch (error) { res.status(503).json({ error: error instanceof Error ? error.message : "Terminal mux unavailable" }); }
});

app.put("/api/terminal-mux/layout", async (req, res) => {
  try {
    const result = await terminalMuxRequest({ type: "layout_save", layout: req.body?.layout, expectedVersion: req.body?.expectedVersion });
    if (result.type === "error") { res.status(400).json({ error: result.message }); return; }
    if (result.type === "layout_conflict") { res.status(409).json({ layout: result.layout, version: result.version }); return; }
    const layout = JSON.stringify(req.body?.layout);
    const version = typeof result.version === "number" ? result.version : 0;
    broadcast({ type: "terminal_mux_layout", layout, version });
    res.json({ ok: true, version });
  } catch (error) { res.status(503).json({ error: error instanceof Error ? error.message : "Terminal mux unavailable" }); }
});

app.delete("/api/terminal-mux/tabs/:tabId", async (req, res) => {
  if (!/^terminal-[a-zA-Z0-9-]{8,120}$/.test(req.params.tabId)) { res.status(400).json({ error: "Invalid terminal tab" }); return; }
  try {
    const result = await terminalMuxRequest({ type: "destroy", tabId: req.params.tabId });
    if (result.type === "error") { res.status(400).json({ error: result.message }); return; }
    res.json({ ok: true });
  } catch (error) { res.status(503).json({ error: error instanceof Error ? error.message : "Terminal mux unavailable" }); }
});

// Black Window is a raw PTY, so an image on the clipboard cannot reach the
// CLI through xterm.js (it only pastes text). The pane posts the image here,
// gets back the exact text to type, and both CLIs turn that path into an
// attachment. See server/src/terminalPaste.ts for the verified constraints.
app.post("/api/terminal/paste-image", (req, res) => {
  let images: ReturnType<typeof parseMessageImages>;
  try {
    images = parseMessageImages(req.body?.images);
  } catch (error) {
    if (error instanceof MessageImageValidationError) { res.status(400).json({ error: error.message }); return; }
    throw error;
  }
  if (images.length === 0) { res.status(400).json({ error: t("沒有可貼上的圖片") }); return; }
  try {
    const tokens = stageTerminalPasteImages(images).map((path) => terminalPathToken(path));
    res.json({ tokens });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : t("無法暫存貼上的圖片") });
  }
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
let selfUpdatePending = false;

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
  // 告訴原生控制器「這是計畫中的重啟，不是崩潰」——它看到這個 marker 就會安靜地重啟，不跳
  // 「內附服務意外結束（exit code 0）」的假警報（比照 update.pending 的自我更新機制）。
  try { writeFileSync(join(config.dataDirectory, "logs", "restart.pending"), new Date().toISOString()); }
  catch { /* 寫不進去也無妨，頂多還是跳那個舊警報 */ }
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

async function launchWindowsSelfUpdate(version: string): Promise<void> {
  const root = bundledWindowsRoot(process.platform, process.execPath, existsSync);
  if (!root) throw new Error(t("此安裝方式不支援一鍵更新，請下載最新版 Pixel Crew.exe"));
  const helperSource = join(root, "scripts", "windows", "self-update.ps1");
  const helperDir = mkdtempSync(join(tmpdir(), "pixel-crew-update-launch-"));
  const helper = join(helperDir, "self-update.ps1");
  try {
    copyFileSync(helperSource, helper);
  } catch (error) {
    rmSync(helperDir, { recursive: true, force: true });
    throw error;
  }
  await new Promise<void>((resolve, reject) => {
    let started = false;
    try {
      const updater = spawn("powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper,
        "-InstallRoot", root, "-Version", version, "-ServerPid", String(process.pid),
      ], { detached: true, stdio: "ignore", windowsHide: true });
      updater.once("spawn", () => {
        started = true;
        updater.unref();
        resolve();
      });
      updater.once("error", (error) => {
        if (!started) {
          rmSync(helperDir, { recursive: true, force: true });
          reject(error);
        } else console.error("[self-update] updater failed after launch:", error);
      });
    } catch (error) {
      rmSync(helperDir, { recursive: true, force: true });
      reject(error);
    }
  });
}

function performServerRestart(): void {
  // 有原生控制器監督時（Windows Pixel Crew.exe / macOS menu bar 都會設這個旗標）：直接優雅退出，
  // 由監督者偵測結束後重生。這樣就不必 spawn 外部 restart helper——Windows 那個 helper 會用
  // taskkill 殺掉 8787 樹，反而把控制器剛重啟的 server 也殺掉，製造第二次「意外結束」假警報。
  if (process.env.PIXEL_CREW_SUPERVISED === "1") {
    console.log("[restart] 所有 NPC 空檔，交由原生控制器重啟…");
    finishServerRestart();
    return;
  }
  if (process.platform !== "win32") {
    console.log("[restart] 所有 NPC 空檔，重啟中…");
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

app.post("/api/update/apply", async (_req, res) => {
  if (selfUpdatePending) {
    res.status(409).json({ error: t("新版已在下載及安裝中") });
    return;
  }
  const info = updateChecker.getInfo();
  const version = info.updateAvailable ? releaseVersion(info.latestVersion) : null;
  if (!version) {
    res.status(409).json({ error: t("目前沒有可安裝的新版") });
    return;
  }
  if (!info.oneClickAvailable) {
    res.status(409).json({ error: t("此安裝方式不支援一鍵更新，請下載最新版 Pixel Crew.exe") });
    return;
  }
  if ([...workers.values()].some((worker) => workerSummary(worker).busy)) {
    res.status(409).json({ error: t("請先等所有 NPC 工作完成，再開始更新") });
    return;
  }
  try {
    await launchWindowsSelfUpdate(version);
    selfUpdatePending = true;
    console.log(`[self-update] v${version} download and verified replacement scheduled`);
    res.json({ ok: true, version });
    const timer = setTimeout(() => exitAfterShutdown("self update", 0), 800);
    timer.unref();
  } catch (error) {
    console.error("[self-update] unable to launch updater:", error);
    res.status(503).json({ error: t("無法啟動更新工具：{message}", { message: (error as Error).message }) });
  }
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

// 拉起轉接站的共用邏輯：手動按鈕（下方路由）與「開機自動啟動遠端」（server.listen 後）共用。
async function startTsproxyRelay(): Promise<{ ok: boolean; running: boolean; already?: boolean; status?: number; error?: string }> {
  if (await tsproxyRunning()) return { ok: true, running: true, already: true };
  try {
    writeTsproxyStartupLog("Starting relay");
    if (process.platform === "win32") {
      // Windows：用隱藏視窗的 vbs 拉起（不彈黑窗）。
      const vbs = join(REPO_ROOT, "_tsproxy_launch.vbs");
      if (!existsSync(vbs)) return { ok: false, running: false, status: 404, error: t("找不到 _tsproxy_launch.vbs") };
      spawn("wscript.exe", [vbs], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } else {
      // macOS / Linux：直接用當前 node 執行檔跑 _tsproxy.mjs，detached 讓它獨立存活。
      const mjs = join(REPO_ROOT, "_tsproxy.mjs");
      if (!existsSync(mjs)) return { ok: false, running: false, status: 404, error: t("找不到 _tsproxy.mjs") };
      const child = spawn(process.execPath, [mjs], {
        detached: true, stdio: "ignore", cwd: REPO_ROOT,
        env: { ...process.env, PC_TSPROXY_LOG: TSPROXY_START_LOG },
      });
      child.once("error", (err) => writeTsproxyStartupLog(`Could not launch relay: ${err.message}`, true));
      child.unref();
    }
  } catch (err) {
    return { ok: false, running: false, status: 500, error: (err as Error).message };
  }
  // 等它綁定連接埠（最多 ~4 秒）
  let running = false;
  for (let i = 0; i < 10 && !running; i++) {
    await new Promise((r) => setTimeout(r, 400));
    running = await tsproxyRunning();
  }
  return {
    ok: running,
    running,
    error: running ? undefined : (tsproxyStartupDetail() || t("轉接站啟動失敗，請稍後再試")),
  };
}

app.post("/api/remote-access/start", async (_req, res) => {
  const outcome = await startTsproxyRelay();
  if (outcome.status && !outcome.ok) { res.status(outcome.status).json({ ok: false, error: outcome.error }); return; }
  res.json({ ok: outcome.ok, running: outcome.running, already: outcome.already, error: outcome.error });
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

// GET 版本：cloudflared 下載進度條每秒輪詢 cloudflared/progress。那支端點只讀轉接站的
// 記憶體狀態（不 spawn tailscale/schtasks），所以輪詢成本遠低於整包 /state。
app.get("/api/remote-access/api/*", async (req, res) => {
  const name = String((req.params as Record<string, string>)[0] || "").replace(/[^a-z/]/gi, "");
  if (!name) { res.status(400).json({ error: "bad api path" }); return; }
  if (!(await tsproxyRunning())) { res.status(503).json({ error: "轉接站未啟動" }); return; }
  const up = await proxyToTsproxy("GET", name, "");
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

// ── 專家顧問：把一個粗略念頭展開成「以你自身專業不一定知道」的幾個專業方向，讓你
//     只需挑一個，再直接餵進既有 Boss Task 執行到完成。無工具、一次性判斷（沿用
//     Boss Task 的 decision runtime 與 no_tools 政策）；解析失敗補一次 repair 重試。
app.post("/api/advisor/propose", async (req, res) => {
  const idea = collaborationText(req.body?.idea, 4_000).trim();
  // 主動模式：沒給念頭（或前端明確要求 proactive）就讓顧問從工作區脈絡主動端方向，不再擋。
  const proactive = Boolean(req.body?.proactive) || idea.length === 0;
  const preferredWorkspace = collaborationText(req.body?.workspacePath, 1_000) || null;
  const runtime = resolveDecisionRuntime(req.body?.provider, req.body?.model, preferredWorkspace);
  if ("error" in runtime) { res.status(503).json({ error: runtime.error }); return; }
  const maxProposals = Number.isFinite(req.body?.maxProposals) ? Number(req.body.maxProposals) : undefined;
  const workspace = preferredWorkspace || config.targetRepoPath;
  const usage = await usageRegistry.refresh(runtime.provider, true);
  const usageError = usageBlockReason(runtime.provider, usage, runtime.model);
  if (usageError) {
    res.status(409).json({ error: t("{provider} 目前無法進行顧問判斷：{error}", { provider: providerLabel(runtime.provider), error: usageError }), usage });
    return;
  }
  // 主動模式每次隨機挑一個探索視角，逼模型每回從不同角度切入，降低重複（使用者反映重複性高）。
  const varietyHint = proactive ? ADVISOR_VARIETY_LENSES[Math.floor(Math.random() * ADVISOR_VARIETY_LENSES.length)] : undefined;
  const prompt = expertAdvisorPrompt({ idea, workspacePath: workspace, maxProposals, proactive, varietyHint });
  let text: string;
  try {
    text = (await runDetachedTurn(runtime.provider, workspace, runtime.model, undefined, null, prompt, 150_000, { kind: "no_tools" })).text;
  } catch (error) {
    res.status(502).json({ error: t("顧問模型無法完成判斷：{error}", { error: (error as Error).message }) });
    return;
  }
  let result = parseAdvisorResult(text, maxProposals);
  if (!result) {
    const reason = explainAdvisorFailure(text, maxProposals) ?? "The response did not match the required format.";
    const repair = `${prompt}\n\nYour previous response was invalid: ${reason} Return one corrected <expert_advisor> block only.`;
    try {
      text = (await runDetachedTurn(runtime.provider, workspace, runtime.model, undefined, null, repair, 150_000, { kind: "no_tools" })).text;
      result = parseAdvisorResult(text, maxProposals);
    } catch { result = null; }
  }
  if (!result) { res.status(502).json({ error: t("顧問模型未能給出有效的方向建議，請換個說法再試一次") }); return; }
  res.json({ result });
});

// ── 全域功能開關與本機診斷 ────────────────────────────────────────────────────
registerOperationalSettingsRoutes({ app, appSettings, store, localDay, setLang });

// 每 30 秒掃一次：到點、今天沒跑過、NPC 空檔 → 送出排程指示。
// NPC 在忙就先不標記，30 秒後再試（同一天內補跑）。
setInterval(() => {
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const nowMs = now.getTime();
  const today = localDay(now);
  for (const schedule of store.listSchedules()) {
    if (!schedule.enabled) continue;
    // interval_minutes 有值＝每 N 分鐘重複（用 last_run_at 判斷是否到點）；否則＝每日 HH:MM 一次。
    const recurring = typeof schedule.intervalMinutes === "number" && schedule.intervalMinutes > 0;
    if (recurring) {
      const lastMs = schedule.lastRunAt ? Date.parse(schedule.lastRunAt) : NaN;
      if (Number.isFinite(lastMs) && nowMs < lastMs + schedule.intervalMinutes! * 60_000) continue;
    } else if (schedule.lastRunDay === today || schedule.time > hhmm) {
      continue;
    }
    const worker = workers.get(schedule.workerId);
    if (!worker) continue;
    if (!workerProviderReady(worker)) continue;
    const scheduleLabel = recurring
      ? t("每 {minutes} 分鐘", { minutes: schedule.intervalMinutes ?? 0 })
      : t("每日 {time}", { time: schedule.time });
    // 無人看管風險口（作戰室裁決 P1）：⚡無限制模式跳過所有審批，不給自動排程觸發。
    // 標記為今天已處理＋留一則說明，避免每 30 秒重試洗版。
    if (worker.autoApproveMode === "invincible") {
      store.markScheduleRun(schedule.id, today, now.toISOString());
      record(worker, { type: "error", message: t("⏰ 排程（{label}）未執行：此 NPC 處於⚡無限制模式（跳過所有審批），無人看管時段不自動執行。審批改為「完全信任」或「安全」後會自動恢復。", { label: scheduleLabel }) });
      continue;
    }
    if (worker.runner.busy || handoffInProgress(worker) || collaborationInProgress(worker.id) || missionInProgress(worker.id)) continue;
    store.markScheduleRun(schedule.id, today, now.toISOString());
    record(worker, { type: "user_message", text: t("⏰ 排程任務（{label}）：{prompt}", { label: scheduleLabel, prompt: schedule.prompt }) });
    try {
      worker.runner.send(t("【排程任務，{label} 自動觸發】{prompt}", { label: scheduleLabel, prompt: schedule.prompt }), [], []);
      broadcast({ type: "worker_status", workerId: worker.id, busy: true });
    } catch { /* 送失敗就等明天；user_message 已留在紀錄裡可追查 */ }
  }
}, 30_000);

// 排隊佇列的安全掃描：正常情況下 turn_end/error 一發生就會 drain，但少數「worker 變回空閒
// 卻沒有 turn_end 來觸發」的路徑（例如 mission/協作結束的當下）會漏。每 15 秒補掃一次，
// 讓任何 idle 又有排隊的 NPC 一定會被 drain。drainWorkerQueue 自帶 idle/預算守衛，busy 的
// worker 只做一次極輕量的記憶體檢查就跳過；不可能無限循環（每次每 worker 最多送 1 則）。
setInterval(() => {
  for (const worker of workers.values()) {
    try { drainWorkerQueue(worker); } catch { /* 安全掃描 best-effort，不可影響主流程 */ }
  }
}, 15_000);

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
  if (persistentWorkerCount() >= MAX_WORKERS) {
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
  const raw = req.body?.accountId;
  const accountId = raw === null || raw === undefined || raw === "" ? null : String(raw);
  if (accountId) {
    const account = store.getAccount(accountId);
    if (!account || account.provider !== worker.runner.provider) {
      res.status(400).json({ error: t("找不到指定的帳號") });
      return;
    }
  }
  // Switching accounts only takes effect on the session's next restart, at
  // which point it can't resume the old thread under the new account's home
  // directory (thread/conversation history is scoped per CODEX_HOME /
  // CLAUDE_CONFIG_DIR) and silently starts a blank one. We still refuse to do
  // that silently — but when the owner passes force:true they've already
  // confirmed the reset in the UI, so we fold the clear INTO the switch (one
  // click) instead of making them clear the session as a separate step first.
  if (worker.runner.getPersistenceState().completedTurns > 0) {
    if (req.body?.force !== true) {
      res.status(409).json({ error: t("這位 NPC 已有對話紀錄，請先清除工作階段再切換帳號") });
      return;
    }
    const cleared = cleanWorkerAndAnnounce(worker);
    if (!cleared.ok) { res.status(409).json({ error: cleared.error }); return; }
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
  if (!worker) { res.status(400).json({ error: t("無效請求") }); return; }
  // 守門判定（檔名穿越／symlink／非檔／過大）抽到 resolveOutboxFile，見 outboxFile.ts 與其回歸測試。
  const resolved = resolveOutboxFile(worker.runner.workspacePath, name);
  if (!resolved.ok) {
    const error = resolved.status === 400 ? t("無效請求")
      : resolved.status === 413 ? t("檔案過大，請直接到工作區 outbox 資料夾開啟")
      : t("檔案不存在");
    res.status(resolved.status).json({ error }); return;
  }
  const full = resolved.fullPath;
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
  // Export also ensures/contacts the mux daemon. Do not let a concurrent
  // export recreate that owner after restore has deliberately shut it down.
  if (maintenanceMode) { res.status(503).json({ error: t("還原正在進行中") }); return; }
  // A raw copy of the live mux db (+WAL/SHM) could straddle a write the
  // still-running daemon makes between checkpoint and copy. Ask the daemon
  // for an atomic VACUUM INTO snapshot instead, and export that file.
  const muxSnapshotPath = join(config.dataDirectory, `.mux-export-${randomUUID()}.sqlite`);
  let tookSnapshot = false;
  try {
    tookSnapshot = await snapshotTerminalMuxDatabase(muxSnapshotPath);
    await writeBackupExport({
      response: res, dataDirectory: config.dataDirectory, dbPath: config.dbPath, avatarDir: config.avatarDir,
      muxDbPath: tookSnapshot ? muxSnapshotPath : undefined, id: randomUUID(), password, flush: () => store.flush(), checkpoint: () => store.checkpoint(),
    });
  } finally {
    rmSync(muxSnapshotPath, { force: true });
  }
}

app.get("/api/backup/export", async (_req, res) => { await exportBackup(res); });
app.post("/api/backup/export", async (req, res) => {
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!password) { res.status(400).json({ error: t("請輸入備份密碼") }); return; }
  try { await exportBackup(res, password); }
  catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

const voiceModelManager = new VoiceModelManager(config.voiceModelsDir);
const voiceEngineInstaller = new VoiceEngineInstaller(config.voiceEnginesDir, (path) => voiceEngineServer.setExecutable(path));
const voiceEngineServer = new VoiceEngineServer(
  resolveWhisperBinary([...new Set([config.whisperServerBin, "whisper-server"])]) ?? voiceEngineInstaller.installedBinary,
  config.voiceServerPort,
  () => voiceModelManager.modelPath,
);
const voiceTranscriber = new VoiceTranscriber(voiceEngineServer);
registerVoiceRoutes({ app, modelManager: voiceModelManager, transcriber: voiceTranscriber, engineInstaller: voiceEngineInstaller });

// ── 影片理解：上傳影片 → ffmpeg 抽關鍵影格＋音訊 → whisper 轉文字 → 回傳「影格(當圖片)＋
//     文字稿」，前端把它們塞進訊息一起送給 Claude（Claude 不吃影片，但吃圖片＋文字）。
//     影片音訊可能很長，所以另建一個逾時放寬到 5 分鐘的 transcriber（語音輸入那顆維持 15 秒）。
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const videoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_VIDEO_BYTES } });
const videoAudioTranscriber = new VoiceTranscriber(voiceEngineServer, fetch, 300_000);
// 影片 buffer → 抽影格＋whisper → 回應 JSON。上傳檔與貼連結兩條入口共用同一段管線。
async function respondWithVideoAnalysis(res: Response, video: Buffer): Promise<void> {
  let extracted;
  try {
    extracted = await extractVideoFramesAndAudio(video, { ffmpegBin: config.ffmpegBin, ffprobeBin: config.ffprobeBin, maxFrames: 8 });
  } catch (error) {
    const detail = error instanceof VideoProcessingError ? error.message : t("影片處理失敗");
    res.status(422).json({ error: detail });
    return;
  }
  // 音訊轉文字（whisper）：引擎沒裝或轉寫失敗都不致命——至少影格還在。
  let transcript = "";
  let transcriptError: string | null = null;
  if (extracted.audioWav && videoAudioTranscriber.engineAvailable) {
    try { transcript = await videoAudioTranscriber.transcribe(extracted.audioWav); }
    catch (error) { transcriptError = error instanceof Error ? error.message : t("語音轉寫失敗"); }
  } else if (extracted.audioWav) {
    transcriptError = t("找不到本機語音轉寫引擎（音訊未轉文字，僅送出畫面）");
  }
  res.json({
    images: extracted.frames.map((frame) => ({ name: frame.name, mimeType: "image/jpeg", dataBase64: frame.dataBase64 })),
    transcript,
    durationSeconds: extracted.durationSeconds,
    audioAvailable: Boolean(extracted.audioWav),
    transcriptError,
  });
}

app.post("/api/video/process", videoUpload.single("video"), async (req, res) => {
  if (!req.file || req.file.buffer.length === 0) { res.status(400).json({ error: t("請提供影片檔") }); return; }
  await respondWithVideoAnalysis(res, req.file.buffer);
});

// 貼連結看影片：yt-dlp 下載公開影片 → 走上面同一條抽影格＋轉字幕管線。
app.post("/api/video/from-link", express.json({ limit: "8kb" }), async (req, res) => {
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!url) { res.status(400).json({ error: t("請提供影片連結") }); return; }
  if (!isProbableVideoUrl(url)) { res.status(400).json({ error: t("請提供有效的 http(s) 影片連結") }); return; }
  let downloaded;
  try {
    downloaded = await downloadVideoFromUrl(url, { ytDlpBin: config.ytDlpBin, maxBytes: MAX_VIDEO_BYTES, timeoutMs: 240_000 });
  } catch (error) {
    const detail = error instanceof VideoDownloadError ? error.message : t("影片下載失敗");
    res.status(422).json({ error: detail });
    return;
  }
  await respondWithVideoAnalysis(res, downloaded.buffer);
});

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
    discardPending: discardPendingImport, dataDirectory: config.dataDirectory, dbPath: config.dbPath, avatarDir: config.avatarDir, muxDbPath: join(config.dataDirectory, "terminal-mux.sqlite"),
    // terminalMuxRequest starts the optional daemon when absent, so a failure
    // here means ownership was not safely released and restore must abort.
    stopTerminalMux: async () => { await terminalMuxRequest({ type: "shutdown" }); },
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
    directExecute?: boolean;
    noReview?: boolean;
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
    // 依老闆指示不做查證回合（execute→review→correct 的來回是慢的另一主因）：research 本就是 0，
    // project 也改成 0——只跑一次執行、不再自我 review/修正，換取速度。要恢復查證把 project 調回 2。
    maxCorrections: 0,
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
  // 單步直執行快速道：決策模型把這個 stage 標為 directExecute（單一動作、無需多步規劃與獨立查證，
  // 例如回答一個問題、寫一個小檔）時，跳過整輪規劃 LLM，本地合成一個 execute 步驟直接開跑。
  // 複用一般計畫解析後的同一條下游路徑（executing → dispatchMissionStep → completeMissionStep →
  // completed），只是不呼叫規劃模型、不追加 review／synthesize 步驟。狀態機是寬鬆的：單一 execute
  // 步驟不會進 reviewing，最後一步完成即 completed，review 契約因沒有 review 步驟而完全不觸發。
  if (options.directExecute) {
    mission.planSummary = t("單步直執行：{objective}", { objective: mission.objective });
    mission.steps = [{
      id: randomUUID(),
      title: t("直接執行並交付"),
      objective: mission.objective,
      kind: "execute",
      assigneeWorkerId: mission.bossWorkerId,
      acceptanceCriteria: mission.acceptanceCriteria,
      attachmentIds,
      status: "pending",
      attempt: 0,
      result: null,
      reviewResult: null,
      startedAt: null,
      completedAt: null,
      formatRepairCount: 0,
    }];
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
    dispatchMissionStep(mission, 0);
    return { mission };
  }
  // 走一般規劃路徑時，若交辦決策標了 noReview，記下 missionId，等計畫解析完在 finishMission 剝掉 review。
  if (options.noReview) noReviewMissions.add(mission.id);
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
  // Mission 的 workspace_path 存的是正規化（win32 小寫）路徑，但部門保留使用者原始大小寫。
  // 直接拿 department.workspacePath 做 exact-match 會在大小寫不同的工作區撈到 0 筆 → 任務日誌
  // 重整後整片空白。用 registryKey 正規化再查。
  return store.listDepartmentMissions(registryKey(department.workspacePath), 200)
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
  if (matchNativeCommand(text) === "clean" || (
    images.length === 0
    && documents.length === 0
    && isClearCommand(text)
  )) {
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
  // stall 標記的中央護欄：所有 boss task 變更都經本函式落地，任務推進或 error 被任何
  // 寫入點改寫時在這裡統一清掉結構化停滯標記——散落各處的 error 寫入點不必各自維護。
  task.stall = reconcileBossTaskStall(task);
  task.updatedAt = new Date().toISOString();
  store.saveBossTask(task);
  broadcastBossTask(task, created);
}

// 為一個交辦目標即時建立一支專屬部門（AI 規劃成員→建立→上線），讓決策模型在沒有
// 合適既有部門時能「自己開部門」再討論、執行。成功回傳部門，失敗回 null（呼叫端回退）。
// 專屬部門用「短命工」組成臨時團隊：像作戰室一樣繞過 20 人上限（createWorker 本身不擋，
// 上限只在端點擋），2–4 人、persist:false，只註冊在記憶體不寫 SQLite——所以重啟後短命工
// 被清、部門也不會變殭屍。任務一結束由 disbandEphemeralDepartment 整支解散。
const ephemeralDepartments = new Set<string>();

async function createDepartmentForObjective(input: {
  purpose: string;
  workspacePath: string;
  provider: ProviderId;
  count: number;
}): Promise<Department | null> {
  const { workspacePath, provider } = input;
  const purpose = normalizeDepartmentPurpose(input.purpose);
  if (!purpose) return null;
  if (workspaceMission(workspacePath)) return null; // 此工作區正在跑 mission，先不建
  if (!providerReady(provider)) return null;
  // 至少 2 人（Execute 與 Review 需不同 NPC），最多 4 人；不受滿編影響（短命工）。
  const count = Math.min(Math.max(2, Math.floor(input.count) || 3), 4);
  const existingMembers = [...workers.values()]
    .filter((member) => sameWorkspacePath(member.runner.workspacePath, workspacePath))
    .map((member) => ({ name: member.runner.name, role: member.persona?.role || null }));
  const prompt = departmentPlanPrompt({ purpose, count, workspacePath, existingMembers });
  let plan: DepartmentPlan | null;
  try {
    const result = await runDetachedTurn(provider, workspacePath, null, undefined, null, prompt, 90_000);
    plan = parseDepartmentPlan(result.text, count);
  } catch { return null; }
  const existingNames = new Set([...workers.values()].map((member) => member.runner.name.toLocaleLowerCase()));
  // 需要至少 2 人，否則部門 Mission 的 Execute/Review 無法交給不同 NPC。
  if (!plan || plan.members.length < 2 || plan.members.some((member) => existingNames.has(member.name.toLocaleLowerCase()))) return null;
  const departmentId = randomUUID();
  const now = new Date().toISOString();
  const created = plan.members.map((member) => createWorker(
    member.name,
    undefined,
    provider,
    workspacePath,
    undefined,
    normalizePersona({ role: member.role, instructions: member.instructions }),
    departmentId,
    { warmup: false, persist: false, broadcast: false, ephemeralKind: "dedicated" },
  ));
  // 老闆交辦的專屬部門 NPC 預設「完全自動核准（full）」：這些是為單一交辦臨時建、任務一結束就
  // 解散的短命工，讓它們能自己把交辦一路做完，不必每顆指令都停下來等老闆點核准（否則像 `which
  // python` 這種安全指令也會卡住整張交辦）。full 仍會擋下 rm -rf 這類毀滅性指令當最後安全網。
  for (const worker of created) worker.autoApproveMode = "full";
  const department: Department = {
    id: departmentId,
    name: `${EPHEMERAL_DEPT_PREFIX}${purpose.slice(0, 14)}`,
    purpose,
    workspacePath,
    leadWorkerId: created[0].id,
    memberWorkerIds: created.map((worker) => worker.id),
    createdAt: now,
    updatedAt: now,
  };
  // 必須持久化：部門 Mission 的 boss_worker_id 外鍵指向 workers 表，lead 要在表裡 mission 才存得下。
  // 用名稱前綴標記為臨時；任務結束由 disbandEphemeralDepartment 解散，重啟殘留由啟動掃描清掉。
  if (!store.saveDepartmentWithWorkers(department, created.map(workerPersistenceRecord))) {
    for (const worker of created) { try { worker.runner.stop(); } catch { /* noop */ } workers.delete(worker.id); }
    return null;
  }
  departments.set(department.id, department);
  ephemeralDepartments.add(department.id);
  broadcast({ type: "department_created", department });
  for (const worker of created) broadcast({ type: "worker_added", worker: workerSummary(worker) });
  if (provider === "claude") void claudeCapabilitiesFor(workspacePath).refresh();
  else void codexCapabilitiesFor(workspacePath).refresh();
  return department;
}

// 解散一支臨時部門：停掉並移除全部短命成員，再移除部門本身。冪等（重複呼叫安全）。
function disbandEphemeralDepartment(departmentId: string): void {
  if (!ephemeralDepartments.has(departmentId)) return;
  ephemeralDepartments.delete(departmentId);
  const memberIds = [...workers.values()].filter((worker) => worker.departmentId === departmentId).map((worker) => worker.id);
  for (const workerId of memberIds) {
    const worker = workers.get(workerId);
    if (!worker) continue;
    try { worker.runner.stop(); } catch { /* already stopped */ }
    workers.delete(workerId);
    deleteEphemeralWorkerRow(workerId);
    deleteExtras(workerId);
    clearWorkerHookState(workerId);
    broadcast({ type: "worker_removed", workerId });
  }
  if (departments.has(departmentId)) {
    departments.delete(departmentId);
    store.deleteDepartment(departmentId);
    broadcast({ type: "department_removed", departmentId });
  }
}

// 解散一個交辦底下所有臨時部門。idempotent。
function disbandTaskEphemeralDepartments(task: BossTask): void {
  for (const stage of task.stages) {
    if (ephemeralDepartments.has(stage.departmentId)) disbandEphemeralDepartment(stage.departmentId);
  }
}

// 由 advanceBossTask 統一呼叫：只有「取消」才立即解散臨時團隊。
// 完成/失敗「不」解散——使用者可能要追問或重試（追問會重用同一支部門）；那些留給
// 封存/刪除、閒置清掃、或巡迴推進下一步時才解散。
function ephemeralCleanupHook(task: BossTask): void {
  if (task.status === "cancelled") disbandTaskEphemeralDepartments(task);
}

// 探索 in-flight 追蹤：/restart 只該擋「本程序真的有背景探索在跑」的 discovering，
// 重啟殭屍（狀態卡著但沒有工作在跑）要放行手動重開（卡點盤點 P0）。synthesizing 的
// in-flight 既有 bossTaskFinalizing 可判，這裡只補探索側。
const bossTaskDiscoveryWork = new BossTaskWorkCounter();

// 專屬部門建立失敗的三個入口各自的錯誤文案。純粹是給人看的共用文案——入口識別已改用
// task.stall.kind 結構化標記（引擎認領與開機重建都認它，不 parse 文案），這裡改寫措辭
// 或換語系都不影響自動重試（2026-09-30 結構化改造，拔掉文案認領的漂移病根）。
const deptCreateFailureError = {
  dedicated: () => t("無法自動建立專屬臨時部門（可能此工作區正在執行其他 Mission，或團隊規劃失敗）；可稍後再試，或關掉「專屬部門」改用既有部門路由。"),
  follow_up: () => t("無法為追問重建專屬部門（可能此工作區正在執行其他 Mission）；可稍後再試。"),
  decide: () => t("無法自動建立專屬部門（可能此工作區正在執行、人數已滿或規劃失敗），請手動建立部門後再交辦。"),
} as const;

// 「為此交辦開專屬部門」的直接路徑：完全跳過決策模型路由——直接為目標規劃並建立一支
// 專屬新部門，掛一個單一 stage，直接開跑（討論[目前無]＋規劃＋執行）。不呼叫決策模型、
// 不重跑、不會卡到既有部門。省下整條管線最大的那顆 prompt（決策模型讀全部門目錄）。
async function runDedicatedDepartmentTask(task: BossTask): Promise<void> {
  bossTaskDiscoveryWork.enter(task.id);
  try {
    return await runDedicatedDepartmentTaskInner(task);
  } finally {
    bossTaskDiscoveryWork.exit(task.id);
  }
}

async function runDedicatedDepartmentTaskInner(task: BossTask): Promise<void> {
  const usage = await usageRegistry.refresh(task.decisionProvider, true);
  const usageError = usageBlockReason(task.decisionProvider, usage, task.decisionModel);
  if (usageError) {
    const blockedError = t("{provider} 無法進行任務判斷：{error}", { provider: providerLabel(task.decisionProvider), error: usageError });
    task.status = "needs_attention";
    task.error = blockedError;
    task.stall = { kind: usageStallKind("dedicated"), error: blockedError };
    task.messages.push(bossTaskMessage("system", blockedError));
    // 登記恢復探測：用量視窗重置後自動接手重跑本路徑，不用等人回覆（卡點盤點 P1-5）。
    bossUsageRetry.note(task.id, "dedicated", Date.now());
    persistBossTask(task);
    return;
  }
  task.messages.push(bossTaskMessage("system", t("正在為這個交辦建立一支專屬部門並直接開工…")));
  persistBossTask(task);
  const department = await createDepartmentForObjective({
    purpose: task.objective,
    workspacePath: task.workspacePath,
    provider: task.decisionProvider,
    count: task.executionBudget?.maxAgents ?? 3,
  });
  // 建部門要跑最長 90s 的規劃 LLM：期間老闆可能已取消／刪除這張交辦，手上是舊快照
  // （decide 路徑既有同款護欄；自動重試讓這條競態更容易踩到——交互自審補上）。
  // 套用結果前重讀權威狀態，已終結就放手，剛建好的臨時部門一併解散不留孤兒。
  const liveAfterCreate = store.getBossTask(task.id);
  if (!liveAfterCreate || liveAfterCreate.status === "cancelled" || liveAfterCreate.status === "failed") {
    if (department) disbandEphemeralDepartment(department.id);
    return;
  }
  if (!department) {
    const failure = deptCreateFailureError.dedicated();
    task.status = "needs_attention";
    task.error = failure;
    task.stall = { kind: deptCreateStallKind("dedicated"), error: failure };
    task.messages.push(bossTaskMessage("system", failure));
    // 登記自動重試：工作區空出（阻塞 Mission 結束）後由掃描重走本路徑，不用等人回覆（P1-3）。
    bossDeptCreateRetry.note(task.id, "dedicated", null, Date.now());
    persistBossTask(task);
    return;
  }
  task.executionMode = "project";
  task.stages = [{
    id: randomUUID(),
    departmentId: department.id,
    departmentName: department.name,
    title: t("執行交辦"),
    objective: task.objective,
    acceptanceCriteria: task.acceptanceCriteria,
    dependsOn: [],
    executionMode: "project",
    status: "pending",
    missionId: null,
    report: null,
  }];
  task.status = "ready";
  task.error = null;
  task.messages.push(bossTaskMessage("system", t("已建立「{name}」，直接交給它規劃與執行。", { name: department.name })));
  persistBossTask(task);
  advanceBossTask(task);
}

// 追問「專屬部門」跑完的交辦：不再丟回決策模型亂路由——原隊還活著就直接交回同一隊；
// 被重啟掃掉就自動重建一支專屬部門接手。追問的目標帶上原交辦當背景，成果可延續。
async function runDedicatedFollowUp(task: BossTask, followUp: string, liveDepartmentId: string | null): Promise<void> {
  // 追問期間 task 也掛在 discovering（可能要重建部門、跑規劃 LLM）——一樣要進 in-flight
  // 計數，否則 /restart 的殭屍判定會把「正在跑的追問」誤當殭屍放行，造成並發互踩（自審發現）。
  bossTaskDiscoveryWork.enter(task.id);
  try {
    return await runDedicatedFollowUpInner(task, followUp, liveDepartmentId);
  } finally {
    bossTaskDiscoveryWork.exit(task.id);
  }
}

async function runDedicatedFollowUpInner(task: BossTask, followUp: string, liveDepartmentId: string | null): Promise<void> {
  let department = liveDepartmentId ? departments.get(liveDepartmentId) ?? null : null;
  if (!department) {
    task.messages.push(bossTaskMessage("system", t("原專屬部門已解散（伺服器重啟或已清理），正在重建一支專屬部門接手追問…")));
    persistBossTask(task);
    department = await createDepartmentForObjective({
      purpose: task.objective,
      workspacePath: task.workspacePath,
      provider: task.decisionProvider,
      count: task.executionBudget?.maxAgents ?? 3,
    });
    // 與 dedicated 路徑同款取消護欄：重建部門的長流程期間交辦被終結就放手（交互自審補上）。
    const liveAfterCreate = store.getBossTask(task.id);
    if (!liveAfterCreate || liveAfterCreate.status === "cancelled" || liveAfterCreate.status === "failed") {
      if (department) disbandEphemeralDepartment(department.id);
      return;
    }
    if (!department) {
      const failure = deptCreateFailureError.follow_up();
      task.status = "needs_attention";
      task.error = failure;
      task.stall = { kind: deptCreateStallKind("follow_up"), error: failure };
      task.messages.push(bossTaskMessage("system", failure));
      // 帶上追問文字登記，重試時走回同一條追問路徑（P1-3）。
      bossDeptCreateRetry.note(task.id, "follow_up", followUp, Date.now());
      persistBossTask(task);
      return;
    }
  }
  task.executionMode = "project";
  task.stages = [{
    id: randomUUID(),
    departmentId: department.id,
    departmentName: department.name,
    title: t("追問處理"),
    objective: t("這是對已完成交辦的後續追問，請延續先前成果處理，不要從頭重做。\n【原交辦】{objective}\n【追問】{followUp}", { objective: task.objective.slice(0, 600), followUp }),
    acceptanceCriteria: [],
    dependsOn: [],
    executionMode: "project",
    status: "pending",
    missionId: null,
    report: null,
  }];
  task.status = "ready";
  task.error = null;
  task.messages.push(bossTaskMessage("system", t("追問已交回「{name}」處理。", { name: department.name })));
  persistBossTask(task);
  advanceBossTask(task);
}

async function decideBossTask(task: BossTask, allowCreateDepartment = true): Promise<void> {
  bossTaskDiscoveryWork.enter(task.id);
  try {
    return await decideBossTaskInner(task, allowCreateDepartment);
  } finally {
    bossTaskDiscoveryWork.exit(task.id);
  }
}

async function decideBossTaskInner(task: BossTask, allowCreateDepartment = true): Promise<void> {
  const candidates = bossTaskCandidates();
  if (candidates.length === 0 && !allowCreateDepartment) {
    task.status = "needs_attention";
    task.error = t("目前沒有可用的部門；請先建立具有職務的部門");
    task.messages.push(bossTaskMessage("system", task.error));
    persistBossTask(task);
    return;
  }
  const usage = await usageRegistry.refresh(task.decisionProvider, true);
  const usageError = usageBlockReason(task.decisionProvider, usage, task.decisionModel);
  if (usageError) {
    const blockedError = t("{provider} 無法進行任務判斷：{error}", { provider: providerLabel(task.decisionProvider), error: usageError });
    task.status = "needs_attention";
    task.error = blockedError;
    task.stall = { kind: usageStallKind("decide"), error: blockedError };
    task.messages.push(bossTaskMessage("system", blockedError));
    // 登記恢復探測：用量視窗重置後自動接手重跑 decide，不用等人回覆（卡點盤點 P1-5）。
    bossUsageRetry.note(task.id, "decide", Date.now());
    persistBossTask(task);
    return;
  }
  const clarificationBudget = bossTaskClarificationBudget(task);
  const prompt = bossTaskDecisionPrompt({ task, candidates });
  const workspace = candidates.find((candidate) => sameWorkspacePath(candidate.workspacePath, task.workspacePath))?.workspacePath
    ?? candidates[0]?.workspacePath ?? task.workspacePath;
  let output = "";
  try {
    output = (await runDetachedTurn(task.decisionProvider, workspace, task.decisionModel, undefined, null, prompt, 150_000, { kind: "no_tools" })).text;
    let decision = parseBossTaskDecision(output, candidates, task.executionBudget ?? normalizeExecutionProfile(task.executionProfile));
    const clarificationPastBudget = decision?.status === "clarification" && clarificationBudget.remaining === 0;
    if (!decision || clarificationPastBudget) {
      const reason = clarificationPastBudget
        ? "You asked another clarification question, but the clarification budget is exhausted."
        : explainBossTaskDecisionFailure(output, candidates, task.executionBudget ?? normalizeExecutionProfile(task.executionProfile)) ?? "The response did not match the required format.";
      const repair = `${prompt}\n\nYour previous response was invalid: ${reason}${clarificationPastBudget ? " You must produce a ready execution graph from the existing answers." : ""} Return one corrected <boss_task_decision> block only.`;
      output = (await runDetachedTurn(task.decisionProvider, workspace, task.decisionModel, undefined, null, repair, 150_000, { kind: "no_tools" })).text;
      decision = parseBossTaskDecision(output, candidates, task.executionBudget ?? normalizeExecutionProfile(task.executionProfile));
    }
    if (!decision || (decision.status === "clarification" && clarificationBudget.remaining === 0)) {
      throw new Error(t("決策模型無法依現有資訊建立有效的跨部門計畫"));
    }
    // 探索是背景長流程（LLM 最長 150s×2）：期間老闆可能已取消或刪除這張交辦，而手上是舊快照。
    // 套用決策前重讀權威狀態，已終結就直接放手——否則已取消的交辦會被蓋回 ready 並真的派工復活。
    const current = store.getBossTask(task.id);
    if (!current || current.status === "cancelled" || current.status === "failed") return;
    task.error = null;
    if (decision.status === "clarification") {
      task.status = "needs_input";
      task.messages.push(bossTaskMessage("decision_model", decision.question));
      persistBossTask(task);
      // 自動接手開著時，讓幕僚長代答 clarification（能用安全假設回答就回答，
      // 需要老闆本人的東西才停下等人）。
      autopilotHook(task);
      return;
    }
    if (decision.status === "create_department") {
      // 沒有合適的既有部門：自己開一支專屬部門，再重跑一次決策把工作交給它（只建一次，防迴圈）。
      if (!allowCreateDepartment) {
        throw new Error(t("決策模型無法依現有資訊建立有效的跨部門計畫"));
      }
      task.messages.push(bossTaskMessage("system", t("沒有合適的既有部門，正在為這個交辦建立專屬部門：{purpose}…", { purpose: decision.departmentPurpose })));
      persistBossTask(task);
      const department = await createDepartmentForObjective({
        purpose: decision.departmentPurpose,
        workspacePath: task.workspacePath,
        provider: task.decisionProvider,
        count: decision.memberCount,
      });
      if (!department) {
        const failure = deptCreateFailureError.decide();
        task.status = "needs_attention";
        task.error = failure;
        task.stall = { kind: deptCreateStallKind("decide"), error: failure };
        task.messages.push(bossTaskMessage("system", failure));
        // 登記自動重試：重走整條 decide（部門版圖可能已變，讓決策模型重新路由）（P1-3）。
        bossDeptCreateRetry.note(task.id, "decide", null, Date.now());
        persistBossTask(task);
        return;
      }
      task.messages.push(bossTaskMessage("system", t("已建立「{name}」，交給它繼續規劃與執行。", { name: department.name })));
      persistBossTask(task);
      await decideBossTask(task, false);
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
  advanceBossTaskStages(task);
  autopilotHook(task);
  ephemeralCleanupHook(task);
}

// 開機自癒／wss 重連的 advanceBossTask 防 crash-loop catch 原本只 console.error（全庫盤點
// #19）：交辦停在 ready/running 外觀像執行中、實際永遠沒人推進，也沒有任何訊息。改誠實
// 轉 needs_attention——一轉就離開 ready/running 掃描名單，不會再被反覆嘗試；若其實是
// 誤傷（mission 還活著），mission 事件的 advanceBossTasksForMission 也掃 needs_attention，
// 會自動撥回 running。訊息與上一則相同就不重複 push（重連迴圈／來回翻轉不轟炸）。
function quarantineAdvanceFailure(task: BossTask, error: unknown): void {
  try {
    const detail = (error as Error).message || t("推進交辦時發生未預期錯誤");
    task.status = "needs_attention";
    task.error = detail;
    const warning = collaborationText(t("⚠️ 自動推進這張交辦時發生錯誤：{error}；回覆這張交辦或按「重新交辦」再試。", { error: detail }), 40_000);
    const last = task.messages[task.messages.length - 1];
    if (!(last && last.role === "system" && last.text === warning)) {
      task.messages.push(bossTaskMessage("system", warning));
    }
    persistBossTask(task);
  } catch (persistError) {
    // 降級寫入自己失敗（壞資料連 persist 都過不了）：回到原行為只留 log，絕不讓收斂邏輯反過來弄掛開機／重連。
    console.error(`[boss-task] 推進失敗降級寫入也失敗 ${task.id}:`, persistError);
  }
}

function advanceBossTaskStages(task: BossTask): void {
  for (const stage of task.stages) {
    if (!stage.missionId || stage.status === "completed" || stage.status === "failed" || stage.status === "cancelled") continue;
    const mission = store.getDepartmentMission(stage.missionId);
    if (!mission) {
      // Mission 紀錄不見了（多半是伺服器重啟時進行中的臨時部門 mission 沒保存下來）：
      // 把 stage 打回 pending 重新派工，而不是讓 boss task 永遠掛在 running 指著幽靈
      // mission。若所屬部門也一併消失，下方派工會走「找不到部門主管」的 needs_attention
      // 路徑，至少狀態誠實可見、自動接手也有機會處理。
      stage.status = "pending";
      stage.missionId = null;
      task.messages.push(bossTaskMessage("system", t("「{title}」的 Mission 在重啟後遺失，已重新排入派工。", { title: stage.title })));
      persistBossTask(task);
      continue;
    }
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
    // 沒有驗收條件可核對：直接產出報告（維持原行為，省一次判斷）。
    if (task.acceptanceCriteria.length === 0) {
      task.status = "completed";
      task.error = null;
      task.completedAt = new Date().toISOString();
      task.finalReport = bossTaskFinalReport(task);
      task.messages.push(bossTaskMessage("report", task.finalReport));
      persistBossTask(task);
      return;
    }
    // 有驗收條件：先讓決策模型逐條核對各部門報告，再出報告（非同步，避免阻塞推進鏈）。
    if (!bossTaskFinalizing.has(task.id)) {
      bossTaskFinalizing.add(task.id);
      task.status = "synthesizing";
      task.error = null;
      task.messages.push(bossTaskMessage("system", t("所有部門已交付，正在逐條核對驗收條件…")));
      persistBossTask(task);
      void finalizeBossTaskWithAcceptance(task).finally(() => bossTaskFinalizing.delete(task.id));
    }
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
    // 部門或主管整個消失是永久性缺口（多半是部門被解散／重啟後臨時部門沒還原），自動重試
    // 救不回來——訊息把下一步說清楚，不讓人對著「找不到主管」乾瞪眼（全庫盤點 C-1）。
    task.error = t("找不到「{department}」的部門主管；部門可能已解散或重啟後未還原，請按「重新交辦」重新派工，或先重建部門再回覆這張交辦。", { department: next.departmentName });
    task.messages.push(bossTaskMessage("system", task.error));
    persistBossTask(task);
    return;
  }
  const eligibility = missionDepartmentEligibility(lead);
  if (!eligibility.members) {
    task.status = "needs_attention";
    task.error = t("{department} 暫時無法開始：{error}", { department: next.departmentName, error: eligibility.error || t("部門不可用") });
    task.messages.push(bossTaskMessage("system", task.error));
    // 登記自動重派：主管轉閒置（turn_end）或定期掃描時會重試，不用等人回覆交辦。
    bossDispatchRetry.note(task.id, Date.now());
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
  // Boss 交辦跑在「既有部門」時，成員的自動核准預設是 "off"，每個唯讀工具（WebSearch/
  // WebFetch/Read…）都會停下來等老闆點核准，整張交辦被拖到極慢（使用者實際回報）。交辦
  // 本來就是「授權這支部隊去把事做完」，這裡把參與成員從 off 升到 safe：只自動放行唯讀
  // 工具，寫檔／危險 Bash 仍照擋。dedicated 專屬部隊建立時已設 full，不受此影響。
  for (const member of [lead, ...eligibility.members]) {
    if (member.autoApproveMode === "off") member.autoApproveMode = "safe";
  }
  const launched = launchDepartmentMission(lead, eligibility.members, objective, next.acceptanceCriteria, {
    attachmentIds: task.attachmentIds ?? [],
    executionMode: next.executionMode ?? task.executionMode ?? "project",
    origin: "boss",
    executionProfile: task.executionProfile,
    maxAgents: task.executionBudget?.maxAgents,
    maxPlanSteps: task.executionBudget?.maxMissionSteps,
    directExecute: next.directExecute === true,
    noReview: next.noReview === true,
  });
  if (!launched.mission || launched.error) {
    task.status = "needs_attention";
    task.error = launched.error || t("無法啟動 {department}", { department: next.departmentName });
    task.messages.push(bossTaskMessage("system", task.error));
    // 與 eligibility 擋下同型的卡住（常見：工作區正在執行其他 Mission）——一樣登記自動重派，
    // 讓 turn_end／定期掃在條件恢復時重試，不用等人回覆交辦（卡點盤點 P1）。
    bossDispatchRetry.note(task.id, Date.now());
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

// 同一張交辦只跑一次逐條驗收收尾（advanceBossTaskStages 可能被多次呼叫）。
const bossTaskFinalizing = new Set<string>();

// 所有部門階段完成後的收尾：讓決策模型逐條核對驗收條件，再產出最終報告。
// 任何失敗（用量受限、模型異常、解析不出）都保底降級為「無法驗證」，絕不讓交辦卡在 synthesizing。
async function finalizeBossTaskWithAcceptance(task: BossTask): Promise<void> {
  let verdicts: BossTaskAcceptanceVerdict[] | null = null;
  try {
    const prompt = bossTaskAcceptancePrompt(task);
    const text = (await runDetachedTurn(task.decisionProvider, task.workspacePath, task.decisionModel, undefined, null, prompt, 150_000, { kind: "no_tools" })).text;
    verdicts = parseBossTaskAcceptanceVerdicts(text, task.acceptanceCriteria);
  } catch (error) {
    console.error(`[boss-task] acceptance verification failed for task ${task.id}:`, error);
  }
  // LLM 驗收可跑上兩分鐘：期間老闆可能已取消或刪除這張交辦（cancel 端點對 synthesizing 放行，
  // 且 store 每次讀取回新物件——手上這份是舊快照）。收尾前重讀權威狀態，已終結就不覆寫，
  // 否則取消會被靜默蓋回 completed、autopilotHook 還會再開下一張循環交辦。
  const current = store.getBossTask(task.id);
  if (!current || current.status !== "synthesizing") return;
  task.status = "completed";
  task.error = null;
  task.completedAt = new Date().toISOString();
  task.finalReport = bossTaskFinalReport(task, verdicts ?? undefined);
  task.messages.push(bossTaskMessage("report", task.finalReport));
  persistBossTask(task);
  // 收尾完成才是真正的終態：此時再觸發自動循環與臨時團隊清理。
  autopilotHook(task);
  ephemeralCleanupHook(task);
}

// ── 派工卡住自動重派 ───────────────────────────────────────────────────────
// 派工被 missionDepartmentEligibility 擋下（最常見：部門主管正是對話中的 worker）時，
// 「回覆交辦」只做立即同步重試，主管沒空就再失敗且沒有任何自癒機制（2026-09-30
// autoResolve 實測）。這裡在任一 worker 的 turn_end 與定期掃描時，對登記過的卡住
// 交辦重新檢查 eligibility，通過才重派；次數與冷卻上限在 bossDispatchRetry.ts。
const bossDispatchRetry = new BossDispatchRetryTracker();

function sweepStalledBossDispatch(): void {
  const now = Date.now();
  for (const id of bossDispatchRetry.trackedIds()) {
    const task = store.getBossTask(id);
    const next = task ? runnableNextStage(task.stages) : null;
    const department = next ? departments.get(next.departmentId) : null;
    const lead = department ? workers.get(department.leadWorkerId) : null;
    const action = dispatchRetryAction(bossDispatchRetry, id, {
      status: task?.status ?? "missing",
      stages: task?.stages ?? [],
      leadPresent: Boolean(lead),
      leadEligible: Boolean(lead && missionDepartmentEligibility(lead).members),
    }, now);
    if (action.kind === "wait") continue;
    if (action.kind === "drop") { bossDispatchRetry.resolve(id); continue; }
    if (!task || !next) { bossDispatchRetry.resolve(id); continue; } // action 是 retry/exhausted 時必有，防衛一下
    if (action.kind === "exhausted") {
      bossDispatchRetry.resolve(id);
      task.messages.push(bossTaskMessage("system", t("自動重派已達 {max} 次上限，請直接回覆這張交辦再試一次。", { max: BOSS_DISPATCH_RETRY_MAX_ATTEMPTS })));
      persistBossTask(task);
      continue;
    }
    task.messages.push(bossTaskMessage("system", t("⏯️ {department} 已空出，自動重新派工（第 {n}/{max} 次）。", { department: next.departmentName, n: action.attempt, max: BOSS_DISPATCH_RETRY_MAX_ATTEMPTS })));
    try {
      advanceBossTask(task);
    } catch (error) {
      console.error("[boss-dispatch-retry] 自動重派失敗:", error);
    }
    // advanceBossTask 會就地改 status，TS 的控制流縮窄不知道——重新取一次再比對。
    const afterRetry = store.getBossTask(id);
    if (afterRetry && afterRetry.status === "running") bossDispatchRetry.resolve(id);
  }
}

// ── 專屬部門建立失敗自動重試（卡點盤點 P1-3）──────────────────────────────
// createDepartmentForObjective 回 null（最常見：工作區正在跑別的 Mission）後，阻塞
// 的 Mission 結束也沒有任何人重試建部門，交辦停在 needs_attention 只能等老闆回覆。
// 這裡對登記過的失敗交辦在 turn_end 與定期掃描時檢查工作區是否空出，空出才依原入口
// 重試；指數退避、次數上限與降級決策在 bossDeptCreateRetry.ts。
const bossDeptCreateRetry = new DeptCreateRetryTracker();
// 重試本體是長流程（規劃 LLM 最長 90s）而退避最短 15s——in-flight 期間掃描一律 wait，
// 擋住對同一張的重疊發動。
const bossDeptCreateRetryInFlight = new Set<string>();

function sweepFailedDeptCreation(): void {
  const now = Date.now();
  for (const id of bossDeptCreateRetry.trackedIds()) {
    const task = store.getBossTask(id);
    const action = deptCreateRetryAction(bossDeptCreateRetry, id, {
      status: task?.status ?? "missing",
      stallKind: task?.stall?.kind ?? null,
      workspaceFree: task ? !workspaceMission(task.workspacePath) : false,
      providerReady: task ? providerReady(task.decisionProvider) : false,
      inFlight: bossDeptCreateRetryInFlight.has(id),
    }, now);
    if (action.kind === "wait") continue;
    if (action.kind === "drop" || !task) { bossDeptCreateRetry.resolve(id); continue; }
    if (action.kind === "exhausted") {
      // 降級路徑：明確回報主人，不靜默吞掉。除名後使用者回覆交辦仍可手動重試（會重新登記）。
      bossDeptCreateRetry.resolve(id);
      task.messages.push(bossTaskMessage("system", t("⛔ 已自動重試 {max} 次仍無法建立專屬部門。請回覆這張交辦重新嘗試、手動建立部門後再交辦，或關掉「專屬部門」改用既有部門路由。", { max: DEPT_CREATE_RETRY_MAX_ATTEMPTS })));
      persistBossTask(task);
      continue;
    }
    task.messages.push(bossTaskMessage("system", t("🔁 自動重試建立專屬部門（第 {n}/{max} 次）…", { n: action.attempt, max: DEPT_CREATE_RETRY_MAX_ATTEMPTS })));
    persistBossTask(task);
    bossDeptCreateRetryInFlight.add(id);
    const rerun = action.entry.kind === "dedicated"
      ? runDedicatedDepartmentTask(task)
      : action.entry.kind === "follow_up"
        ? runDedicatedFollowUp(task, action.entry.followUp ?? task.objective, null)
        : decideBossTask(task);
    void rerun
      .catch((error) => console.error("[dept-create-retry] 自動重試失敗:", error))
      .finally(() => {
        bossDeptCreateRetryInFlight.delete(id);
        // 成功（ready/running）就除名；又失敗則入口已重新 note()，留給下一輪退避後再試。
        const after = store.getBossTask(id);
        if (after && after.status !== "needs_attention") bossDeptCreateRetry.resolve(id);
      });
  }
}

// ── 用量受限恢復探測自動重跑（卡點盤點 P1-5）──────────────────────────────
// usageBlockReason 擋下任務判斷後，usage 視窗重置（整點／5h）也沒有任何人重試。
// 這裡對登記過的受限交辦定期探測即時用量，usageBlockReason 歸空（明確依據，不猜
// 時間）才走回原入口重跑；探測退避、次數上限與作廢決策在 bossUsageRetry.ts。
// 不做開機重建（設計留白）：task.stall.kind 落地後結構上已認得回入口，但本輪維持
// 既有語義——重啟後 needs_attention 等人回覆，不會誤動作。
const bossUsageRetry = new UsageRetryTracker();
const bossUsageRetryInFlight = new Set<string>();

function sweepUsageBlockedBossTasks(): void {
  const now = Date.now();
  for (const id of bossUsageRetry.trackedIds()) {
    const task = store.getBossTask(id);
    const action = usageRetryAction(bossUsageRetry, id, {
      status: task?.status ?? "missing",
      stallKind: task?.stall?.kind ?? null,
      inFlight: bossUsageRetryInFlight.has(id),
    }, now);
    if (action.kind === "wait") continue;
    if (action.kind === "drop" || !task) { bossUsageRetry.resolve(id); continue; }
    if (action.kind === "exhausted") {
      // 降級路徑：明確回報主人後停止自動等待，不靜默。回覆交辦仍可手動續跑（會重新登記）。
      bossUsageRetry.resolve(id);
      task.messages.push(bossTaskMessage("system", t("⛔ 已定期探測 {max} 次，用量仍受限，停止自動等待。額度恢復後回覆這張交辦即可續跑。", { max: USAGE_RETRY_MAX_PROBES })));
      persistBossTask(task);
      continue;
    }
    // probe：查即時用量，恢復才重跑原入口；仍受限就等下一輪（這次探測已計數並退避）。
    bossUsageRetryInFlight.add(id);
    void (async () => {
      try {
        const usage = await usageRegistry.refresh(task.decisionProvider, true);
        if (usageBlockReason(task.decisionProvider, usage, task.decisionModel)) return;
        // 探測期間老闆可能已回覆或取消——重讀權威狀態，登記已作廢就放手。後續的訊息、
        // persist 與重跑都對這份重讀物件做（掃描開頭的 task 是探測前的舊快照，直接整列
        // persist 會蓋掉探測期間新寫入的訊息——交互自審補上）。
        const current = store.getBossTask(id);
        if (!current || current.status !== "needs_attention" || current.stall?.kind !== usageStallKind(action.entry.kind)) {
          bossUsageRetry.resolve(id);
          return;
        }
        current.messages.push(bossTaskMessage("system", t("🔁 {provider} 用量已恢復（第 {n} 次探測），自動接手重跑任務判斷。", { provider: providerLabel(current.decisionProvider), n: action.probe })));
        persistBossTask(current);
        await (action.entry.kind === "dedicated" ? runDedicatedDepartmentTask(current) : decideBossTask(current));
        // 成功（ready/running）就除名；又失敗則入口已依新失敗型態重新登記（usage 再受限→
        // 本追蹤器；建立失敗→bossDeptCreateRetry），stall 標記換人的舊登記下一輪掃描 drop。
        const after = store.getBossTask(id);
        if (after && after.status !== "needs_attention") bossUsageRetry.resolve(id);
      } catch (error) {
        console.error("[usage-retry] 恢復探測失敗:", error);
      } finally {
        bossUsageRetryInFlight.delete(id);
      }
    })();
  }
}

// ── Mission 步驟派工卡住自動重派（needs_attention 全庫盤點續篇 A-1）───────────
// dispatchMissionStep 遇被指派 NPC 忙碌／provider 未登入而 pauseMission 後，NPC 空出
// 也沒有任何人重派——bossDispatchRetry 只涵蓋交辦「派工前」的卡住（stage 已
// needs_attention 的形狀被 isPreDispatchStall 明確排除）。守衛與退避在 missionStepRetry.ts。
const missionStepRetry = new BackoffRetryTracker<MissionStepRetryPayload<ReturnType<typeof parseCollaborationResult>>>(MISSION_STEP_RETRY_POLICY);

function sweepPausedMissionSteps(): void {
  const now = Date.now();
  for (const id of missionStepRetry.trackedIds()) {
    const mission = activeMissions.get(id) ?? store.getDepartmentMission(id);
    const payload = missionStepRetry.get(id)?.payload;
    const step = payload ? mission?.steps[payload.stepIndex] ?? null : null;
    const assignee = payload ? workers.get(payload.assigneeWorkerId) ?? null : null;
    const action = missionStepRetryAction(missionStepRetry, id, {
      status: mission?.status ?? "missing",
      attentionReason: mission?.attentionReason ?? null,
      error: mission?.error ?? null,
      stepStatus: step?.status ?? null,
      stepAssigneeId: step?.assigneeWorkerId ?? null,
      assigneePresent: Boolean(assignee),
      // 與 dispatchMissionStep 的前置檢查同一套條件：不忙、無交接／協作、provider 已登入。
      assigneeReady: Boolean(assignee && !assignee.runner.busy && !handoffInProgress(assignee) && !collaborationInProgress(assignee.id) && workerProviderReady(assignee)),
    }, now);
    if (action.kind === "wait") continue;
    if (action.kind === "drop" || !mission) { missionStepRetry.resolve(id); continue; }
    if (action.kind === "exhausted") {
      // 降級路徑：更新 mission.error 明確告知後除名，不靜默。人工從 Mission 面板重試／
      // 重新指派仍可解（若又卡住會重新登記、次數重算）。
      missionStepRetry.resolve(id);
      mission.error = t("已自動等待 {max} 次仍派不出「{title}」，請在 Mission 面板重試或重新指派。", { max: MISSION_STEP_RETRY_MAX_ATTEMPTS, title: mission.steps[action.payload.stepIndex]?.title ?? "" });
      store.saveDepartmentMission(mission);
      broadcastMission(mission);
      advanceBossTasksForMission(mission.id); // 讓 boss task 上的引用文案同步成最新的 mission.error
      continue;
    }
    // retry：與 applyMissionResolution 的 retry 尾段同款恢復（步驟本就停在 pending，
    // 只需清 attention 再走一次 dispatchMissionStep；再卡住會在 pause 分支重新登記並退避）。
    mission.attentionReason = null;
    mission.error = null;
    mission.completedAt = null;
    activeMissions.set(mission.id, mission);
    store.saveDepartmentMission(mission);
    broadcastMission(mission);
    try {
      dispatchMissionStep(mission, action.payload.stepIndex, action.payload.priorReview);
    } catch (error) {
      console.error("[mission-step-retry] 自動重派失敗:", error);
    }
    const after = activeMissions.get(id) ?? store.getDepartmentMission(id);
    if (after && after.status !== "needs_attention") missionStepRetry.resolve(id);
  }
}

function bossDispatchRetryHook(event: RunnerEvent): void {
  if (event.type !== "turn_end") return;
  if (bossDispatchRetry.size > 0) sweepStalledBossDispatch();
  if (bossDeptCreateRetry.size > 0) sweepFailedDeptCreation();
  if (missionStepRetry.size > 0) sweepPausedMissionSteps();
}

function advanceBossTasksForMission(missionId: string): void {
  // 也要掃 needs_attention：boss task 因部門 Mission 卡住而標成 needs_attention 後，老闆若從
  // Mission 面板解卡（resolve/retry），mission 恢復與完成時的通知進來，只掃 running 會漏掉它，
  // task 就永遠停在 needs_attention 不推進（advanceBossTaskStages 會把恢復中的 stage 撥回 running）。
  for (const task of store.listBossTasksByStatus(["running", "needs_attention"])) {
    if (task.stages.some((stage) => stage.missionId === missionId)) advanceBossTask(task);
  }
}

// ===== Autopilot（老闆交辦自動循環）==========================================
// 開關按 workspace 記在記憶體：有值＝開，重啟後全清空（護欄：重啟預設關，無人時不偷跑）。
type AutopilotState = { stepsRemaining: number; running: boolean; deadlineAt: number | null; autoResolve: boolean };
const autopilotByWorkspace = new Map<string, AutopilotState>();
// 開關持久化：存 dataDir 的 JSON（server 端，不經瀏覽器），重啟後還原——使用者
// 不用每次重啟都重新打開自動循環。running 一律以 false 還原（重啟時沒有進行中的推進）。
const autopilotStateStore = new AutopilotStateStore(config.dataDirectory);
for (const [key, state] of Object.entries(autopilotStateStore.load())) {
  autopilotByWorkspace.set(key, { ...state, running: false });
}
function persistAutopilotStates(): void {
  const snapshot: Record<string, { stepsRemaining: number; deadlineAt: number | null; autoResolve: boolean }> = {};
  for (const [key, state] of autopilotByWorkspace) {
    snapshot[key] = { stepsRemaining: state.stepsRemaining, deadlineAt: state.deadlineAt, autoResolve: state.autoResolve };
  }
  autopilotStateStore.save(snapshot);
}
// 同一張交辦的終態只觸發一次循環（advanceBossTask 可能被多次呼叫）。
const autopilotFired = new Set<string>();
// 全域鎖：一次只推進一步，杜絕並發生出多張交辦。
let autopilotAdvancing = false;
// 自動接手：每張交辦已嘗試次數（護欄：超過 AUTOPILOT_RESOLVE_MAX_ATTEMPTS 就停下等人）。
const autopilotResolveAttempts = new Map<string, number>();
// 全域鎖：一次只自動接手一個卡點，避免並發對同一 Mission 重複派工。
let autopilotResolving = false;

function autopilotKey(workspacePath: string): string {
  return registryKey(workspacePath);
}

function autopilotWorkspaceLabel(workspacePath: string): string {
  return workspacePath.split(/[\\/]/).filter(Boolean).pop() || workspacePath;
}

function autopilotSnapshot(workspacePath: string): { enabled: boolean; stepsRemaining: number; deadlineAt: number | null; autoResolve: boolean } {
  const state = autopilotByWorkspace.get(autopilotKey(workspacePath));
  return { enabled: Boolean(state), stepsRemaining: state?.stepsRemaining ?? 0, deadlineAt: state?.deadlineAt ?? null, autoResolve: state?.autoResolve ?? false };
}

function broadcastAutopilot(workspacePath: string): void {
  // 每一次狀態變動（開關、步數遞減、自動熄火）都會走到這裡——順手持久化，重啟後可還原。
  persistAutopilotStates();
  const snap = autopilotSnapshot(workspacePath);
  broadcast({ type: "autopilot", workspacePath: autopilotKey(workspacePath), enabled: snap.enabled, stepsRemaining: snap.stepsRemaining, deadlineAt: snap.deadlineAt, autoResolve: snap.autoResolve });
}

function setAutopilot(workspacePath: string, enabled: boolean, maxSteps?: number, maxMinutes?: number, autoResolve = false): void {
  const key = autopilotKey(workspacePath);
  if (enabled) {
    const minutes = clampAutopilotMinutes(maxMinutes);
    autopilotByWorkspace.set(key, {
      stepsRemaining: clampAutopilotSteps(maxSteps),
      running: false,
      deadlineAt: minutes ? Date.now() + minutes * 60_000 : null,
      autoResolve,
    });
  } else {
    autopilotByWorkspace.delete(key);
  }
  broadcastAutopilot(workspacePath);
}

function disableAutopilotWithNote(task: BossTask, note: string): void {
  const had = autopilotByWorkspace.delete(autopilotKey(task.workspacePath));
  if (!had) return;
  task.messages.push(bossTaskMessage("system", note));
  persistBossTask(task);
  broadcastAutopilot(task.workspacePath);
}

// 從交辦目標直接開一張新的 Boss Task（給自動循環程式化建立用；行為對齊 POST /api/boss-tasks）。
async function spawnBossTask(workspacePath: string, objective: string, note?: string): Promise<BossTask | null> {
  const runtime = resolveDecisionRuntime(undefined, undefined, workspacePath);
  if ("error" in runtime) return null;
  const now = new Date().toISOString();
  const executionProfile = normalizeExecutionProfile(undefined);
  const executionBudget = executionBudgetFor(executionProfile, {});
  const messages = [bossTaskMessage("boss", objective)];
  if (note) messages.push(bossTaskMessage("system", note));
  const task: BossTask = {
    id: randomUUID(),
    title: objective.slice(0, 120),
    archivedAt: null,
    workspacePath,
    decisionProvider: runtime.provider,
    decisionModel: runtime.model,
    objective,
    acceptanceCriteria: [],
    attachmentIds: [],
    clientMessageId: null,
    idempotencyKey: null,
    status: "discovering",
    executionProfile,
    executionBudget,
    messages,
    stages: [],
    finalReport: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
  if (!store.saveBossTask(task)) return null;
  broadcastBossTask(task, true);
  await decideBossTask(task);
  return task;
}

// 交辦任務進入終態時的自動循環 hook（由 advanceBossTask 統一呼叫）：
// 完成 → 讓決策模型自己決定下一步 → 再開一張；卡住／失敗 → 停下等人（護欄）。
function autopilotHook(task: BossTask): void {
  const state = autopilotByWorkspace.get(autopilotKey(task.workspacePath));
  if (!state) return;
  const terminal = task.status === "completed" || task.status === "needs_attention" || task.status === "failed" || task.status === "cancelled";
  // needs_input（決策模型問老闆問題）不是終態；只有開了「自動接手」才介入代答，
  // 沒開就維持原行為：循環留著、安靜等老闆回。
  const answerable = task.status === "needs_input" && state.autoResolve;
  if ((!terminal && !answerable) || autopilotFired.has(task.id)) return;
  autopilotFired.add(task.id);
  if (answerable) {
    const attempts = autopilotResolveAttempts.get(task.id) ?? 0;
    if (autopilotResolving) {
      // 另一件自動接手正在進行：把觸發權還回去，之後的事件會再進來。
      autopilotFired.delete(task.id);
      return;
    }
    if (attempts < AUTOPILOT_RESOLVE_MAX_ATTEMPTS) {
      void autoAnswerBossTask(task, attempts);
      return;
    }
    disableAutopilotWithNote(task, t("⛔ 自動循環已停止：代答次數已用完，這個問題需要你親自回答；回覆後可再打開開關。"));
    return;
  }
  if (task.status !== "completed") {
    // 開了「自動接手」的卡住（needs_attention）：先讓決策模型試著解卡，次數護欄內
    // 不停循環；失敗／取消或次數用盡照舊停下等人。
    if (state.autoResolve && task.status === "needs_attention") {
      if (autopilotResolving) {
        // 另一件自動接手正在進行（可能是別的 workspace 的）：比照 needs_input 分支把觸發權
        // 還回去等下一個事件，不能直接把這條循環關掉——它根本還沒嘗試過。
        autopilotFired.delete(task.id);
        return;
      }
      const attempts = autopilotResolveAttempts.get(task.id) ?? 0;
      if (attempts < AUTOPILOT_RESOLVE_MAX_ATTEMPTS) {
        void autoResolveBossTask(task, attempts);
        return;
      }
    }
    autopilotResolveAttempts.delete(task.id); // 循環要停了，這張的接手計數不再需要
    disableAutopilotWithNote(task, t("⛔ 自動循環已停止：上一個交辦需要你處理或未成功；接手後可再打開開關。"));
    return;
  }
  autopilotResolveAttempts.delete(task.id);
  if (state.running || autopilotAdvancing) {
    // 另一條 workspace 的循環正在推進（全域鎖）：把觸發權還回去，讓之後的事件能重新進來，
    // 否則這張 completed 永遠留在 autopilotFired、這條循環無聲熄火。
    autopilotFired.delete(task.id);
    return;
  }
  void advanceAutopilot(task, state);
}

// 自動接手代答：決策模型在 discovery 問了 clarification、老闆不在時，讓幕僚長用安全
// 有界的假設代答（例如問題給了「先出範本版」的退路就選它），代答後重新跑決策；
// 真的需要老闆本人的資訊（實體資料、憑證、不可逆決定）就停下等人。
async function autoAnswerBossTask(task: BossTask, attempts: number): Promise<void> {
  autopilotResolving = true;
  try {
    const question = [...task.messages].reverse().find((message) => message.role === "decision_model")?.text ?? "";
    const runtime = resolveDecisionRuntime(undefined, undefined, task.workspacePath);
    if ("error" in runtime) {
      disableAutopilotWithNote(task, t("⛔ 自動循環已停止：{error}", { error: runtime.error }));
      return;
    }
    const conversation = task.messages
      .filter((message) => message.role === "boss" || message.role === "decision_model")
      .slice(-8)
      .map((message) => ({ role: message.role, text: message.text }));
    const prompt = autopilotAnswerPrompt({
      objective: task.objective,
      question,
      conversation,
      attemptNumber: attempts + 1,
      maxAttempts: AUTOPILOT_RESOLVE_MAX_ATTEMPTS,
    });
    let decision;
    try {
      const text = (await runDetachedTurn(runtime.provider, task.workspacePath, runtime.model, undefined, null, prompt, 150_000, { kind: "no_tools" })).text;
      decision = parseAutopilotAnswerDecision(text);
    } catch (error) {
      disableAutopilotWithNote(task, t("⛔ 自動循環已停止：決策模型無法給出下一步（{error}）。", { error: (error as Error).message }));
      return;
    }
    // 開關可能在生成期間被關掉；老闆也可能已親自回覆——都不再動任何東西。
    if (!autopilotByWorkspace.has(autopilotKey(task.workspacePath))) return;
    if (task.status !== "needs_input") return;
    if (!decision || decision.action === "wait") {
      const reason = decision?.action === "wait" ? decision.reason : "";
      disableAutopilotWithNote(task, reason
        ? t("⛔ 自動循環已停止：{reason}；接手後可再打開開關。", { reason })
        : t("⛔ 自動循環已停止：上一個交辦需要你處理或未成功；接手後可再打開開關。"));
      return;
    }
    autopilotResolveAttempts.set(task.id, attempts + 1);
    autopilotFired.delete(task.id);
    task.messages.push(bossTaskMessage("boss", t("🤝（自動接手代答，第 {n}/{max} 次，可隨時修正）{reply}", {
      n: attempts + 1,
      max: AUTOPILOT_RESOLVE_MAX_ATTEMPTS,
      reply: decision.reply,
    })));
    task.status = "discovering";
    task.error = null;
    persistBossTask(task);
    // 先釋放全域鎖再重跑決策：decideBossTask 若再問一題，hook 需要能進入下一次代答
    //（遞迴深度由 AUTOPILOT_RESOLVE_MAX_ATTEMPTS 保底）。
    autopilotResolving = false;
    await decideBossTask(task);
  } finally {
    autopilotResolving = false;
  }
}

// 自動接手一張卡在 needs_attention 的交辦：找出中斷的部門 Mission，讓決策模型讀中斷
// 脈絡選一個處理動作（retry / retry_execute / accept_risk），wait 或任何失敗就停下等人。
async function autoResolveBossTask(task: BossTask, attempts: number): Promise<void> {
  autopilotResolving = true;
  try {
    const stopNote = t("⛔ 自動循環已停止：上一個交辦需要你處理或未成功；接手後可再打開開關。");
    const blockedStage = task.stages.find((stage) => {
      if (!stage.missionId) return false;
      const mission = activeMissions.get(stage.missionId) ?? store.getDepartmentMission(stage.missionId);
      return mission?.status === "needs_attention";
    });
    const mission = blockedStage?.missionId
      ? activeMissions.get(blockedStage.missionId) ?? store.getDepartmentMission(blockedStage.missionId)
      : null;
    // 沒有可解的 Mission 中斷（環境類卡住）或等的是計畫核准：不是指示能解的，停下等人。
    if (!blockedStage || !mission || mission.attentionReason === "plan_approval") {
      disableAutopilotWithNote(task, stopNote);
      return;
    }
    const runtime = resolveDecisionRuntime(undefined, undefined, task.workspacePath);
    if ("error" in runtime) {
      disableAutopilotWithNote(task, t("⛔ 自動循環已停止：{error}", { error: runtime.error }));
      return;
    }
    const stepIndex = mission.currentStepIndex;
    const step = stepIndex == null ? null : mission.steps[stepIndex];
    const reviewSummary = step?.kind === "review" && step.reviewResult
      ? collaborationText(JSON.stringify(step.reviewResult), 4_000)
      : "";
    const prompt = autopilotResolvePrompt({
      objective: task.objective,
      stageTitle: blockedStage.title,
      departmentName: blockedStage.departmentName,
      attentionReason: mission.attentionReason ?? "",
      missionError: mission.error ?? "",
      stepTitle: step?.title ?? "",
      stepKind: step?.kind ?? "",
      reviewSummary,
      attemptNumber: attempts + 1,
      maxAttempts: AUTOPILOT_RESOLVE_MAX_ATTEMPTS,
    });
    let decision;
    try {
      const text = (await runDetachedTurn(runtime.provider, task.workspacePath, runtime.model, undefined, null, prompt, 150_000, { kind: "no_tools" })).text;
      decision = parseAutopilotResolveDecision(text);
    } catch (error) {
      disableAutopilotWithNote(task, t("⛔ 自動循環已停止：決策模型無法給出下一步（{error}）。", { error: (error as Error).message }));
      return;
    }
    // 使用者可能在生成期間關掉了開關——關了就不再動任何東西。
    if (!autopilotByWorkspace.has(autopilotKey(task.workspacePath))) return;
    if (!decision || decision.action === "wait") {
      const reason = decision?.action === "wait" ? decision.reason : "";
      disableAutopilotWithNote(task, reason
        ? t("⛔ 自動循環已停止：{reason}；接手後可再打開開關。", { reason })
        : stopNote);
      return;
    }
    autopilotResolveAttempts.set(task.id, attempts + 1);
    const guidance = decision.action === "retry" ? "" : decision.guidance;
    const outcome = applyMissionResolution(mission, decision.action, guidance);
    if (outcome.error) {
      disableAutopilotWithNote(task, t("⛔ 自動循環已停止：自動接手失敗（{error}）。", { error: outcome.error }));
      return;
    }
    // 解卡已派工：把這張交辦移出「已觸發」集合，讓下一次終態（完成→續循環、
    // 再卡→再接手或停）能重新進 hook。
    autopilotFired.delete(task.id);
    const actionLabel = decision.action === "accept_risk"
      ? t("接受 Review 風險並繼續")
      : decision.action === "retry_execute"
        ? t("帶指示重跑 Execute")
        : t("原步驟重試");
    task.messages.push(bossTaskMessage("system", t("🤝 自動接手（第 {n}/{max} 次）：{action}{guidance}", {
      n: attempts + 1,
      max: AUTOPILOT_RESOLVE_MAX_ATTEMPTS,
      action: actionLabel,
      guidance: guidance ? t("——{guidance}", { guidance }) : "",
    })));
    advanceBossTaskStages(task);
  } finally {
    autopilotResolving = false;
  }
}

async function advanceAutopilot(justFinished: BossTask, state: AutopilotState): Promise<void> {
  const workspacePath = justFinished.workspacePath;
  if (state.stepsRemaining <= 0) {
    disableAutopilotWithNote(justFinished, t("✅ 自動循環已達步數上限，已自動停止。要接著討論或調整，直接在這張交辦回覆即可；要再自動接續就重開開關。"));
    return;
  }
  // 時間上限是「軟上限」：在每張交辦收工的節點檢查，過了截止時刻就停在這個邊界（不會攔腰砍斷進行中的交辦）。
  if (state.deadlineAt && Date.now() >= state.deadlineAt) {
    disableAutopilotWithNote(justFinished, t("✅ 自動循環已達時間上限，已自動停止。要接著討論或調整，直接在這張交辦回覆即可；要再自動接續就重開開關。"));
    return;
  }
  state.running = true;
  autopilotAdvancing = true;
  try {
    const runtime = resolveDecisionRuntime(undefined, undefined, workspacePath);
    if ("error" in runtime) {
      disableAutopilotWithNote(justFinished, t("⛔ 自動循環已停止：{error}", { error: runtime.error }));
      return;
    }
    // 提示池：拿近期已完成交辦當脈絡，讓決策模型自己決定下一步。
    const history: AutopilotHistoryEntry[] = store.listBossTasks()
      .filter((item) => sameWorkspacePath(item.workspacePath, workspacePath) && item.status === "completed")
      .sort((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? ""))
      .slice(-8)
      .map((item) => ({ objective: item.objective, report: item.finalReport ? collaborationText(item.finalReport, 600) : undefined }));
    const prompt = autopilotNextPrompt({ workspaceLabel: autopilotWorkspaceLabel(workspacePath), history, stepsRemaining: state.stepsRemaining - 1 });
    let decision;
    try {
      const text = (await runDetachedTurn(runtime.provider, workspacePath, runtime.model, undefined, null, prompt, 150_000, { kind: "no_tools" })).text;
      decision = parseAutopilotDecision(text);
    } catch (error) {
      disableAutopilotWithNote(justFinished, t("⛔ 自動循環已停止：決策模型無法給出下一步（{error}）。", { error: (error as Error).message }));
      return;
    }
    if (!decision || decision.action === "stop") {
      const reason = decision?.action === "stop" ? decision.reason : "";
      disableAutopilotWithNote(justFinished, t("🅿️ 自動循環正常結束{reason}。要接著討論或調整，直接在這張交辦回覆即可（有專屬團隊會由同一隊接手）；要再自動接續就重開開關。", { reason: reason ? t("：{reason}", { reason }) : "" }));
      return;
    }
    // 使用者可能在生成期間關掉了開關——關了就不再推進。
    if (!autopilotByWorkspace.has(autopilotKey(workspacePath))) return;
    state.stepsRemaining -= 1;
    const spawned = await spawnBossTask(workspacePath, decision.objective, t("🔁 自動循環（自動決定的下一步）：{reason}", { reason: decision.reason || decision.objective.slice(0, 80) }));
    if (!spawned) {
      disableAutopilotWithNote(justFinished, t("⛔ 自動循環已停止：無法建立下一個交辦。"));
      return;
    }
    // 巡迴推進到下一步＝上一個交辦收工，把它的臨時團隊解散（不會再手動追問）。
    disbandTaskEphemeralDepartments(justFinished);
    broadcastAutopilot(workspacePath);
  } finally {
    state.running = false;
    autopilotAdvancing = false;
  }
}

app.get("/api/autopilot", (req, res) => {
  const requested = collaborationText(req.query.workspacePath, 1_000);
  let workspacePath: string;
  try { workspacePath = normalizeManagedWorkspacePath(requested || config.targetRepoPath); }
  catch (error) { res.status(400).json({ error: (error as Error).message }); return; }
  res.json({ ok: true, ...autopilotSnapshot(workspacePath) });
});

app.post("/api/autopilot", (req, res) => {
  let workspacePath: string;
  try { workspacePath = normalizeManagedWorkspacePath(collaborationText(req.body?.workspacePath, 1_000) || config.targetRepoPath); }
  catch (error) { res.status(400).json({ error: (error as Error).message }); return; }
  const enabled = Boolean(req.body?.enabled);
  if (enabled) {
    // 開之前先確認決策模型可用，別讓開關開了卻在第一步就默默熄火。
    const runtime = resolveDecisionRuntime(req.body?.decisionProvider, req.body?.decisionModel, workspacePath);
    if ("error" in runtime) { res.status(503).json({ error: runtime.error }); return; }
  }
  const maxSteps = enabled && Number.isFinite(req.body?.maxSteps) ? Number(req.body.maxSteps) : undefined;
  const maxMinutes = enabled && Number.isFinite(req.body?.maxMinutes) ? Number(req.body.maxMinutes) : undefined;
  const autoResolve = enabled && Boolean(req.body?.autoResolve);
  setAutopilot(workspacePath, enabled, maxSteps, maxMinutes, autoResolve);
  res.json({ ok: true, ...autopilotSnapshot(workspacePath) });
});

// ===== 個人自動循環（worker autopilot）======================================
// 單一 NPC 做完一回合後，決策模型看它最近在做什麼、決定下一句指示送回給它，形成個人循環。
// 與 BOSS 層循環的分工見 workerAutopilot.ts。開關按 workerId 記，檔案式 JSON 持久化。
const workerAutopilotByWorker = new Map<string, PersistedWorkerAutopilotState>();
const workerAutopilotStateStore = new WorkerAutopilotStateStore(config.dataDirectory);
for (const [key, state] of Object.entries(workerAutopilotStateStore.load())) {
  workerAutopilotByWorker.set(key, { ...state });
}
// 每位 NPC 同時只允許一個「想下一步」在跑（決策 LLM 最長 150s）。
const workerAutopilotAdvancing = new Set<string>();
// 決策模型呼叫失敗的退避重試（P1-1）：一次失敗不熄火，登記後由 15s 保底掃接手。
const workerAutopilotRetry = new BackoffRetryTracker<null>(WORKER_AUTOPILOT_RETRY_POLICY);
// 重試前的用量探測進行中（防掃描班次重疊發動）。
const workerAutopilotProbing = new Set<string>();

// 循環復盤記憶：每輪收尾留一行教訓，下輪決策 prompt 帶入（見 workerAutopilot.ts 機制一）。
const workerAutopilotRetroStore = new WorkerAutopilotRetroStore(config.dataDirectory);
const workerAutopilotRetros: Record<string, WorkerAutopilotRetro[]> = workerAutopilotRetroStore.load();

function saveWorkerAutopilotRetro(workerId: string, note: string | undefined): void {
  if (appendWorkerAutopilotRetro(workerAutopilotRetros, workerId, note, Date.now())) {
    workerAutopilotRetroStore.save(workerAutopilotRetros);
  }
}

// 活的計畫（支柱 A · 增量 1）：跨回合演進的單一事實來源（目標→假設→已試→待試→卡點），
// 取代「每回合從近幾回合重推下一步」的貪心單步。檔案式 JSON 持久化、key=workerId（見 workerAutopilot.ts）。
const workerAutopilotPlanStore = new WorkerAutopilotPlanStore(config.dataDirectory);
const workerAutopilotPlans: Record<string, WorkerAutopilotPlan> = workerAutopilotPlanStore.load();

function saveWorkerAutopilotPlan(workerId: string, plan: WorkerAutopilotPlan): void {
  workerAutopilotPlans[workerId] = plan;
  workerAutopilotPlanStore.save(workerAutopilotPlans);
}

// 未結案使用者請求帳本：真人臨時請求落地，在教練 prompt 與換腦交接兩處原文注入，防被循環議程
// 或摘要壓縮蒸發（見 openRequests.ts）。只收真人非 notice 訊息——自動循環自己在 6168 也用
// 非 notice user_message 送指示，所以只在真人入口（drainWorkerQueue／/message）落帳。
const openUserRequestStore = new OpenUserRequestStore(config.dataDirectory);
const openUserRequests: Record<string, OpenUserRequest[]> = openUserRequestStore.load();

function captureOpenUserRequest(worker: Worker, text: string): void {
  // 記所有真人請求，不論有沒有開循環——「做一半換腦就忘」在互動對話同樣會發生（甚至更常，
  // 因為互動對話最容易被 context 撐滿觸發換腦）。上限 12 筆 open、超額最舊自動降級（見
  // openRequests.ts），一般閒聊也不會無限堆積；教練回報結案或人工確認才離開 open 清單。
  if (appendOpenRequest(openUserRequests, worker.id, text, Date.now(), randomUUID())) {
    pruneResolved(openUserRequests);
    openUserRequestStore.save(openUserRequests);
  }
}

function resolveCapturedRequests(workerId: string, ids: string[] | undefined): void {
  if (!ids?.length) return;
  if (resolveOpenRequests(openUserRequests, workerId, ids, Date.now()) > 0) {
    pruneResolved(openUserRequests);
    openUserRequestStore.save(openUserRequests);
  }
}

function persistWorkerAutopilotStates(): void {
  const snapshot: Record<string, PersistedWorkerAutopilotState> = {};
  for (const [key, state] of workerAutopilotByWorker) snapshot[key] = { ...state };
  workerAutopilotStateStore.save(snapshot);
}

function workerAutopilotSnapshot(workerId: string): { stepsRemaining: number; deadlineAt: number | null; proactive: boolean; goal: string | null; paused: { question: string; options: string[]; at: number } | null } | null {
  const state = workerAutopilotByWorker.get(workerId);
  return state ? {
    stepsRemaining: state.stepsRemaining,
    deadlineAt: state.deadlineAt,
    proactive: state.proactive,
    goal: state.goal ?? null,
    paused: state.paused ? { question: state.paused.question, options: state.paused.options, at: state.paused.at } : null,
  } : null;
}

// owner 對暫停中的循環發話＝回答了它的問題：解除暫停、時限順延暫停的時長（人不在的時間不算），
// 這則回覆跑完的 turn_end 會照常觸發教練想下一步（教練在最近回合裡看得到 owner 的回答）。
function resumeWorkerAutopilotIfPaused(worker: Worker): void {
  const state = workerAutopilotByWorker.get(worker.id);
  if (!state?.paused) return;
  const pausedFor = Math.max(0, Date.now() - state.paused.at);
  if (state.deadlineAt) state.deadlineAt += pausedFor;
  state.paused = null;
  persistWorkerAutopilotStates();
  appendRuntimeLog(config.dataDirectory, "autopilot resumed by owner reply", { worker: worker.runner.name, pausedMs: pausedFor });
  broadcast({ type: "worker_updated", worker: workerSummary(worker) });
}

// 循環開著時改目標：換根錨並重種計畫（舊計畫以舊目標為錨，留著只會拉回舊方向）。
function updateWorkerAutopilotGoal(worker: Worker, goalText: string): boolean {
  const state = workerAutopilotByWorker.get(worker.id);
  const goal = goalText.trim().slice(0, 800);
  if (!state || !goal) return false;
  state.goal = goal;
  saveWorkerAutopilotPlan(worker.id, seedWorkerAutopilotPlan(goal, (workerAutopilotRetros[worker.id] ?? []).map((entry) => entry.note).reverse()));
  persistWorkerAutopilotStates();
  record(worker, { type: "user_message", text: t("🎯 自動循環目標已改為：{goal}", { goal }), notice: true });
  broadcast({ type: "worker_updated", worker: workerSummary(worker) });
  return true;
}

function setWorkerAutopilot(worker: Worker, enabled: boolean, maxSteps?: number, maxMinutes?: number, proactive?: boolean, goalText?: string): void {
  if (enabled) {
    const minutes = clampWorkerAutopilotMinutes(maxMinutes);
    // 這輪的目標＝owner 開循環當下的原話（明給的優先，否則取最近一則真人指示），整輪固定不讓模型改寫。
    const goal = goalText?.trim().slice(0, 800) || latestOwnerInstruction(worker.history) || null;
    workerAutopilotByWorker.set(worker.id, {
      stepsRemaining: clampWorkerAutopilotSteps(maxSteps),
      deadlineAt: minutes ? Date.now() + minutes * 60_000 : null,
      proactive: proactive === true,
      goal,
    });
    // 換了目標：舊計畫（以舊目標為根錨的已試／待試）歸零重種，過往教訓仍由 retros 帶入新計畫。
    const existing = workerAutopilotPlans[worker.id];
    if (goal && existing && existing.goal !== goal) {
      saveWorkerAutopilotPlan(worker.id, seedWorkerAutopilotPlan(goal, (workerAutopilotRetros[worker.id] ?? []).map((entry) => entry.note).reverse()));
    }
  } else {
    workerAutopilotByWorker.delete(worker.id);
    workerAutopilotRetry.resolve(worker.id);
  }
  persistWorkerAutopilotStates();
  broadcast({ type: "worker_updated", worker: workerSummary(worker) });
}

function disableWorkerAutopilotWithNote(worker: Worker, note: string, ask?: { options: string[] }): void {
  if (!workerAutopilotByWorker.delete(worker.id)) return;
  workerAutopilotRetry.resolve(worker.id);
  persistWorkerAutopilotStates();
  // ask 非空＝循環停下來是要 owner 決定(非單純做完/出錯)。標成 autopilotAsk 讓 UI 渲染醒目「循環問你」卡、
  // askOptions 給一鍵回答按鈕。owner 之後對這位 NPC 發話即視為已回答(UI 由訊息流自行判定，不需額外 server 狀態)。
  record(worker, { type: "user_message", text: note, notice: true, ...(ask ? { autopilotAsk: true, askOptions: ask.options } : {}) });
  broadcast({ type: "worker_updated", worker: workerSummary(worker) });
}

// 循環撞到步數／時間上限而停時用：除了貼停止註記，再補送一個「收尾交接」回合，讓 NPC 主動給擁有者
// 一份看得懂的結案（做了什麼／結論／下一步／怎麼接續）。這條在拿掉「剩 N 步」倒數後尤其重要——否則
// NPC 不知道是最後一步、不會自己總結，循環就這樣停在半空，擁有者回頭看不懂也不知怎麼接。
function concludeWorkerAutopilotWithHandoff(worker: Worker, note: string, ask?: { options: string[] }): void {
  if (!workerAutopilotByWorker.delete(worker.id)) return;
  workerAutopilotRetry.resolve(worker.id);
  persistWorkerAutopilotStates();
  // ask 非空＝教練停下來是要你拍板：停止註記照樣標成「循環問你」卡＋一鍵選項；下面的四段收尾仍照送，
  // 讓你同時有「做了什麼的完整回顧」與「一鍵回答的決定」。
  record(worker, { type: "user_message", text: note, notice: true, ...(ask ? { autopilotAsk: true, askOptions: ask.options } : {}) });
  // 只有 NPC 當下閒著、provider 就緒、且沒有在交接/協作/Mission/換腦/排隊時，才補送收尾回合。
  // 送不出就只留停止註記，不硬塞（寧可少一份交接，也不要卡住或拋錯）。
  const canHandoff = !worker.runner.busy && workerProviderReady(worker)
    && !handoffInProgress(worker) && !collaborationInProgress(worker.id) && !missionInProgress(worker.id)
    && !pendingSwapSummaries.has(worker.id) && !brainSwapPending.has(worker.id)
    && store.listQueue(worker.id).length === 0;
  if (canHandoff) {
    const handoff = t("🏁 自動循環在此結束，請只做一件事：給擁有者一份看得懂的收尾交接，寫完就停、不要再開始任何新工作或新測試。用四段寫清楚：① 這段循環實際做了什麼（具體、可核對，不要只說「驗了幾支」要講結論）② 現在的結論／狀態 ③ 建議的下一步 ④ 擁有者要怎麼接續（直接回什麼一句話、或怎麼重開循環）。");
    // system:true＝系統產生、非真人目標：若之後重開循環，別把這句交接指令誤當成原始大局目標。
    record(worker, { type: "user_message", text: handoff, system: true });
    try {
      worker.runner.send(handoff, [], []);
      broadcast({ type: "worker_status", workerId: worker.id, busy: true });
    } catch { /* 送不出就算了，停止註記已經在了 */ }
  }
  broadcast({ type: "worker_updated", worker: workerSummary(worker) });
}

// 從 worker 對話歷史組出教練決策要的脈絡（純邏輯抽到 workerAutopilot.ts 便於單測）：跳過
// notice 通知與 system 系統回合（換腦/交接/續跑）避免把交接摘要誤當「最新結果」診斷；另抽出
// originalGoal（大局目標）與 carriedSummary（換腦帶來的先前摘要背景）。
function recentWorkerAutopilotTurns(worker: Worker): WorkerAutopilotContext {
  return autopilotContextFromHistory(worker.history);
}

// 工作區實況（唯讀、便宜、不可拋錯）：outbox 成品與最近改動的檔名，給決策教練對照
// NPC 的自述抓落差（「說交付了但 outbox 是空的」）。任何 IO 失敗都當成沒有實況。
function collectWorkerWorkspaceFacts(workspacePath: string): { outbox: string[]; recent: string[] } | null {
  const listByMtime = (dir: string, limit: number): string[] => {
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
      .slice(0, 200)
      .map((entry) => {
        try { return { name: entry.name, mtime: statSync(join(dir, entry.name)).mtimeMs }; }
        catch { return null; }
      })
      .filter((item): item is { name: string; mtime: number } => item !== null)
      .sort((a, b) => b.mtime - a.mtime);
    return entries.slice(0, limit).map((item) => item.name);
  };
  try {
    const recent = listByMtime(workspacePath, 10);
    let outbox: string[] = [];
    try { outbox = listByMtime(join(workspacePath, "outbox"), 12); } catch { /* 沒有 outbox 目錄＝沒有成品 */ }
    return { outbox, recent };
  } catch {
    return null;
  }
}

// 某段時間內工作區有沒有檔案被改過（空轉偵測的補充實測：Bash 跑腳本產檔不會出現 Write 工具）。
// 有界遞迴（略過 node_modules/.git/dist 等、最多掃 4000 個項目），IO 失敗一律當「沒看到改動」。
const WORKSPACE_SCAN_SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".venv", "__pycache__", ".cache"]);
function workspaceChangedBetween(workspacePath: string, startAt: number | null, endAt: number | null): boolean {
  if (startAt == null) return false;
  const until = (endAt ?? Date.now()) + 2_000;
  let budget = 4_000;
  const walk = (dir: string, depth: number): boolean => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      if (--budget <= 0) return false;
      if (entry.isDirectory()) {
        if (depth < 6 && !WORKSPACE_SCAN_SKIP.has(entry.name) && walk(join(dir, entry.name), depth + 1)) return true;
      } else if (entry.isFile()) {
        try {
          const mtime = statSync(join(dir, entry.name)).mtimeMs;
          if (mtime >= startAt && mtime <= until) return true;
        } catch { /* 讀不到就略過 */ }
      }
    }
    return false;
  };
  return walk(workspacePath, 0);
}

function workerAutopilotHook(worker: Worker, event: RunnerEvent): void {
  if (event.type !== "turn_end") return;
  const state = workerAutopilotByWorker.get(worker.id);
  if (!state) return;
  if (worker.ephemeralKind) { workerAutopilotByWorker.delete(worker.id); workerAutopilotRetry.resolve(worker.id); persistWorkerAutopilotStates(); return; }
  // 暫停等 owner 回覆中：什麼都不做（owner 發話時 resumeWorkerAutopilotIfPaused 會先解除暫停）。
  if (state.paused) return;
  if (event.isError && lastTurnWasSystem(worker.history)) {
    // 出錯的是換腦／交接這類系統回合（不是循環派的工作）：換腦流程自己會放棄或重來，循環不該跟著熄火，
    // 往下照常讓路／推進（下一步教練會在新的或原本的 session 上接著做）。
    appendRuntimeLog(config.dataDirectory, "autopilot ignored system-turn error", { worker: worker.runner.name });
  } else if (event.isError) {
    disableWorkerAutopilotWithNote(worker, t("⛔ 自動循環已停止：上一回合發生錯誤；處理後可再打開開關。"));
    return;
  }
  if (state.stepsRemaining <= 0) {
    // 步數用完時，最後一步的指示本來就要求 NPC 收尾並附收尾報告（見 workerAutopilot.ts 的 FINAL STEP），
    // 不再補送收尾交接回合——實測會產出兩份重複的收尾、白花一個回合。時間上限則照舊補送（教練事先不知道）。
    disableWorkerAutopilotWithNote(worker, t("✅ 自動循環已達步數上限，自動停止；收尾報告在上一則回覆。要繼續就再打開開關。"));
    return;
  }
  if (state.deadlineAt && Date.now() >= state.deadlineAt) {
    concludeWorkerAutopilotWithHandoff(worker, t("✅ 自動循環已達時間上限，自動停止。要繼續就再打開開關。"));
    return;
  }
  // 讓路：交接/協作/Mission 進行中、換腦流程中、或佇列還有排隊訊息時不觸發——
  // 循環保持武裝，之後的回合結束會再進來。
  if (handoffInProgress(worker) || collaborationInProgress(worker.id) || missionInProgress(worker.id)) return;
  if (pendingSwapSummaries.has(worker.id) || brainSwapPending.has(worker.id)) return;
  if (store.listQueue(worker.id).length > 0) return;
  if (workerAutopilotAdvancing.has(worker.id)) return;
  void advanceWorkerAutopilot(worker, state);
}

async function advanceWorkerAutopilot(worker: Worker, state: PersistedWorkerAutopilotState): Promise<void> {
  workerAutopilotAdvancing.add(worker.id);
  try {
    const runtime = resolveWorkerDecisionRuntime(worker);
    if ("error" in runtime) {
      disableWorkerAutopilotWithNote(worker, t("⛔ 自動循環已停止：{error}", { error: runtime.error }));
      return;
    }
    // 決策/探索/修復三通呼叫都跑在這位 NPC 指定帳號的 home 上（而非共用登入的預設 home）。
    const workerHome = homeForWorker(worker) ?? undefined;
    const context = recentWorkerAutopilotTurns(worker);
    const { turns, carriedSummary } = context;
    // 目標用 owner 開循環時的原話（state.goal）；舊版持久化沒有 goal 的才退回歷史推得的目標。
    const originalGoal = state.goal || context.originalGoal;
    // 空轉偵測（伺服器實測）：連 N 步沒改檔／commit／查資料就停，不再花決策呼叫；差一步就先警告教練。
    const idleStreak = workerAutopilotIdleStreak(
      workerAutopilotStepActivity(worker.history),
      (step) => workspaceChangedBetween(worker.runner.workspacePath, step.startAt, step.endAt),
    );
    if (idleStreak >= WORKER_AUTOPILOT_IDLE_STOP) {
      appendRuntimeLog(config.dataDirectory, "autopilot idle stop", { worker: worker.runner.name, idleStreak });
      concludeWorkerAutopilotWithHandoff(worker, t("⏸ 自動循環：連續 {n} 步沒有新產出（沒改檔、沒 commit、也沒查資料），先停下來避免空轉。要繼續就再打開開關。", { n: idleStreak }));
      return;
    }
    // 活計畫（支柱 A）：載入既有計畫；空則用大局目標＋過往教訓種入一份（吃掉既有狀態、不並存）。
    let plan = workerAutopilotPlans[worker.id];
    if (!plan || isWorkerAutopilotPlanEmpty(plan)) {
      plan = seedWorkerAutopilotPlan(originalGoal, (workerAutopilotRetros[worker.id] ?? []).map((entry) => entry.note).reverse());
    }
    // 決策沿用 resolveDecisionRuntime 選的模型。實測（874d990）換成 sonnet 不但沒加速、反而更慢
    // （85s vs opus 48s）——證明接回延遲的大頭是「決策走完整 CLI turn＋大量 extended thinking」的
    // 本質成本，與模型無關，故不再做模型替換（避免回歸）。真正要秒級需改走輕量決策路徑，屬較大工程。
    const decisionModel = runtime.model;
    let decision: WorkerAutopilotDecision | null = null;
    // 兩段式決策（支柱 B）：決策 →（需要查證就 explore → 真的查 → 結構化回灌 → 再決策），
    // 每步最多探索 WORKER_AUTOPILOT_MAX_EXPLORE_PER_STEP 次，用盡就逼它用現有資訊 continue/stop。
    const findingsThisStep: WorkerAutopilotFinding[] = [];
    let exploreRounds = 0;
    // 原地踏步軟訊號（純字串比對、零額外呼叫）：有才注入 prompt 逼教練換角度。
    const stallSignals = workerAutopilotStallSignals(turns);
    if (idleStreak > 0) {
      stallSignals.push(`The last loop step produced NO new output (server-checked: no file changed, no commit, no research). ${WORKER_AUTOPILOT_IDLE_STOP - idleStreak} more empty step and the server stops the loop — make this step produce something concrete toward the owner's goal, or STOP honestly now.`);
    }
    let lastPrompt = "";
    for (;;) {
      const canExplore = exploreRounds < WORKER_AUTOPILOT_MAX_EXPLORE_PER_STEP;
      const prompt = workerAutopilotNextPrompt({
        workerName: worker.runner.name,
        role: worker.persona?.role || null,
        workspaceLabel: worker.runner.workspacePath,
        turns,
        originalGoal,
        carriedSummary,
        freshSession: context.freshSession,
        stepsRemaining: state.stepsRemaining - 1,
        proactive: state.proactive,
        retros: (workerAutopilotRetros[worker.id] ?? []).map((entry) => entry.note).reverse(),
        workspaceFacts: collectWorkerWorkspaceFacts(worker.runner.workspacePath),
        openRequests: listOpenRequests(openUserRequests, worker.id),
        plan,
        canExplore,
        explorationFindings: findingsThisStep,
        stallSignals,
      });
      lastPrompt = prompt;
      try {
        // 量測：接回延遲的大頭是這通決策呼叫——落檔總耗時＋prompt 長度＋用的模型，供診斷「冷啟 vs 推論」。
        const decisionStart = Date.now();
        appendRuntimeLog(config.dataDirectory, `autopilot decision call start`, { worker: worker.runner.name, provider: runtime.provider, model: decisionModel, promptChars: prompt.length, exploreRounds });
        const text = (await runDetachedTurn(runtime.provider, worker.runner.workspacePath, decisionModel, undefined, null, prompt, 150_000, { kind: "no_tools" }, workerHome)).text;
        appendRuntimeLog(config.dataDirectory, `autopilot decision call done`, { worker: worker.runner.name, model: decisionModel, ms: Date.now() - decisionStart, replyChars: text.length });
        // 呼叫成功即清失敗連勝（無論 parse 結果）——退避追蹤的是「模型叫不動」，不是格式。
        workerAutopilotRetry.resolve(worker.id);
        decision = parseWorkerAutopilotDecision(text);
        if (!decision) {
          // 格式修復重問（一次）：把被拒的具體原因附回去。以前 parse 失敗被當成「正常結束」
          // 靜默收場，一次格式抖動就浪費整輪循環。
          const failure = explainWorkerAutopilotFailure(text) ?? "unrecognized reply";
          const repaired = (await runDetachedTurn(runtime.provider, worker.runner.workspacePath, decisionModel, undefined, null, workerAutopilotRepairPrompt(prompt, failure), 150_000, { kind: "no_tools" }, workerHome)).text;
          decision = parseWorkerAutopilotDecision(repaired);
          if (!decision) {
            if (!workerAutopilotByWorker.has(worker.id) || !workers.has(worker.id)) return;
            disableWorkerAutopilotWithNote(worker, t("⛔ 自動循環已停止：決策模型連續兩次未能給出有效的下一步格式（{error}）。", { error: explainWorkerAutopilotFailure(repaired) ?? failure }));
            return;
          }
        }
      } catch (error) {
        // 一次失敗不熄火（比照 boss 層拔「失敗即停」）：登記退避，15s 保底掃描依退避重試；
        // 用量受限期間掃描端先探測、不消耗次數。連續用盡才停，且明確通知，不靜默。
        if (!workerAutopilotByWorker.has(worker.id) || !workers.has(worker.id)) return;
        const firstFailure = !workerAutopilotRetry.get(worker.id);
        workerAutopilotRetry.note(worker.id, null, Date.now());
        if (firstFailure) {
          // 登入過期（OAuth refresh 失敗）不是模型壞了——明講要重新登入，免得被誤認成換模型造成的故障。
          const message = (error as Error).message;
          const text = /OAuth|authenticat|not logged in|log ?in/i.test(message)
            ? t("🔑 自動循環：Claude 登入已過期（{error}）。請重新登入這位 NPC 用的帳號；登入恢復後循環會自動重試接續。", { error: message })
            : t("⏳ 自動循環：決策模型暫時失敗（{error}），將自動退避重試；連續失敗才會停止。", { error: message });
          record(worker, { type: "user_message", text, notice: true });
          broadcast({ type: "worker_updated", worker: workerSummary(worker) });
        }
        return;
      }
      // 生成期間開關可能被關掉、NPC 可能被刪除——都不再動任何東西。
      if (!workerAutopilotByWorker.has(worker.id) || !workers.has(worker.id)) return;
      // 活計畫（支柱 A）：把教練回傳的更新後計畫併回並落盤（探索輪與定稿輪都併，跨回合不歸零）。
      if (decision.planUpdate !== undefined) {
        plan = mergeWorkerAutopilotPlan(plan, decision.planUpdate, plan.updatedRound + 1).plan;
        saveWorkerAutopilotPlan(worker.id, plan);
      }
      if (decision.action !== "explore") break;
      // 支柱 B 第二段：真的去查——唯讀查詢回合（WebSearch/WebFetch 真上網＋Read/Grep 讀檔＋
      // allowSafeShell 跑唯讀安全指令如 npm test/tsc），危險指令由 queryToolPolicy+通道 E 擋死。
      exploreRounds += 1;
      record(worker, { type: "user_message", text: t("🔎 查證：{query}", { query: decision.query }), notice: true });
      broadcast({ type: "worker_updated", worker: workerSummary(worker) });
      let finding: WorkerAutopilotFinding;
      try {
        const exploreText = (await runDetachedTurn(
          runtime.provider, worker.runner.workspacePath, decisionModel, undefined, null,
          workerAutopilotExplorePrompt({ workerName: worker.runner.name, workspaceLabel: worker.runner.workspacePath, query: decision.query, originalGoal }),
          150_000,
          { kind: "read_only_query", allowedTools: [], allowSafeShell: true },
          workerHome,
        )).text;
        finding = parseExplorationFindings(exploreText, decision.query);
      } catch (error) {
        // 探索失敗不熄火：記一條 low 信心「查不到」，讓決策照樣用現有資訊決定，不整輪浪費。
        finding = { query: decision.query, summary: t("（探索失敗：{error}）", { error: (error as Error).message }), confidence: "low", sources: [] };
      }
      findingsThisStep.push(finding);
      if (!workerAutopilotByWorker.has(worker.id) || !workers.has(worker.id)) return;
    }
    const live = workerAutopilotByWorker.get(worker.id);
    if (!live || !workers.has(worker.id)) return;
    // 進步護欄：跟最近幾步實質相同的指示一律轉成誠實停止（機制三），不燒 NPC 的步數。
    if (decision) decision = workerAutopilotProgressGuard(decision, turns);
    // 計畫感知護欄（支柱 A 結構面）：用完整 tried 清單抓長程繞圈——第 N 回合又提早已試過的做法即停。
    if (decision) decision = workerAutopilotPlanProgressGuard(decision, plan);
    // 教練回報「已真正處理完」的使用者請求即結案（resolve 語義 (a)）——指的是先前回合已完成的工作，
    // 與這步是否送出無關，故在此committed decision 一有就結案。
    // owner 授權：循環開著時，可逆的選項分岔由教練自己分析選最佳、繼續跑（不停下來等人）。
    // 只重問一次；花錢／不可逆／owner 私有資料（gate authorization/owner_data）不在此列，照樣暫停等回覆。
    if (decision && workerAutopilotShouldAutoPick(decision) && decision.action === "stop" && lastPrompt) {
      appendRuntimeLog(config.dataDirectory, "autopilot auto-pick", { worker: worker.runner.name, gate: decision.gate ?? null });
      try {
        const pickedText = (await runDetachedTurn(runtime.provider, worker.runner.workspacePath, decisionModel, undefined, null, workerAutopilotAutoPickPrompt(lastPrompt, decision.reason), 150_000, { kind: "no_tools" }, workerHome)).text;
        if (!workerAutopilotByWorker.has(worker.id) || !workers.has(worker.id)) return;
        const picked = parseWorkerAutopilotDecision(pickedText);
        if (picked && picked.action !== "explore") {
          if (picked.planUpdate !== undefined) {
            plan = mergeWorkerAutopilotPlan(plan, picked.planUpdate, plan.updatedRound + 1).plan;
            saveWorkerAutopilotPlan(worker.id, plan);
          }
          decision = workerAutopilotPlanProgressGuard(workerAutopilotProgressGuard(picked, turns), plan);
          appendRuntimeLog(config.dataDirectory, "autopilot auto-pick result", { worker: worker.runner.name, action: decision.action, picked: decision.action === "continue" ? decision.choice?.picked ?? null : null });
        }
      } catch (error) {
        // 自選呼叫失敗：退回原本的「問 owner」→ 下面會暫停等回覆，不熄火。
        appendRuntimeLog(config.dataDirectory, "autopilot auto-pick failed", { worker: worker.runner.name, error: (error as Error).message });
      }
    }
    if (decision && decision.action !== "explore") resolveCapturedRequests(worker.id, decision.resolvedRequestIds);
    // 真的需要 owner（花錢／不可逆／對外／私有資料）：暫停而非結束——開關留著、不扣步數、不補收尾回合，
    // owner 一回覆就自動接著跑（目標、計畫、剩餘步數都保留）。
    if (decision && decision.action === "stop" && decision.kind === "ask") {
      const live2 = workerAutopilotByWorker.get(worker.id);
      if (!live2) return;
      const options = parseAutopilotAskOptions(decision.reason);
      live2.paused = { question: decision.reason, options, at: Date.now(), ...(decision.gate ? { gate: decision.gate } : {}) };
      persistWorkerAutopilotStates();
      appendRuntimeLog(config.dataDirectory, "autopilot paused for owner", { worker: worker.runner.name, gate: decision.gate ?? null });
      record(worker, { type: "user_message", text: workerAutopilotPausedNote(decision.reason, decision.gate), notice: true, autopilotAsk: true, askOptions: options });
      broadcast({ type: "worker_updated", worker: workerSummary(worker) });
      return;
    }
    if (!decision || decision.action !== "continue") {
      if (decision && decision.action === "stop" && decision.retro) saveWorkerAutopilotRetro(worker.id, decision.retro);
      const reason = decision && decision.action === "stop" ? decision.reason : "";
      // 停止類型決定註記措辭與要不要標成「循環問你」卡（見 workerAutopilotStopNote）：
      // done＝達標不打擾、ask/stuck＝問題卡＋一鍵選項；沒給類型的舊輸出沿用「有理由就問你」。
      const stopNote = workerAutopilotStopNote({ kind: decision && decision.action === "stop" ? decision.kind : undefined, reason, plan });
      const ask = stopNote.ask ? { options: parseAutopilotAskOptions(reason) } : undefined;
      // 教練判定做完而停＝正常停：和撞上限一樣補一份四段收尾交接（看得懂＋怎麼接），
      // 有待拍板的決定時停止註記照樣帶一鍵選項卡。只有「出錯停」才不補交接。
      concludeWorkerAutopilotWithHandoff(worker, stopNote.note, ask);
      return;
    }
    // 決策期間使用者可能搶先發話或排了佇列：放棄這步（不扣步數），循環留著等下個回合結束再想。
    if (worker.runner.busy || store.listQueue(worker.id).length > 0) return;
    live.stepsRemaining -= 1;
    persistWorkerAutopilotStates();
    // 最後一步的決策帶著整輪復盤——存起來讓下一輪循環從這裡往上爬（機制一）。
    if (live.stepsRemaining <= 0 && decision.retro) saveWorkerAutopilotRetro(worker.id, decision.retro);
    // 刻意不把「剩 N 步」寫進給 NPC 的指令：讓 NPC 看到倒數會誘發「交券效應」——快沒步數時提早草草
    // 收尾、為了在上限前交東西而非真推進。步數只留在引擎內部當安全界限；NPC 靠教練判斷真完成才停。
    // 完成標準附在指示尾端：NPC 知道做到什麼算完成，下一步教練據此驗收（prevMet）。
    const text = t("🔁（自動循環）{instruction}", { instruction: workerAutopilotInstructionWithCriterion(decision.instruction, decision.doneWhen) });
    record(worker, { type: "user_message", text, autopilot: true });
    try {
      worker.runner.send(text, [], []);
      broadcast({ type: "worker_status", workerId: worker.id, busy: true });
    } catch (error) {
      disableWorkerAutopilotWithNote(worker, t("⛔ 自動循環已停止：無法送出下一步（{error}）。", { error: (error as Error).message }));
      return;
    }
    // 階梯可見化：教練每步都判斷「工作站在哪一階」，只進決策不給主人看太可惜。
    // notice 型訊息只顯示、不進 NPC session、也不進 recentWorkerAutopilotTurns 的回合彙整。
    // 一句話進度：上一步驗收 · 所在階 · 這步推進什麼 · 完成標準（見 workerAutopilotStepNotice）。
    // 教練替 owner 選了分岔：留一則看得懂的紀錄（選了什麼、為什麼），owner 回來想改直接回一句。
    if (decision.choice) record(worker, { type: "user_message", text: workerAutopilotChoiceNotice(decision.choice), notice: true });
    const stepNotice = workerAutopilotStepNotice(decision);
    if (stepNotice) record(worker, { type: "user_message", text: stepNotice, notice: true });
    broadcast({ type: "worker_updated", worker: workerSummary(worker) });
  } finally {
    workerAutopilotAdvancing.delete(worker.id);
  }
}

// 自動循環保底掃描（P1-2）：turn_end 讓路後（協作／交接／Mission／換腦）那些流程結束
// 不一定伴隨這位 NPC 的 turn_end，循環會武裝著卻停擺；決策失敗的退避重試（P1-1）也靠
// 這班掃。決策抽純函式 workerAutopilotSweepAction。無武裝循環時零成本。
function sweepWorkerAutopilot(): void {
  const now = Date.now();
  for (const [workerId, state] of workerAutopilotByWorker) {
    const worker = workers.get(workerId);
    const action = workerAutopilotSweepAction({
      present: !!worker,
      paused: !!state.paused,
      busy: worker?.runner.busy ?? false,
      queued: worker ? store.listQueue(workerId).length > 0 : false,
      yielding: worker
        ? (handoffInProgress(worker) || collaborationInProgress(workerId) || missionInProgress(workerId)
          || pendingSwapSummaries.has(workerId) || brainSwapPending.has(workerId))
        : false,
      advancing: workerAutopilotAdvancing.has(workerId) || workerAutopilotProbing.has(workerId),
      stepsRemaining: state.stepsRemaining,
      deadlinePassed: !!(state.deadlineAt && now >= state.deadlineAt),
      retry: {
        registered: !!workerAutopilotRetry.get(workerId),
        due: workerAutopilotRetry.due(workerId, now),
        exhausted: workerAutopilotRetry.exhausted(workerId),
      },
    });
    if (action === "wait") continue;
    if (action === "drop" || !worker) {
      workerAutopilotByWorker.delete(workerId);
      workerAutopilotRetry.resolve(workerId);
      persistWorkerAutopilotStates();
      continue;
    }
    if (action === "disable_steps") { disableWorkerAutopilotWithNote(worker, t("✅ 自動循環已達步數上限，自動停止。要繼續就再打開開關。")); continue; }
    if (action === "disable_deadline") { disableWorkerAutopilotWithNote(worker, t("✅ 自動循環已達時間上限，自動停止。要繼續就再打開開關。")); continue; }
    if (action === "exhausted") {
      disableWorkerAutopilotWithNote(worker, t("⛔ 自動循環已停止：決策模型連續失敗 {n} 次；處理後可再打開開關。", { n: WORKER_AUTOPILOT_RETRY_POLICY.maxAttempts }));
      continue;
    }
    // advance：失敗重試型先探測用量——受限期間不消耗次數（比照 dept-create 的
    // 「條件未恢復不花次數」語義）；一般停擺型直接補觸發。
    if (workerAutopilotRetry.get(workerId)) {
      workerAutopilotProbing.add(workerId);
      void (async () => {
        try {
          const runtime = resolveWorkerDecisionRuntime(worker);
          if (!("error" in runtime)) {
            const usage = await refreshWorkerDecisionUsage(worker, runtime.provider);
            if (usageBlockReason(runtime.provider, usage, runtime.model)) return;
          }
          workerAutopilotRetry.begin(workerId, Date.now());
          const live = workerAutopilotByWorker.get(workerId);
          if (live && workers.has(workerId)) await advanceWorkerAutopilot(worker, live);
        } catch (error) {
          console.error("[worker-autopilot] 重試探測失敗:", error);
        } finally {
          workerAutopilotProbing.delete(workerId);
        }
      })();
    } else {
      void advanceWorkerAutopilot(worker, state);
    }
  }
}

app.get("/api/workers/:id/autopilot", (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) { res.status(404).json({ error: t("找不到 NPC") }); return; }
  res.json({ ok: true, autopilot: workerAutopilotSnapshot(worker.id) });
});

app.post("/api/workers/:id/autopilot", (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) { res.status(404).json({ error: t("找不到 NPC") }); return; }
  const enabled = Boolean(req.body?.enabled);
  if (enabled) {
    if (worker.ephemeralKind) { res.status(409).json({ error: t("臨時 NPC 不能開自動循環") }); return; }
    // 開之前先確認決策模型可用，別讓開關開了卻在第一步就默默熄火（比照 BOSS 循環端點）。
    // 用 account-aware 版本：指定帳號可用時就能開，不被共用登入狀態綁死。
    const runtime = resolveWorkerDecisionRuntime(worker);
    if ("error" in runtime) { res.status(503).json({ error: runtime.error }); return; }
  }
  const maxSteps = enabled && Number.isFinite(req.body?.maxSteps) ? Number(req.body.maxSteps) : undefined;
  const maxMinutes = enabled && Number.isFinite(req.body?.maxMinutes) ? Number(req.body.maxMinutes) : undefined;
  // 主動模式預設開（owner 回饋：開循環的本意就是「持續思考下一步發展」，不是把當前線收尾就停）。
  // 非主動（收尾型）改成明確傳 proactive:false 才啟用。
  const proactive = enabled && req.body?.proactive !== false;
  const goalText = enabled && typeof req.body?.goal === "string" ? req.body.goal : undefined;
  setWorkerAutopilot(worker, enabled, maxSteps, maxMinutes, proactive, goalText);
  // 開啟當下 NPC 若閒著：立即想第一步（只靠 turn_end 觸發的話，開了會毫無反應）。
  const state = workerAutopilotByWorker.get(worker.id);
  if (enabled && state && !worker.runner.busy && !workerAutopilotAdvancing.has(worker.id)
    && !handoffInProgress(worker) && !collaborationInProgress(worker.id) && !missionInProgress(worker.id)
    && !pendingSwapSummaries.has(worker.id) && store.listQueue(worker.id).length === 0) {
    void advanceWorkerAutopilot(worker, state);
  }
  res.json({ ok: true, autopilot: workerAutopilotSnapshot(worker.id) });
});

app.post("/api/workers/:id/autopilot/goal", (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) { res.status(404).json({ error: t("找不到 NPC") }); return; }
  const goal = typeof req.body?.goal === "string" ? req.body.goal.trim() : "";
  if (!goal) { res.status(400).json({ error: t("目標不能是空的") }); return; }
  if (!workerAutopilotByWorker.has(worker.id)) { res.status(409).json({ error: t("自動循環沒有開著") }); return; }
  updateWorkerAutopilotGoal(worker, goal);
  res.json({ ok: true, autopilot: workerAutopilotSnapshot(worker.id) });
});

app.get("/api/boss-tasks", (req, res) => {
  const requested = collaborationText(req.query.workspacePath, 1_000);
  let workspacePath: string | undefined;
  if (requested) {
    try { workspacePath = normalizeManagedWorkspacePath(requested); }
    catch (error) { res.status(400).json({ error: (error as Error).message }); return; }
  }
  res.json({ bossTasks: store.listBossTasks(workspacePath ? registryKey(workspacePath) : undefined).map(bossTaskForDisplay) });
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
  // 立即回應：探索（決策模型）或建專屬部門都可能跑十幾秒以上，不讓建立端點同步阻塞到前端逾時、看起來像卡住。
  // 任務已存為 discovering 並廣播；之後每次狀態改變都經 persistBossTask → broadcast 由 WebSocket 推給前端。
  res.status(201).json({ bossTask: bossTaskForDisplay(task) });
  // 「為此交辦開專屬部門」：走直接建部門路徑，跳過決策模型路由（省 token、不卡既有部門）。背景執行。
  void (req.body?.dedicatedDepartment ? runDedicatedDepartmentTask(task) : decideBossTask(task))
    .catch((error) => {
      // decideBossTask / runDedicatedDepartmentTask 內部已處理常見錯誤並廣播；這裡只兜住未預期的丟出，
      // 避免任務永遠卡在 discovering。
      console.error(`[boss-task] 背景探索意外失敗 ${task.id}:`, error);
      if (task.status === "discovering") {
        task.status = "needs_attention";
        task.error = (error as Error).message || t("探索失敗");
        task.messages.push(bossTaskMessage("system", t("⛔ 探索失敗：{error}", { error: task.error })));
        persistBossTask(task);
      }
    });
});

app.patch("/api/boss-tasks/:id", (req, res) => {
  const task = store.getBossTask(req.params.id);
  if (!task) { res.status(404).json({ error: t("找不到 Boss Task") }); return; }
  const patchError = applyBossTaskRecordPatch(task, req.body ?? {});
  if (patchError) {
    res.status(patchError.includes("不能封存") ? 409 : 400).json({ error: patchError });
    return;
  }
  // 封存＝使用者收工，把這個交辦的臨時團隊解散（不再追問了）。
  if (task.archivedAt) disbandTaskEphemeralDepartments(task);
  persistBossTask(task);
  res.json({ bossTask: bossTaskForDisplay(task) });
});

app.delete("/api/boss-tasks/:id", (req, res) => {
  const task = store.getBossTask(req.params.id);
  if (!task) { res.status(404).json({ error: t("找不到 Boss Task") }); return; }
  // 可刪除：終態(完成/失敗/取消)＋「等你處理」的卡住狀態(needs_attention/needs_input)——
  // 那些沒有背景在跑，卡著也刪不掉會很煩。只有真正執行中(discovering/ready/running/
  // synthesizing)才擋，避免刪掉正在跑的任務。
  if (!["completed", "failed", "cancelled", "needs_attention", "needs_input"].includes(task.status)) {
    res.status(409).json({ error: t("進行中的 Boss Task 不能刪除；請等它完成或先取消") });
    return;
  }
  disbandTaskEphemeralDepartments(task); // 刪除交辦＝連它的臨時團隊一起收掉
  autopilotFired.delete(task.id); // 任務不存在了，觸發標記與接手計數一併回收
  autopilotResolveAttempts.delete(task.id);
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
  // 只擋「本程序真的有背景在跑」的探索/驗收；重啟殭屍（狀態卡著但工作已隨重啟蒸發）放行，
  // 讓手動重開能救——否則 409 連人工都解不了（卡點盤點 P0）。
  if (restartBlockedByActiveWork({
    status: task.status,
    discoveryInFlight: bossTaskDiscoveryWork.inFlight(task.id),
    synthesisInFlight: bossTaskFinalizing.has(task.id),
  })) { res.status(409).json({ error: t("Boss 正在整理交辦內容，請稍後再重開") }); return; }
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
  // 重新交辦＝新的一輪：清掉上一輪的自動循環觸發標記與接手計數，讓新一輪的終態能正常進 hook。
  autopilotFired.delete(task.id);
  autopilotResolveAttempts.delete(task.id);
  task.messages.push(bossTaskMessage("system", t("已清空原本交辦並重新規劃；附件與稽核紀錄已保留。"), [], null, null, timestampAfter(clearedAt)));
  persistBossTask(task);
  await decideBossTask(task);
  res.json({ bossTask: bossTaskForDisplay(task), ...preview });
});

// 老闆手動中止交辦：取消所有進行中的部門 Mission、標記交辦為已取消、解散臨時團隊。
// 給前端一顆一鍵「中止」按鈕用——不必再繞進部門任務面板找 Mission 取消。
app.post("/api/boss-tasks/:id/cancel", (req, res) => {
  const task = store.getBossTask(req.params.id);
  if (!task) { res.status(404).json({ error: t("找不到 Boss Task") }); return; }
  if (["completed", "failed", "cancelled"].includes(task.status)) {
    res.status(409).json({ error: t("Boss Task 已結束，不需要中止") });
    return;
  }
  const scope = bossTaskRestartScope(task);
  for (const mission of scope.activeMissions) cancelMissionForScopedRestart(mission);
  for (const stage of task.stages) {
    if (stage.status === "running" || stage.status === "pending") stage.status = "cancelled";
  }
  task.status = "cancelled";
  task.error = null;
  task.completedAt = new Date().toISOString();
  task.messages.push(bossTaskMessage("system", t("⛔ 交辦已由老闆手動中止；進行中的部門工作已停止，臨時團隊已解散。")));
  persistBossTask(task);
  ephemeralCleanupHook(task);
  res.json({ ok: true, bossTask: bossTaskForDisplay(task) });
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
  // `/clear` is a provider-neutral conversation control. Handle it before a
  // runner sees the message, so it cannot be interpreted as a skill.
  if (matchNativeCommand(message) === "clean" || (
    images.length === 0
    && documents.length === 0
    && isClearCommand(message)
  )) {
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
    // 追問前先記住這張交辦是否由「專屬部門」執行——是的話追問要回到同一隊
    //（或重建同型的隊），不能丟回決策模型路由去打擾其他部門。
    const hadDedicatedCrew = task.stages.some((stage) => stage.departmentName?.startsWith(EPHEMERAL_DEPT_PREFIX));
    const liveDedicatedId = task.stages.map((stage) => stage.departmentId).find((id) => ephemeralDepartments.has(id)) ?? null;
    task.stages = [];
    task.finalReport = null;
    task.completedAt = null;
    // 追問＝新的一輪：清掉上一輪的循環觸發標記與接手計數，新一輪完成時自動循環才會再推進。
    autopilotFired.delete(task.id);
    autopilotResolveAttempts.delete(task.id);
    if (hadDedicatedCrew) {
      task.status = "discovering";
      task.error = null;
      persistBossTask(task);
      await runDedicatedFollowUp(task, message || t("請依附加檔案處理後續工作"), liveDedicatedId);
      res.json({ bossTask: bossTaskForDisplay(task) });
      return;
    }
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
  res.json({ missions: store.listDepartmentMissions(workspacePath ? registryKey(workspacePath) : undefined) });
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

// Mission 中斷處理的核心規則：/api/missions/:id/resolve 與自動循環的「自動接手」共用，
// 兩邊行為必須一致（同樣的守衛、同樣的步驟重置與派工）。回傳 error 即失敗（附 HTTP 狀態碼）。
function applyMissionResolution(
  mission: DepartmentMission,
  action: string,
  guidance: string,
  workerId = "",
): { status: number; error?: string } {
  if (!(["needs_attention", "failed"] as DepartmentMission["status"][]).includes(mission.status) || mission.attentionReason === "plan_approval") {
    return { status: 409, error: t("這個 Mission 目前沒有可處理的中斷") };
  }
  const reserved = workspaceMission(mission.workspacePath, mission.departmentId);
  if (mission.status === "failed" && reserved && reserved.id !== mission.id) {
    return { status: 409, error: t("同一工作位置已有進行中的 Department Mission") };
  }
  if (guidance) mission.ownerGuidance = guidance;
  if (action === "retry" && mission.steps.length === 0) {
    const error = retryMissionPlanning(mission);
    return error ? { status: 409, error } : { status: 202 };
  }
  const currentIndex = mission.currentStepIndex;
  const current = currentIndex == null ? null : mission.steps[currentIndex];
  if (!current || currentIndex == null) {
    return { status: 409, error: t("Mission 找不到可恢復的步驟") };
  }
  if (action === "accept_risk") {
    if (current.kind !== "review" || !current.reviewResult) {
      return { status: 409, error: t("只有已有結果的 Review 才能接受風險繼續") };
    }
    current.status = "completed";
    mission.attentionReason = null;
    mission.error = guidance ? t("老闆接受風險：{guidance}", { guidance }) : t("老闆已接受目前 Review 風險");
    store.saveDepartmentMission(mission);
    broadcastMission(mission);
    completeMissionStep(mission, currentIndex);
    return { status: 202 };
  }
  let targetIndex = currentIndex;
  if (action === "retry_execute" || action === "guide") {
    if (current.kind === "review") {
      const executeIndex = precedingExecuteIndex(mission, currentIndex);
      if (executeIndex == null) return { status: 409, error: t("找不到可重試的 Execute 步驟") };
      targetIndex = executeIndex;
      current.status = "pending";
      current.completedAt = null;
    } else if (current.kind !== "execute") {
      return { status: 409, error: t("目前步驟不能退回 Execute") };
    }
  } else if (action === "reassign") {
    const replacement = workers.get(workerId);
    if (!replacement || !sameWorkspacePath(replacement.runner.workspacePath, mission.workspacePath)) {
      return { status: 409, error: t("只能重新指派給同部門 NPC") };
    }
    const preceding = current.kind === "review" ? precedingExecuteIndex(mission, currentIndex) : null;
    if (preceding != null && mission.steps[preceding]?.assigneeWorkerId === workerId) {
      return { status: 409, error: t("Review 必須由與 Execute 不同的 NPC 負責") };
    }
    current.assigneeWorkerId = workerId;
  } else if (action !== "retry") {
    return { status: 400, error: t("不支援的 Mission 處理方式") };
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
  return { status: 202 };
}

app.post("/api/missions/:id/resolve", (req, res) => {
  const mission = activeMissions.get(req.params.id) ?? store.getDepartmentMission(req.params.id);
  if (!mission) { res.status(404).json({ error: t("找不到 Department Mission") }); return; }
  const action = String(req.body?.action ?? "");
  const guidance = collaborationText(req.body?.guidance, 2_000);
  const outcome = applyMissionResolution(mission, action, guidance, String(req.body?.workerId ?? ""));
  if (outcome.error) { res.status(outcome.status).json({ error: outcome.error }); return; }
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
  noReviewMissions.delete(mission.id);
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
  if (workerAutopilotByWorker.delete(worker.id)) persistWorkerAutopilotStates(); // NPC 沒了，個人循環狀態一併回收
  if (workerAutopilotRetros[worker.id]) { delete workerAutopilotRetros[worker.id]; workerAutopilotRetroStore.save(workerAutopilotRetros); }
  repairDepartmentAfterMemberLeaves(departmentId, worker.id);
  broadcast({ type: "worker_removed", workerId: worker.id });
  res.json({ ok: true });
  if (avatarId) await deleteAvatarIfUnused(avatarId);
});

// ============ War Room（作戰室）orchestrator ============
// 一場「真辯論（表態→反駁 2 輪）＋依難度配模型＋主持裁決」的顧問議會。peers 是可見的臨時 worker
// （ephemeralKind: "warroom"，前端據此把它們拉到會議桌圍坐；persist:false），跑完寬限期自動刪除。
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
  scheduleWarroomQueuePump(); // 臨時成員離場＝席位釋出，看看排隊的作戰室能不能開場
}

// 作戰室上桌的角色：使用者有自訂角色（⚙ 面板）就用自訂的，否則依難度配。所需臨時席＝角色數＋主持。
function resolveWarroomStances(difficulty: WarRoomDifficulty, customStances: WarRoomStance[]): WarRoomStance[] {
  return customStances.length >= 2 ? customStances : warroomStances(difficulty);
}

async function runWarroom(topic: string, difficulty: WarRoomDifficulty, workspacePath: string, provider: ProviderId, accountId: string | null, stances: WarRoomStance[], context = ""): Promise<WarRoomResult> {
  const { peer: peerModel, lead: leadModel } = warroomModels(provider, difficulty);
  const timeoutMs = difficulty === "hard" ? 240_000 : 150_000;
  const deadlineAt = Date.now() + WARROOM_TOTAL_TIMEOUT_MS;
  const created: Worker[] = [];
  let costMicros = 0;
  let completed = false;
  // 上桌人數與輪數隨難度伸縮：簡單 2 人 1 輪（快又省）、中等 3 人 2 輪、困難 4 人（含查證方）2 輪。
  // 使用者有自訂角色（⚙ 面板）就用自訂的（由呼叫端 resolveWarroomStances 決定），輪數仍照難度。
  const rounds = difficulty === "simple" ? 1 : 2;
  // 席位不夠開完整一場（全部成員＋主持）就直接說清楚，不要默默少開人、拿殘缺辯論去裁決。
  // 正常路徑由 /api/warroom 的排隊閘門保證席位夠了才會走到這裡；這裡是最後一道防線。
  if (ephemeralSeatsLeft() < stances.length + 1) {
    throw new Error(t("作戰室需要 {n} 個臨時席位，但辦公室目前已滿。請先移除幾位閒置的 NPC，或等其他作戰室散會後再開。", { n: stances.length + 1 }));
  }
  reservedEphemeralSeats += 1; // 主持的席位，主持上桌或本場結束時歸還
  let leadSeatReserved = true;
  const releaseLeadSeat = () => {
    if (!leadSeatReserved) return;
    leadSeatReserved = false;
    reservedEphemeralSeats -= 1;
  };
  try {
    for (const stance of stances) {
      if (ephemeralSeatsLeft() <= 0) break; // 主持的席位已預留
      const peer = createWorker(stance.name, peerModel, provider, workspacePath, undefined, null, null, { warmup: true, persist: false, broadcast: true, ephemeralKind: "warroom" }, accountId);
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
      warroomSend(worker, warroomOpeningPrompt({ topic, stanceBrief: stances[i].brief, context }), warroomTurnTimeout(timeoutMs, deadlineAt))));
    const r1texts = r1.map((s) => s.status === "fulfilled" ? warroomEventText(s.value) : "");
    for (const s of r1) if (s.status === "fulfilled") costMicros += warroomEventCost(provider, s.value);
    // 全員第一輪都沒能發言（額度滿、供應商掛…）→ 整場中止，別拿空辯論去「裁決」。
    // 丟錯誤會讓外層 500 回報、不存檔、不回報 host，前端会看到明確錯誤而不是垃圾結論。
    if (r1texts.every((text) => !text.trim())) {
      throw new Error(t("作戰室成員全數未能發言（可能是使用額度已滿或供應商故障），本場中止。請稍後再試。"));
    }
    warroomTurnTimeout(1, deadlineAt);
    // 第 2 輪：看到彼此意見後互相反駁（真辯論）。簡單題只跑 1 輪，直接拿表態去裁決；
    // 第 1 輪全員判斷已一致（GO/HOLD/NO 相同、且無查證席）也省略，直接裁決——省一整輪。
    let r2texts: string[] = peers.map(() => "");
    const seated = stances.slice(0, peers.length);
    const earlyConsensus = rounds >= 2 && !warroomRebuttalNeeded(seated, r1texts);
    // 各方第 1 輪的底線落檔，事後才查得出「為什麼這場沒省到反駁輪」。
    appendRuntimeLog(config.dataDirectory, "warroom round-1 positions", {
      positions: seated.map((stance, i) => `${stance.key}:${parseWarroomPosition(r1texts[i]) ?? "-"}`).join(" "),
      earlyConsensus,
    });
    if (rounds >= 2 && !earlyConsensus) {
      // 每人只看「別人」的第 1 輪：自己的主張已在同一個 session 裡，不重送。
      // 第 1 輪沒發言成功（多半是逾時、還在跑）的成員不送反駁：它手上那回合還沒結束，
      // 再送只會撞忙碌或白等到逾時，實測會把整場拖過 5 分鐘。
      const r2 = await Promise.allSettled(peers.map((worker, i) => !r1texts[i].trim()
        ? Promise.reject(new Error("skipped: no opening"))
        : warroomSend(worker, warroomRebuttalPrompt({ stanceBrief: stances[i].brief, othersDebate: warroomOthersDigest(seated, r1texts, i) }), warroomTurnTimeout(timeoutMs, deadlineAt))));
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
    releaseLeadSeat();
    if (ephemeralSeatsLeft() > 0) {
      const lead = createWorker(t("主持"), leadModel, provider, workspacePath, undefined, null, null, { warmup: true, persist: false, broadcast: true, ephemeralKind: "warroom" }, accountId);
      lead.autoApproveMode = "safe";
      created.push(lead);
      await waitForWarroomWarmup(1_200, deadlineAt);
      const ev = await warroomSend(lead, warroomSynthesisPrompt({ topic, debate, context, peerCount: peers.length, rounds, earlyConsensus }), warroomTurnTimeout(timeoutMs, deadlineAt));
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
    result.rounds = rounds >= 2 && !earlyConsensus ? 2 : 1;
    if (earlyConsensus) result.earlyConsensus = true;
    completed = true;
    return result;
  } finally {
    releaseLeadSeat();
    scheduleWarroomQueuePump(); // 主持席歸還（失敗時成員也已立即清掉），讓排隊中的下一場有機會開
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
    warroomHostConfidenceNote(result) +
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
    warroomReportExtras(result) +
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
async function triageDifficulty(topic: string, workspacePath: string, provider: ProviderId, homeDir?: string | null): Promise<WarRoomDifficulty> {
  try {
    const { text } = await runDetachedTurn(provider, workspacePath, warroomModels(provider, "simple").peer, undefined, null,
      t("判斷這個討論主題的難度，只回一個英文單詞：simple（常識/簡單）、medium（需要一些分析）、hard（架構/專業/多方權衡）。規則：只要主題涉及「即時資訊」（今日行情、天氣、新聞、現價…需要上網查證的），至少回 medium，不可回 simple——因為查證需要較可靠的模型執行。不要多寫。\n主題：{topic}", { topic }),
      30_000, { kind: "no_tools" }, homeDir ?? undefined);
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

// ===== 作戰室排隊：臨時席位不夠時改排 FIFO 佇列，席位釋出自動開場（純邏輯在 warroomQueue.ts） =====
// - 排隊中的請求不佔席位；開場那一刻才同步建立成員、預留主持席（runWarroom 開頭到第一個 await 前）。
// - 排隊的請求 POST 立即回 202 { queued, ticketId, ahead }；前端用 GET /api/warroom/queue/:ticketId
//   輪詢名次／開場／結果，DELETE 同一路徑取消排隊（已開場就不能取消）。
// - 佇列與票據只存在記憶體：server 重啟後全部失效，前端輪詢會拿到 404 並請使用者重新開場。
//   已開場的那場本來就會被重啟中斷（殘留的臨時 NPC 由啟動清理處理），不另外持久化。
type WarroomJob = {
  topic: string;
  difficulty: WarRoomDifficulty;
  workspacePath: string;
  provider: ProviderId;
  hostWorkerId: string;
  stances: WarRoomStance[];
  context: string;
};
type WarroomTicket =
  | { state: "queued"; seats: number }
  | { state: "running"; seats: number }
  | { state: "done"; seats: number; result: WarRoomResult; difficulty: WarRoomDifficulty; finishedAt: number }
  | { state: "failed" | "cancelled"; seats: number; error: string; finishedAt: number };
// 結束的票據留一段時間給前端來拿結果；之後就回收，避免記憶體慢慢長大。
const WARROOM_TICKET_KEEP_MS = 30 * 60_000;
const warroomQueue = new WarroomQueue<WarroomJob>();
const warroomTickets = new Map<string, WarroomTicket>();
let warroomQueuePumpPending = false;
let warroomQueueSweepTimer: ReturnType<typeof setInterval> | null = null;

// 一場作戰室從開場到收尾（存檔＋把精簡裁決交回召集人）。立即開場與排隊開場共用。
async function executeWarroomJob(job: WarroomJob): Promise<WarRoomResult> {
  const accountId = workers.get(job.hostWorkerId)?.accountId ?? null;
  const result = await runWarroom(job.topic, job.difficulty, job.workspacePath, job.provider, accountId, job.stances, job.context);
  const reportPath = saveWarroomReport(job.topic, job.difficulty, result, job.workspacePath); // 自動存檔（人不在也拿得到）
  // 閉環：把「精簡版」裁決貼回召集者（host NPC＝持久大腦），它接手執行；細節靠檔案指針。
  const hostMessage = formatWarroomVerdictForHost(job.topic, result, workers.get(job.hostWorkerId)?.runner.name ?? t("你"), reportPath);
  const liveHost = workers.get(job.hostWorkerId);
  if (liveHost?.runner.busy) {
    // 開會這幾分鐘召集人可能被派了別的事；以前會直接略過、裁決就此沒送到。改排進它的佇列，忙完自動接手。
    store.enqueueCommand(randomUUID(), liveHost.id, hostMessage, [], []);
    broadcastQueue(liveHost.id);
    scheduleQueueDrain(liveHost);
  } else {
    postToHost(job.hostWorkerId, hostMessage);
  }
  return result;
}

function warroomImpossibleMessage(seats: number): string {
  return t("作戰室需要 {n} 個臨時席位，但扣掉常駐 NPC 後最多只有 {max} 席，排隊也等不到。請減少自訂角色或移除幾位常駐 NPC。", {
    n: String(seats), max: String(Math.max(0, maxEphemeralSeats())),
  });
}

function finishWarroomTicket(id: string, ticket: WarroomTicket): void {
  warroomTickets.set(id, ticket);
  const now = Date.now();
  for (const [key, value] of warroomTickets) {
    if ((value.state === "done" || value.state === "failed" || value.state === "cancelled") && now - value.finishedAt > WARROOM_TICKET_KEEP_MS) {
      warroomTickets.delete(key);
    }
  }
}

// 席位可能釋出的時機（成員離場、主持席歸還、整場結束）都會呼叫；延到下一個 tick 再跑，
// 免得在 runWarroom「歸還主持席→立刻讓主持上桌」之間被排隊的下一場搶走那一席。
function scheduleWarroomQueuePump(): void {
  if (warroomQueue.size === 0 || warroomQueuePumpPending) return;
  warroomQueuePumpPending = true;
  setImmediate(() => {
    warroomQueuePumpPending = false;
    pumpWarroomQueue();
  });
}

function pumpWarroomQueue(): void {
  for (;;) {
    const step = warroomQueue.next(ephemeralSeatsLeft(), maxEphemeralSeats(), Date.now());
    for (const { item, reason } of step.dropped) {
      finishWarroomTicket(item.id, {
        state: "failed",
        seats: item.seats,
        finishedAt: Date.now(),
        error: reason === "expired"
          ? t("作戰室排隊超過 {minutes} 分鐘仍等不到席位，已自動取消；請稍後再開。", { minutes: String(WARROOM_QUEUE_MAX_WAIT_MS / 60_000) })
          : warroomImpossibleMessage(item.seats),
      });
    }
    const next = step.start;
    if (!next) break;
    if (!workers.get(next.payload.hostWorkerId)) {
      finishWarroomTicket(next.id, { state: "failed", seats: next.seats, finishedAt: Date.now(), error: t("召集的 NPC 已不在，排隊中的作戰室已取消") });
      continue;
    }
    const { id: ticketId, seats } = next;
    const difficulty = next.payload.difficulty;
    warroomTickets.set(ticketId, { state: "running", seats });
    appendRuntimeLog(config.dataDirectory, "warroom dequeued", { ticketId, seats, waitedMs: Date.now() - next.enqueuedAt });
    // runWarroom 在第一個 await 前就同步建好成員、預留主持席，所以下一圈拿到的剩餘席位已扣掉這場。
    executeWarroomJob(next.payload).then(
      (result) => finishWarroomTicket(ticketId, { state: "done", seats, result, difficulty, finishedAt: Date.now() }),
      (error) => finishWarroomTicket(ticketId, { state: "failed", seats, finishedAt: Date.now(), error: error instanceof Error ? error.message : t("作戰室執行失敗") }),
    );
  }
  syncWarroomQueueSweep();
}

// 保底輪詢：常駐 NPC 被刪除、委派研究員散場等「不經過作戰室」的席位釋出，以及排隊逾時，
// 都靠這個每 5 秒的檢查接住。佇列空了就停掉，不常駐跑。
function syncWarroomQueueSweep(): void {
  if (warroomQueue.size > 0 && !warroomQueueSweepTimer) {
    warroomQueueSweepTimer = setInterval(pumpWarroomQueue, 5_000);
    warroomQueueSweepTimer.unref?.();
  } else if (warroomQueue.size === 0 && warroomQueueSweepTimer) {
    clearInterval(warroomQueueSweepTimer);
    warroomQueueSweepTimer = null;
  }
}

app.post("/api/warroom", async (req, res) => {
  const topic = String(req.body?.topic ?? "").trim();
  if (!topic) { res.status(400).json({ error: t("請提供討論主題") }); return; }
  const requested = String(req.body?.difficulty);
  const hostWorkerId = typeof req.body?.hostWorkerId === "string" ? req.body.hostWorkerId : null;
  const host = hostWorkerId ? workers.get(hostWorkerId) : null;
  if (!host || !hostWorkerId) { res.status(400).json({ error: t("請從目前 NPC 開啟作戰室") }); return; }
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
  const stances = resolveWarroomStances(difficulty, sanitizeCustomStances(req.body?.stances));
  // 議題背景：召集人＋專案名＋召集人最近幾則對話（封頂 900 字），讓成員不必就字面空談。
  const context = warroomContextBrief({ hostName: host.runner.name, hostRole: host.persona?.role, workspacePath, events: host.history });
  const job: WarroomJob = { topic, difficulty, workspacePath, provider, hostWorkerId, stances, context };
  const seats = stances.length + 1; // 全部成員＋主持
  // 分級要等 LLM 回覆，期間席位可能變動；所以在 await 之後才判定開場／排隊，判定後同步開場。
  const admission = warroomQueue.admit(seats, ephemeralSeatsLeft(), maxEphemeralSeats());
  if (admission.kind === "impossible") {
    res.status(409).json({ error: warroomImpossibleMessage(seats) });
    return;
  }
  if (admission.kind === "full") {
    res.status(429).json({ error: t("作戰室排隊已滿（最多 {max} 場），請等前面幾場開完再試。", { max: String(warroomQueue.maxQueued) }) });
    return;
  }
  if (admission.kind === "queue") {
    const ticketId = randomUUID();
    const ahead = warroomQueue.enqueue(ticketId, seats, job, Date.now());
    warroomTickets.set(ticketId, { state: "queued", seats });
    appendRuntimeLog(config.dataDirectory, "warroom queued", { ticketId, seats, ahead, seatsLeft: ephemeralSeatsLeft() });
    syncWarroomQueueSweep();
    res.status(202).json({ ok: true, queued: true, ticketId, ahead, seats, difficulty });
    return;
  }
  try {
    const result = await executeWarroomJob(job);
    res.json({ ok: true, result, difficulty });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : t("作戰室執行失敗") });
  }
});

// 排隊票據：前端輪詢名次與結果。state＝queued（附 ahead）／running／done（附 result）／failed／cancelled。
app.get("/api/warroom/queue/:ticketId", (req, res) => {
  const ticketId = String(req.params.ticketId);
  const ticket = warroomTickets.get(ticketId);
  if (!ticket) { res.status(404).json({ error: t("找不到這場排隊（伺服器可能已重啟），請重新開場。") }); return; }
  if (ticket.state === "queued") {
    res.json({ ok: true, state: "queued", ahead: warroomQueue.ahead(ticketId) ?? 0, seats: ticket.seats });
    return;
  }
  res.json({ ok: true, ...ticket });
});

// 取消排隊：只有還在排的能取消；已開場的照常跑完（散會後裁決仍會交回召集人）。
app.delete("/api/warroom/queue/:ticketId", (req, res) => {
  const ticketId = String(req.params.ticketId);
  const ticket = warroomTickets.get(ticketId);
  if (!ticket) { res.status(404).json({ error: t("找不到這場排隊（伺服器可能已重啟），請重新開場。") }); return; }
  if (ticket.state !== "queued" || !warroomQueue.cancel(ticketId)) {
    res.status(409).json({ error: t("這場作戰室已開場或已結束，無法取消排隊"), state: ticket.state });
    return;
  }
  finishWarroomTicket(ticketId, { state: "cancelled", seats: ticket.seats, error: t("已取消排隊"), finishedAt: Date.now() });
  syncWarroomQueueSweep();
  scheduleWarroomQueuePump(); // 取消的若是隊首，後面那場可能已坐得下
  res.json({ ok: true, state: "cancelled" });
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
  if (ephemeralSeatsLeft() <= 0) throw new Error(t("已達 NPC 上限，無法派工"));
  const worker = createWorker(t("研究員"), "sonnet", "claude", workspacePath, undefined, null, null, { warmup: true, persist: false, broadcast: true, ephemeralKind: "research" });
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
  // 隊長可能正在跟使用者講話：等它這回合結束再送，回報才不會被丟掉。
  // awaitWorkerTurn 回傳 { wait, cancel }，必須 await 其 .wait（await 物件本身會立刻 resolve、根本沒等）。
  if (workers.get(lead.id)?.runner.busy) await awaitWorkerTurn(lead.id, 120_000).wait;
  postToHost(lead.id, digest);
}

app.post("/api/workers/:id/consult", (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) { res.status(404).json({ error: "worker not found" }); return; }
  const dept = worker.departmentId ? departments.get(worker.departmentId) : null;
  if (!dept || dept.leadWorkerId !== worker.id) { res.status(403).json({ error: t("只有部門/小隊的隊長可以發起商量") }); return; }
  const question = String(req.body?.question ?? "").trim();
  if (!question) { res.status(400).json({ error: t("請提供要商量的問題") }); return; }
  if (detectGarbledText(question)) { res.status(400).json({ error: garbledTextError() }); return; }
  if (consultPending.has(dept.id)) { res.status(409).json({ error: t("這個小隊已有一場商量進行中，等回報送達後再發起") }); return; }
  consultPending.add(dept.id);
  runConsult(dept, worker, question)
    .catch(() => { /* 個別失敗已反映在 digest；這裡只保底不讓 unhandled rejection 炸掉 */ })
    .finally(() => consultPending.delete(dept.id));
  res.json({ ok: true, note: t("已把問題發給隊員，回覆彙整後會以【隊員商量回報】訊息送回給你。請先結束這回合等回報。") });
});

// ── 跨裝置排隊佇列：drain＋端點 ───────────────────────────────────────────────
// 佇列存 server（不再只在瀏覽器 IndexedDB）。任何 NPC 一空下來 server 自己 drain 下一
// 則，所以「切走的 NPC 也會自動跑」＋「手機排的隊電腦照跑」一次解決。
function broadcastQueue(workerId: string): void {
  broadcast({ type: "queue_updated", workerId, queue: store.listQueue(workerId) });
}

function workerAcceptsUserSend(worker: Worker): boolean {
  return workerProviderReady(worker)
    && !worker.runner.busy
    && !handoffInProgress(worker)
    && !collaborationInProgress(worker.id)
    && !missionInProgress(worker.id);
}

// 送出失敗時佇列項目要留著（不能先刪再送，失敗就永久消失），但 record() 遇到 error
// 事件自己會再排一次 drain，所以同一則必須限制重試次數，否則會變成每個 tick 重試一次
// 的無窮迴圈。連續失敗這麼多次才放棄並移除。
const QUEUE_MAX_SEND_ATTEMPTS = 3;
const queueSendAttempts = new Map<string, { itemId: string; attempts: number }>();

// worker 空閒時把佇列最前面一則送出。預算超標就留著（下次再試），不丟。
function drainWorkerQueue(worker: Worker): void {
  // 換腦交接摘要還沒送進新 session：先讓路，摘要送達後會再排 drain（見 trySendSummary）。
  if (pendingSwapSummaries.has(worker.id)) return;
  if (!workerAcceptsUserSend(worker)) return;
  const budget = getExtras(worker.id).dailyBudgetUsd;
  if (budget != null && todayCostUsd(worker.id) >= budget) return;
  const next = store.peekFirstQueued(worker.id);
  if (!next) return;
  let images: ReturnType<typeof parseMessageImages> = [];
  let documents: ReturnType<typeof parseMessageDocuments> = [];
  try { images = parseMessageImages(next.images); documents = parseMessageDocuments(next.documents); }
  catch { images = []; documents = []; }
  const imageLabels = images.map((image, index) => `[Image #${index + 1}: ${image.name}]`).join(" ");
  const documentLabels = documents.map((document, index) => `[Document #${index + 1}: ${document.name}]`).join(" ");
  const text = [next.message, imageLabels, documentLabels].filter(Boolean).join("\n");
  try {
    worker.runner.send(next.message, images, documents);
  } catch (error) {
    const previous = queueSendAttempts.get(worker.id);
    const attempts = previous?.itemId === next.id ? previous.attempts + 1 : 1;
    const givingUp = attempts >= QUEUE_MAX_SEND_ATTEMPTS;
    if (givingUp) {
      queueSendAttempts.delete(worker.id);
      store.removeQueueItem(worker.id, next.id);
    } else {
      queueSendAttempts.set(worker.id, { itemId: next.id, attempts });
    }
    record(worker, { type: "error", message: error instanceof Error ? error.message : t("無法送出排隊訊息") });
    if (givingUp) broadcastQueue(worker.id);
    return;
  }
  queueSendAttempts.delete(worker.id);
  store.removeQueueItem(worker.id, next.id);
  record(worker, { type: "user_message", text });
  captureOpenUserRequest(worker, text); // 真人佇列訊息（循環武裝時）落帳，防換腦／議程蒸發
  resumeWorkerAutopilotIfPaused(worker); // 暫停等你的循環：這則就是你的回答，跑完自動接著推進
  limitTurnText.set(worker.id, text);
  broadcast({ type: "worker_status", workerId: worker.id, busy: true });
  broadcastQueue(worker.id);
}

// 延到下一個 tick 再 drain：turn_end 當下 busy 可能還沒翻回 false，等它落定再送。
function scheduleQueueDrain(worker: Worker): void {
  setTimeout(() => { try { drainWorkerQueue(worker); } catch { /* drain 為 best-effort，不可影響主流程 */ } }, 0);
}

app.get("/api/workers/:id/queue", (req, res) => {
  const worker = requireWorker(res, req.params.id);
  if (!worker) return;
  res.json({ queue: store.listQueue(worker.id) });
});

app.post("/api/workers/:id/queue", (req, res) => {
  const worker = requireWorker(res, req.params.id);
  if (!worker) return;
  const message = String(req.body?.message ?? "").trim();
  try {
    const images = parseMessageImages(req.body?.images);
    const documents = parseMessageDocuments(req.body?.documents);
    if (!message && images.length === 0 && documents.length === 0) {
      res.status(400).json({ error: "message or attachment required" });
      return;
    }
  } catch (error) {
    const detail = error instanceof MessageImageValidationError || error instanceof MessageDocumentValidationError ? error.message : t("附件無效");
    res.status(400).json({ error: detail });
    return;
  }
  // 存原始 images/documents（drain 時再用 parseMessage* 驗一次，與 /message 一致）。
  store.enqueueCommand(randomUUID(), worker.id, message, req.body?.images ?? [], req.body?.documents ?? []);
  broadcastQueue(worker.id);
  scheduleQueueDrain(worker); // 若其實現在就空閒，立刻開跑
  res.json({ ok: true, queue: store.listQueue(worker.id) });
});

app.patch("/api/workers/:id/queue", (req, res) => {
  const worker = requireWorker(res, req.params.id);
  if (!worker) return;
  const order = Array.isArray(req.body?.order) ? req.body.order.map((value: unknown) => String(value)) : [];
  store.reorderQueue(worker.id, order);
  broadcastQueue(worker.id);
  res.json({ ok: true, queue: store.listQueue(worker.id) });
});

app.delete("/api/workers/:id/queue/:queueId", (req, res) => {
  const worker = requireWorker(res, req.params.id);
  if (!worker) return;
  store.removeQueueItem(worker.id, req.params.queueId);
  broadcastQueue(worker.id);
  res.json({ ok: true, queue: store.listQueue(worker.id) });
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
  if (matchNativeCommand(message) === "clean" || (
    images.length === 0
    && documents.length === 0
    && isClearCommand(message)
  )) {
    const result = cleanWorkerAndAnnounce(worker);
    if (!result.ok) {
      res.status(409).json({ error: result.error });
      return;
    }
    res.json({ ok: true, cleaned: true });
    return;
  }
  // Codex dispatches `/goal` through its app-server. Claude's stream-json
  // transport has no equivalent slash-command RPC, so mirror the same
  // get/set/clear semantics here and re-spawn its idle transport with the
  // persisted goal appended to its system prompt.
  const claudeGoal = worker.runner.provider === "claude" && images.length === 0 && documents.length === 0
    ? parseGoalCommand(message)
    : null;
  if (claudeGoal) {
    announceClaudeGoal(worker, claudeGoal);
    res.json({ ok: true, goal: getExtras(worker.id).goal });
    return;
  }
  if (worker.resumeCandidate) {
    store.deleteResumeCandidate(worker.id);
    worker.resumeCandidate = null;
  }
  const imageLabels = images.map((image, index) => `[Image #${index + 1}: ${image.name}]`).join(" ");
  const documentLabels = documents.map((document, index) => `[Document #${index + 1}: ${document.name}]`).join(" ");
  const userText = [message, imageLabels, documentLabels].filter(Boolean).join("\n");
  record(worker, { type: "user_message", text: userText });
  captureOpenUserRequest(worker, userText); // 真人直送訊息（循環武裝時）落帳，防換腦／議程蒸發
  resumeWorkerAutopilotIfPaused(worker); // 暫停等你的循環：這則就是你的回答，跑完自動接著推進
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
  noReviewMissions.delete(mission.id);
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
  dropBackgroundAgents(worker);
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
  dropBackgroundAgents(worker);
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

// ── 全域長期記憶（global_memory，SQLite table）──────────────────────────────
// 跟上面的 npc-extras 是平行擴充：per-worker 記憶綁在單一 NPC 身上，這裡是
// App 對使用者本人的記憶，任何 NPC 學到的事都寫進同一份、所有 NPC 共用。
//
// 已經在跑的 worker 要怎麼拿到新記憶：composeWorkerPrompt 只在 spawn 那一刻
// 被讀一次，process 活著的期間不會重讀，所以寫入後呼叫下面的
// refreshGlobalMemoryForAllWorkers()——對每個非短命 worker 呼叫
// runner.requestPromptRefresh()（見 AgentSession），標記它下次 idle 時該
// 重啟底層 process。**寫入來源自己也要包含在內**：它剛學到的事只活在這回合
// 的對話上下文裡，一旦之後被壓縮（換腦／compact）就會消失，而它的 system
// prompt 從 spawn 那一刻就沒有這則記憶——不重新整理的話它反而比其他 worker
// 更早失憶。這條路徑刻意不會打斷正在進行的回合：busy 的 worker 只是先記下
// 待處理，等它自己下一次 send() 才真正 stop()+respawn；對話連續性靠
// --resume（Claude）／thread/resume（Codex）保留，stop() 不動 session id。
function refreshGlobalMemoryForAllWorkers(): void {
  for (const worker of workers.values()) {
    if (worker.ephemeralKind) continue; // 短命 worker 本來就沒被注入這段
    worker.runner.requestPromptRefresh();
  }
}

app.get("/api/memory", (_req, res) => {
  res.json({ notes: listGlobalMemory(store) });
});

app.post("/api/memory", (req, res) => {
  const rawWorkerId = typeof req.body?.workerId === "string" ? req.body.workerId.trim() : "";
  let sourceWorkerId: string | null = null;
  let sourceWorkerName: string | null = null;
  if (rawWorkerId) {
    const worker = workers.get(rawWorkerId);
    if (!worker) {
      res.status(400).json({ error: t("找不到這個 workerId") });
      return;
    }
    sourceWorkerId = worker.id;
    sourceWorkerName = worker.runner.name ?? null;
  }
  const result = addGlobalMemoryNote(store, req.body?.note, sourceWorkerId, sourceWorkerName);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  const notes = listGlobalMemory(store);
  broadcast({ type: "global_memory_updated", notes });
  refreshGlobalMemoryForAllWorkers();
  res.json({ ok: true, notes });
});

app.delete("/api/memory/:id", (req, res) => {
  if (!removeGlobalMemoryNote(store, req.params.id)) {
    res.status(400).json({ error: t("沒有這則記憶") });
    return;
  }
  const notes = listGlobalMemory(store);
  broadcast({ type: "global_memory_updated", notes });
  refreshGlobalMemoryForAllWorkers();
  res.json({ ok: true, notes });
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
  // 短命工不還原成 NPC——包含為了 Mission 外鍵留下的封存錨點列，它們也不該佔滿編名額。
  .filter((worker) => !worker.ephemeralKind)
  // 同上：舊資料列沒有 ephemeral_kind，只有名字，舊版殘骸靠字首認。
  .filter((worker) => !isLegacyEphemeralWorkerName(worker.name))
  .slice(0, MAX_WORKERS)) {
  createWorker(undefined, undefined, savedWorker.provider, savedWorker.workspacePath, savedWorker, null, null, { warmup: true });
}
if (workers.size === 0 && config.targetRepoConfigured) {
  createWorker(undefined, undefined, "claude", config.targetRepoPath, undefined, null, null, { warmup: true });
}

// 重啟和解：進行中的 Mission/協作是純記憶體驅動（missionRunners/activeCollaborations 開機為空、
// 事件不會再來），從 SQLite 還原成 planning/executing/reviewing 的 Mission 若不處理會變殭屍——
// 永遠顯示執行中、被指派者恆 busy、同 workspace 全員 409、也沒有任何端點能解（/resolve 只收
// needs_attention/failed）。開機時統一打成 needs_attention，老闆可重試/取消，自動接手也有機會處理。
for (const mission of [...activeMissions.values()]) {
  if (mission.status === "planning" || mission.status === "executing" || mission.status === "reviewing" || mission.status === "discussing") {
    pauseMission(mission, t("伺服器重啟，進行中的步驟已中斷；請重試或取消"), "step_failed");
  }
}
// 進行中的協作同理：開機不還原 runner，資料庫裡 running/returning 的協作永遠收不了尾，直接標失敗。
for (const collaborationTask of store.listActiveCollaborationTasks()) {
  collaborationTask.status = "failed";
  collaborationTask.error = t("伺服器重啟，協作已中斷；請重新發起");
  collaborationTask.completedAt = new Date().toISOString();
  store.saveCollaborationTask(collaborationTask);
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

// 派工卡住自動重派的保底掃描：主要靠 turn_end 即時觸發，但主管轉閒置不一定伴隨
// turn_end（例如協作/交接結束、Mission 收尾），定期掃補上這些空窗。無登記時零成本。
const bossDispatchRetrySweepTimer = setInterval(() => {
  if (bossDispatchRetry.size > 0) {
    try { sweepStalledBossDispatch(); } catch (error) { console.error("[boss-dispatch-retry] 定期掃描失敗:", error); }
  }
  // 建立失敗重試同用這班定期掃：阻塞 Mission 結束不一定伴隨 turn_end（收尾路徑多），保底補上。
  if (bossDeptCreateRetry.size > 0) {
    try { sweepFailedDeptCreation(); } catch (error) { console.error("[dept-create-retry] 定期掃描失敗:", error); }
  }
  // 用量恢復探測只靠定期掃（恢復與 turn_end 無關；探測退避最短 60s，15s 班次只是上限頻率）。
  if (bossUsageRetry.size > 0) {
    try { sweepUsageBlockedBossTasks(); } catch (error) { console.error("[usage-retry] 定期掃描失敗:", error); }
  }
  // Mission 步驟重派同用這班定期掃：NPC 轉閒置不一定伴隨 turn_end（協作／交接收尾）、
  // provider 登入完成更沒有 turn_end，保底補上。無登記時零成本。
  if (missionStepRetry.size > 0) {
    try { sweepPausedMissionSteps(); } catch (error) { console.error("[mission-step-retry] 定期掃描失敗:", error); }
  }
  // 個人自動循環保底掃同班：讓路後停擺補觸發＋決策失敗退避重試。無武裝循環時零成本。
  if (workerAutopilotByWorker.size > 0) {
    try { sweepWorkerAutopilot(); } catch (error) { console.error("[worker-autopilot] 定期掃描失敗:", error); }
  }
  // 自我進化全自動觸發（預設關、保守閘門）：開了才動，HEAD 未出貨過且沒人在忙才自裝。
  try { maybeAutoSelfInstall(); } catch (error) { console.error("[self-install] 自動觸發檢查失敗:", error); }
}, 15_000);
bossDispatchRetrySweepTimer.unref();

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
  // 逾時保底：某顆 worker 的背景 Agent 超過上限還沒回報收尾（CLI 的收尾事件是經驗性的、不保證
  // 一定到），就銷號並補廣播 worker_updated，讓 BOSS 旁的「執行中」不會卡死回不到待命。
  for (const [workerId, activity] of workerActivities) {
    if (activity.openedAt == null || now - activity.openedAt < MISSION_ASYNC_AGENT_TIMEOUT_MS) continue;
    workerActivities.delete(workerId);
    const worker = workers.get(workerId);
    if (worker) broadcast({ type: "worker_updated", worker: workerSummary(worker) });
  }
}, 60_000);

// 臨時團隊「不」按閒置自動解散：使用者可能放著讓它跑、事後才回來看結果或追問，時間到就
// 解散會讓人以為沒做、也拿不到追問。改成只在使用者明確收工時解散（取消／封存／刪除交辦，
// 或巡迴推進下一步）。注意：解散的只是臨時 NPC，交辦與最終報告、產出檔案一律保留。
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

// 自我進化 · 開機解析自裝結果（Stage 3 跨重啟狀態機的收尾）：上一輪若剛自裝完會留一張 pending
// marker，重啟後在這裡驗收——我們能跑進 listen callback＝新版起得來＝健康，於是晉升回滾點
// （rollback := 這次成功的好版，供下次回滾）並清 marker；少見的「起得來但檢查不過」只記錄給 owner
// （真正「爛到起不來」的回滾由 detached 的 pc-selfinstall 健康輪詢負責，app 自己沒機會跑這段）。
async function resolvePendingSelfInstallOnBoot(): Promise<void> {
  try {
    const dir = config.dataDirectory;
    const store = new PendingSelfInstallStore(dir);
    const marker = store.read();
    if (!marker) return;
    // 降落傘2.0事故的根修：不能把「進得了 listen callback」當健康——壞版(聽錯port)也進得來，
    // 還會把自己晉升成回滾點(污染)。必須真的打 canonical port 拿到 200 才算健康、才准晉升。
    let selfHealthOk = false;
    try {
      const resp = await fetch(`http://127.0.0.1:${config.port}/`, { signal: AbortSignal.timeout(5000) });
      selfHealthOk = resp.status === 200;
    } catch { /* 打不到 8787 ＝ 不健康（例如本進程聽錯 port） */ }
    const installedExe = join(dir, "app", "Pixel Crew.exe");
    const stagedExe = join(dir, "coldinstall", "Pixel Crew.exe");
    const rollbackExe = join(dir, "coldinstall", "Pixel Crew.rollback.exe");
    let installedMtime = 0;
    try { installedMtime = statSync(installedExe).mtimeMs; } catch { /* 取不到＝當沒換到 */ }
    let logTail = "";
    try { logTail = readFileSync(join(dir, "logs", "self-install.log"), "utf8").slice(-4000); } catch { /* 沒 log */ }
    const checks: PostInstallChecks = {
      exeFresh: installedMtime > marker.prevExeMtimeMs,
      swappedOk: /SWAPPED OK|HEALTHY OK/.test(logTail),
      distHasNewCode: true,        // 正在執行的就是新碼
      apiOk: selfHealthOk,         // 真的打 canonical port 的結果，不再寫死（根修）
      healthOk: selfHealthOk,
    };
    const res = evaluateBootResolution(marker, checks);
    if (res.action === "confirm_ok") {
      try {
        // Hash 守衛（降落傘事故的直接教訓）：晉升前驗 staged 仍是 marker 記的那支新版。
        // 回滾會把 staged 覆成舊版——此時若照舊晉升，就把回滾點污染成「不是剛驗過健康的那版」。
        // pc-selfinstall 回滾路徑已會先刪 marker（第一道防線）；這裡是第二道，兩道都過才晉升。
        if (marker.stagedSha256) {
          const stagedHash = createHash("sha256").update(readFileSync(stagedExe)).digest("hex").toUpperCase();
          if (stagedHash !== marker.stagedSha256.toUpperCase()) {
            appendRuntimeLog(dir, "self-install promote SKIPPED: staged hash != marker (rollback likely touched staged)", { stagedHash, expected: marker.stagedSha256 });
            store.clear();
            return;
          }
        }
        for (const op of planPromoteOnSuccess({ staged: stagedExe, rollback: rollbackExe })) copyFileSync(op.from, op.to);
        appendRuntimeLog(dir, "self-install confirmed healthy; promoted rollback point", { prevMtime: marker.prevExeMtimeMs, installedMtime });
        // 新版驗過健康才記「已上線」，下次閘門從這裡起算。
        const attempted = lastAttemptedCommit();
        if (attempted) recordShippedCommit(attempted);
        // 把桌面啟動器也同步成這版好版(納入自動鏈,免得停在舊版、誤點降級)。路徑走環境變數,未設就跳過。
        const launcher = process.env.PIXEL_CREW_DESKTOP_LAUNCHER?.trim();
        if (launcher && existsSync(dirname(launcher))) {
          try { copyFileSync(installedExe, launcher); appendRuntimeLog(dir, "desktop launcher synced to current good build", { launcher }); }
          catch (e) { appendRuntimeLog(dir, "desktop launcher sync failed", { error: (e as Error).message }); }
        }
      } catch (error) {
        appendRuntimeLog(dir, "self-install promote failed", { error: (error as Error).message });
      }
      store.clear();
    } else if (res.action === "rollback") {
      appendRuntimeLog(dir, "self-install boot checks failed; detached installer owns won't-boot rollback", { failed: res.result.failed });
      store.clear();
    }
  } catch (error) {
    try { appendRuntimeLog(config.dataDirectory, "resolvePendingSelfInstallOnBoot error", { error: (error as Error).message }); } catch { /* best-effort */ }
  }
}

// 自我進化 · 觸發器（「把改好的新版自己真的裝上去」那隻手）。只做快速閘門(動到剎車→回 owner、
// 回滾就緒)，重活(build/test/package/打包/stage/發 pc-selfinstall)交 detached 的 pc-selfrebuild.ps1——
// 它測不過就中止不裝。全自動由 selfInstallAutoEnabled 控制，首次需 owner 看著驗降落傘後才開。
const SELF_REPO = process.env.PIXEL_CREW_SELF_REPO?.trim() || "";
function gitOut(repo: string, args: string[]): string {
  try { return execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 20_000_000 }); } catch { return ""; }
}
function selfInstallAutoEnabled(): boolean {
  try { return JSON.parse(readFileSync(join(config.dataDirectory, "self-install-auto.json"), "utf8"))?.enabled === true; } catch { return false; }
}
function setSelfInstallAuto(enabled: boolean): void {
  writeFileSync(join(config.dataDirectory, "self-install-auto.json"), JSON.stringify({ enabled: enabled === true }));
}
function lastShippedCommit(): string {
  try { return String(JSON.parse(readFileSync(join(config.dataDirectory, "self-install-shipped.json"), "utf8"))?.commit || ""); } catch { return ""; }
}
function recordShippedCommit(commit: string): void {
  try { writeFileSync(join(config.dataDirectory, "self-install-shipped.json"), JSON.stringify({ commit })); } catch { /* best-effort */ }
}
// 「已上線」只在新版開機驗過健康後才寫（見 resolvePendingSelfInstallOnBoot）；觸發當下只記「嘗試過」。
// 否則重建失敗時那段範圍會被當成已上線，下次閘門就不再檢查它。嘗試紀錄用來防同一 HEAD 失敗後反覆重試。
function lastAttemptedCommit(): string {
  try { return String(JSON.parse(readFileSync(join(config.dataDirectory, "self-install-attempt.json"), "utf8"))?.commit || ""); } catch { return ""; }
}
function recordAttemptedCommit(commit: string): void {
  try { writeFileSync(join(config.dataDirectory, "self-install-attempt.json"), JSON.stringify({ commit, at: new Date().toISOString() })); } catch { /* best-effort */ }
}

function gitIsAncestor(repo: string, ancestor: string, descendant: string): boolean {
  try { execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: repo, stdio: "ignore" }); return true; } catch { return false; }
}
// 單一 commit 對其第一個 parent 的改動（root commit 對空樹）。--no-renames：改名拆成刪＋增，舊檔名
// (例如 toolPolicy.ts 被改名走)也會出現在清單裡被檔名規則看到。取不到 diff → null（呼叫端保守處理）。
const SELF_INSTALL_MAX_COMMITS = 200;
function readSelfInstallCommit(repo: string, commit: string): SelfChangeCommit | null {
  const parents = gitOut(repo, ["rev-list", "--parents", "-n", "1", commit]).trim().split(/\s+/).slice(1);
  const base = parents[0] || "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // git 空樹
  const common = ["-c", "core.quotepath=false", "diff", "--no-renames", "--no-color", "--no-ext-diff"];
  const changedFiles = gitOut(repo, [...common, "--name-only", base, commit]).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const diffText = gitOut(repo, [...common, base, commit]);
  if (changedFiles.length && !diffText) return null;
  return { commit, changedFiles, diffText };
}

function triggerSelfInstall(reason: string): { outcome: string; detail?: string } {
  if (!SELF_REPO || !existsSync(SELF_REPO)) return { outcome: "repo_not_configured", detail: "PIXEL_CREW_SELF_REPO 未設定或不存在" };
  const head = gitOut(SELF_REPO, ["rev-parse", "HEAD"]).trim();
  if (!head) return { outcome: "needs_owner", detail: "讀不到 HEAD，無法確認要裝的改動" };
  // 這次要裝的改動 = 上次上線 commit..HEAD 的每個 commit（不是只看最新一個，否則被擋的會搭便車）；
  // 任一 commit 動到剎車 → 回 owner，不自裝。上線紀錄不可信 → 退回 HEAD~1..HEAD，自動觸發一律回 owner。
  const shipped = lastShippedCommit();
  const range = resolveSelfInstallRange({
    head,
    lastShipped: shipped,
    lastShippedIsAncestor: !!shipped && gitIsAncestor(SELF_REPO, shipped, head),
    trigger: reason === "auto" ? "auto" : "manual",
  });
  let rangeNote = "";
  if (range.kind === "fallback_last_commit") {
    appendRuntimeLog(config.dataDirectory, "self-install range fallback", { reason, head, shipped, blockAsNeedsOwner: range.blockAsNeedsOwner, why: range.reason });
    if (range.blockAsNeedsOwner) return { outcome: "needs_owner", detail: `${range.reason}；自動觸發不冒險，請 owner 確認後手動觸發` };
    rangeNote = `（注意：${range.reason}）`;
  }
  const commitIds = range.kind === "since_shipped"
    ? gitOut(SELF_REPO, ["rev-list", "--reverse", `${range.base}..${range.head}`]).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    : range.kind === "fallback_last_commit" ? [head] : [];
  if (range.kind === "since_shipped" && commitIds.length === 0) return { outcome: "needs_owner", detail: "列不出上線範圍內的 commit，無法確認要裝的改動" };
  if (commitIds.length > SELF_INSTALL_MAX_COMMITS) return { outcome: "needs_owner", detail: `距上次上線已累積 ${commitIds.length} 個 commit（>${SELF_INSTALL_MAX_COMMITS}），請 owner 確認` };
  const commits: SelfChangeCommit[] = [];
  for (const id of commitIds) {
    const c = readSelfInstallCommit(SELF_REPO, id);
    if (!c) return { outcome: "needs_owner", detail: `取不到 commit ${id.slice(0, 7)} 的 diff，無法確認是否動到剎車` };
    commits.push(c);
  }
  const cls = classifySelfChangeCommits(commits);
  appendRuntimeLog(config.dataDirectory, "self-install gate", { reason, range: range.kind, base: range.kind === "since_shipped" ? range.base : undefined, head, checked: cls.checked, criticalCommits: cls.criticalCommits });
  if (cls.critical) return { outcome: "needs_owner", detail: describeSelfChangeRangeBlock(cls) + rangeNote };
  const changed = [...new Set(commits.flatMap((c) => c.changedFiles))];
  // 回滾就緒快速檢查（深比對交給 pc-selfrebuild 的 hash 複檢）。
  const stagedExe = join(config.dataDirectory, "coldinstall", "Pixel Crew.exe");
  const rollbackExe = join(config.dataDirectory, "coldinstall", "Pixel Crew.rollback.exe");
  const ready = checkRollbackReady({ stagedExists: existsSync(stagedExe), rollbackExists: existsSync(rollbackExe), rollbackSameAsStaged: false });
  if (!ready.ready) return { outcome: "rollback_not_ready", detail: ready.reason };
  const rebuild = join(SELF_REPO, "scripts", "windows", "pc-selfrebuild.ps1");
  if (!existsSync(rebuild)) return { outcome: "rebuild_script_missing" };
  // 透過 wscript+vbs 啟動（app 唯一驗證過可動的 detached 啟動模式，見 tsproxy）：managed node 在無
  // 互動 console 的環境下，直接 detached spawn powershell(console 子系統)起不來；wscript(GUI 子系統)
  // 可動，再由 vbs 的 WScript.Shell.Run 隱藏視窗叫 powershell(它會替 powershell 正確建 console)。
  const psExe = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const safeReason = reason.replace(/[\r\n"]/g, " ").slice(0, 120);
  const psCmd = `"${psExe}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${rebuild}" -Repo "${SELF_REPO}" -Reason "${safeReason}"`;
  // 寫到無空格路徑（SELF_REPO 有連字號沒空格）：wscript 對含空格的腳本路徑會從空格截斷、
  // 跳出「…\Pixel 沒有副檔名」錯誤（dataDirectory 是 …\Pixel Crew\ 有空格，故不可用）。
  const vbsPath = join(SELF_REPO, ".pc-selfrebuild-launch.vbs");
  try {
    // VBS 字串字面以 "" 跳脫內嵌雙引號；視窗樣式 0=隱藏、第三參數 False=不等待。
    writeFileSync(vbsPath, `CreateObject("WScript.Shell").Run "${psCmd.replace(/"/g, '""')}", 0, False\r\n`);
    const child = spawn("wscript.exe", [vbsPath], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", (err) => appendRuntimeLog(config.dataDirectory, "self-install launch error", { error: (err as Error).message }));
    child.unref();
  } catch (error) {
    return { outcome: "launch_failed", detail: (error as Error).message };
  }
  recordAttemptedCommit(head);
  appendRuntimeLog(config.dataDirectory, "self-install triggered: detached self-rebuild launched", { reason, head, range: range.kind, checked: cls.checked, changed: changed.slice(0, 20), psExe });
  return rangeNote ? { outcome: "fired", detail: rangeNote } : { outcome: "fired" };
}

// 保守自動觸發：僅在開關開、HEAD 未出貨過、且沒有 NPC 正在忙（不打斷你）時才動。節奏閘防頻繁重裝。
function maybeAutoSelfInstall(): void {
  if (!selfInstallAutoEnabled() || !SELF_REPO) return;
  const head = gitOut(SELF_REPO, ["rev-parse", "HEAD"]).trim();
  if (!head || head === lastShippedCommit() || head === lastAttemptedCommit()) return; // 失敗過的同一 HEAD 不自動重試，等新 commit
  for (const w of workers.values()) { if (w.runner.busy) return; } // 有人在忙就不重啟
  const r = triggerSelfInstall("auto");
  appendRuntimeLog(config.dataDirectory, "maybeAutoSelfInstall", { outcome: r.outcome, detail: r.detail });
}

// 手動觸發（首次驗降落傘、owner 想立刻出貨時用）。
app.post("/api/self-install/trigger", (req, res) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason : "manual";
  const result = triggerSelfInstall(reason);
  res.json(result);
});
// 全自動開關（預設關；首次看著驗過降落傘後再開）。
app.get("/api/self-install/auto", (_req, res) => { res.json({ enabled: selfInstallAutoEnabled(), repoConfigured: !!SELF_REPO }); });
app.post("/api/self-install/auto", (req, res) => {
  setSelfInstallAuto(Boolean(req.body?.enabled));
  res.json({ enabled: selfInstallAutoEnabled() });
});

server.listen(config.port, config.host, () => {
  appendRuntimeLog(config.dataDirectory, `HTTP server listening on ${config.host}:${config.port}`);
  void resolvePendingSelfInstallOnBoot();
  console.log(`pixel-crew server listening on http://${config.host}:${config.port}`);
  console.log(`target repo: ${config.targetRepoPath}`);
  console.log(`local database: ${config.dbPath}`);
  if (config.production && !existsSync(config.webDistPath)) {
    console.warn(`web build not found at ${config.webDistPath}; run npm run build first`);
  }
  // 重啟殭屍和解（卡點盤點 P0）：discovering（探索）與 synthesizing（驗收核對）都是
  // 純記憶體 async，重啟後結果永遠不會回來；不處理就永卡該狀態。探索殭屍轉 needs_attention
  // 引導回覆/重開；驗收殭屍若各部門交付俱在就打回 running 自動重新驗收，否則誠實轉 needs_attention。
  for (const task of store.listBossTasksByStatus(["discovering"])) {
    task.status = "needs_attention";
    task.error = t("伺服器重啟時探索中斷");
    task.messages.push(bossTaskMessage("system", t("⚠️ 伺服器重啟時探索被中斷；回覆這張交辦或按「重新交辦」即可重新開始。")));
    persistBossTask(task);
  }
  for (const task of store.listBossTasksByStatus(["synthesizing"])) {
    if (synthesizingZombieAction(task.stages) === "resynthesize") {
      task.status = "running";
      task.error = null;
      task.messages.push(bossTaskMessage("system", t("🔄 伺服器重啟時驗收核對被中斷，已自動重新核對。")));
      persistBossTask(task);
      try { advanceBossTask(task); } catch (error) {
        console.error(`[boss-task] 重啟後重新驗收失敗 ${task.id}:`, error);
        // 剛把狀態打回 running 又推進失敗：不告知就是一張永遠顯示執行中、實際沒人在跑的
        // 殭屍（全庫盤點 C-2）。誠實轉 needs_attention 並給出可行動的下一步。
        task.status = "needs_attention";
        task.error = (error as Error).message || t("重啟後重新驗收失敗");
        task.messages.push(bossTaskMessage("system", t("⚠️ 重啟後自動重新驗收失敗：{error}；回覆這張交辦或按「重新交辦」再試。", { error: task.error })));
        persistBossTask(task);
      }
    } else {
      task.status = "needs_attention";
      task.error = t("伺服器重啟時驗收中斷");
      task.messages.push(bossTaskMessage("system", t("⚠️ 伺服器重啟時驗收被中斷；回覆這張交辦或按「重新交辦」處理。")));
      persistBossTask(task);
    }
  }
  // 開機自癒：重啟時進行中的 boss task 可能指著重啟後已遺失的 mission（臨時部門的
  // mission 不跨重啟保存）。這種幽靈狀態不會再有 mission 事件來推進，開機主動掃一次，
  // 讓 advanceBossTaskStages 的遺失處理把 stage 打回 pending 重新派工或誠實轉 needs_attention。
  // ready 一併掃：status 寫成 "ready" 與 advance 之間崩潰的極小窗口（卡點盤點 P3-9），advance 一次就活。
  for (const task of store.listBossTasksByStatus(["ready", "running"])) {
    try { advanceBossTask(task); } catch (error) {
      console.error(`[boss-task] 開機自癒失敗 ${task.id}:`, error);
      quarantineAdvanceFailure(task, error);
    }
  }
  // 派工卡住的交辦（needs_attention 且沒有任何 stage 在跑）追蹤器是記憶體態，重啟就掉——
  // 開機時從現存交辦重建登記並立掃一次，主管此刻閒著就直接重派，忙著就交給雙掃描接手。
  for (const task of store.listBossTasksByStatus(["needs_attention"])) {
    if (isPreDispatchStall(task)) bossDispatchRetry.note(task.id, Date.now());
    // 建立失敗的追蹤器同樣是記憶體態——靠落地的 task.stall.kind 結構化標記認回入口重建
    // 登記（次數歸零，重啟視同重新開始），不比對文案，重啟前後改寫失敗訊息或切換語系
    // 都不影響。stall 缺欄的舊版落地資料走 bootRebuildKind 的升級橋（文案僅在此對舊列
    // 盡力比對一次），認回後回填 stall 標記落地——下次重啟就走結構化路徑，不再碰文案。
    // 追問路徑的追問文字不跨重啟保存，無法安全重放，留給人工。
    else {
      const rebuilt = bootRebuildKind(task.stall?.kind ?? null, task.error, {
        dedicated: deptCreateFailureError.dedicated(),
        decide: deptCreateFailureError.decide(),
      });
      if (rebuilt) {
        if (rebuilt.legacy && task.error !== null) {
          task.stall = { kind: deptCreateStallKind(rebuilt.kind), error: task.error };
          persistBossTask(task);
        }
        bossDeptCreateRetry.note(task.id, rebuilt.kind, null, Date.now());
        // 冷安裝當天的驗證線索：認回幾張、走哪條路（結構化 vs 升級橋）只有這裡知道，
        // 追蹤器是記憶體態、外部觀測不到，不留 log 就無從確認升級橋真的接住了舊列。
        console.log(`[dept-create-retry] 開機重建認回 ${task.id}（${rebuilt.kind}${rebuilt.legacy ? "，升級橋以舊版文案橋接並回填 stall" : "，結構化 stall 標記"}）`);
      }
    }
  }
  if (bossDispatchRetry.size > 0) {
    try { sweepStalledBossDispatch(); } catch (error) {
      console.error("[boss-dispatch-retry] 開機重建掃描失敗:", error);
    }
  }
  if (bossDeptCreateRetry.size > 0) {
    try { sweepFailedDeptCreation(); } catch (error) {
      console.error("[dept-create-retry] 開機重建掃描失敗:", error);
    }
  }
  // 開機自癒：武裝中的個人自動循環（載入時已從 store 復原）在重啟後不會有 turn_end 來觸發
  // 下一步，只靠 15s 保底掃會慢半拍——冷安裝重啟後「沒第一時間接回」的元兇。
  // 實測（b993031 驗證紀錄）發現真正的延遲是「接回時那通決策模型呼叫」在冷重啟後偏慢，而非
  // sweep 節奏；所以這裡做三件事把接回盡量提前：①開機就先 warmup 武裝 worker 的 runner（CLI
  // 與決策並行暖機）②延遲縮到 2s 讓決策呼叫盡早開始（省掉乾等第一個 15s tick 的時間）③用
  // appendRuntimeLog 落檔（console.log 會被 stdout block-buffer 吃掉，驗不到），記下開機補掃
  // 真的在開機時跑過、掃了幾個循環，供冷安裝後對時間戳驗證。
  if (workerAutopilotByWorker.size > 0) {
    const armed = workerAutopilotByWorker.size;
    for (const workerId of workerAutopilotByWorker.keys()) {
      const worker = workers.get(workerId);
      if (worker && !worker.runner.busy && providerReady(worker.runner.provider)) {
        try { worker.runner.warmup(); } catch { /* 暖機失敗不擋開機，sweep 會再補 */ }
      }
    }
    const bootResume = setTimeout(() => {
      try {
        appendRuntimeLog(config.dataDirectory, `worker-autopilot boot resume sweep: ${armed} armed loop(s)`);
        sweepWorkerAutopilot();
      } catch (error) {
        appendRuntimeLog(config.dataDirectory, "worker-autopilot boot resume sweep failed", (error as Error).message);
      }
    }, 2_000);
    bootResume.unref();
  }
  // 遠端存取自動啟動：設定開著就在開機時把轉接站拉起來，重開機後手機不用等人手動開。
  if (appSettings.get().remoteAccessAutoStart) {
    void startTsproxyRelay().then((outcome) => {
      appendRuntimeLog(config.dataDirectory, outcome.running
        ? "remote-access relay auto-started"
        : `remote-access relay auto-start failed: ${outcome.error ?? "unknown"}`);
    });
  }
});
