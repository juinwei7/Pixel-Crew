import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ProviderId } from "./providers/types.js";
import { config } from "./config.js";
import { spawnCli, terminateProcessTree } from "./platform/processes.js";
import { t } from "./i18n.js";

export type McpLoginStatus = "running" | "succeeded" | "failed" | "timeout" | "cancelled";

export type McpLoginState = {
  provider: ProviderId;
  workspacePath: string;
  name: string;
  status: McpLoginStatus;
  startedAt: string;
  finishedAt: string | null;
  message: string | null;
};

function boundedTail(value: string, limit = 4_000): string {
  const sanitized = value.replace(/\0/g, "").trim();
  return sanitized.length <= limit ? sanitized : `…${sanitized.slice(-limit)}`;
}

type Spawner = (command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;
type Terminator = (child: ChildProcessWithoutNullStreams) => void | Promise<void>;

// `claude mcp login <name>` / `codex mcp login <name>` open the user's system
// browser and wait for them to click "authorize" — an unbounded, user-paced
// duration that the request/response cycle of POST /api/mcp/login cannot
// block on. This tracker starts the CLI in the background, resolves the HTTP
// request immediately, and reports completion later via the caller's
// onFinished callback (wired to a WS broadcast in index.ts). Unlike
// ProviderInstaller (which reuses execCli's Promise), this keeps its own
// handle to the child process so an in-flight login can be cancelled.
export class McpLoginTracker {
  private readonly states = new Map<string, McpLoginState>();
  private readonly children = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(
    private readonly onFinished: (state: McpLoginState) => void | Promise<void>,
    private readonly spawner: Spawner = spawnCli,
    private readonly safetyTimeoutMs = 4 * 60_000,
    private readonly terminator: Terminator = terminateProcessTree,
  ) {}

  private key(provider: ProviderId, workspacePath: string, name: string): string {
    return `${provider}:${workspacePath}:${name}`;
  }

  get(provider: ProviderId, workspacePath: string, name: string): McpLoginState | undefined {
    return this.states.get(this.key(provider, workspacePath, name));
  }

  start(provider: ProviderId, workspacePath: string, name: string, env?: NodeJS.ProcessEnv): { state: McpLoginState; alreadyRunning: boolean } {
    const k = this.key(provider, workspacePath, name);
    const existing = this.states.get(k);
    if (existing?.status === "running") return { state: existing, alreadyRunning: true };

    const bin = provider === "codex" ? config.codexBin : config.claudeBin;
    const state: McpLoginState = {
      provider,
      workspacePath,
      name,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      message: null,
    };
    this.states.set(k, state);

    const child = this.spawner(bin, ["mcp", "login", name], env ? { cwd: workspacePath, env } : { cwd: workspacePath });
    this.children.set(k, child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      void this.terminator(child);
      this.finish(k, "timeout", t("登入逾時（4 分鐘內未完成瀏覽器授權），已自動取消"));
    }, this.safetyTimeoutMs);
    timer.unref?.();

    child.on("close", (code) => {
      clearTimeout(timer);
      if (this.states.get(k)?.status !== "running") return;
      if (code === 0) this.finish(k, "succeeded", boundedTail(stdout) || t("登入成功"));
      else this.finish(k, "failed", boundedTail(stderr || stdout) || t("登入失敗（exit {code}）", { code: code ?? "" }));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      this.finish(k, "failed", (error as Error).message);
    });

    return { state, alreadyRunning: false };
  }

  cancel(provider: ProviderId, workspacePath: string, name: string): boolean {
    const k = this.key(provider, workspacePath, name);
    const child = this.children.get(k);
    if (!child || this.states.get(k)?.status !== "running") return false;
    void this.terminator(child);
    this.finish(k, "cancelled", t("使用者取消登入"));
    return true;
  }

  private finish(k: string, status: McpLoginStatus, message: string): void {
    const prior = this.states.get(k);
    if (!prior || prior.status !== "running") return;
    const state: McpLoginState = { ...prior, status, message, finishedAt: new Date().toISOString() };
    this.states.set(k, state);
    this.children.delete(k);
    void this.onFinished(state);
  }
}
