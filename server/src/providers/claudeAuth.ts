import type { AgentAuthProvider, ProviderAuthState } from "./types.js";
import { config } from "../config.js";
import { resolveClaudeAuthStatus } from "./claudeAuthStatus.js";
import { execCli } from "../platform/processes.js";

function shellCommand(value: string): string {
  if (process.platform === "win32") return /\s/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
  return /^[A-Za-z0-9_./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'"'"'`)}'`;
}

export class ClaudeAuthProvider implements AgentAuthProvider {
  readonly id = "claude" as const;
  readonly displayName = "Claude Code";
  readonly loginCommand = `${shellCommand(config.claudeBin)} auth login`;

  private activeCheck: Promise<ProviderAuthState> | null = null;

  checkAuth(): Promise<ProviderAuthState> {
    if (this.activeCheck) return this.activeCheck;
    this.activeCheck = this.runCheck().finally(() => {
      this.activeCheck = null;
    });
    return this.activeCheck;
  }

  private async runCheck(): Promise<ProviderAuthState> {
    let error: NodeJS.ErrnoException | null = null;
    let stdout = "";
    try {
      ({ stdout } = await execCli(config.claudeBin, ["auth", "status", "--json"], { timeout: 10_000 }));
    } catch (caught) {
      error = caught as NodeJS.ErrnoException;
      stdout = String((caught as any).stdout ?? "");
    }
    const checkedAt = new Date().toISOString();
    const result = resolveClaudeAuthStatus(error, stdout);
    return this.state(result.status, checkedAt, result.error);
  }

  private state(
    status: ProviderAuthState["status"],
    checkedAt: string,
    error: string | null = null,
  ): ProviderAuthState {
    return {
      provider: this.id,
      displayName: this.displayName,
      status,
      loginCommand: this.loginCommand,
      checkedAt,
      error,
    };
  }
}
