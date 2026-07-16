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

// Only seed commands that Claude Code itself provides in every workspace.
// The init frame also contains user/project commands; persisting that entire
// list globally would leak room-specific commands into unrelated projects.
const PORTABLE_CLAUDE_COMMANDS = new Set([
  "clear", "compact", "config", "context", "cost", "doctor", "exit", "export",
  "help", "hooks", "ide", "init", "login", "logout", "mcp", "memory", "model",
  "permissions", "pr-comments", "release-notes", "rename", "resume", "review",
  "security-review", "status", "terminal-setup", "usage", "vim",
]);

export const DEFAULT_CLAUDE_MODELS: ModelOption[] = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
  { id: "fable", label: "Fable" },
];

// The CLI's init event (and any cache written before this normalization
// existed) reports the resolved full model id (e.g. "claude-sonnet-5"),
// not the alias the user picked. Collapse it back to the alias so it
// de-dupes against the alias entry instead of showing up as a second,
// oddly-labeled option in the model picker. Non-Claude ids (custom or
// Codex) are left untouched so their labels survive.
function normalizeModelOption(model: ModelOption): ModelOption {
  const match = model.id.match(/^claude-([a-z]+)(?:-|$)/i);
  if (!match) return model;
  const alias = match[1].toLowerCase();
  return { ...model, id: alias, label: alias.charAt(0).toUpperCase() + alias.slice(1) };
}

function mergeModels(...groups: ModelOption[][]): ModelOption[] {
  const models = new Map<string, ModelOption>();
  for (const group of groups) {
    for (const model of group) {
      if (!model.id) continue;
      const normalized = normalizeModelOption(model);
      models.set(normalized.id, normalized);
    }
  }
  return [...models.values()];
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function portableClaudeCommands(values: string[]): string[] {
  return uniqueSorted(values).filter((name) => PORTABLE_CLAUDE_COMMANDS.has(name));
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
  if (/needs authentication/i.test(raw)) return "needs_auth";
  if (/failed|✘/i.test(raw)) return "failed";
  return raw.trim().toLowerCase() || "unknown";
}

export function parseMcpList(stdout: string): McpServerState[] {
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
    // Seed portable built-in commands from the global cache so a fresh NPC or
    // not-yet-messaged room shows them immediately. Room/user commands still
    // come from that workspace's filesystem scan and never cross rooms.
    this.runtimeCommands = portableClaudeCommands(store.loadSlashCommandSeed());
    const cached = store.loadCapabilities(workspacePath);
    const seededCommands = uniqueSorted([...(cached?.slashCommands ?? []), ...this.runtimeCommands]);
    this.state = cached
      ? { ...cached, slashCommands: seededCommands, models: mergeModels(DEFAULT_CLAUDE_MODELS, cached.models ?? []), loading: true, source: "cache", error: null }
      : { ...EMPTY_STATE, slashCommands: seededCommands, models: [...DEFAULT_CLAUDE_MODELS] };
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
    model?: string;
    slashCommands: string[];
    mcpServers: McpServerState[];
    toolCount: number;
  }): void {
    const discoveredCommands = uniqueSorted(meta.slashCommands);
    // Resumed/background Claude sessions sometimes emit an init/meta frame
    // without slash_commands. That frame is not evidence that commands were
    // removed, so do not let it erase a previously discovered palette.
    if (discoveredCommands.length > 0) {
      this.runtimeCommands = discoveredCommands;
      // Refresh only the portable subset for other/new workspaces.
      this.store.saveSlashCommandSeed(portableClaudeCommands(discoveredCommands));
    }
    const byName = new Map(this.state.mcpServers.map((server) => [server.name, server]));
    for (const server of meta.mcpServers) byName.set(server.name, server);
    this.publish({
      ...this.state,
      models: mergeModels(
        DEFAULT_CLAUDE_MODELS,
        this.state.models,
        meta.model ? [{ id: meta.model, label: meta.model }] : [],
      ),
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
