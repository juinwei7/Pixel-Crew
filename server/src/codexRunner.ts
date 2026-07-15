import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { config } from "./config.js";
import type { RunnerEvent } from "./claudeRunner.js";
import type { AgentSession } from "./providers/session.js";

export class CodexSession implements AgentSession {
  readonly provider = "codex" as const;
  private child: ChildProcessWithoutNullStreams | null = null;
  private sessionId: string;
  private completedTurns: number;
  private model: string | undefined;
  private startedAt = 0;
  private generation = 0;
  private openTools = new Set<string>();
  busy = false;
  name = "";

  constructor(
    private readonly onEvent: (event: RunnerEvent) => void,
    readonly workspacePath: string,
    initialState?: { sessionId: string; completedTurns: number },
  ) {
    this.sessionId = initialState?.sessionId || randomUUID();
    this.completedTurns = initialState?.completedTurns ?? 0;
  }

  warmup(): void {
    // `codex exec` is turn-based; spawning without a prompt would start an
    // interactive UI, so the process is intentionally created on send().
  }

  send(text: string): void {
    if (this.busy) throw new Error("codex worker busy");
    this.busy = true;
    this.startedAt = Date.now();
    this.openTools.clear();

    const args = buildCodexArgs({
      sessionId: this.sessionId,
      completedTurns: this.completedTurns,
      model: this.model,
      sandbox: config.codexSandbox,
      prompt: text,
    });

    const child = spawn(config.codexBin, args, {
      cwd: this.workspacePath,
      env: codexChildEnv(process.env),
    });
    // In non-TTY mode Codex accepts extra prompt content from stdin and waits
    // for EOF before starting the thread. Pixel Crew sends the prompt as an
    // argument, so close the unused pipe immediately.
    child.stdin.end();
    this.child = child;
    const generation = ++this.generation;
    let stderr = "";
    let ended = false;

    const finishWithError = (message: string) => {
      if (generation !== this.generation || ended) return;
      ended = true;
      this.busy = false;
      this.child = null;
      this.onEvent({ type: "error", message });
    };

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (generation !== this.generation || !line.trim()) return;
      try {
        const event = JSON.parse(line) as any;
        if (event.type === "thread.started" && event.thread_id) {
          this.sessionId = String(event.thread_id);
        }
        if (event.type === "turn.completed") {
          ended = true;
          this.completedTurns++;
          this.busy = false;
          this.child = null;
          this.onEvent({
            type: "turn_end",
            resultText: "",
            costUsd: 0,
            durationMs: Date.now() - this.startedAt,
            isError: false,
            permissionDenials: [],
          });
          return;
        }
        if (event.type === "turn.failed" || event.type === "error") {
          finishWithError(extractError(event));
          return;
        }
        if (event.type === "item.started") this.handleItemStarted(event.item);
        if (event.type === "item.completed") this.handleItemCompleted(event.item);
      } catch {
        // Ignore non-JSON diagnostic lines; stderr is reported if the turn fails.
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => finishWithError(error.message));
    child.on("close", (code) => {
      if (generation !== this.generation || ended) return;
      finishWithError(stderr.trim() || `codex exited with code ${code}`);
    });
  }

  interrupt(): void {
    const wasBusy = this.busy;
    this.stop();
    if (wasBusy) this.onEvent({ type: "error", message: "已中止" });
  }

  stop(): void {
    this.generation++;
    if (this.child) this.child.kill();
    this.child = null;
    this.busy = false;
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

  private handleItemStarted(item: any): void {
    if (!item?.id) return;
    const tool = codexTool(item);
    if (!tool) return;
    this.openTools.add(String(item.id));
    this.onEvent({
      type: "tool_call_start",
      id: String(item.id),
      name: tool.name,
      input: tool.input,
    });
  }

  private handleItemCompleted(item: any): void {
    if (!item) return;
    if (item.type === "agent_message" && typeof item.text === "string") {
      this.onEvent({ type: "text_delta", text: item.text });
      return;
    }
    if (item.type === "reasoning" && typeof item.text === "string") {
      this.onEvent({ type: "thinking_delta", text: item.text });
      return;
    }

    const tool = codexTool(item);
    if (!tool || !item.id) return;
    const id = String(item.id);
    if (!this.openTools.has(id)) {
      this.openTools.add(id);
      this.onEvent({ type: "tool_call_start", id, name: tool.name, input: tool.input });
    }
    this.onEvent({
      type: "tool_call_result",
      id,
      output: tool.output,
      isError: tool.isError,
    });
    this.openTools.delete(id);
  }
}

export function buildCodexArgs(options: {
  sessionId: string;
  completedTurns: number;
  model?: string;
  sandbox: string;
  prompt: string;
}): string[] {
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

/**
 * A Pixel Crew server started from inside Codex inherits host-only flags such
 * as CODEX_THREAD_ID and CODEX_SANDBOX_NETWORK_DISABLED. Passing those to a
 * nested CLI can attach it to the host thread or disable its model network.
 * CODEX_HOME is user configuration, so it remains available for auth/config.
 */
export function codexChildEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CODEX_") && key !== "CODEX_HOME") delete env[key];
  }
  return env;
}

export function codexTool(item: any): { name: string; input: unknown; output: unknown; isError: boolean } | null {
  const failed = item?.status === "failed" || Number(item?.exit_code ?? 0) !== 0;
  switch (item?.type) {
    case "command_execution":
      return {
        name: "Bash",
        input: { command: item.command ?? "" },
        output: item.aggregated_output ?? item.output ?? "",
        isError: failed,
      };
    case "mcp_tool_call":
      return {
        name: `mcp__${item.server ?? "unknown"}__${item.tool ?? "tool"}`,
        input: item.arguments ?? item.input ?? {},
        output: item.result ?? item.output ?? item.error ?? "",
        isError: failed || Boolean(item.error),
      };
    case "web_search":
      return { name: "WebSearch", input: item.query ?? {}, output: item.result ?? "", isError: failed };
    case "file_change":
      return { name: "Edit", input: item.changes ?? item, output: item.status ?? "completed", isError: failed };
    default:
      return null;
  }
}

function extractError(event: any): string {
  return String(event?.error?.message ?? event?.message ?? "Codex turn failed");
}
