import type { AgentAuthProvider, ProviderAuthState } from "./types.js";
import { config } from "../config.js";
import { resolveClaudeAuthStatus } from "./claudeAuthStatus.js";
import { execCli } from "../platform/processes.js";
import { buildAuthDebug } from "./authDebug.js";
import { claudeChildEnv } from "../claudeEnv.js";

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

  // null = shared/global CLAUDE_CONFIG_DIR (ambient ~/.claude.json), same
  // fallback-to-legacy-behavior convention as CodexAuthProvider's codexHome.
  constructor(private readonly claudeHome: string | null = null) {}

  checkAuth(): Promise<ProviderAuthState> {
    if (this.activeCheck) return this.activeCheck;
    this.activeCheck = this.runCheck().finally(() => {
      this.activeCheck = null;
    });
    return this.activeCheck;
  }

  private async runCheck(): Promise<ProviderAuthState> {
    const args = ["auth", "status", "--json"];
    const startedAt = Date.now();
    let error: NodeJS.ErrnoException | null = null;
    let stdout = "";
    let stderr = "";
    try {
      ({ stdout, stderr } = await execCli(config.claudeBin, args, {
        timeout: 10_000,
        env: claudeChildEnv(process.env, this.claudeHome),
      }));
    } catch (caught) {
      error = caught as NodeJS.ErrnoException;
      stdout = String((caught as any).stdout ?? "");
      stderr = String((caught as any).stderr ?? "");
    }
    const checkedAt = new Date().toISOString();
    const result = resolveClaudeAuthStatus(error, stdout);
    const debug = result.status === "authenticated"
      ? null
      : buildAuthDebug({ command: config.claudeBin, args, durationMs: Date.now() - startedAt, stdout, stderr, error });
    if (debug) console.error(`[claude-auth] status=${result.status}\n${debug}`);
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
