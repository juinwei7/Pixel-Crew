import { randomUUID } from "node:crypto";
import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import type { ApprovalDecision, ApprovalRequest, RunnerEvent } from "./claudeRunner.js";
import type { AgentSession, ExecutionProfile, MessageDocument, MessageImage, SendOptions } from "./providers/session.js";
import { stageMessageDocuments } from "./messageDocuments.js";
import { ensurePrivateDirectorySync, protectFileSync } from "./platform/fileProtection.js";
import { spawnCli, terminateProcessTree } from "./platform/processes.js";
import { evaluateAutoApproval, type AutoApproveMode } from "./dangerousCommand.js";
import { parseCodexMcpServerStatus, type CodexMcpServerToolsEntry } from "./codexCapabilities.js";
import { codexChildEnv } from "./codexEnv.js";
import { t } from "./i18n.js";
import {
  ABORTED_MESSAGE,
  autoApproveConfirmReason,
  autoApproveEnabledReason,
  boundedValue,
  composeMessageText,
  isReadOnlyExecutionProfile,
  messageDocumentsDirectory,
  riskReasonFor,
  truncateCommand,
} from "./runnerShared.js";

type RpcId = string | number;
type PendingRpc = { resolve(value: any): void; reject(error: Error): void };
type PendingApproval = { rpcId: RpcId; method: string; params: any; request: ApprovalRequest };

export function codexSandbox(profile: ExecutionProfile, normalSandbox: string): string {
  return isReadOnlyExecutionProfile(profile) ? "read-only" : normalSandbox;
}

export type CodexNativeCommand =
  | { type: "reset" }
  | { type: "compact" }
  | { type: "review"; instructions: string }
  | { type: "goal_set"; objective: string }
  | { type: "goal_clear" }
  | { type: "goal_get" };

