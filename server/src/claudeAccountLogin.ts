import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { config } from "./config.js";
import { spawnCli, terminateProcessTree } from "./platform/processes.js";
import { ensurePrivateDirectorySync } from "./platform/fileProtection.js";
import { claudeChildEnv } from "./claudeEnv.js";
import { extractLoginUrl } from "./loginUrlExtraction.js";
import { t } from "./i18n.js";

export type ClaudeLoginStatus = "running" | "awaiting_code" | "succeeded" | "failed" | "timeout" | "cancelled";

export type ClaudeLoginState = {
  accountId: string;
  status: ClaudeLoginStatus;
  startedAt: string;
  finishedAt: string | null;
  message: string | null;
  // Fallback OAuth URL `claude auth login` prints ("If the browser didn't
  // open, visit: ...") — same rationale as CodexAccountLoginState.loginUrl.
  loginUrl: string | null;
};

function boundedTail(value: string, limit = 4_000): string {
  const sanitized = value.replace(/\0/g, "").trim();
  return sanitized.length <= limit ? sanitized : `…${sanitized.slice(-limit)}`;
}

const NON_TERMINAL: ClaudeLoginStatus[] = ["running", "awaiting_code"];

type Spawner = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;
type Terminator = (child: ChildProcessWithoutNullStreams) => void | Promise<void>;

// Unlike Codex (spawn, browser completes it via a local callback server, done),
// `claude auth login` is two-phase: spawn -> it prints a fallback URL and
// blocks on "Paste code here if prompted > " -> the owner authorizes in the
// browser, copies the code shown, and it has to be written back to this
// process's stdin via submitCode() before it will actually finish. Verified
// empirically (Claude Code 2.1.206): an invalid code makes it exit 1 with
// "Login failed: ..." on stderr within ~1s — the failure path is prompt,
// not a hang, so the safety-net timeout only needs to guard against the
// owner never getting around to visiting the URL/pasting a code at all.
export class ClaudeLoginTracker {
  private readonly states = new Map<string, ClaudeLoginState>();
  private readonly children = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(
    private readonly onFinished: (state: ClaudeLoginState) => void | Promise<void>,
    private readonly spawner: Spawner = spawnCli,
    private readonly safetyTimeoutMs = 5 * 60_000,
    private readonly terminator: Terminator = terminateProcessTree,
    // Fired once the fallback URL (and thus the "awaiting_code" transition)
    // is detected — separate from onFinished since the login isn't done yet.
    private readonly onUrlFound: (state: ClaudeLoginState) => void | Promise<void> = () => {},
    // Guards against `spawn ENOENT` when claudeHome doesn't exist yet — same
    // rationale as CodexAccountLoginTracker's ensureDir.
    private readonly ensureDir: (dir: string) => void = ensurePrivateDirectorySync,
  ) {}

  get(accountId: string): ClaudeLoginState | undefined {
    return this.states.get(accountId);
  }

  start(accountId: string, claudeHome: string): { state: ClaudeLoginState; alreadyRunning: boolean } {
    const existing = this.states.get(accountId);
    if (existing && NON_TERMINAL.includes(existing.status)) return { state: existing, alreadyRunning: true };

    const state: ClaudeLoginState = {
      accountId,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      message: null,
      loginUrl: null,
    };
    this.states.set(accountId, state);

    try {
      this.ensureDir(claudeHome);
    } catch (error) {
      this.finish(accountId, "failed", (error as Error).message);
      return { state: this.states.get(accountId)!, alreadyRunning: false };
    }

    const child = this.spawner(config.claudeBin, ["auth", "login"], { cwd: claudeHome, env: claudeChildEnv(process.env, claudeHome) });
    this.children.set(accountId, child);
    let stdout = "";
    let stderr = "";
    const captureUrl = (chunk: Buffer | string) => {
      const current = this.states.get(accountId);
      if (!current || current.loginUrl) return;
      const url = extractLoginUrl(chunk.toString());
      if (!url) return;
      const updated: ClaudeLoginState = { ...current, loginUrl: url, status: "awaiting_code" };
      this.states.set(accountId, updated);
      void this.onUrlFound(updated);
    };
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); captureUrl(chunk); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); captureUrl(chunk); });

    const timer = setTimeout(() => {
      void this.terminator(child);
      this.finish(accountId, "timeout", t("登入逾時（{minutes} 分鐘內未完成），已自動取消", { minutes: Math.round(this.safetyTimeoutMs / 60_000) }));
    }, this.safetyTimeoutMs);
    timer.unref?.();

    child.on("close", (code) => {
      clearTimeout(timer);
      if (!NON_TERMINAL.includes(this.states.get(accountId)?.status as ClaudeLoginStatus)) return;
      if (code === 0) this.finish(accountId, "succeeded", boundedTail(stdout) || t("登入成功"));
      else this.finish(accountId, "failed", boundedTail(stderr || stdout) || t("登入失敗（exit {code}）", { code: code ?? "" }));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      this.finish(accountId, "failed", (error as Error).message);
    });

    return { state, alreadyRunning: false };
  }

  // Writes the code the owner pasted (copied from the browser's callback
  // page after authorizing) back into the waiting child's stdin.
  submitCode(accountId: string, code: string): boolean {
    const child = this.children.get(accountId);
    const state = this.states.get(accountId);
    if (!child || !state || !NON_TERMINAL.includes(state.status)) return false;
    child.stdin.write(`${code}\n`);
    return true;
  }

  cancel(accountId: string): boolean {
    const child = this.children.get(accountId);
    const state = this.states.get(accountId);
    if (!child || !state || !NON_TERMINAL.includes(state.status)) return false;
    void this.terminator(child);
    this.finish(accountId, "cancelled", t("使用者取消登入"));
    return true;
  }

  private finish(accountId: string, status: ClaudeLoginStatus, message: string): void {
    const prior = this.states.get(accountId);
    if (!prior || !NON_TERMINAL.includes(prior.status)) return;
    const state: ClaudeLoginState = { ...prior, status, message, finishedAt: new Date().toISOString() };
    this.states.set(accountId, state);
    this.children.delete(accountId);
    void this.onFinished(state);
  }
}
