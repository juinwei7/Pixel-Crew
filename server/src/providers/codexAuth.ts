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

  checkAuth(): Promise<ProviderAuthState> {
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
    if (debug) console.error(`[codex-auth] status=${result.status}\n${debug}`);
    return this.state(result.status, checkedAt, result.error, debug);
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