export function parseCodexNativeCommand(text: string): CodexNativeCommand | null {
  const match = text.trim().match(/^\/(clear|new|compact|review|goal)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const name = match[1].toLowerCase();
  const argument = (match[2] ?? "").trim();
  if ((name === "clear" || name === "new") && !argument) return { type: "reset" };
  if (name === "compact" && !argument) return { type: "compact" };
  if (name === "review") return { type: "review", instructions: argument };
  if (name === "goal") {
    if (!argument) return { type: "goal_get" };
    // Only the whole (trimmed) argument being exactly "clear" counts as the
    // clear verb — "/goal clear the auth debt" must set that as the
    // objective, not be misread as clearing the goal.
    if (argument.toLowerCase() === "clear") return { type: "goal_clear" };
    return { type: "goal_set", objective: argument };
  }
  return null;
}

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
  private executionProfile: ExecutionProfile = "normal";
  private mcpReloadPending = false;
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
    // Per-worker Codex account: overrides CODEX_HOME for this worker's
    // app-server child. Read live at each spawn (not cached at construction)
    // so reassigning a worker's account takes effect next restart. null/undefined
    // falls back to the shared/global CODEX_HOME (legacy behavior).
    private readonly getCodexHome: () => string | null = () => null,
  ) {
    this.sessionId = initialState?.sessionId || randomUUID();
    this.completedTurns = initialState?.completedTurns ?? 0;
  }

  warmup(): void {
    void this.ensureThread().catch((error) => console.warn("Codex app-server warmup failed:", error.message));
  }

  async reloadMcp(): Promise<"reloaded" | "deferred"> {
    if (this.busy) {
      this.mcpReloadPending = true;
      return "deferred";
    }
    this.mcpReloadPending = true;
    this.busy = true;
    try {
      await this.ensureThread();
      await this.request("config/mcpServer/reload", null);
      this.mcpReloadPending = false;
      return "reloaded";
    } finally {
      this.busy = false;
    }
  }

  send(text: string, images: MessageImage[] = [], documents: MessageDocument[] = [], options: SendOptions = {}): void {
    if (this.busy) throw new Error("codex worker busy");
    this.executionProfile = options.executionProfile ?? "normal";
    const nativeCommand = images.length === 0 && documents.length === 0
      ? parseCodexNativeCommand(text)
      : null;
    if (nativeCommand) {
      this.runNativeCommand(nativeCommand);
      return;
    }
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
      .then(async (threadId) => {
        if (this.mcpReloadPending) {
          await this.request("config/mcpServer/reload", null);
          this.mcpReloadPending = false;
        }
        return this.request("turn/start", {
          threadId,
          input: codexTurnInput(composeMessageText(text, documentFiles), imagePaths),
          cwd: this.workspacePath,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: codexSandbox(this.executionProfile, config.codexSandbox),
          ...(this.model ? { model: this.model } : {}),
        });
      })
      .catch((error) => this.finishWithError(error.message));
  }

  private runNativeCommand(command: CodexNativeCommand): void {
    if (command.type === "reset") {
      this.stop();
      this.sessionId = randomUUID();
      this.completedTurns = 0;
    }
    this.busy = true;
    this.startedAt = Date.now();
    this.openTools.clear();
    this.streamedAgentText.clear();
    this.streamedReasoning.clear();
    this.finalText = "";
    void this.ensureThread().then(async (threadId) => {
      if (command.type === "compact") {
        await this.request("thread/compact/start", { threadId });
        // Completion is signalled separately by thread/compacted.
        return;
      }
      if (command.type === "review") {
        await this.request("review/start", {
          threadId,
          delivery: "inline",
          target: command.instructions
            ? { type: "custom", instructions: command.instructions }
            : { type: "uncommittedChanges" },
        });
        // review/start produces the ordinary turn/item notifications; the
        // turn/completed handler owns the final state and persisted output.
        return;
      }
      // Unlike compact (fire-and-forget, confirmed later by thread/compacted),
      // the goal RPCs' own responses already carry the result — no need to
      // also listen for thread/goal/updated|cleared notifications.
      if (command.type === "goal_set") {
        const result = await this.request("thread/goal/set", { threadId, objective: command.objective, status: "active" });
        this.finishNativeCommand(t("已設定目標：{objective}", { objective: result?.goal?.objective ?? command.objective }), false);
        return;
      }
      if (command.type === "goal_clear") {
        const result = await this.request("thread/goal/clear", { threadId });
        this.finishNativeCommand(result?.cleared ? t("已清除目標。") : t("目前沒有設定目標。"), false);
        return;
      }
      if (command.type === "goal_get") {
        const result = await this.request("thread/goal/get", { threadId });
        const goal = result?.goal;
        this.finishNativeCommand(goal ? t("目前目標：{objective}（狀態：{status}）", { objective: goal.objective, status: goal.status }) : t("目前沒有設定目標。"), false);
        return;
      }
      this.finishNativeCommand(t("已建立新的 Codex 對話；後續工作不會沿用先前上下文。"), false);
    }).catch((error) => this.finishWithError((error as Error).message));
  }

  private finishNativeCommand(resultText: string, isError: boolean): void {
    if (!this.busy) return;
    this.busy = false;
    this.currentTurnId = null;
    this.finalText = resultText;
    this.onEvent({ type: "text_delta", text: resultText });
    this.onEvent({
      type: "turn_end",
      resultText,
      costUsd: 0,
      durationMs: Date.now() - this.startedAt,
      isError,
      permissionDenials: [],
    });
  }

  interrupt(): void {
    if (!this.busy) return;
    if (this.child && this.currentTurnId) {
      void this.request("turn/interrupt", { threadId: this.sessionId, turnId: this.currentTurnId })
        .catch((error) => this.finishWithError(error.message));
    } else {
      this.stop();
      this.onEvent({ type: "error", message: t(ABORTED_MESSAGE) });
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

  // Queries the (undocumented, experimental) mcpServerStatus/list app-server
  // method for a full tool catalog of every connected MCP server. Any
  // failure — an older Codex CLI, no live connection yet, or the method
  // being renamed/removed in a future version — degrades to "unsupported"
  // rather than throwing, since this is not a documented, stable surface.
  async listMcpServerTools(): Promise<
    | { ok: true; servers: CodexMcpServerToolsEntry[] }
    | { ok: false; reason: "not_ready" | "unsupported"; message: string }
  > {
    try {
      await this.ensureThread();
    } catch (error) {
      return { ok: false, reason: "not_ready", message: (error as Error).message };
    }
    try {
      const result = await this.request("mcpServerStatus/list", { detail: "full" });
      return { ok: true, servers: parseCodexMcpServerStatus(result) };
    } catch (error) {
      return { ok: false, reason: "unsupported", message: (error as Error).message };
    }
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
      env: codexChildEnv(process.env, this.getCodexHome()),
    });
    this.child = child;
    // Writing to stdin after the app-server has already died (but before
    // Node delivers 'close') throws EPIPE asynchronously; without a listener
    // that becomes an uncaught exception that takes down the whole server,
    // not just this worker (observed under concurrent multi-worker load).
    child.stdin.on("error", () => {});
    const generation = ++this.generation;
    let stderr = "";
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      // An unexpected app-server message shape must only fail this worker's
      // turn, not propagate to process.on("uncaughtException") and take
      // every worker down.
      try {
        this.handleRpcLine(line, generation);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[codexRunner] event handling error: ${message}`);
        // generation matched at call time (handleRpcLine's own guard returns
        // early otherwise), so `child` is still the live process for this turn.
        this.handleProcessFailure(message, generation);
        void terminateProcessTree(child);
      }
    });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString()}`.slice(-20_000); });
    child.on("error", (error) => this.handleProcessFailure(error.message, generation));
    child.on("close", (code) => this.handleProcessFailure(stderr.trim() || `codex app-server exited with code ${code}`, generation));

    await this.request("initialize", {
      clientInfo: { name: "pixel_crew", title: "Pixel Crew", version: "0.1.0" },
      // Undocumented flag required to unlock mcpServerStatus/list (see
      // listMcpServerTools below) — an experimental app-server method, not
      // exposed by `codex app-server --help` or any official doc.
      capabilities: { experimentalApi: true },
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
      case "thread/compacted":
        this.finishNativeCommand(t("Codex 對話內容已壓縮。"), false);
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
      this.onEvent({ type: "thinking_delta", text: t("計畫\n{text}", { text: String(item.text) }) });
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
    if (isReadOnlyExecutionProfile(this.executionProfile)) {
      const id = randomUUID();
      const command = category === "command" && params.command ? truncateCommand(params.command) : undefined;
      this.onEvent({ type: "approval_requested", request: {
        id,
        activityId: params.itemId ? String(params.itemId) : null,
        category,
        title: category === "command" ? t("唯讀模式已拒絕指令") : category === "file_change" ? t("唯讀模式已拒絕檔案變更") : t("唯讀模式已拒絕提高權限"),
        input: boundedValue(category === "command" ? { command: params.command ?? "", actions: params.commandActions ?? [] } : params),
        command,
        cwd: params.cwd ? String(params.cwd).slice(0, 4_000) : undefined,
        reason: this.executionProfile === "read_only_query"
          ? t("唯讀查詢不允許需要額外權限的操作")
          : t("唯讀 NPC 協作不允許需要額外權限的操作"),
        decisions: [],
        riskReason: riskReasonFor(command),
      } });
      if (method === "item/permissions/requestApproval") this.sendRpcError(message.id, -32000, "Read-only mode declined permissions");
      else this.sendRpcResult(message.id, { decision: "decline" });
      this.onEvent({ type: "approval_resolved", id, decision: "deny" });
      return;
    }
    const command = category === "command" && params.command ? truncateCommand(params.command) : undefined;
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
          title: t("Codex 執行了這個指令"),
          input: boundedValue({ command: params.command ?? "", actions: params.commandActions ?? [] }),
          command,
          cwd: params.cwd ? String(params.cwd).slice(0, 4_000) : undefined,
          reason: autoApproveEnabledReason(mode),
          decisions: [],
          riskReason: riskReasonFor(command),
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
      title: category === "command" ? t("允許執行這個指令？") : category === "file_change" ? t("允許套用檔案變更？") : t("允許提高工作權限？"),
      input: boundedValue(category === "command" ? { command: params.command ?? "", actions: params.commandActions ?? [] } : params),
      command,
      cwd: params.cwd ? String(params.cwd).slice(0, 4_000) : undefined,
      reason: mode !== "off"
        ? autoApproveConfirmReason(mode, autoApproval.reason)
        : params.reason ? String(params.reason).slice(0, 4_000) : undefined,
      decisions: ["allow_once", "allow_session", "deny"],
      riskReason: riskReasonFor(command),
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
    const files = stageMessageDocuments(documents, messageDocumentsDirectory());
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

// Re-exported for backward compatibility — callers/tests that import
// codexChildEnv from here keep working; the real implementation lives in
// codexEnv.ts (a dependency-free leaf module so codexCapabilities.ts can also
// import it without an import cycle, since codexRunner.ts <-> codexCapabilities.ts
// already import from each other).
export { codexChildEnv } from "./codexEnv.js";

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
