import express from "express";
import cors, { type CorsOptions } from "cors";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "./config.js";
import { ClaudeSession, type RunnerEvent } from "./claudeRunner.js";
import { CapabilityRegistry } from "./capabilities.js";
import { CodexCapabilityRegistry } from "./codexCapabilities.js";
import { LocalStore, type PersistedWorker } from "./store.js";
import { ClaudeAuthProvider } from "./providers/claudeAuth.js";
import { CodexAuthProvider } from "./providers/codexAuth.js";
import { CodexSession } from "./codexRunner.js";
import type { AgentSession } from "./providers/session.js";
import type { AgentAuthProvider, ProviderAuthState, ProviderId } from "./providers/types.js";
import { deleteProjectCommand, listProjectCommands, saveProjectCommand } from "./commandLibrary.js";
import { deleteProjectSkill, listProjectSkills, saveProjectSkill } from "./skillLibrary.js";
import { isAllowedLoopbackOrigin } from "./localAccess.js";
import { WorkflowLibraryWatcher } from "./workflowWatcher.js";
import { AvatarStore, AvatarValidationError } from "./avatarStore.js";

const app = express();
const loopbackCors: CorsOptions = {
  origin(origin, callback) {
    callback(null, isAllowedLoopbackOrigin(origin));
  },
};
app.use(cors(loopbackCors));
app.use(express.json({ limit: "3mb" }));

const server = createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/ws",
  verifyClient(info, done) {
    done(isAllowedLoopbackOrigin(info.origin));
  },
});

const CLAUDE_MODELS = new Set(["fable", "opus", "sonnet", "haiku"]);
const MAX_HISTORY = 2000;
const MAX_WORKERS = 20;
const store = new LocalStore(config.dbPath);
const avatarStore = new AvatarStore(config.avatarDir);
const authProviders: Record<ProviderId, AgentAuthProvider> = {
  claude: new ClaudeAuthProvider(),
  codex: new CodexAuthProvider(),
};
const authStates: Record<ProviderId, ProviderAuthState> = {
  claude: initialAuthState(authProviders.claude),
  codex: initialAuthState(authProviders.codex),
};

type Worker = {
  id: string;
  runner: AgentSession;
  history: RunnerEvent[];
  colorIndex: number;
  avatarId: string | null;
};

const workers = new Map<string, Worker>();
let workerCounter = 0;

function workerSummary(w: Worker) {
  return {
    id: w.id,
    name: w.runner.name,
    model: w.runner.getModel() ?? null,
    busy: w.runner.busy,
    colorIndex: w.colorIndex,
    avatarId: w.avatarId,
    provider: w.runner.provider,
    workspacePath: w.runner.workspacePath,
  };
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
  try {
    return realpathSync(workspacePath);
  } catch {
    return resolve(workspacePath);
  }
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
    }, key);
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
    provider: worker.runner.provider,
    workspacePath: worker.runner.workspacePath,
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
  worker.history.push(event);
  if (worker.history.length > MAX_HISTORY) {
    worker.history.splice(0, worker.history.length - MAX_HISTORY);
  }
  store.appendEvent(worker.id, event, MAX_HISTORY);
  if (event.type === "meta" && worker.runner.provider === "claude") {
    claudeCapabilitiesFor(worker.runner.workspacePath).mergeWorkerMeta(event);
  }
  if (event.type === "turn_end" || event.type === "error") persistWorker(worker);
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
    ? new CodexSession((event) => record(worker, event), workspacePath, initialState)
    : new ClaudeSession(
        (event) => record(worker, event),
        workspacePath,
        () => claudeCapabilitiesFor(workspacePath).getAllowedTools(),
        initialState,
      );
}

function validModel(provider: ProviderId, model: string): boolean {
  if (!model) return true;
  if (provider === "claude") return CLAUDE_MODELS.has(model);
  return /^[A-Za-z0-9._-]+$/.test(model);
}

function normalizeWorkspacePath(input: unknown): string {
  const requested = String(input ?? "").trim() || config.targetRepoPath;
  const expanded = requested === "~" || requested.startsWith("~/")
    ? resolve(homedir(), requested.slice(2))
    : resolve(requested);
  try {
    const canonical = realpathSync(expanded);
    if (!statSync(canonical).isDirectory()) throw new Error("工作位置不是資料夾");
    return canonical;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("找不到這個資料夾，請確認本機絕對路徑");
    }
    throw error;
  }
}

function normalizeManagedWorkspacePath(input: unknown): string {
  const canonical = normalizeWorkspacePath(input);
  const managedPaths = [config.targetRepoPath, ...[...workers.values()].map((worker) => worker.runner.workspacePath)];
  const managed = managedPaths.some((path) => {
    try {
      return realpathSync(path) === canonical;
    } catch {
      return false;
    }
  });
  if (!managed) throw new Error("只能管理目前已加入 Pixel Crew 的工作資料夾");
  return canonical;
}

function sameWorkspacePath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return resolve(left) === resolve(right);
  }
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

wss.on("connection", (socket) => {
  socket.send(
    JSON.stringify({
      type: "snapshot",
      targetRepoPath: config.targetRepoPath,
      workspacePaths: recentWorkspacePaths(),
      auth: Object.values(authStates),
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

app.post("/api/workspaces/validate", (req, res) => {
  try {
    res.json({ ok: true, path: normalizeWorkspacePath(req.body?.path) });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || "無法使用這個工作位置" });
  }
});

app.post("/api/workspaces/pick", async (_req, res) => {
  if (process.platform !== "darwin") {
    res.status(501).json({ error: "目前只有 macOS 支援原生資料夾選擇器，請改用絕對路徑" });
    return;
  }
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "Pixel Crew：選擇工作資料夾")',
    ], { timeout: 120000 });
    res.json({ path: normalizeWorkspacePath(stdout.trim()) });
  } catch (error: any) {
    if (/cancel|取消|-128/i.test(String(error?.stderr ?? error?.message ?? ""))) {
      res.json({ canceled: true });
      return;
    }
    res.status(500).json({ error: "無法開啟資料夾選擇器，請改用絕對路徑" });
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
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || "無法刪除 Codex Skill" });
  }
});

