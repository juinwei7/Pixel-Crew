import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { WebSocketServer, WebSocket } from "ws";
import { v4 as uuidv4 } from "uuid";
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

const app = express();
app.use(cors());
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const CLAUDE_MODELS = new Set(["fable", "opus", "sonnet", "haiku"]);
const MAX_HISTORY = 2000;
const MAX_WORKERS = 20;
const store = new LocalStore(config.dbPath);
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

const capabilities = new CapabilityRegistry(store, (state) => {
  broadcast({ type: "capabilities_updated", provider: "claude", capabilities: state });
});
const codexCapabilities = new CodexCapabilityRegistry((state) => {
  broadcast({ type: "capabilities_updated", provider: "codex", capabilities: state });
});

function persistWorker(worker: Worker): void {
  const session = worker.runner.getPersistenceState();
  store.saveWorker({
    id: worker.id,
    name: worker.runner.name,
    model: worker.runner.getModel() ?? null,
    colorIndex: worker.colorIndex,
    provider: worker.runner.provider,
    workspacePath: worker.runner.workspacePath,
    ...session,
  });
}

function record(worker: Worker, event: RunnerEvent): void {
  worker.history.push(event);
  if (worker.history.length > MAX_HISTORY) {
    worker.history.splice(0, worker.history.length - MAX_HISTORY);
  }
  store.appendEvent(worker.id, event, MAX_HISTORY);
  if (
    event.type === "meta" &&
    worker.runner.workspacePath === capabilities.getWorkspacePath()
  ) {
    capabilities.mergeWorkerMeta(event);
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
  const workerWorkspace = persisted?.workspacePath || workspacePath || config.targetRepoPath;
  const id = persisted?.id ?? uuidv4();
  const worker: Worker = {
    id,
    runner: null as unknown as AgentSession,
    history: persisted?.events ?? [],
    colorIndex: persisted?.colorIndex ?? workerCounter % 6,
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
        () => capabilities.getAllowedTools(),
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

function recentWorkspacePaths(): string[] {
  return [...new Set([
    config.targetRepoPath,
    ...[...workers.values()].map((worker) => worker.runner.workspacePath),
  ].filter(Boolean))];
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
      capabilities: {
        claude: capabilities.getState(),
        codex: codexCapabilities.getState(),
      },
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

app.get("/api/capabilities", (_req, res) => {
  res.json({
    capabilities: {
      claude: capabilities.getState(),
      codex: codexCapabilities.getState(),
    },
  });
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
    if (provider === "claude") void capabilities.refresh(workspacePath);
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
  if (provider === "claude") void capabilities.refresh(workspacePath);
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
    if (provider === "claude") void capabilities.refresh(workspacePath);
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
    void capabilities.refresh(worker.runner.workspacePath);
  }
  res.json({ ok: true, workspacePath: worker.runner.workspacePath });
});

app.delete("/api/workers/:id", (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) {
    res.status(404).json({ error: "unknown worker" });
    return;
  }
  worker.runner.stop();
  workers.delete(worker.id);
  store.deleteWorker(worker.id);
  broadcast({ type: "worker_removed", workerId: worker.id });
  res.json({ ok: true });
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
function restartIdleWorkers(provider?: ProviderId): void {
  for (const worker of workers.values()) {
    if (
      (!provider || worker.runner.provider === provider) &&
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
    if (provider === "claude") void capabilities.refresh();
    else void codexCapabilities.refresh();
  }
  return next;
}

async function refreshAuth(provider?: ProviderId): Promise<ProviderAuthState[]> {
  if (provider) return [await refreshOneAuth(provider)];
  return Promise.all((Object.keys(authProviders) as ProviderId[]).map(refreshOneAuth));
}

app.post("/api/mcp", async (req, res) => {
  const provider: ProviderId = req.body?.provider === "codex" ? "codex" : "claude";
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
      cwd: config.targetRepoPath,
      timeout: 30000,
    });
    if (provider === "codex") await codexCapabilities.refresh();
    else await capabilities.refresh();
    restartIdleWorkers(provider);
    res.json({ ok: true, message: stdout.trim() });
  } catch (err: any) {
    res.status(500).json({ error: (err.stderr || err.message || "").trim().slice(0, 500) });
  }
});

app.post("/api/mcp/refresh", async (req, res) => {
  const provider: ProviderId = req.body?.provider === "codex" ? "codex" : "claude";
  if (provider === "codex") await codexCapabilities.refresh();
  else await capabilities.refresh();
  restartIdleWorkers(provider);
  res.json({
    ok: true,
    capabilities: provider === "codex" ? codexCapabilities.getState() : capabilities.getState(),
  });
});

app.delete("/api/mcp/:name", async (req, res) => {
  const provider: ProviderId = req.query.provider === "codex" ? "codex" : "claude";
  const name = req.params.name;
  if (!/^[\w.-]+$/.test(name)) {
    res.status(400).json({ error: "這個 server 不能從這裡移除（可能是 claude.ai 帳號層級的連接器）" });
    return;
  }
  try {
    const { stdout } = await execFileAsync(provider === "codex" ? config.codexBin : config.claudeBin, ["mcp", "remove", name], {
      cwd: config.targetRepoPath,
      timeout: 30000,
    });
    if (provider === "codex") await codexCapabilities.refresh();
    else await capabilities.refresh();
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

void Promise.all([capabilities.refresh(), codexCapabilities.refresh()]).then(() => {
  restartIdleWorkers();
});
void refreshAuth();

server.listen(config.port, config.host, () => {
  console.log(`pixel-crew server listening on http://${config.host}:${config.port}`);
  console.log(`target repo: ${config.targetRepoPath}`);
  console.log(`local database: ${config.dbPath}`);
});
