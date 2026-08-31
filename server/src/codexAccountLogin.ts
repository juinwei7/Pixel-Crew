import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { config } from "./config.js";
import { spawnCli, terminateProcessTree } from "./platform/processes.js";
import { ensurePrivateDirectorySync } from "./platform/fileProtection.js";
import { codexChildEnv } from "./codexRunner.js";
import { extractLoginUrl } from "./loginUrlExtraction.js";
import { t } from "./i18n.js";

export type CodexAccountLoginStatus = "running" | "succeeded" | "failed" | "timeout" | "cancelled";
export type CodexAccountLoginMode = "oauth" | "api-key";

export type CodexAccountLoginState = {
  accountId: string;
  status: CodexAccountLoginStatus;
  startedAt: string;
  finishedAt: string | null;
  message: string | null;
  // Fallback OAuth URL codex prints ("If your browser did not open, navigate
  // to this URL...") for when the CLI's own browser-open attempt fails or
  // there's no browser to auto-open in the environment Pixel Crew's server
  // runs in. Surfacing this is the difference between "click a link in the
  // app" and "the owner has to go dig through server logs / a terminal" —
  // verified empirically: `codex login` always prints this line up front,
  // it isn't conditional on the auto-open actually having failed.
  loginUrl: string | null;
};

function boundedTail(value: string, limit = 4_000): string {
  const sanitized = value.replace(/\0/g, "").trim();
  return sanitized.length <= limit ? sanitized : `…${sanitized.slice(-limit)}`;
}

type Spawner = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;
type Terminator = (child: ChildProcessWithoutNullStreams) => void | Promise<void>;

// `codex login` opens the user's system browser and waits (OAuth); `codex
// login --with-api-key` reads a key piped over stdin instead — both are
// spawned with CODEX_HOME pinned to the target account's directory so the
// resulting auth.json lands in the right, isolated place. Mirrors
// McpLoginTracker (mcpLogin.ts): fire-and-forget background CLI process,
// resolves the HTTP request immediately, reports completion later via
// onFinished (wired to a WS broadcast in index.ts).
//
// NOTE: the OAuth (`codex login`, no flags) success path assumes the child
// process exits 0 on its own once the browser callback lands, same as
// McpLoginTracker assumes for `codex mcp login`. That has not been verified
// against codex-cli for the plain `login` subcommand — if it turns out the
// process doesn't self-exit, this needs to poll `login status` in the
// background instead of relying on the `close` event.
export class CodexAccountLoginTracker {
  private readonly states = new Map<string, CodexAccountLoginState>();
  private readonly children = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(
    private readonly onFinished: (state: CodexAccountLoginState) => void | Promise<void>,
    private readonly spawner: Spawner = spawnCli,
    private readonly safetyTimeoutMs = 5 * 60_000,
    private readonly terminator: Terminator = terminateProcessTree,
    // Fired as soon as the fallback OAuth URL is parsed out of the child's
    // output — separate from onFinished since the login is still "running"
    // at this point, just now with a URL the UI can render as a link.
    private readonly onUrlFound: (state: CodexAccountLoginState) => void | Promise<void> = () => {},
    // Guards against `spawn ENOENT` when codexHome doesn't exist yet (e.g. the
    // default slot's directory is normally created lazily by the one-time
    // ambient-CODEX_HOME migration, which never runs — and so never creates
    // the directory — when there's nothing to migrate, or if the directory
    // is removed after the fact). Named accounts already get this from their
    // creation route, but centralizing it here means neither caller can forget.
    private readonly ensureDir: (dir: string) => void = ensurePrivateDirectorySync,
  ) {}

  get(accountId: string): CodexAccountLoginState | undefined {
    return this.states.get(accountId);
  }

  start(
    accountId: string,
    codexHome: string,
    mode: CodexAccountLoginMode,
    apiKey?: string,
  ): { state: CodexAccountLoginState; alreadyRunning: boolean } {
    const existing = this.states.get(accountId);
    if (existing?.status === "running") return { state: existing, alreadyRunning: true };

    const args = mode === "api-key" ? ["login", "--with-api-key"] : ["login"];
    const state: CodexAccountLoginState = {
      accountId,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      message: null,
      loginUrl: null,
    };
    this.states.set(accountId, state);

    try {
      this.ensureDir(codexHome);
    } catch (error) {
      this.finish(accountId, "failed", (error as Error).message);
      return { state: this.states.get(accountId)!, alreadyRunning: false };
    }

    const child = this.spawner(config.codexBin, args, { cwd: codexHome, env: codexChildEnv(process.env, codexHome) });
    this.children.set(accountId, child);
    let stdout = "";
    let stderr = "";
    const captureUrl = (chunk: Buffer | string) => {
      if (mode !== "oauth" || this.states.get(accountId)?.loginUrl) return;
      const url = extractLoginUrl(chunk.toString());
      if (!url) return;
      const updated = { ...this.states.get(accountId)!, loginUrl: url };
      this.states.set(accountId, updated);
      void this.onUrlFound(updated);
    };
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); captureUrl(chunk); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); captureUrl(chunk); });

    if (mode === "api-key") {
      child.stdin.write(apiKey ?? "");
      child.stdin.end();
    }

    const timer = setTimeout(() => {
      void this.terminator(child);
      this.finish(accountId, "timeout", t("登入逾時（{minutes} 分鐘內未完成），已自動取消", { minutes: Math.round(this.safetyTimeoutMs / 60_000) }));
    }, this.safetyTimeoutMs);
    timer.unref?.();

    child.on("close", (code) => {
      clearTimeout(timer);
      if (this.states.get(accountId)?.status !== "running") return;
      if (code === 0) this.finish(accountId, "succeeded", boundedTail(stdout) || t("登入成功"));
      else this.finish(accountId, "failed", boundedTail(stderr || stdout) || t("登入失敗（exit {code}）", { code: code ?? "" }));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      this.finish(accountId, "failed", (error as Error).message);
    });

    return { state, alreadyRunning: false };
  }

  cancel(accountId: string): boolean {
    const child = this.children.get(accountId);
    if (!child || this.states.get(accountId)?.status !== "running") return false;
    void this.terminator(child);
    this.finish(accountId, "cancelled", t("使用者取消登入"));
    return true;
  }

  private finish(accountId: string, status: CodexAccountLoginStatus, message: string): void {
    const prior = this.states.get(accountId);
    if (!prior || prior.status !== "running") return;
    const state: CodexAccountLoginState = { ...prior, status, message, finishedAt: new Date().toISOString() };
    this.states.set(accountId, state);
    this.children.delete(accountId);
    void this.onFinished(state);
  }
}
