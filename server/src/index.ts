import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocketServer, WebSocket } from "ws";
import { v4 as uuidv4 } from "uuid";
import { config } from "./config.js";
import { ClaudeSession, type RunnerEvent } from "./claudeRunner.js";
import { CapabilityRegistry } from "./capabilities.js";
import { LocalStore, type PersistedWorker } from "./store.js";

const app = express();
app.use(cors());
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const ALLOWED_MODELS = new Set(["fable", "opus", "sonnet", "haiku"]);
const MAX_HISTORY = 2000;
const store = new LocalStore(config.dbPath);

type Worker = {
  id: string;
  runner: ClaudeSession;
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
  };
}

function broadcast(payload: unknown): void {
  const raw = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(raw);
  }
}

const capabilities = new CapabilityRegistry(store, (state) => {
  broadcast({ type: "capabilities_updated", capabilities: state });
});

function persistWorker(worker: Worker): void {
  const session = worker.runner.getPersistenceState();
  store.saveWorker({
    id: worker.id,
    name: worker.runner.name,
    model: worker.runner.getModel() ?? null,
    colorIndex: worker.colorIndex,
    ...session,
  });
}

function record(worker: Worker, event: RunnerEvent): void {
  worker.history.push(event);
  if (worker.history.length > MAX_HISTORY) {
    worker.history.splice(0, worker.history.length - MAX_HISTORY);
  }
  store.appendEvent(worker.id, event, MAX_HISTORY);
  if (event.type === "meta") capabilities.mergeWorkerMeta(event);
  if (event.type === "turn_end") persistWorker(worker);
  broadcast({ type: "event", workerId: worker.id, event });
}

function createWorker(
  name?: string,
  model?: string,
  persisted?: PersistedWorker,
): Worker {
  const id = persisted?.id ?? uuidv4();
  const worker: Worker = {
    id,
    runner: null as unknown as ClaudeSession,
    history: persisted?.events ?? [],
    colorIndex: persisted?.colorIndex ?? workerCounter % 6,
  };
  const runner = new ClaudeSession(
    (event) => record(worker, event),
    () => capabilities.getAllowedTools(),
    persisted
      ? {
          claudeSessionId: persisted.claudeSessionId,
          completedTurns: persisted.completedTurns,
        }
      : undefined,
  );
  worker.runner = runner;
  workerCounter++;
  runner.name = persisted?.name || name?.trim() || `${["一", "二", "三", "四", "五", "六", "七", "八", "九"][
    (workerCounter - 1) % 9
  ]}號機`;
  const selectedModel = persisted?.model ?? model;
  if (selectedModel && ALLOWED_MODELS.has(selectedModel)) runner.setModel(selectedModel);
  workers.set(id, worker);
  runner.warmup();
  persistWorker(worker);
  if (persisted && hasUnfinishedTurn(worker.history)) {
    record(worker, { type: "error", message: "伺服器已重啟，上一個未完成的回合已中止" });
  }
  if (!persisted) broadcast({ type: "worker_added", worker: workerSummary(worker) });
  return worker;
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
      capabilities: capabilities.getState(),
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

app.get("/api/capabilities", (_req, res) => {
  res.json({ capabilities: capabilities.getState() });
});

app.post("/api/workers", (req, res) => {
  const worker = createWorker(req.body?.name, String(req.body?.model ?? ""));
  res.json(workerSummary(worker));
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
  if (worker.runner.busy) {
    res.status(409).json({ error: "worker busy" });
    return;
  }
  const model = String(req.body?.model ?? "");
  if (model && !ALLOWED_MODELS.has(model)) {
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

/** Restart idle workers so their next message picks up the new MCP config. */
function restartIdleWorkers(): void {
  for (const worker of workers.values()) {
    if (!worker.runner.busy) {
      worker.runner.stop();
      worker.runner.warmup();
    }
  }
}

app.post("/api/mcp", async (req, res) => {
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

  const args = ["mcp", "add", "-s", "user"];
  const isUrl = /^https?:\/\//.test(target);
  if (isUrl) {
    args.push("-t", target.endsWith("/sse") ? "sse" : "http");
    if (header) args.push("-H", header);
    args.push(name, target);
  } else {
    args.push(name, "--", ...target.split(/\s+/));
  }

  try {
    const { stdout } = await execFileAsync(config.claudeBin, args, {
      cwd: config.targetRepoPath,
      timeout: 30000,
    });
    await capabilities.refresh();
    restartIdleWorkers();
    res.json({ ok: true, message: stdout.trim() });
  } catch (err: any) {
    res.status(500).json({ error: (err.stderr || err.message || "").trim().slice(0, 500) });
  }
});

app.post("/api/mcp/refresh", async (_req, res) => {
  await capabilities.refresh();
  restartIdleWorkers();
  res.json({ ok: true, capabilities: capabilities.getState() });
});

app.delete("/api/mcp/:name", async (req, res) => {
  const name = req.params.name;
  if (!/^[\w.-]+$/.test(name)) {
    res.status(400).json({ error: "這個 server 不能從這裡移除（可能是 claude.ai 帳號層級的連接器）" });
    return;
  }
  try {
    const { stdout } = await execFileAsync(config.claudeBin, ["mcp", "remove", name], {
      cwd: config.targetRepoPath,
      timeout: 30000,
    });
    await capabilities.refresh();
    restartIdleWorkers();
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

for (const savedWorker of store.loadWorkers(MAX_HISTORY)) {
  createWorker(undefined, undefined, savedWorker);
}
if (workers.size === 0) createWorker();

capabilities.refresh().then(() => {
  restartIdleWorkers();
});

server.listen(config.port, config.host, () => {
  console.log(`pixel-crew server listening on http://${config.host}:${config.port}`);
  console.log(`target repo: ${config.targetRepoPath}`);
  console.log(`local database: ${config.dbPath}`);
});