app.get("/api/auth", (_req, res) => {
  res.json({ auth: Object.values(authStates) });
});

app.post("/api/auth/refresh", async (req, res) => {
  const requested = String(req.body?.provider ?? "");
  const provider = requested === "claude" || requested === "codex" ? requested : undefined;
  const auth = await refreshAuth(provider);
  res.json({ auth });
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

app.patch("/api/workers/:id", (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) {
    res.status(404).json({ error: "unknown worker" });
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
    const avatarId = await avatarStore.save(req.body?.dataBase64 ?? req.body?.pngBase64, req.body?.mimeType ?? "image/png");
    worker.avatarId = avatarId;
    if (!persistWorker(worker)) {
      worker.avatarId = previousId;
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

app.delete("/api/workers/:id/avatar", async (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) {
    res.status(404).json({ error: "unknown worker" });
    return;
  }
  const previousId = worker.avatarId;
  worker.avatarId = null;
  if (!persistWorker(worker)) {
    worker.avatarId = previousId;
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
  if (worker.runner.busy) {
    res.status(409).json({ error: "NPC 執行中，不能切換類型" });
    return;
  }
  if (worker.history.some((event) => event.type === "user_message")) {
    res.status(409).json({ error: "已有對話的 NPC 不能直接切換類型，請建立新的 NPC" });
    return;
  }

  const name = worker.runner.name;
  const workspacePath = worker.runner.workspacePath;
  worker.runner.stop();
  worker.history = [];
  store.clearWorkerEvents(worker.id);
  worker.runner = createRunner(worker, provider, workspacePath);
  worker.runner.name = name;
  if (providerReady(provider)) worker.runner.warmup();
  persistWorker(worker);
  if (provider === "claude") void claudeCapabilitiesFor(workspacePath).refresh();
  else void codexCapabilitiesFor(workspacePath).refresh();
  const summary = workerSummary(worker);
  broadcast({ type: "worker_updated", worker: summary });
  res.json(summary);
});

app.patch("/api/workers/:id/workspace", (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) {
    res.status(404).json({ error: "unknown worker" });
    return;
  }
  if (worker.runner.busy) {
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
  const message = String(req.body?.message ?? "").trim();
  if (!message) {
    res.status(400).json({ error: "message required" });
    return;
  }
  record(worker, { type: "user_message", text: message });
  worker.runner.send(message);
  broadcast({ type: "worker_status", workerId: worker.id, busy: true });
  res.json({ ok: true });
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
  if (worker.runner.busy) {
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

const execFileAsync = promisify(execFile);

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

async function refreshProviderWorkspaces(provider: ProviderId): Promise<void> {
  await Promise.all(recentWorkspacePaths().map((workspacePath) => (
    provider === "codex"
      ? codexCapabilitiesFor(workspacePath).refresh()
      : claudeCapabilitiesFor(workspacePath).refresh()
  )));
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
  const target = String(req.body?.target ?? "").trim();
  const header = String(req.body?.header ?? "").trim();
  if (!/^[\w.-]+$/.test(name)) {
    res.status(400).json({ error: "名稱只能用英數、-、_、." });
    return;
  }
  if (!target) {
    res.status(400).json({ error: "缺少 URL 或指令" });
    return;
  }

  const isUrl = /^https?:\/\//.test(target);
  const args = provider === "codex"
    ? ["mcp", "add", name]
    : ["mcp", "add", "-s", "user"];
  if (provider === "codex") {
    if (header) {
      res.status(400).json({ error: "Codex 遠端 MCP 請使用 OAuth 或 bearer-token-env-var，介面不保存 token" });
      return;
    }
    if (isUrl) args.push("--url", target);
    else args.push("--", ...target.split(/\s+/));
  } else if (isUrl) {
    args.push("-t", target.endsWith("/sse") ? "sse" : "http");
    if (header) args.push("-H", header);
    args.push(name, target);
  } else {
    args.push(name, "--", ...target.split(/\s+/));
  }

  try {
    const { stdout } = await execFileAsync(provider === "codex" ? config.codexBin : config.claudeBin, args, {
      cwd: workspacePath,
      timeout: 30000,
    });
    await refreshProviderWorkspaces(provider);
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
  try {
    const { stdout } = await execFileAsync(provider === "codex" ? config.codexBin : config.claudeBin, ["mcp", "remove", name], {
      cwd: workspacePath,
      timeout: 30000,
    });
    await refreshProviderWorkspaces(provider);
    restartIdleWorkers(provider);
    res.json({ ok: true, message: stdout.trim() });
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
  worker.runner.interrupt();
  broadcast({ type: "worker_status", workerId: worker.id, busy: false });
  res.json({ ok: true });
});

for (const savedWorker of store.loadWorkers(MAX_HISTORY).slice(0, MAX_WORKERS)) {
  createWorker(undefined, undefined, savedWorker.provider, savedWorker.workspacePath, savedWorker);
}
if (workers.size === 0) createWorker(undefined, undefined, "claude", config.targetRepoPath);

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

server.listen(config.port, config.host, () => {
  console.log(`pixel-crew server listening on http://${config.host}:${config.port}`);
  console.log(`target repo: ${config.targetRepoPath}`);
  console.log(`local database: ${config.dbPath}`);
});
