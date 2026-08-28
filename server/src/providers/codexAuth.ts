import { config } from "../config.js";
import type { AgentAuthProvider, ProviderAuthState } from "./types.js";
import { execCli } from "../platform/processes.js";
import { resolveCodexAuthStatus } from "./codexAuthStatus.js";
import { buildAuthDebug } from "./authDebug.js";

function shellCommand(value: string): string {
  if (process.platform === "win32") return /\s/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
  return /^[A-Za-z0-9_./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'"'"'`)}'`;
}

export class CodexAuthProvider implements AgentAuthProvider {
  readonly id = "codex" as const;
  readonly displayName = "Codex";
  readonly loginCommand = `${shellCommand(config.codexBin)} login`;
  private activeCheck: Promise<ProviderAuthState> | null = null;
  private cliMissingState: ProviderAuthState | null = null;
  private cliMissingAt = 0;
  private lastLoggedStatus: ProviderAuthState["status"] | null = null;

  checkAuth(): Promise<ProviderAuthState> {
    // CLI 不在 PATH 時,前端對未登入 provider 每 3 秒輪詢一次,會不停 spawn
    // ENOENT。60 秒內直接回快取;之後裝好 CLI 最多一分鐘就會被偵測到。
    if (this.cliMissingState && Date.now() - this.cliMissingAt < 60_000) {
      return Promise.resolve(this.cliMissingState);
    }
    if (this.activeCheck) return this.activeCheck;
    this.activeCheck = this.runCheck().finally(() => {
      this.activeCheck = null;
    });
    return this.activeCheck;
  }

  private async runCheck(): Promise<ProviderAuthState> {
    const args = ["login", "status"];
    const startedAt = Date.now();
    const checkedAt = new Date().toISOString();
    let error: NodeJS.ErrnoException | null = null;
    let stdout = "";
    let stderr = "";
    try {
      ({ stdout, stderr } = await execCli(config.codexBin, args, { timeout: 10_000 }));
    } catch (caught) {
      error = caught as NodeJS.ErrnoException;
      stdout = String((caught as any).stdout ?? "");
      stderr = String((caught as any).stderr ?? "");
    }
    const result = resolveCodexAuthStatus(error);
    const debug = result.status === "authenticated"
      ? null
      : buildAuthDebug({ command: config.codexBin, args, durationMs: Date.now() - startedAt, stdout, stderr, error });
    if (debug && result.status !== this.lastLoggedStatus) {
      console.error(`[codex-auth] status=${result.status}\n${debug}`);
    }
    this.lastLoggedStatus = result.status;
    const state = this.state(result.status, checkedAt, result.error, debug);
    if (result.status === "cli_missing") {
      this.cliMissingState = state;
      this.cliMissingAt = Date.now();
    } else {
      this.cliMissingState = null;
    }
    return state;
  }

  private state(
    status: ProviderAuthState["status"],
    checkedAt: string,
    error: string | null = null,
    debug: string | null = null,
  ): ProviderAuthState {
    return {
      provider: this.id,
      displayName: this.displayName,
      status,
      loginCommand: this.loginCommand,
      checkedAt,
      error,
      debug,
    };
  }
}
