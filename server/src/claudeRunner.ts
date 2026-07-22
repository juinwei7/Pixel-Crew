import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import type { AgentSession, ExecutionProfile, MessageDocument, MessageImage, SendOptions } from "./providers/session.js";
import { documentPrompt, stageMessageDocuments } from "./messageDocuments.js";
import { ensurePrivateDirectorySync, protectFileSync } from "./platform/fileProtection.js";
import { spawnCli, terminateProcessTree } from "./platform/processes.js";
import { evaluateAutoApproval, type AutoApproveMode } from "./dangerousCommand.js";

export type RunnerEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string; input: unknown }
  | { type: "tool_call_output_delta"; id: string; delta: string }
  | { type: "tool_call_result"; id: string; output: unknown; isError: boolean }
  | { type: "approval_requested"; request: ApprovalRequest }
  | { type: "approval_resolved"; id: string; decision: ApprovalDecision }
  | {
      type: "turn_end";
      resultText: string;
      costUsd: number;
      durationMs: number;
      isError: boolean;
      permissionDenials: unknown[];
    }
  | {
      type: "meta";
      model: string;
      slashCommands: string[];
      mcpServers: Array<{ name: string; status: string }>;
      toolCount: number;
      // Built-in tools (Bash, Read, Edit, …) available at session init time —
      // NOT an MCP server's tool list. The init frame fires before slow MCP
      // servers finish connecting, so it typically excludes their tools.
      builtinTools: string[];
    }
  | { type: "user_message"; text: string; departmentFollowUpMissionId?: string }
  | { type: "error"; message: string };

export type ApprovalDecision = "allow_once" | "allow_session" | "deny" | "auto_allow";

export function claudePermissionMode(profile: ExecutionProfile, normalMode: string): string {
  return profile === "read_only_collaboration" ? "plan" : normalMode;
}

export type ApprovalRequest = {
  id: string;
  activityId: string | null;
  category: "command" | "file_change" | "tool" | "permissions";
  title: string;
  input: unknown;
  command?: string;
  cwd?: string;
  reason?: string;
  decisions: ApprovalDecision[];
};

type SessionPermissionUpdate = {
  type: "addRules";
  rules: Array<{ toolName: string; ruleContent: string }>;
  behavior: "allow";
  destination: "session";
};

function sessionPermissionUpdates(value: unknown, toolName: string): SessionPermissionUpdate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as Record<string, unknown>;
    if (candidate.type !== "addRules" || candidate.behavior !== "allow" || !Array.isArray(candidate.rules)) return [];
    const rules = candidate.rules.flatMap((rule) => {
      if (!rule || typeof rule !== "object") return [];
      const detail = rule as Record<string, unknown>;
      const suggestedTool = String(detail.toolName ?? "").slice(0, 120);
      const ruleContent = typeof detail.ruleContent === "string" ? detail.ruleContent.trim().slice(0, 20_000) : "";
      // A bare tool grant would turn one harmless approval into blanket access
      // to every Bash command or file operation. Only accept scoped rules for
      // the tool currently shown to the user.
      return suggestedTool === toolName && ruleContent ? [{ toolName: suggestedTool, ruleContent }] : [];
    }).slice(0, 20);
    return rules.length ? [{ type: "addRules" as const, rules, behavior: "allow" as const, destination: "session" as const }] : [];
  }).slice(0, 10);
}

export function approvalBridgeLaunch(moduleUrl = import.meta.url): { bridgePath: string; args: string[] } {
  const runningTypescript = moduleUrl.endsWith(".ts");
  const bridgePath = fileURLToPath(new URL(
    runningTypescript ? "./claudeApprovalBridge.ts" : "./claudeApprovalBridge.js",
    moduleUrl,
  ));
  // Claude starts MCP processes with the NPC workspace as cwd. A bare `tsx`
  // import would therefore be resolved from the user's repo instead of Pixel
  // Crew and the approval server would silently fail to load.
  const args = runningTypescript
    ? ["--import", import.meta.resolve("tsx"), bridgePath]
    : [bridgePath];
  return { bridgePath, args };
}

/**
 * One persistent `claude` CLI process per chat session. Messages are fed
 * over stdin (stream-json input), so the CLI cold start (settings, hooks,
 * MCP connections) is paid once per session instead of once per message.
 */
