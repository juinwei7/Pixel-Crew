import { config } from "./config.js";
import type { CapabilityState, McpServerState, McpToolInfo, ModelOption } from "./capabilities.js";
import { execCli } from "./platform/processes.js";
import type { LocalStore } from "./store.js";
import { t } from "./i18n.js";

const FALLBACK_MODELS: ModelOption[] = [
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { id: "gpt-5.5", label: "GPT-5.5" },
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
];

// Codex app-server does not emit the TUI's slash-command catalog. Seed the
// conversation controls Pixel Crew implements through app-server itself. Do
// not advertise TUI-only controls (theme, keymap, model picker, etc.): sending
// those through turn/start would incorrectly treat them as ordinary prompts.
// Repo workflows remain separate (`$skill`) and come from `.agents`.
export const DEFAULT_CODEX_SLASH_COMMANDS = [
  "clear", "compact", "new", "review",
] as const;

function mergeSlashCommands(...groups: ReadonlyArray<readonly string[]>): string[] {
  return [...new Set(groups.flatMap((group) => [...group]).filter(Boolean))];
}

export function parseCodexMcpList(stdout: string): McpServerState[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item: any) => {
    if (!item || typeof item.name !== "string") return [];
    const transport = item.transport ?? {};
    const server: McpServerState = {
      name: item.name,
      status: item.enabled === false ? "disabled" : "enabled",
    };
    if (transport.type === "stdio") server.transport = "stdio";
    else if (typeof transport.url === "string") server.transport = "http";
    if (typeof transport.command === "string") server.command = transport.command;
    if (Array.isArray(transport.args)) server.args = transport.args.map(String);
    if (typeof transport.url === "string") server.url = transport.url;
    // Only key names are kept — Codex's env values (e.g. bearer tokens) must
    // never reach the API response or the frontend.
    if (transport.env && typeof transport.env === "object") server.envKeys = Object.keys(transport.env);
    if (typeof item.disabled_reason === "string") server.detail = item.disabled_reason;
    // `auth_status` (e.g. "unsupported" for stdio) is Codex's only signal for
    // whether OAuth login/logout applies to this server — `enabled` is about
    // whether the server itself is on/off, not authentication. The exact set
    // of non-"unsupported" values isn't fully documented, so the frontend
    // treats anything other than "unsupported" as "login may apply" rather
    // than hard-coding a specific enum.
    if (typeof item.auth_status === "string") server.authStatus = item.auth_status;
    return [server];
  });
}

export function mergeCodexMcpConfig(
  listed: McpServerState[],
  previous: McpServerState[],
): McpServerState[] {
  const previousByName = new Map(previous.map((server) => [server.name, server]));
  return listed.map((server) => ({ ...previousByName.get(server.name), ...server }));
}

// Codex's own internal MCP server (not something the user configured via
// `codex mcp add`) — it appears in mcpServerStatus/list but never in
// `codex mcp list`. Shown, labeled distinctly, rather than filtered out: it
// IS a real connected server with real tools.
const CODEX_BUILTIN_MCP_SERVERS = new Set(["codex_apps"]);

export type CodexMcpServerToolsEntry = { name: string; tools: McpToolInfo[]; builtin?: boolean };

// Parses the (undocumented, experimental) mcpServerStatus/list app-server
// response. Defensive about the exact envelope shape across Codex versions:
// current app-server uses {data,nextCursor}; older builds/fixtures used a bare
// array or one of the server-named wrapper keys below.
export function parseCodexMcpServerStatus(result: unknown): CodexMcpServerToolsEntry[] {
  const list = Array.isArray(result)
    ? result
    : Array.isArray((result as any)?.data)
      ? (result as any).data
      : Array.isArray((result as any)?.servers)
        ? (result as any).servers
        : Array.isArray((result as any)?.mcpServers)
          ? (result as any).mcpServers
          : [];
  return list.flatMap((entry: any) => {
    if (!entry || typeof entry.name !== "string") return [];
    const toolsMap = entry.tools && typeof entry.tools === "object" ? entry.tools : {};
    const tools: McpToolInfo[] = Object.entries(toolsMap).map(([toolName, tool]: [string, any]) => {
      const annotations = tool?.annotations && typeof tool.annotations === "object" ? tool.annotations : {};
      return {
        name: typeof tool?.name === "string" ? tool.name : toolName,
        description: typeof tool?.description === "string" ? tool.description : undefined,
        ...(typeof annotations.readOnlyHint === "boolean" ? { readOnlyHint: annotations.readOnlyHint } : {}),
        ...(typeof annotations.destructiveHint === "boolean" ? { destructiveHint: annotations.destructiveHint } : {}),
      };
    });
    const item: CodexMcpServerToolsEntry = { name: entry.name, tools };
    if (CODEX_BUILTIN_MCP_SERVERS.has(entry.name)) item.builtin = true;
    return [item];
  });
}

export type CodexMcpAddInput = {
  name: string;
  transport: "stdio" | "http";
  target?: string;
  localArgv?: string[];
  env?: string[];
  // Advanced, http-only OAuth options.
  oauthClientId?: string;
  oauthResource?: string;
};

