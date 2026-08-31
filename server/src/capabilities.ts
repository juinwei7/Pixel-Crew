import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { config } from "./config.js";
import type { LocalStore } from "./store.js";
import { execCli } from "./platform/processes.js";
import { claudeChildEnv } from "./claudeEnv.js";
import { t } from "./i18n.js";

import type {
  CapabilityState,
  McpScope,
  McpServerState,
  McpToolInfo,
  McpTransport,
  ModelOption,
} from "./protocol.js";

export type { CapabilityState, McpScope, McpServerState, McpToolInfo, McpTransport, ModelOption };

const EMPTY_STATE: CapabilityState = {
  slashCommands: [],
  mcpServers: [],
  models: [],
  toolCount: null,
  builtinTools: null,
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
const DEFAULT_CLAUDE_COMMANDS = [...PORTABLE_CLAUDE_COMMANDS];

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
  // Checked before "connected"/"failed": an unapproved project .mcp.json
  // server is neither, and the pending symbol/word must win the match.
  if (/pending.*approval|awaiting approval/i.test(raw)) return "pending_approval";
  // Also checked before the generic "connected" match below — this text
  // itself contains the word "Connected", so it would otherwise be silently
  // collapsed into a healthy-looking status and hide a real problem.
  if (/connected.*tools fetch failed/i.test(raw)) return "connected_tools_failed";
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

// Parses `claude mcp get <name>` output. Only field names/keys are kept for
// env vars and headers — see the McpServerState comment on why values are
// never retained. Status is intentionally not re-parsed here: `mcp list`'s
// connection status remains authoritative, this only adds scope/transport
// detail on top of it.
export function parseMcpGetOutput(stdout: string): Omit<McpServerState, "name" | "status"> {
  const result: Omit<McpServerState, "name" | "status"> = {};
  let section: "env" | "headers" | null = null;
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (/^\s*To remove this server/.test(line)) break;
    const trimmed = line.trim();
    if (!trimmed) {
      section = null;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent > 2 && section) {
      if (section === "env") {
        const match = trimmed.match(/^([\w.]+)=/);
        if (match) result.envKeys!.push(match[1]);
      } else {
        const match = trimmed.match(/^([^:]+):/);
        if (match) result.headerNames!.push(match[1].trim());
      }
      continue;
    }
    section = null;
    const scopeMatch = trimmed.match(/^Scope:\s*(.+)$/i);
    if (scopeMatch) {
      // Anchored to the leading word, not a substring test: "Local config
      // (private to you in this project)" contains the word "project" but
      // must still resolve to the "local" scope.
      const value = scopeMatch[1];
      result.scope = /^claude\.ai/i.test(value) ? "account"
        : /^project/i.test(value) ? "project"
        : /^local/i.test(value) ? "local"
        : /^user/i.test(value) ? "user"
        : undefined;
      continue;
    }
    const typeMatch = trimmed.match(/^Type:\s*(stdio|sse|http)/i);
    if (typeMatch) {
      result.transport = typeMatch[1].toLowerCase() as McpTransport;
      continue;
    }
    const commandMatch = trimmed.match(/^Command:\s*(.+)$/i);
    if (commandMatch) {
      result.command = commandMatch[1];
      continue;
    }
    const argsMatch = trimmed.match(/^Args:\s*(.+)$/i);
    if (argsMatch) {
      result.args = argsMatch[1].split(/\s+/).filter(Boolean);
      continue;
    }
    const urlMatch = trimmed.match(/^URL:\s*(.+)$/i);
    if (urlMatch) {
      result.url = urlMatch[1];
      continue;
    }
    if (/^Environment:$/i.test(trimmed)) {
      section = "env";
      result.envKeys = [];
      continue;
    }
    if (/^Headers:$/i.test(trimmed)) {
      section = "headers";
      result.headerNames = [];
      continue;
    }
  }
  return result;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const current = cursor++;
      results[current] = await fn(items[current]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function sanitizeServerName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, "_");
}