export class ClaudeSession implements AgentSession {
  readonly provider = "claude" as const;
  private child: ChildProcessWithoutNullStreams | null = null;
  private claudeSessionId: string;
  private completedTurns: number;
  private generation = 0;
  private model: string | undefined;
  private executionProfile: ExecutionProfile = "normal";
  private spawnedProfile: ExecutionProfile | null = null;
  private readonly approvalToken = randomUUID();
  private readonly approvalConfigPath = join(dirname(config.dbPath), `.pixel-crew-approval-${randomUUID()}.json`);
  private readonly documentDirectory = join(dirname(config.dbPath), "message-documents");
  private stagedInputDocuments = new Set<string>();
  private pendingApprovals = new Map<string, {
    input: unknown;
    permissionUpdates: SessionPermissionUpdate[];
    resolve(result: unknown): void;
  }>();
  busy = false;
  name = "";

  constructor(
    private readonly onEvent: (event: RunnerEvent) => void,
    readonly workspacePath: string,
    private readonly getAllowedTools: () => string[] = () => [],
    // Returns the composed persona system-prompt for this worker, or "" for
    // none. Read at spawn time so a persona change survives /clear, model
    // switches, and restarts by being re-applied on the next `ensureChild`.
    private readonly getPersonaPrompt: () => string = () => "",
    // Auto-approve mode for this worker's tool calls, read live on every
    // approval request (no restart needed to switch). "off" always prompts,
    // "safe" only allows a narrow read-only/verified-safe set, "full" allows
    // everything except isDangerousCommand matches. See dangerousCommand.ts.
    private readonly getAutoApproveMode: () => AutoApproveMode = () => "off",
    initialState?: { sessionId: string; completedTurns: number },
  ) {
    this.claudeSessionId = initialState?.sessionId || randomUUID();
    this.completedTurns = initialState?.completedTurns ?? 0;
  }

  /** Kill the running turn; the next message resumes the conversation. */
  interrupt(): void {
    const wasBusy = this.busy;
    this.stop();
    if (wasBusy) this.onEvent({ type: "error", message: "已中止" });
  }

  /** Spawn the CLI ahead of the first message so MCP connections warm up. */
  warmup(): void {
    this.ensureChild();
  }

  setModel(model: string | undefined): void {
    if (model === this.model) return;
    this.model = model;
    // Restart on next message; finished turns are recovered via --resume.
    this.stop();
  }

  getModel(): string | undefined {
    return this.model;
  }

  getPersistenceState(): { sessionId: string; completedTurns: number } {
    return {
      sessionId: this.claudeSessionId,
      completedTurns: this.completedTurns,
    };
  }

  send(text: string, images: MessageImage[] = [], documents: MessageDocument[] = [], options: SendOptions = {}): void {
    const nextProfile = options.executionProfile ?? "normal";
    if (this.child && this.spawnedProfile !== nextProfile) this.stop();
    this.executionProfile = nextProfile;
    const files = this.stageInputDocuments(documents);
    try {
      this.busy = true;
      const child = this.ensureChild();
      const attachmentNote = documentPrompt(files);
      const line =
        JSON.stringify({
          type: "user",
          message: { role: "user", content: claudeMessageContent([text, attachmentNote].filter(Boolean).join("\n\n"), images) },
        }) + "\n";
      child.stdin.write(line);
    } catch (error) {
      this.cleanupInputDocuments();
      this.busy = false;
      throw error;
    }
  }

  stop(): void {
    this.generation++;
    this.cancelApprovals();
    if (this.child) {
      void terminateProcessTree(this.child);
      this.child = null;
    }
    this.busy = false;
    this.cleanupInputDocuments();
    rmSync(this.approvalConfigPath, { force: true });
  }

  resolveApproval(id: string, decision: ApprovalDecision): boolean {
    const pending = this.pendingApprovals.get(id);
    if (!pending) return false;
    if (decision === "allow_session" && pending.permissionUpdates.length === 0) return false;
    this.pendingApprovals.delete(id);
    pending.resolve(decision === "deny"
      ? { behavior: "deny", message: "使用者拒絕這項操作" }
      : {
          behavior: "allow",
          updatedInput: pending.input,
          ...(decision === "allow_session" ? { updatedPermissions: pending.permissionUpdates } : {}),
        });
    this.onEvent({ type: "approval_resolved", id, decision });
    return true;
  }

