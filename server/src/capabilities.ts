import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import type { LocalStore } from "./store.js";

const execFileAsync = promisify(execFile);

export type McpServerState = { name: string; status: string };
export type ModelOption = { id: string; label: string; description?: string };

export type CapabilityState = {
  slashCommands: string[];
  mcpServers: McpServerState[];
  models: ModelOption[];
  toolCount: number | null;
  loading: boolean;
  source: "empty" | "cache" | "live";
  updatedAt: string | null;
  error: string | null;
};

const EMPTY_STATE: CapabilityState = {
  slashCommands: [],
  mcpServers: [],
  models: [],
  toolCount: null,
  loading: true,
  source: "empty",
  updatedAt: null,
  error: null,
};

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

async function commandFiles(root: string): Promise<string[]> {
  const commands: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        commands.push(relative(root, path).slice(0, -3).split(sep).join("/"));
      }
    }));
  }
  await walk(root);
  return commands;
}

function normalizeMcpStatus(raw: string): string {
  if (/connected|✓/i.test(raw)) return "connected";
  if (/failed|✘/i.test(raw)) return "failed";
  return raw.trim().toLowerCase() || "unknown";
}

function parseMcpList(stdout: string): McpServerState[] {
  const servers: McpServerState[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(/^(.+?):\s+.+\s+-\s+(.+)$/);
    if (!match) continue;
    servers.push({ name: match[1].trim(), status: normalizeMcpStatus(match[2]) });
  }
  return servers;
}

function sanitizeServerName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, "_");
}

export class CapabilityRegistry {
  private state: CapabilityState;
  private refreshGeneration = 0;
  private allowRules: string[] = [];
  private diskCommands: string[] = [];
  private runtimeCommands: string[] = [];

  constructor(
    private readonly store: LocalStore,
    private readonly onUpdate: (state: CapabilityState) => void,
    private readonly workspacePath = config.targetRepoPath,
  ) {
    const cached = store.loadCapabilities(workspacePath);
    this.state = cached
      ? { ...cached, models: cached.models ?? [], loading: true, source: "cache", error: null }
      : { ...EMPTY_STATE };
    this.rebuildAllowRules();
  }

  getState(): CapabilityState {
    return this.state;
  }

  getAllowedTools(): string[] {
    return this.allowRules;
  }

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  async refresh(resetRuntimeCommands = false): Promise<void> {
    const generation = ++this.refreshGeneration;
    if (resetRuntimeCommands) this.runtimeCommands = [];
    this.publish({ ...this.state, loading: true, error: null }, false);
    const [repoCommands, userCommands] = await Promise.all([
      commandFiles(join(this.workspacePath, ".claude", "commands")),
      commandFiles(join(homedir(), ".claude", "commands")),
    ]);
    if (generation !== this.refreshGeneration) return;
    this.diskCommands = uniqueSorted([...repoCommands, ...userCommands]);
    this.publish({
      ...this.state,
      slashCommands: uniqueSorted([...this.diskCommands, ...this.runtimeCommands]),
      loading: true,
      source: "live",
      updatedAt: new Date().toISOString(),
      error: null,
    }, false);

    let mcpServers = this.state.mcpServers;
    let error: string | null = null;
    try {
      const mcpResult = await execFileAsync(config.claudeBin, ["mcp", "list"], {
        cwd: this.workspacePath,
        timeout: 60000,
      });
      mcpServers = parseMcpList(mcpResult.stdout);
    } catch (err) {
      error = (err as Error).message;
    }
    if (generation !== this.refreshGeneration) return;

    this.publish({
      ...this.state,
      slashCommands: uniqueSorted([...this.diskCommands, ...this.runtimeCommands]),
      mcpServers,
      loading: false,
      source: "live",
      updatedAt: new Date().toISOString(),
      error,
    });
  }

  async refreshCommands(resetRuntimeCommands = false): Promise<void> {
    if (resetRuntimeCommands) this.runtimeCommands = [];
    const [repoCommands, userCommands] = await Promise.all([
      commandFiles(join(this.workspacePath, ".claude", "commands")),
      commandFiles(join(homedir(), ".claude", "commands")),
    ]);
    this.diskCommands = uniqueSorted([...repoCommands, ...userCommands]);
    this.publish({
      ...this.state,
      slashCommands: uniqueSorted([...this.diskCommands, ...this.runtimeCommands]),
      source: "live",
      updatedAt: new Date().toISOString(),
      error: null,
    });
  }

  mergeWorkerMeta(meta: {
    slashCommands: string[];
    mcpServers: McpServerState[];
    toolCount: number;
  }): void {
    const discoveredCommands = uniqueSorted(meta.slashCommands);
    // Resumed/background Claude sessions sometimes emit an init/meta frame
    // without slash_commands. That frame is not evidence that commands were
    // removed, so do not let it erase a previously discovered palette.
    if (discoveredCommands.length > 0) this.runtimeCommands = discoveredCommands;
    const byName = new Map(this.state.mcpServers.map((server) => [server.name, server]));
    for (const server of meta.mcpServers) byName.set(server.name, server);
    this.publish({
      ...this.state,
      slashCommands: uniqueSorted([...this.diskCommands, ...this.runtimeCommands]),
      mcpServers: [...byName.values()],
      toolCount: meta.toolCount,
      loading: false,
      source: "live",
      updatedAt: new Date().toISOString(),
      error: null,
    });
  }

  private rebuildAllowRules(): void {
    this.allowRules = this.state.mcpServers.map(
      (server) => `mcp__${sanitizeServerName(server.name)}__*`,
    );
  }

  private publish(state: CapabilityState, persist = true): void {
    this.state = state;
    this.rebuildAllowRules();
    if (persist) this.store.saveCapabilities(this.workspacePath, state);
    this.onUpdate(state);
  }
}
