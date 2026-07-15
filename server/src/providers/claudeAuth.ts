import { execFile } from "node:child_process";
import type { AgentAuthProvider, ProviderAuthState } from "./types.js";
import { config } from "../config.js";
import { resolveClaudeAuthStatus } from "./claudeAuthStatus.js";

function shellCommand(value: string): string {
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

  private runCheck(): Promise<ProviderAuthState> {
    return new Promise((resolve) => {
      execFile(
        config.claudeBin,
        ["auth", "status", "--json"],
        { timeout: 10000 },
        (error, stdout) => {
          const checkedAt = new Date().toISOString();
          const result = resolveClaudeAuthStatus(error as NodeJS.ErrnoException | null, stdout);
          resolve(this.state(result.status, checkedAt, result.error));
        },
      );
    });
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
