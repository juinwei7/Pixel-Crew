import { execFile } from "node:child_process";
import { config } from "../config.js";
import type { AgentAuthProvider, ProviderAuthState } from "./types.js";

function shellCommand(value: string): string {
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

  private runCheck(): Promise<ProviderAuthState> {
    return new Promise((resolve) => {
      execFile(config.codexBin, ["login", "status"], { timeout: 10000 }, (error) => {
        const checkedAt = new Date().toISOString();
        if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
          resolve(this.state("cli_missing", checkedAt, "找不到 Codex CLI"));
        } else if (!error) {
          resolve(this.state("authenticated", checkedAt));
        } else {
          resolve(this.state("unauthenticated", checkedAt));
        }
      });
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