export type ClaudeMcpAddInput = {
  name: string;
  scope: "local" | "project" | "user";
  mode: "form" | "json";
  transport?: McpTransport;
  target?: string;
  localArgv?: string[];
  env?: string[];
  headers?: string[];
  json?: string;
  // Advanced, http/sse-only OAuth options. `--client-secret` is deliberately
  // not supported here — the CLI itself only accepts it as an interactive
  // prompt or via the MCP_CLIENT_SECRET env var, precisely so the secret
  // never has to pass through a request body.
  callbackPort?: string;
  clientId?: string;
};

// Pure arg builder so the add/remove logic can be unit tested without
// spawning the real CLI. Mirrors `claude mcp add`/`add-json`'s flags exactly.
//
// Argument order matters here in a way that isn't obvious from the CLI's
// `--help` text: `-e`/`--env` and `-H`/`--header` are variadic (`<env...>`),
// so commander greedily consumes every following non-flag token as another
// value — including <name> and <commandOrUrl>/<url> — if those positionals
// are placed after them. Empirically verified against the real CLI: the
// positionals must come first, with all option flags trailing (for stdio,
// `--` still has to precede the literal command/args since that marker
// disables all further flag parsing, so -e must sit before it, right after
// <name>).
export function buildClaudeMcpAddArgs(input: ClaudeMcpAddInput): string[] {
  if (input.mode === "json") {
    return ["mcp", "add-json", input.name, input.json ?? "", "-s", input.scope];
  }
  if (input.transport === "stdio") {
    const args = ["mcp", "add", "-s", input.scope, input.name, "-t", "stdio"];
    for (const entry of input.env ?? []) args.push("-e", entry);
    args.push("--", ...(input.localArgv ?? []));
    return args;
  }
  const args = ["mcp", "add", "-s", input.scope, input.name, input.target ?? "", "-t", input.transport ?? "http"];
  for (const entry of input.headers ?? []) args.push("-H", entry);
  if (input.callbackPort) args.push("--callback-port", input.callbackPort);
  if (input.clientId) args.push("--client-id", input.clientId);
  return args;
}

