import express from "express";
import cors, { type CorsOptions } from "cors";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { release as osRelease, tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import type { AgentSession } from "./providers/session.js";
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
import { composePersonaPrompt, normalizePersona, normalizePersonaTemplate, type Persona, type PersonaTemplate } from "./persona.js";
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
const AVATAR_PRESET_IDS = new Set(["classic", "cyber", "signal", "spark", "ops"]);
const store = new LocalStore(config.dbPath);
const avatarStore = new AvatarStore(config.avatarDir);

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
  restartIdleWorkers(state.provider, state.workspacePath);
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
};

const workers = new Map<string, Worker>();
let workerCounter = 0;

function workerSummary(w: Worker) {
  const handoffBusy = handoffInProgress(w);
  return {
    id: w.id,
    name: w.runner.name,
    model: w.runner.getModel() ?? null,
    busy: w.runner.busy || handoffBusy,
    colorIndex: w.colorIndex,
    avatarId: w.avatarId,
    avatarKind: w.avatarKind,
    avatarPresetId: w.avatarPresetId,
    provider: w.runner.provider,
    workspacePath: w.runner.workspacePath,
    persona: w.persona,
    autoApproveMode: w.autoApproveMode,
    handoff: w.handoff,
  };
}

function handoffInProgress(worker: Worker): boolean {
  return Boolean(worker.handoff && !["completed", "failed"].includes(worker.handoff.stage));
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
  const session = worker.runner.getPersistenceState();
  return store.saveWorker({
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
    ...session,
  });
}

async function deleteAvatarIfUnused(avatarId: string): Promise<void> {
  if ([...workers.values()].some((worker) => worker.avatarId === avatarId)) return;
  try {
    await avatarStore.delete(avatarId);
  } catch (error) {
    console.warn("Delete unused avatar failed:", (error as Error).message);
  }
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
  broadcast({ type: "event", workerId: worker.id, event });
}

function createWorker(
  name?: string,
  model?: string,
  provider: ProviderId = "claude",
  workspacePath = config.targetRepoPath,
  persisted?: PersistedWorker,
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
    persona: persisted?.persona ?? null,
    autoApproveMode: persisted?.autoApproveMode ?? "off",
    handoff: persisted ? store.loadLatestFailedHandoff(id) : null,
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
  if (providerReady(workerProvider)) runner.warmup();
  persistWorker(worker);
  if (persisted && hasUnfinishedTurn(worker.history)) {
    record(worker, { type: "error", message: "伺服器已重啟，上一個未完成的回合已中止" });
  }
  if (!persisted) broadcast({ type: "worker_added", worker: workerSummary(worker) });
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

function validModel(_provider: ProviderId, model: string): boolean {
  // Both CLIs accept a short alias (e.g. "sonnet") or a full model id
  // (e.g. "claude-sonnet-5"); the CLI itself rejects anything bogus at
  // spawn time, so this only guards against obviously malformed input.
  if (!model) return true;
  return /^[A-Za-z0-9._-]+$/.test(model);
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
    if (event.type === "tool_call_start" && /(^|__)agent$/i.test(event.name)) openAgents.add(event.id);
    if (event.type === "tool_call_result") openAgents.delete(event.id);
    if (event.type === "turn_end" || event.type === "error") {
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

function runDetachedTurn(
  provider: ProviderId,
  workspacePath: string,
  model: string | null,
  initialState: { sessionId: string; completedTurns: number } | undefined,
  persona: Persona | null,
  prompt: string,
  timeoutMs = 60_000,
): Promise<{ text: string; state: { sessionId: string; completedTurns: number } }> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let runner: AgentSession | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let streamedText = "";
    const finish = (error?: Error, text = "") => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const state = runner?.getPersistenceState();
      runner?.stop();
      if (error) rejectPromise(error);
      else if (!state) rejectPromise(new Error("無法建立 LLM 交接工作階段"));
      else resolvePromise({ text, state });
    };
    runner = detachedRunner(provider, workspacePath, model, initialState, (event) => {
      if (event.type === "text_delta") streamedText += event.text;
      else if (event.type === "approval_requested") finish(new Error("交接整理意外要求工具權限"));
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
      runner.send(prompt);
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
    const worker = createWorker(
      req.body?.name,
      String(req.body?.model ?? ""),
      provider,
      workspacePath,
    );
    if (provider === "claude") void claudeCapabilitiesFor(workspacePath).refresh();
    else void codexCapabilitiesFor(workspacePath).refresh();
    res.json(workerSummary(worker));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || "無法使用這個工作位置" });
  }
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
  if (handoffInProgress(worker)) {
    res.status(409).json({ error: "NPC 正在進行 LLM 交接，暫時不能改名" });
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
  if (worker.runner.busy || handoffInProgress(worker)) {
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
  if (worker.runner.busy) {
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
  if (worker.runner.busy || handoffInProgress(worker)) {
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
    persistWorker(worker);
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
  res.json({ ok: true, workspacePath: worker.runner.workspacePath });
});

app.delete("/api/workers/:id", async (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) {
    res.status(404).json({ error: "unknown worker" });
    return;
  }
  if (handoffInProgress(worker)) {
    res.status(409).json({ error: "NPC 正在進行 LLM 交接，暫時不能移除" });
    return;
  }
  worker.runner.stop();
  const avatarId = worker.avatarId;
  workers.delete(worker.id);
  store.deleteWorker(worker.id);
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
  if (worker.runner.busy || handoffInProgress(worker)) {
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

app.post("/api/workers/:id/persona", (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) {
    res.status(404).json({ error: "unknown worker" });
    return;
  }
  if (worker.runner.busy || handoffInProgress(worker)) {
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
      restartIdleWorkers(provider);
      res.json({ ok: true, message: stdout.trim() });
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
    restartIdleWorkers(provider);
    res.json({ ok: true, message: stdout.trim() });
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
  restartIdleWorkers(provider, workspacePath);
  res.json({
    ok: true,
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
    restartIdleWorkers(provider);
    res.json({ ok: true, message: stdout.trim() });
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
    restartIdleWorkers(provider);
    res.json({ ok: true, message: stdout.trim() });
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
    res.json({ ok: true, message: stdout.trim() || "已從 Claude Desktop 匯入 MCP servers" });
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
  worker.runner.interrupt();
  broadcast({ type: "worker_status", workerId: worker.id, busy: false });
  res.json({ ok: true });
});

for (const savedWorker of store.loadWorkers(MAX_HISTORY).slice(0, MAX_WORKERS)) {
  createWorker(undefined, undefined, savedWorker.provider, savedWorker.workspacePath, savedWorker);
}
if (workers.size === 0 && config.targetRepoConfigured) {
  createWorker(undefined, undefined, "claude", config.targetRepoPath);
}

const workflowWatcher = new WorkflowLibraryWatcher(recentWorkspacePaths, ({ workspacePath, provider, revision }) => {
  broadcast({ type: "workflow_library_updated", workspacePath, provider, revision });
  if (provider === "claude") {
    void claudeCapabilitiesFor(workspacePath).refreshCommands(true);
    restartIdleWorkers("claude", workspacePath);
  }
});
workflowWatcher.start();

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
  for (const worker of workers.values()) worker.runner.stop();
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