// Pure arg builder mirroring `codex mcp add`'s flags, kept alongside
// buildClaudeMcpAddArgs so both providers' add logic is unit-testable
// without spawning the real CLI.
export function buildCodexMcpAddArgs(input: CodexMcpAddInput): string[] {
  const args = ["mcp", "add", input.name];
  if (input.transport === "http") {
    args.push("--url", input.target ?? "");
    if (input.oauthClientId) args.push("--oauth-client-id", input.oauthClientId);
    if (input.oauthResource) args.push("--oauth-resource", input.oauthResource);
  } else {
    for (const entry of input.env ?? []) args.push("--env", entry);
    args.push("--", ...(input.localArgv ?? []));
  }
  return args;
}

export function parseCodexModels(stdout: string): ModelOption[] {
  const parsed = JSON.parse(stdout) as any;
  if (!Array.isArray(parsed?.models)) return [];
  return parsed.models
    .filter((model: any) => model?.visibility === "list" && typeof model.slug === "string")
    .sort((a: any, b: any) => Number(a.priority ?? 999) - Number(b.priority ?? 999))
    .map((model: any) => ({
      id: model.slug,
      label: typeof model.display_name === "string" ? model.display_name : model.slug,
      description: typeof model.description === "string" ? model.description : undefined,
    }));
}

export class CodexCapabilityRegistry {
  private state: CapabilityState;

  constructor(
    private readonly onUpdate: (state: CapabilityState) => void,
    private readonly workspacePath = config.targetRepoPath,
    private readonly store?: LocalStore,
  ) {
    const slashCommands = mergeSlashCommands(
      store?.loadSlashCommandSeed("codex") ?? [],
      DEFAULT_CODEX_SLASH_COMMANDS,
    );
    this.state = {
      slashCommands,
      mcpServers: [],
      models: FALLBACK_MODELS,
      toolCount: null,
      // Not a Claude concept for Codex — always null, never observed.
      builtinTools: null,
      loading: true,
      source: "empty",
      updatedAt: null,
      error: null,
    };
    // Persist immediately, before any worker turn, so every later room/session
    // can bootstrap from the same provider-scoped seed.
    store?.saveSlashCommandSeed(slashCommands, "codex");
  }

  getState(): CapabilityState {
    return this.state;
  }

  async refresh(): Promise<void> {
    this.publish({ ...this.state, loading: true, error: null });
    const [mcpResult, modelResult] = await Promise.allSettled([
      execCli(config.codexBin, ["mcp", "list", "--json"], {
        cwd: this.workspacePath,
        timeout: 15000,
        maxBuffer: 2 * 1024 * 1024,
      }),
      execCli(config.codexBin, ["debug", "models"], {
        cwd: this.workspacePath,
        timeout: 15000,
        maxBuffer: 8 * 1024 * 1024,
      }),
    ]);

    const errors: string[] = [];
    let mcpServers = this.state.mcpServers;
    let models = this.state.models;
    if (mcpResult.status === "fulfilled") {
      try {
        const listed = parseCodexMcpList(mcpResult.value.stdout);
        // A config refresh and an in-session tool reload may finish in either
        // order. Preserve the live tool catalog merged by reloadMcpWorkers so
        // a slower `codex mcp list` result cannot erase it immediately after
        // the session successfully discovered the new tools.
        mcpServers = mergeCodexMcpConfig(listed, this.state.mcpServers);
      } catch (error) {
        errors.push(`MCP: ${(error as Error).message}`);
      }
    } else {
      errors.push(`MCP: ${mcpResult.reason?.message ?? t("讀取失敗")}`);
    }
    if (modelResult.status === "fulfilled") {
      try {
        const discovered = parseCodexModels(modelResult.value.stdout);
        if (discovered.length > 0) models = discovered;
      } catch (error) {
        errors.push(`Models: ${(error as Error).message}`);
      }
    } else {
      errors.push(`Models: ${modelResult.reason?.message ?? t("讀取失敗")}`);
    }

    this.publish({
      ...this.state,
      mcpServers,
      models,
      loading: false,
      source: "live",
      updatedAt: new Date().toISOString(),
      error: errors.length > 0 ? errors.join("; ") : null,
    });
  }

  // Merges a full tool catalog (from CodexSession.listMcpServerTools) into
  // the existing `mcp list`-derived server states. Deliberately only touches
  // tools/toolsStatus/builtin — never overwrites status/authStatus/transport,
  // which the `codex mcp list` parsing above already populated precisely.
  mergeMcpTools(servers: CodexMcpServerToolsEntry[]): void {
    const byName = new Map(this.state.mcpServers.map((server) => [server.name, server]));
    for (const incoming of servers) {
      const existing = byName.get(incoming.name);
      byName.set(incoming.name, {
        ...(existing ?? { name: incoming.name, status: "enabled" }),
        tools: incoming.tools,
        toolsStatus: "available",
        ...(incoming.builtin ? { builtin: true } : {}),
      });
    }
    this.publish({ ...this.state, mcpServers: [...byName.values()] });
  }

  // Graceful-degradation path when mcpServerStatus/list itself failed (older
  // Codex CLI, no active worker, the experimental method renamed/removed).
  // Leaves servers that already have a catalog untouched.
  markMcpToolsUnavailable(): void {
    this.publish({
      ...this.state,
      mcpServers: this.state.mcpServers.map((server) =>
        server.toolsStatus === "available" ? server : { ...server, toolsStatus: "error" },
      ),
    });
  }

  private publish(state: CapabilityState): void {
    this.state = state;
    this.onUpdate(state);
  }
}
