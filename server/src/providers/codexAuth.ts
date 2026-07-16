import { config } from "../config.js";
import type { AgentAuthProvider, ProviderAuthState } from "./types.js";
import { execCli } from "../platform/processes.js";

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
    const checkedAt = new Date().toISOString();
    try {
      await execCli(config.codexBin, ["login", "status"], { timeout: 10_000 });
      return this.state("authenticated", checkedAt);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return this.state("cli_missing", checkedAt, "找不到 Codex CLI");
      }
      return this.state("unauthenticated", checkedAt);
    }
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
