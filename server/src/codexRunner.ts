import { randomUUID } from "node:crypto";
import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import type { ApprovalDecision, ApprovalRequest, RunnerEvent } from "./claudeRunner.js";
import type { AgentSession, MessageDocument, MessageImage } from "./providers/session.js";
import { documentPrompt, stageMessageDocuments } from "./messageDocuments.js";
import { ensurePrivateDirectorySync, protectFileSync } from "./platform/fileProtection.js";
import { spawnCli, terminateProcessTree } from "./platform/processes.js";
import { evaluateAutoApproval, type AutoApproveMode } from "./dangerousCommand.js";

type RpcId = string | number;
type PendingRpc = { resolve(value: any): void; reject(error: Error): void };
type PendingApproval = { rpcId: RpcId; method: string; params: any; request: ApprovalRequest };

export function codexPersonaConfig(path: string): string {
  // `-c` values use TOML syntax. JSON string quoting is TOML-compatible for
  // ordinary absolute paths and keeps spaces/backslashes inside the value.
  return `model_instructions_file=${JSON.stringify(path)}`;
}

export class CodexSession implements AgentSession {
  readonly provider = "codex" as const;
  private child: ChildProcessWithoutNullStreams | null = null;
  private sessionId: string;
  private completedTurns: number;
  private model: string | undefined;
  private startedAt = 0;
  private generation = 0;
  private rpcCounter = 0;
  private ready: Promise<string> | null = null;
  private pendingRpc = new Map<RpcId, PendingRpc>();
  private approvals = new Map<string, PendingApproval>();
  private openTools = new Set<string>();
  private streamedAgentText = new Map<string, string>();
  private streamedReasoning = new Set<string>();
  private currentTurnId: string | null = null;
  private finalText = "";
  private stagedInputImages = new Set<string>();
  private stagedInputDocuments = new Set<string>();
  busy = false;
  name = "";

  private personaFilePath: string | null = null;

  constructor(
    private readonly onEvent: (event: RunnerEvent) => void,
    readonly workspacePath: string,
    // Composed persona system-prompt for this worker, or "" for none. Read at
    // spawn time and written to a per-NPC instructions file so it survives
    // /clear, model switches, and restarts (re-applied on every app-server).
    private readonly getPersonaPrompt: () => string = () => "",
    // Auto-approve mode for this worker's tool calls, read live on every
    // approval request Codex's app-server sends us (no restart needed).
    // "off" always prompts, "safe" only allows a narrow read-only/verified
    // -safe set, "full" allows everything except isDangerousCommand matches.
    // See dangerousCommand.ts.
    private readonly getAutoApproveMode: () => AutoApproveMode = () => "off",
    initialState?: { sessionId: string; completedTurns: number },
  ) {
    this.sessionId = initialState?.sessionId || randomUUID();
    this.completedTurns = initialState?.completedTurns ?? 0;
  }

  warmup(): void {
    void this.ensureThread().catch((error) => console.warn("Codex app-server warmup failed:", error.message));
  }

  send(text: string, images: MessageImage[] = [], documents: MessageDocument[] = []): void {
    if (this.busy) throw new Error("codex worker busy");
    let imagePaths: string[];
    let documentFiles: Array<{ name: string; path: string }>;
    try {
      imagePaths = this.stageInputImages(images);
      documentFiles = this.stageInputDocuments(documents);
    } catch (error) {
      this.cleanupInputImages();
      this.cleanupInputDocuments();
      throw error;
    }
    this.busy = true;
    this.startedAt = Date.now();
    this.openTools.clear();
    this.streamedAgentText.clear();
    this.streamedReasoning.clear();
    this.finalText = "";
    void this.ensureThread()
      .then((threadId) => this.request("turn/start", {
        threadId,
        input: codexTurnInput([text, documentPrompt(documentFiles)].filter(Boolean).join("\n\n"), imagePaths),
        cwd: this.workspacePath,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: config.codexSandbox,
        ...(this.model ? { model: this.model } : {}),
      }))
      .catch((error) => this.finishWithError(error.message));
  }

  interrupt(): void {
    if (!this.busy) return;
    if (this.child && this.currentTurnId) {
      void this.request("turn/interrupt", { threadId: this.sessionId, turnId: this.currentTurnId })
        .catch((error) => this.finishWithError(error.message));
    } else {
      this.stop();
      this.onEvent({ type: "error", message: "已中止" });
    }
  }