  handleApprovalBridge(token: string, rawInput: unknown): Promise<unknown> | null {
    if (token !== this.approvalToken || !this.busy) return null;
    const detail = rawInput && typeof rawInput === "object" ? rawInput as Record<string, unknown> : {};
    const toolName = String(detail.tool_name ?? detail.toolName ?? "Tool").slice(0, 120);
    const originalInput = detail.input ?? detail.tool_input ?? {};
    const permissionUpdates = sessionPermissionUpdates(detail.permission_suggestions ?? detail.suggestions, toolName);
    const input = boundedValue(originalInput);
    const command = toolName === "Bash" && originalInput && typeof originalInput === "object"
      ? String((originalInput as Record<string, unknown>).command ?? "").slice(0, 20_000)
      : undefined;
    if (this.executionProfile === "read_only_collaboration") {
      const id = randomUUID();
      this.onEvent({ type: "approval_requested", request: {
        id, activityId: null,
        category: toolName === "Bash" ? "command" : ["Edit", "Write", "NotebookEdit"].includes(toolName) ? "file_change" : "tool",
        title: `唯讀協作已拒絕 ${toolName}`,
        input,
        command,
        cwd: this.workspacePath,
        reason: "唯讀 NPC 協作不允許需要額外權限的操作",
        decisions: [],
      } });
      this.onEvent({ type: "approval_resolved", id, decision: "deny" });
      return Promise.resolve({ behavior: "deny", message: "唯讀 NPC 協作不允許需要額外權限的操作" });
    }
    const mode = this.getAutoApproveMode();
    const autoApproval = evaluateAutoApproval(mode, toolName, command);

    if (autoApproval.allowed) {
      // Still surface it in the task log as an already-resolved item, so the
      // user can see what ran without having to act on it.
      const id = randomUUID();
      this.onEvent({
        type: "approval_requested",
        request: {
          id,
          activityId: null,
          category: toolName === "Bash" ? "command" : ["Edit", "Write", "NotebookEdit"].includes(toolName) ? "file_change" : "tool",
          title: toolName === "Bash" ? "Claude 執行了這個指令" : `Claude 使用了 ${toolName}`,
          input,
          command,
          cwd: this.workspacePath,
          reason: mode === "full" ? "完全自動核准已開啟" : "安全自動核准已開啟",
          decisions: [],
        },
      });
      this.onEvent({ type: "approval_resolved", id, decision: "auto_allow" });
      return Promise.resolve({ behavior: "allow", updatedInput: originalInput });
    }

    const id = randomUUID();
    const request: ApprovalRequest = {
      id,
      activityId: null,
      category: toolName === "Bash" ? "command" : ["Edit", "Write", "NotebookEdit"].includes(toolName) ? "file_change" : "tool",
      title: toolName === "Bash" ? "允許 Claude 執行這個指令？" : `允許 Claude 使用 ${toolName}？`,
      input,
      command,
      cwd: this.workspacePath,
      reason: mode !== "off"
        ? `${mode === "full" ? "完全" : "安全"}自動核准已開啟，但此操作仍需確認（${autoApproval.reason}）`
        : permissionUpdates.length
          ? `Claude Code 需要額外權限；「本次皆允許」只套用目前工作階段的建議規則：${permissionUpdates.flatMap((update) => update.rules.map((rule) => `${rule.toolName}(${rule.ruleContent})`)).join("、").slice(0, 500)}`
          : "Claude Code 需要額外權限才能繼續目前回合",
      decisions: permissionUpdates.length ? ["allow_once", "allow_session", "deny"] : ["allow_once", "deny"],
    };
    const pending = new Promise((resolve) => this.pendingApprovals.set(id, { input: originalInput, permissionUpdates, resolve }));
    this.onEvent({ type: "approval_requested", request });
    return pending;
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;

    this.writeApprovalConfig();
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--permission-mode",
      claudePermissionMode(this.executionProfile, config.permissionMode),
      "--mcp-config",
      this.approvalConfigPath,
      "--permission-prompt-tool",
      "mcp__pixel_crew_approval__approval_prompt",
    ];
    // Attachments live in Pixel Crew's private app-data directory rather than
    // polluting the user's repo. Explicitly grant this one read scope so
    // Claude can inspect them without an unrelated outside-workspace prompt.
    ensurePrivateDirectorySync(this.documentDirectory);
    args.push("--add-dir", this.documentDirectory);
    if (this.completedTurns > 0) {
      args.push("--resume", this.claudeSessionId);
    } else {
      // A killed process may have claimed the old id without completing a
      // turn, so start unused sessions on a fresh id.
      this.claudeSessionId = randomUUID();
      args.push("--session-id", this.claudeSessionId);
    }
    if (this.model) args.push("--model", this.model);
    const personaPrompt = this.getPersonaPrompt().trim();
    if (personaPrompt) args.push("--append-system-prompt", personaPrompt);
    const allowed = [...this.getAllowedTools(), "mcp__pixel_crew_approval__approval_prompt"];
    if (allowed.length > 0) args.push("--allowedTools", allowed.join(","));

