import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import type { AgentSession } from "./providers/session.js";

export type RunnerEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string; input: unknown }
  | { type: "tool_call_result"; id: string; output: unknown; isError: boolean }
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
    }
  | { type: "user_message"; text: string }
  | { type: "error"; message: string };

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
  busy = false;
  name = "";

  constructor(
    private readonly onEvent: (event: RunnerEvent) => void,
    readonly workspacePath: string,
    private readonly getAllowedTools: () => string[] = () => [],
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

  send(text: string): void {
    this.busy = true;
    const child = this.ensureChild();
    const line =
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
      }) + "\n";
    child.stdin.write(line);
  }

  stop(): void {
    this.generation++;
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
    this.busy = false;
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;

    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--permission-mode",
      config.permissionMode,
    ];
    if (this.completedTurns > 0) {
      args.push("--resume", this.claudeSessionId);
    } else {
      // A killed process may have claimed the old id without completing a
      // turn, so start unused sessions on a fresh id.
      this.claudeSessionId = randomUUID();
      args.push("--session-id", this.claudeSessionId);
    }
    if (this.model) args.push("--model", this.model);
    const allowed = this.getAllowedTools();
    if (allowed.length > 0) args.push("--allowedTools", allowed.join(","));

    const child = spawn(config.claudeBin, args, {
      cwd: this.workspacePath,
      env: process.env,
    });
    this.child = child;
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
      if (this.busy) {
        this.busy = false;
        this.onEvent({ type: "error", message });
      }
    };

    child.on("error", (err) => fail(err.message));
    child.on("close", (code) =>
      fail(stderrBuf.trim() || `claude exited with code ${code}`),
    );

    return child;
  }
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