  stop(): void {
    this.generation++;
    this.cancelApprovals();
    if (this.child) void terminateProcessTree(this.child);
    this.child = null;
    this.ready = null;
    this.busy = false;
    this.currentTurnId = null;
    for (const pending of this.pendingRpc.values()) pending.reject(new Error("Codex app-server stopped"));
    this.pendingRpc.clear();
    this.cleanupInputImages();
    this.cleanupInputDocuments();
    this.clearPersonaFile();
  }

  resolveApproval(id: string, decision: ApprovalDecision): boolean {
    const pending = this.approvals.get(id);
    if (!pending || !this.child) return false;
    this.approvals.delete(id);
    const nativeDecision = decision === "allow_once" ? "accept" : decision === "allow_session" ? "acceptForSession" : "decline";
    if (pending.method === "item/permissions/requestApproval") {
      if (decision === "deny") this.sendRpcError(pending.rpcId, -32000, "User declined permissions");
      else this.sendRpcResult(pending.rpcId, {
        permissions: pending.params.permissions,
        scope: decision === "allow_session" ? "session" : "turn",
      });
    } else {
      this.sendRpcResult(pending.rpcId, { decision: nativeDecision });
    }
    this.onEvent({ type: "approval_resolved", id, decision });
    return true;
  }

  handleApprovalBridge(_token: string, _input: unknown): Promise<unknown> | null {
    return null;
  }

  setModel(model: string | undefined): void {
    this.model = model;
  }

  getModel(): string | undefined {
    return this.model;
  }

  getPersistenceState(): { sessionId: string; completedTurns: number } {
    return { sessionId: this.sessionId, completedTurns: this.completedTurns };
  }

  private async ensureThread(): Promise<string> {
    if (this.ready) return this.ready;
    this.ready = this.startAppServer();
    try {
      return await this.ready;
    } catch (error) {
      this.ready = null;
      throw error;
    }
  }