export function buildClaudeMcpRemoveArgs(name: string, scope?: McpScope): string[] {
  const args = ["mcp", "remove", name];
  if (scope === "local" || scope === "project" || scope === "user") args.push("-s", scope);
  return args;
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
    private readonly claudeHome: string | null = null,
  ) {
    // Always seed portable built-ins, then merge the global discovery cache,
    // so a fresh NPC or not-yet-messaged room shows commands like /mcp
    // immediately. Room/user commands still come from that workspace's
    // filesystem scan and never cross rooms.
    this.runtimeCommands = uniqueSorted([
      ...DEFAULT_CLAUDE_COMMANDS,
      ...portableClaudeCommands(store.loadSlashCommandSeed()),
    ]);
    const cached = store.loadCapabilities(workspacePath);
    const seededCommands = uniqueSorted([...(cached?.slashCommands ?? []), ...this.runtimeCommands]);
    this.state = cached
      ? { ...cached, slashCommands: seededCommands, models: mergeModels(DEFAULT_CLAUDE_MODELS, cached.models ?? []), builtinTools: cached.builtinTools ?? null, loading: true, source: "cache", error: null }
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
    if (resetRuntimeCommands) this.runtimeCommands = [...DEFAULT_CLAUDE_COMMANDS];
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
    let listed: McpServerState[] | null = null;
    try {
      const mcpResult = await execCli(config.claudeBin, ["mcp", "list"], {
        cwd: this.workspacePath,
        timeout: 60000,
        env: claudeChildEnv(process.env, this.claudeHome),
      });
      listed = parseMcpList(mcpResult.stdout);
      // Carry over this server's previous scope/transport/detail as a
      // starting point rather than resetting it to nothing — otherwise
      // badges would visibly flicker away and back on every refresh while
      // the (much slower) `mcp get` enrichment below re-populates them.
      const previousByName = new Map(this.state.mcpServers.map((server) => [server.name, server]));
      mcpServers = listed.map((server) => ({ ...previousByName.get(server.name), ...server }));
    } catch (err) {
      error = (err as Error).message;
    }
    if (generation !== this.refreshGeneration) return;

    // Publish connection status as soon as `mcp list` resolves — this is
    // the part that actually changes right after a login/logout/add/remove
    // and that the UI most needs to reflect promptly. The `mcp get` detail
    // enrichment below is comparatively expensive (a health-check subprocess
    // per server) and must not hold up this update.
    // A failed `mcp list` (most commonly: the provider isn't authenticated
    // anymore) keeps showing the previous mcpServers untouched — that's
    // useful context, but it must not be labeled "live" with a fresh
    // timestamp, or the UI implies these are current results from just now.
    // Same class of bug as the providerUsage.ts fix: a stale-but-labeled-live
    // cache silently misleads once the underlying session has ended.
    const stale = listed == null;
    this.publish({
      ...this.state,
      slashCommands: uniqueSorted([...this.diskCommands, ...this.runtimeCommands]),
      mcpServers,
      loading: listed != null,
      source: stale && mcpServers.length > 0 ? "cache" : "live",
      updatedAt: stale ? this.state.updatedAt : new Date().toISOString(),
      error,
    });
    if (!listed) return;

    // `mcp list`'s connection status is authoritative; `mcp get` only adds
    // scope/transport detail on top of it, so a single server's get failing
    // doesn't fail the whole refresh — it just lacks detail.
    const enriched = await mapWithConcurrency(listed, 4, async (server) => {
      try {
        // stdio servers can be genuinely slow here: `mcp get` health-checks
        // by actually booting the subprocess (observed 100ms–6s locally
        // depending on interpreter/venv cold start), so this needs much
        // more headroom than a simple text-parsing round trip would.
        const getResult = await execCli(config.claudeBin, ["mcp", "get", server.name], {
          cwd: this.workspacePath,
          timeout: 15000,
          env: claudeChildEnv(process.env, this.claudeHome),
        });
        return { ...server, ...parseMcpGetOutput(getResult.stdout) };
      } catch {
        return { ...server, detail: t("無法取得詳細資訊") };
      }
    });
    if (generation !== this.refreshGeneration) return;

    this.publish({
      ...this.state,
      slashCommands: uniqueSorted([...this.diskCommands, ...this.runtimeCommands]),
      mcpServers: enriched,
      loading: false,
      source: "live",
      updatedAt: new Date().toISOString(),
      error,
    });
  }

  async refreshCommands(resetRuntimeCommands = false): Promise<void> {
    if (resetRuntimeCommands) this.runtimeCommands = [...DEFAULT_CLAUDE_COMMANDS];
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
    builtinTools: string[];
  }): void {
    const discoveredCommands = uniqueSorted(meta.slashCommands);
    // Resumed/background Claude sessions sometimes emit an init/meta frame
    // without slash_commands. That frame is not evidence that commands were
    // removed, so do not let it erase a previously discovered palette.
    if (discoveredCommands.length > 0) {
      this.runtimeCommands = uniqueSorted([...DEFAULT_CLAUDE_COMMANDS, ...discoveredCommands]);
      // Refresh only the portable subset for other/new workspaces.
      this.store.saveSlashCommandSeed(portableClaudeCommands(discoveredCommands));
    }
    const byName = new Map(this.state.mcpServers.map((server) => [server.name, server]));
    // Shallow-merge rather than overwrite: the init frame only ever reports
    // {name, status}, so a full overwrite would erase the scope/transport
    // detail that refresh()'s `mcp get` calls already gathered.
    for (const server of meta.mcpServers) byName.set(server.name, { ...byName.get(server.name), ...server });
    // Same "don't erase on an empty resumed-frame" guard as slash commands:
    // an empty builtinTools array here just means this particular frame
    // didn't carry it, not that the session lost its built-in tools.
    const builtinTools = meta.builtinTools.length > 0
      ? uniqueSorted(meta.builtinTools)
      : (this.state.builtinTools ?? []);
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
      builtinTools,
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
