import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ProviderId } from "./providers/types.js";

export type McpConfigChange = {
  provider: ProviderId;
  workspacePath: string | null;
  path: string;
  scope: "global" | "workspace";
  section: "file" | "claude-global" | "claude-project";
};

type WatcherOptions = {
  intervalMs?: number;
  homeDirectory?: string;
  codexHome?: string;
};

function uniqueWorkspacePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
}

export function mcpConfigTargets(
  workspacePaths: string[],
  options: Pick<WatcherOptions, "homeDirectory" | "codexHome"> = {},
): McpConfigChange[] {
  const homeDirectory = options.homeDirectory ?? homedir();
  const codexHome = options.codexHome
    ?? process.env.CODEX_HOME?.trim()
    ?? join(homeDirectory, ".codex");
  const targets: McpConfigChange[] = [
    {
      provider: "claude",
      workspacePath: null,
      path: join(homeDirectory, ".claude.json"),
      scope: "global",
      section: "claude-global",
    },
    {
      provider: "codex",
      workspacePath: null,
      path: join(codexHome, "config.toml"),
      scope: "global",
      section: "file",
    },
  ];
  for (const workspacePath of uniqueWorkspacePaths(workspacePaths)) {
    targets.push(
      {
        provider: "claude",
        workspacePath,
        path: join(homeDirectory, ".claude.json"),
        scope: "workspace",
        section: "claude-project",
      },
      {
        provider: "claude",
        workspacePath,
        path: join(workspacePath, ".mcp.json"),
        scope: "workspace",
        section: "file",
      },
      {
        provider: "codex",
        workspacePath,
        path: join(workspacePath, ".codex", "config.toml"),
        scope: "workspace",
        section: "file",
      },
    );
  }
  return targets;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function claudeMcpSection(contents: Buffer, target: McpConfigChange): Buffer | string {
  if (target.section === "file") return contents;
  try {
    const parsed = JSON.parse(contents.toString("utf8")) as Record<string, any>;
    if (target.section === "claude-global") {
      return stableJson({ mcpServers: parsed.mcpServers ?? {} });
    }
    const project = parsed.projects?.[target.workspacePath ?? ""] ?? {};
    return stableJson({
      mcpServers: project.mcpServers ?? {},
      enabledMcpjsonServers: project.enabledMcpjsonServers ?? [],
      disabledMcpjsonServers: project.disabledMcpjsonServers ?? [],
      disabledMcpServers: project.disabledMcpServers ?? [],
      mcpContextUris: project.mcpContextUris ?? [],
      hasTrustDialogAccepted: project.hasTrustDialogAccepted ?? false,
    });
  } catch {
    // Invalid JSON may be a transient atomic-write state or a real broken
    // configuration. Fingerprint the raw bytes so recovery to valid JSON is
    // observed too.
    return contents;
  }
}

async function fileFingerprint(target: McpConfigChange): Promise<string> {
  try {
    const contents = await readFile(target.path);
    const relevantContents = target.provider === "claude"
      ? claudeMcpSection(contents, target)
      : contents;
    return createHash("sha256").update(relevantContents).digest("hex");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    // A temporary permissions/read failure is still a meaningful state
    // transition. Hash only the error code — never the path's contents.
    return `unreadable:${code ?? "unknown"}`;
  }
}

function targetKey(target: McpConfigChange): string {
  return `${target.provider}\0${target.workspacePath ?? "*"}\0${target.path}\0${target.section}`;
}

/**
 * Polls the handful of MCP configuration files instead of watching parent
 * directories. This catches atomic file replacement and files that did not
 * exist at startup, while avoiding recursive home-directory watchers.
 */
export class McpConfigWatcher {
  private readonly intervalMs: number;
  private readonly targetOptions: Pick<WatcherOptions, "homeDirectory" | "codexHome">;
  private readonly fingerprints = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private checking = false;
  private rerunRequested = false;

  constructor(
    private readonly getWorkspacePaths: () => string[],
    private readonly onChange: (change: McpConfigChange) => void | Promise<void>,
    options: WatcherOptions = {},
  ) {
    this.intervalMs = Math.max(250, options.intervalMs ?? 2_000);
    this.targetOptions = {
      homeDirectory: options.homeDirectory,
      codexHome: options.codexHome,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.runCheck(false).finally(() => {
      if (!this.running || this.timer) return;
      this.timer = setInterval(() => void this.checkNow(), this.intervalMs);
      this.timer.unref?.();
    });
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async checkNow(): Promise<void> {
    if (this.checking) {
      this.rerunRequested = true;
      return;
    }
    await this.runCheck(true);
  }

  /** Public for deterministic startup and unit testing. */
  async initialize(): Promise<void> {
    await this.runCheck(false);
  }

  private async runCheck(notify: boolean): Promise<void> {
    if (this.checking) {
      this.rerunRequested = true;
      return;
    }
    this.checking = true;
    try {
      const targets = mcpConfigTargets(this.getWorkspacePaths(), this.targetOptions);
      const activeKeys = new Set(targets.map(targetKey));
      const changes: McpConfigChange[] = [];
      await Promise.all(targets.map(async (target) => {
        const key = targetKey(target);
        const next = await fileFingerprint(target);
        const previous = this.fingerprints.get(key);
        this.fingerprints.set(key, next);
        if (notify && previous !== undefined && previous !== next) changes.push(target);
      }));
      for (const key of this.fingerprints.keys()) {
        if (!activeKeys.has(key)) this.fingerprints.delete(key);
      }
      await Promise.all(changes.map((change) => this.onChange(change)));
    } finally {
      this.checking = false;
      if (this.rerunRequested) {
        this.rerunRequested = false;
        await this.runCheck(true);
      }
    }
  }
}