  private async startAppServer(): Promise<string> {
    // Codex applies `model_instructions_file` on top of its base coding
    // instructions (verified: the persona is adopted while apply_patch/tool
    // knowledge is retained), mirroring Claude's --append-system-prompt.
    const args = ["app-server"];
    const persona = this.getPersonaPrompt().trim();
    // An app-server may exit unexpectedly and be recreated without `stop()`.
    // Remove its superseded instructions file before assigning a new one.
    this.clearPersonaFile();
    if (persona) {
      this.personaFilePath = join(dirname(config.dbPath), `.pixel-crew-persona-${randomUUID()}.md`);
      ensurePrivateDirectorySync(dirname(this.personaFilePath));
      writeFileSync(this.personaFilePath, persona, { mode: 0o600 });
      protectFileSync(this.personaFilePath);
      args.push("-c", codexPersonaConfig(this.personaFilePath));
    }
    const child = spawnCli(config.codexBin, args, {
      cwd: this.workspacePath,
      env: codexChildEnv(process.env),
    });
    this.child = child;
    const generation = ++this.generation;
    let stderr = "";
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => this.handleRpcLine(line, generation));
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString()}`.slice(-20_000); });
    child.on("error", (error) => this.handleProcessFailure(error.message, generation));
    child.on("close", (code) => this.handleProcessFailure(stderr.trim() || `codex app-server exited with code ${code}`, generation));

    await this.request("initialize", {
      clientInfo: { name: "pixel_crew", title: "Pixel Crew", version: "0.1.0" },
    });
    this.notify("initialized", {});

    if (this.completedTurns > 0) {
      try {
        const resumed = await this.request("thread/resume", {
          threadId: this.sessionId,
          cwd: this.workspacePath,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: config.codexSandbox,
          ...(this.model ? { model: this.model } : {}),
        });
        this.sessionId = String(resumed.thread.id);
        return this.sessionId;
      } catch (error) {
        console.warn("Unable to resume legacy Codex thread; starting a new thread:", (error as Error).message);
        this.completedTurns = 0;
      }
    }
    const started = await this.request("thread/start", {
      cwd: this.workspacePath,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: config.codexSandbox,
      ...(this.model ? { model: this.model } : {}),
    });
    this.sessionId = String(started.thread.id);
    return this.sessionId;
  }

  private clearPersonaFile(): void {
    if (!this.personaFilePath) return;
    rmSync(this.personaFilePath, { force: true });
    this.personaFilePath = null;
  }

  private handleRpcLine(line: string, generation: number): void {
    if (generation !== this.generation || !line.trim()) return;
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && !message.method) {
      const pending = this.pendingRpc.get(message.id);
      if (!pending) return;
      this.pendingRpc.delete(message.id);
      if (message.error) pending.reject(new Error(String(message.error.message ?? "Codex request failed")));
      else pending.resolve(message.result);
      return;
    }
    if (message.method && message.id !== undefined) {
      this.handleServerRequest(message);
      return;
    }
    if (message.method) this.handleNotification(message.method, message.params ?? {});
  }

  private handleNotification(method: string, params: any): void {
    switch (method) {
      case "turn/started":
        this.currentTurnId = String(params.turn?.id ?? "");
        break;
      case "turn/completed": {
        const status = String(params.turn?.status ?? "completed");
        const isError = status !== "completed";
        this.cancelApprovals();
        this.completedTurns++;
        this.busy = false;
        this.currentTurnId = null;
        this.cleanupInputImages();
        this.cleanupInputDocuments();
        this.onEvent({
          type: "turn_end",
          resultText: this.finalText,
          costUsd: 0,
          durationMs: Number(params.turn?.durationMs ?? Date.now() - this.startedAt),
          isError,
          permissionDenials: [],
        });
        break;
      }
      case "item/started":
        this.handleItemStarted(params.item);
        break;
      case "item/completed":
        this.handleItemCompleted(params.item);
        break;
      case "item/agentMessage/delta": {
        const id = String(params.itemId ?? "agent");
        const delta = String(params.delta ?? "");
        this.streamedAgentText.set(id, (this.streamedAgentText.get(id) ?? "") + delta);
        this.onEvent({ type: "text_delta", text: delta });
        break;
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        if (params.delta) {
          this.streamedReasoning.add(String(params.itemId ?? "reasoning"));
          this.onEvent({ type: "thinking_delta", text: String(params.delta) });
        }
        break;
      case "item/plan/delta":
        if (params.delta) this.onEvent({ type: "thinking_delta", text: String(params.delta) });
        break;
      case "item/commandExecution/outputDelta":
        if (params.itemId && params.delta) {
          this.onEvent({ type: "tool_call_output_delta", id: String(params.itemId), delta: String(params.delta) });
        }
        break;
      case "item/mcpToolCall/progress":
        if (params.itemId && params.message) {
          this.onEvent({ type: "tool_call_output_delta", id: String(params.itemId), delta: `${String(params.message)}\n` });
        }
        break;
      case "error":
        this.finishWithError(String(params.error?.message ?? params.message ?? "Codex app-server error"));
        break;
    }
  }

  private handleItemStarted(item: any): void {
    if (!item?.id) return;
    const tool = codexAppTool(item);
    if (!tool) return;
    const id = String(item.id);
    this.openTools.add(id);
    this.onEvent({ type: "tool_call_start", id, name: tool.name, input: tool.input });
  }

  private handleItemCompleted(item: any): void {
    if (!item) return;
    if (item.type === "agentMessage" && typeof item.text === "string") {
      const id = String(item.id ?? "agent");
      const streamed = this.streamedAgentText.get(id) ?? "";
      if (!streamed) {
        this.onEvent({ type: "text_delta", text: item.text });
      } else if (item.text.startsWith(streamed) && item.text.length > streamed.length) {
        const suffix = item.text.slice(streamed.length);
        this.onEvent({ type: "text_delta", text: suffix });
      }
      this.finalText = item.text;
      return;
    }
    if (item.type === "reasoning") {
      const text = [...(item.summary ?? []), ...(item.content ?? [])].join("\n");
      if (text && !this.streamedReasoning.has(String(item.id ?? "reasoning"))) {
        this.onEvent({ type: "thinking_delta", text });
      }
      return;
    }
    if (item.type === "plan" && item.text) {
      this.onEvent({ type: "thinking_delta", text: `計畫\n${String(item.text)}` });
      return;
    }
    const tool = codexAppTool(item);
    if (!tool || !item.id) return;
    const id = String(item.id);
    if (!this.openTools.has(id)) this.onEvent({ type: "tool_call_start", id, name: tool.name, input: tool.input });
    this.onEvent({ type: "tool_call_result", id, output: tool.output, isError: tool.isError });
    this.openTools.delete(id);
  }

  private handleServerRequest(message: any): void {
    const method = String(message.method);
    const params = message.params ?? {};
    if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"].includes(method)) {
      this.sendRpcError(message.id, -32601, "Unsupported client request");
      return;
    }
    const category = method.includes("commandExecution") ? "command" : method.includes("fileChange") ? "file_change" : "permissions";
    const command = category === "command" && params.command ? String(params.command).slice(0, 20_000) : undefined;
    // Under "safe" mode, file changes and permission escalations are never in
    // autoApprovalPolicy's allowlist, so only commandExecution can auto
    // -approve. Under "full" mode, evaluateAutoApproval treats any non-Bash
    // action as blanket-safe (mirroring Claude), so these two categories can
    // auto-approve too — that's the whole point of the more permissive mode.
    const mode = this.getAutoApproveMode();
    const autoApproval = evaluateAutoApproval(mode, category === "command" ? "Bash" : "Edit", command);

    if (autoApproval.allowed) {
      const id = randomUUID();
      this.onEvent({
        type: "approval_requested",
        request: {
          id,
          activityId: params.itemId ? String(params.itemId) : null,
          category,
          title: "Codex 執行了這個指令",
          input: boundedValue({ command: params.command ?? "", actions: params.commandActions ?? [] }),
          command,
          cwd: params.cwd ? String(params.cwd).slice(0, 4_000) : undefined,
          reason: mode === "full" ? "完全自動核准已開啟" : "安全自動核准已開啟",
          decisions: [],
        },
      });
      this.onEvent({ type: "approval_resolved", id, decision: "auto_allow" });
      // item/permissions/requestApproval expects a differently-shaped
      // response than the other two categories — mirror resolveApproval's
      // accept path exactly, or Codex's app-server will reject the reply.
      if (method === "item/permissions/requestApproval") {
        this.sendRpcResult(message.id, { permissions: params.permissions, scope: "turn" });
      } else {
        this.sendRpcResult(message.id, { decision: "accept" });
      }
      return;
    }

    const id = randomUUID();
    const request: ApprovalRequest = {
      id,
      activityId: params.itemId ? String(params.itemId) : null,
      category,
      title: category === "command" ? "允許執行這個指令？" : category === "file_change" ? "允許套用檔案變更？" : "允許提高工作權限？",
      input: boundedValue(category === "command" ? { command: params.command ?? "", actions: params.commandActions ?? [] } : params),
      command,
      cwd: params.cwd ? String(params.cwd).slice(0, 4_000) : undefined,
      reason: mode !== "off"
        ? `${mode === "full" ? "完全" : "安全"}自動核准已開啟，但此操作仍需確認（${autoApproval.reason}）`
        : params.reason ? String(params.reason).slice(0, 4_000) : undefined,
      decisions: ["allow_once", "allow_session", "deny"],
    };
    this.approvals.set(id, { rpcId: message.id, method, params, request });
    this.onEvent({ type: "approval_requested", request });
  }

  private request(method: string, params: unknown): Promise<any> {
    if (!this.child) return Promise.reject(new Error("Codex app-server is not running"));
    const id = ++this.rpcCounter;
    return new Promise((resolve, reject) => {
      this.pendingRpc.set(id, { resolve, reject });
      this.child!.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private sendRpcResult(id: RpcId, result: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  private sendRpcError(id: RpcId, code: number, message: string): void {
    this.child?.stdin.write(`${JSON.stringify({ id, error: { code, message } })}\n`);
  }

  private cancelApprovals(): void {
    for (const [id, pending] of this.approvals) {
      this.sendRpcResult(pending.rpcId, { decision: "cancel" });
      this.onEvent({ type: "approval_resolved", id, decision: "deny" });
    }
    this.approvals.clear();
  }

  private handleProcessFailure(message: string, generation: number): void {
    if (generation !== this.generation) return;
    this.child = null;
    this.ready = null;
    this.cancelApprovals();
    for (const pending of this.pendingRpc.values()) pending.reject(new Error(message));
    this.pendingRpc.clear();
    if (this.busy) this.finishWithError(message);
  }

  private finishWithError(message: string): void {
    if (!this.busy) return;
    this.cancelApprovals();
    this.busy = false;
    this.currentTurnId = null;
    this.cleanupInputImages();
    this.cleanupInputDocuments();
    this.onEvent({ type: "error", message });
  }

  private stageInputImages(images: MessageImage[]): string[] {
    if (images.length === 0) return [];
    const directory = join(dirname(config.dbPath), "message-images");
    ensurePrivateDirectorySync(directory);
    const paths: string[] = [];
    try {
      for (const image of images) {
        const extension = image.mimeType === "image/png" ? "png" : image.mimeType === "image/jpeg" ? "jpg" : "webp";
        const path = join(directory, `.pixel-crew-message-${randomUUID()}.${extension}`);
        writeFileSync(path, Buffer.from(image.dataBase64, "base64"), { mode: 0o600 });
        protectFileSync(path);
        this.stagedInputImages.add(path);
        paths.push(path);
      }
      return paths;
    } catch (error) {
      this.cleanupInputImages();
      this.cleanupInputDocuments();
      throw error;
    }
  }

  private cleanupInputImages(): void {
    for (const path of this.stagedInputImages) rmSync(path, { force: true });
    this.stagedInputImages.clear();
  }

  private stageInputDocuments(documents: MessageDocument[]): Array<{ name: string; path: string }> {
    const files = stageMessageDocuments(documents, join(dirname(config.dbPath), "message-documents"));
    for (const file of files) this.stagedInputDocuments.add(file.path);
    return files;
  }

  private cleanupInputDocuments(): void {
    for (const path of this.stagedInputDocuments) rmSync(path, { force: true });
    this.stagedInputDocuments.clear();
  }
}

export function codexTurnInput(text: string, imagePaths: string[]): Array<Record<string, string>> {
  const input: Array<Record<string, string>> = [];
  if (text.trim()) input.push({ type: "text", text });
  for (const path of imagePaths) input.push({ type: "localImage", path });
  return input;
}

export function codexAppTool(item: any): { name: string; input: unknown; output: unknown; isError: boolean } | null {
  const failed = ["failed", "declined"].includes(String(item?.status ?? ""));
  switch (item?.type) {
    case "commandExecution":
      return {
        name: "Bash",
        input: { command: item.command ?? "", cwd: item.cwd ?? "", actions: item.commandActions ?? [] },
        output: item.aggregatedOutput ?? "",
        isError: failed || Number(item.exitCode ?? 0) !== 0,
      };
    case "mcpToolCall":
      return {
        name: `mcp__${item.server ?? "unknown"}__${item.tool ?? "tool"}`,
        input: item.arguments ?? {},
        output: item.result ?? item.error ?? "",
        isError: failed || Boolean(item.error),
      };
    case "dynamicToolCall":
      return { name: item.tool ?? "Tool", input: item.arguments ?? {}, output: item.contentItems ?? "", isError: failed || item.success === false };
    case "webSearch":
      return { name: "WebSearch", input: item, output: item, isError: failed };
    case "fileChange":
      return { name: "Edit", input: item.changes ?? [], output: item.status ?? "completed", isError: failed };
    case "collabAgentToolCall":
      return {
        name: "Agent",
        input: { description: item.tool, prompt: item.prompt, receiverThreadIds: item.receiverThreadIds ?? [] },
        output: item.agentsStates ?? item.status ?? "",
        isError: failed,
      };
    default:
      return null;
  }
}

/** Kept for compatibility tests and old persisted Codex JSONL fixtures. */
export function buildCodexArgs(options: { sessionId: string; completedTurns: number; model?: string; sandbox: string; prompt: string }): string[] {
  if (options.completedTurns > 0) {
    const args = ["exec", "resume", "--json"];
    if (options.model) args.push("--model", options.model);
    args.push(options.sessionId, options.prompt);
    return args;
  }
  const args = ["exec", "--json", "--color", "never", "--sandbox", options.sandbox];
  if (options.model) args.push("--model", options.model);
  args.push(options.prompt);
  return args;
}

export function codexChildEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) if (key.startsWith("CODEX_") && key !== "CODEX_HOME") delete env[key];
  return env;
}

export function codexTool(item: any): { name: string; input: unknown; output: unknown; isError: boolean } | null {
  const failed = item?.status === "failed" || Number(item?.exit_code ?? 0) !== 0;
  switch (item?.type) {
    case "command_execution": return { name: "Bash", input: { command: item.command ?? "" }, output: item.aggregated_output ?? item.output ?? "", isError: failed };
    case "mcp_tool_call": return { name: `mcp__${item.server ?? "unknown"}__${item.tool ?? "tool"}`, input: item.arguments ?? item.input ?? {}, output: item.result ?? item.output ?? item.error ?? "", isError: failed || Boolean(item.error) };
    case "web_search": return { name: "WebSearch", input: item.query ?? {}, output: item.result ?? "", isError: failed };
    case "file_change": return { name: "Edit", input: item.changes ?? item, output: item.status ?? "completed", isError: failed };
    default: return null;
  }
}

function boundedValue(value: unknown, maxLength = 20_000): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= maxLength) return value;
    return `${serialized.slice(0, maxLength)}\n…[內容已截斷]`;
  } catch {
    return String(value).slice(0, maxLength);
  }
}
