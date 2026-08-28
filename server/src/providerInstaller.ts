import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { ProviderId } from "./providers/types.js";
import { execCli, type ExecCliResult } from "./platform/processes.js";
import { t } from "./i18n.js";

export type ProviderInstallStatus = "idle" | "running" | "succeeded" | "failed";

export type ProviderInstallState = {
  provider: ProviderId;
  status: ProviderInstallStatus;
  phase: string;
  command: string;
  sourceUrl: string;
  startedAt: string | null;
  finishedAt: string | null;
  output: string;
  error: string | null;
};

export type ProviderInstallRecipe = {
  file: string;
  args: string[];
  displayCommand: string;
  sourceUrl: string;
};

const CODEX_SH = "https://chatgpt.com/codex/install.sh";
const CODEX_PS = "https://chatgpt.com/codex/install.ps1";
const CLAUDE_SH = "https://claude.ai/install.sh";

function verifiedShellInstaller(url: string, shell: "sh" | "bash", prefix = ""): string {
  return `tmp="$(mktemp)" || exit 1; trap 'rm -f "$tmp"' EXIT HUP INT TERM; curl -fsSL ${url} -o "$tmp" && ${prefix}${shell} "$tmp"`;
}

export function providerInstallRecipe(
  provider: ProviderId,
  platform: NodeJS.Platform = process.platform,
): ProviderInstallRecipe {
  if (provider === "codex") {
    if (platform === "win32") {
      const script = `$ErrorActionPreference='Stop'; $env:CODEX_NON_INTERACTIVE='1'; Invoke-RestMethod ${CODEX_PS} | Invoke-Expression`;
      return {
        file: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", script],
        displayCommand: `$env:CODEX_NON_INTERACTIVE=1; irm ${CODEX_PS} | iex`,
        sourceUrl: CODEX_PS,
      };
    }
    return {
      file: "/bin/sh",
      args: ["-c", verifiedShellInstaller(CODEX_SH, "sh", "CODEX_NON_INTERACTIVE=1 ")],
      displayCommand: `curl -fsSL ${CODEX_SH} | CODEX_NON_INTERACTIVE=1 sh`,
      sourceUrl: CODEX_SH,
    };
  }

  if (platform === "win32") {
    return {
      file: "winget.exe",
      args: [
        "install", "--id", "Anthropic.ClaudeCode", "--exact",
        "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity",
      ],
      displayCommand: "winget install --id Anthropic.ClaudeCode --exact",
      sourceUrl: "https://code.claude.com/docs/en/setup",
    };
  }
  return {
    file: "/bin/sh",
    args: ["-c", verifiedShellInstaller(CLAUDE_SH, "bash")],
    displayCommand: `curl -fsSL ${CLAUDE_SH} | bash`,
    sourceUrl: CLAUDE_SH,
  };
}

function boundedTail(value: string, limit = 8_000): string {
  const sanitized = value.replace(/\0/g, "").trim();
  return sanitized.length <= limit ? sanitized : `…${sanitized.slice(-limit)}`;
}

export function refreshProviderPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const home = homedir();
  const candidates = platform === "win32"
    ? [
        env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin"),
        env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"),
        env.USERPROFILE && join(env.USERPROFILE, ".local", "bin"),
      ]
    : [join(home, ".local", "bin"), join(home, ".claude", "local", "bin")];
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const separator = platform === "win32" ? ";" : delimiter;
  const current = (env[pathKey] ?? "").split(separator).filter(Boolean);
  const additions = candidates.filter((entry): entry is string => Boolean(entry) && !current.includes(entry as string));
  env[pathKey] = [...additions, ...current].join(separator);
}

type InstallerExecutor = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv },
) => Promise<ExecCliResult>;

export class ProviderInstaller {
  private readonly states = new Map<ProviderId, ProviderInstallState>();

  constructor(
    private readonly onFinished: (provider: ProviderId) => void | Promise<void>,
    private readonly executor: InstallerExecutor = execCli,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  get(provider: ProviderId): ProviderInstallState {
    return this.states.get(provider) ?? this.idleState(provider);
  }

  start(provider: ProviderId): ProviderInstallState {
    const current = this.get(provider);
    if (current.status === "running") return current;
    const recipe = providerInstallRecipe(provider, this.platform);
    const running: ProviderInstallState = {
      provider,
      status: "running",
      phase: t("正在執行官方安裝器"),
      command: recipe.displayCommand,
      sourceUrl: recipe.sourceUrl,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      output: "",
      error: null,
    };
    this.states.set(provider, running);
    void this.run(provider, recipe);
    return running;
  }

  private async run(provider: ProviderId, recipe: ProviderInstallRecipe): Promise<void> {
    try {
      const result = await this.executor(recipe.file, recipe.args, {
        timeout: 10 * 60_000,
        maxBuffer: 256 * 1024,
        env: process.env,
      });
      refreshProviderPath(this.platform);
      this.states.set(provider, {
        ...this.get(provider),
        status: "succeeded",
        phase: t("安裝完成，正在檢查登入狀態"),
        finishedAt: new Date().toISOString(),
        output: boundedTail([result.stdout, result.stderr].filter(Boolean).join("\n")),
        error: null,
      });
    } catch (error) {
      const detail = error as Error & { stdout?: string; stderr?: string };
      const output = boundedTail([detail.stdout, detail.stderr].filter(Boolean).join("\n"));
      this.states.set(provider, {
        ...this.get(provider),
        status: "failed",
        phase: t("安裝失敗"),
        finishedAt: new Date().toISOString(),
        output,
        error: boundedTail(detail.message || t("官方安裝器執行失敗"), 2_000),
      });
    } finally {
      try {
        await this.onFinished(provider);
      } catch {
        // Installation result must remain queryable even if a follow-up auth
        // refresh is interrupted by shutdown or another transient CLI error.
      }
    }
  }

  private idleState(provider: ProviderId): ProviderInstallState {
    const recipe = providerInstallRecipe(provider, this.platform);
    return {
      provider,
      status: "idle",
      phase: t("尚未開始"),
      command: recipe.displayCommand,
      sourceUrl: recipe.sourceUrl,
      startedAt: null,
      finishedAt: null,
      output: "",
      error: null,
    };
  }
}