    const child = spawnCli(config.claudeBin, args, {
      cwd: this.workspacePath,
      env: process.env,
    });
    this.child = child;
    this.spawnedProfile = this.executionProfile;
    const gen = ++this.generation;

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (gen !== this.generation || !line.trim()) return;
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (parsed.type === "result") {
        this.completedTurns++;
        this.busy = false;
        this.cleanupInputDocuments();
        this.cancelApprovals();
      }
      handleLine(parsed, this.onEvent);
    });

    let stderrBuf = "";
    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
    });

    const fail = (message: string) => {
      if (gen !== this.generation) return;
      this.child = null;
      this.cancelApprovals();
      rmSync(this.approvalConfigPath, { force: true });
      if (this.busy) {
        this.busy = false;
        this.cleanupInputDocuments();
        this.onEvent({ type: "error", message });
      }
    };

    child.on("error", (err) => fail(err.message));
    child.on("close", (code) =>
      fail(stderrBuf.trim() || `claude exited with code ${code}`),
    );

    return child;
  }

  private writeApprovalConfig(): void {
    ensurePrivateDirectorySync(dirname(this.approvalConfigPath));
    const { args } = approvalBridgeLaunch();
    writeFileSync(this.approvalConfigPath, JSON.stringify({
      mcpServers: {
        pixel_crew_approval: {
          command: process.execPath,
          args,
          env: {
            PIXEL_CREW_APPROVAL_URL: `http://127.0.0.1:${config.port}/internal/claude-approval`,
            PIXEL_CREW_APPROVAL_TOKEN: this.approvalToken,
          },
        },
      },
    }), { mode: 0o600 });
    protectFileSync(this.approvalConfigPath);
  }

  private cancelApprovals(): void {
    for (const [id, pending] of this.pendingApprovals) {
      pending.resolve({ behavior: "deny", message: "Pixel Crew 工作階段已結束" });
      this.onEvent({ type: "approval_resolved", id, decision: "deny" });
    }
    this.pendingApprovals.clear();
  }

  private stageInputDocuments(documents: MessageDocument[]): Array<{ name: string; path: string }> {
    const files = stageMessageDocuments(documents, this.documentDirectory);
    for (const file of files) this.stagedInputDocuments.add(file.path);
    return files;
  }

  private cleanupInputDocuments(): void {
    for (const path of this.stagedInputDocuments) rmSync(path, { force: true });
    this.stagedInputDocuments.clear();
  }
}

export function claudeMessageContent(text: string, images: MessageImage[]): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  if (text.trim()) content.push({ type: "text", text });
  for (const image of images) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: image.mimeType, data: image.dataBase64 },
    });
  }
  return content;
}

function handleLine(parsed: any, onEvent: (event: RunnerEvent) => void): void {
  switch (parsed.type) {
    case "system": {
      if (parsed.subtype === "init") {
        onEvent({
          type: "meta",
          model: parsed.model ?? "",
          slashCommands: Array.isArray(parsed.slash_commands) ? parsed.slash_commands : [],
          mcpServers: Array.isArray(parsed.mcp_servers)
            ? parsed.mcp_servers.map((s: any) => ({
                name: String(s.name ?? ""),
                status: String(s.status ?? "unknown"),
              }))
            : [],
          toolCount: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
          builtinTools: Array.isArray(parsed.tools)
            ? parsed.tools.filter((tool: unknown): tool is string => typeof tool === "string")
            : [],
        });
      }
      break;
    }
    case "stream_event": {
      const inner = parsed.event;
      if (inner?.type === "content_block_delta") {
        const delta = inner.delta;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          onEvent({ type: "text_delta", text: delta.text });
        } else if (
          delta?.type === "thinking_delta" &&
          typeof delta.thinking === "string"
        ) {
          onEvent({ type: "thinking_delta", text: delta.thinking });
        }
      }
      break;
    }
    case "assistant": {
      const blocks = parsed.message?.content ?? [];
      for (const block of blocks) {
        if (block.type === "tool_use") {
          onEvent({
            type: "tool_call_start",
            id: block.id,
            name: block.name,
            input: block.input,
          });
        }
      }
      break;
    }
    case "user": {
      const blocks = parsed.message?.content ?? [];
      for (const block of blocks) {
        if (block.type === "tool_result") {
          onEvent({
            type: "tool_call_result",
            id: block.tool_use_id,
            output: block.content,
            isError: Boolean(block.is_error),
          });
        }
      }
      break;
    }
    case "result": {
      const subtype = String(parsed.subtype ?? "");
      const isError = Boolean(parsed.is_error) || subtype.startsWith("error");
      onEvent({
        type: "turn_end",
        resultText: parsed.result ?? parsed.error?.message ?? parsed.message ?? (isError ? subtype : ""),
        costUsd: parsed.total_cost_usd ?? 0,
        durationMs: parsed.duration_ms ?? 0,
        isError,
        permissionDenials: parsed.permission_denials ?? [],
      });
      break;
    }
    default:
      break;
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
