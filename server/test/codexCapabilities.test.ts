import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildCodexMcpAddArgs, CodexCapabilityRegistry, DEFAULT_CODEX_SLASH_COMMANDS, mergeCodexMcpConfig, parseCodexMcpList, parseCodexMcpServerStatus, parseCodexModels } from "../src/codexCapabilities.js";
import { LocalStore } from "../src/store.js";

test("seeds Codex native slash commands before the first live refresh", () => {
  const registry = new CodexCapabilityRegistry(() => {}, "/repo");

  assert.deepEqual(registry.getState().slashCommands, DEFAULT_CODEX_SLASH_COMMANDS);
  assert.deepEqual(registry.getState().slashCommands, ["clear", "compact", "new", "review"]);
});

test("persists Codex command seeds before any conversation and reloads them in a new session", () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-codex-capabilities-"));
  const store = new LocalStore(join(dir, "test.sqlite"));
  try {
    const first = new CodexCapabilityRegistry(() => {}, "/repo-a", store);
    assert.deepEqual(store.loadSlashCommandSeed("codex"), first.getState().slashCommands);
    assert.deepEqual(store.loadSlashCommandSeed("claude"), []);

    const second = new CodexCapabilityRegistry(() => {}, "/repo-b", store);
    assert.deepEqual(second.getState().slashCommands, first.getState().slashCommands);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migrates the legacy Claude-only command seed into the provider-scoped cache", () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-command-seed-migration-"));
  const path = join(dir, "test.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE slash_command_seed (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      commands TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO slash_command_seed (id, commands) VALUES (1, '["clear","review"]');
  `);
  legacy.close();

  const store = new LocalStore(path);
  try {
    assert.deepEqual(store.loadSlashCommandSeed("claude"), ["clear", "review"]);
    assert.deepEqual(store.loadSlashCommandSeed("codex"), []);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parses Codex MCP configuration detail while keeping env var values out of the result", () => {
  const servers = parseCodexMcpList(JSON.stringify([
    { name: "docs", enabled: true, transport: { type: "stdio", command: "npx", args: ["docs-server"], env: { TOKEN: "secret" } } },
    { name: "browser", enabled: false, disabled_reason: "missing binary", transport: { type: "stdio" } },
    { name: "remote", enabled: true, transport: { url: "https://mcp.example.com" } },
  ]));

  assert.deepEqual(servers, [
    { name: "docs", status: "enabled", transport: "stdio", command: "npx", args: ["docs-server"], envKeys: ["TOKEN"] },
    { name: "browser", status: "disabled", transport: "stdio", detail: "missing binary" },
    { name: "remote", status: "enabled", transport: "http", url: "https://mcp.example.com" },
  ]);
  assert.doesNotMatch(JSON.stringify(servers), /secret/);
});

test("keeps auth_status so the frontend can offer login/logout for OAuth-capable Codex servers", () => {
  // `status` (enabled/disabled) is about whether the server is on, not
  // whether it's authenticated — auth_status is the only signal for that.
  const servers = parseCodexMcpList(JSON.stringify([
    { name: "docs", enabled: true, transport: { type: "stdio" }, auth_status: "unsupported" },
    { name: "remote", enabled: true, transport: { url: "https://mcp.example.com" }, auth_status: "unauthenticated" },
  ]));

  assert.deepEqual(servers.map((s) => s.authStatus), ["unsupported", "unauthenticated"]);
});

test("builds codex mcp add args for stdio and http transports", () => {
  assert.deepEqual(
    buildCodexMcpAddArgs({ name: "docs", transport: "stdio", localArgv: ["npx", "docs-server"], env: ["TOKEN=abc"] }),
    ["mcp", "add", "docs", "--env", "TOKEN=abc", "--", "npx", "docs-server"],
  );
  assert.deepEqual(
    buildCodexMcpAddArgs({ name: "remote", transport: "http", target: "https://mcp.example.com" }),
    ["mcp", "add", "remote", "--url", "https://mcp.example.com"],
  );
  assert.deepEqual(
    buildCodexMcpAddArgs({ name: "remote", transport: "http", target: "https://mcp.example.com", oauthClientId: "my-codex-client", oauthResource: "https://mcp.example.com/resource" }),
    ["mcp", "add", "remote", "--url", "https://mcp.example.com", "--oauth-client-id", "my-codex-client", "--oauth-resource", "https://mcp.example.com/resource"],
  );
});

test("parses a realistic mcpServerStatus/list response, marking codex_apps as builtin and keeping empty-tool servers", () => {
  const entries = parseCodexMcpServerStatus({
    servers: [
      { name: "my-hub", tools: { core_list: { name: "core_list", description: "List cores" }, check_action: {} } },
      { name: "codex_apps", tools: { "sites.get_site_version": { description: "Get version" } } },
      { name: "computer-use", tools: {} },
    ],
  });

  assert.deepEqual(entries, [
    { name: "my-hub", tools: [
      { name: "core_list", description: "List cores" },
      { name: "check_action", description: undefined },
    ] },
    { name: "codex_apps", tools: [{ name: "sites.get_site_version", description: "Get version" }], builtin: true },
    { name: "computer-use", tools: [] },
  ]);
});

test("parseCodexMcpServerStatus accepts a bare array or a mcpServers-keyed envelope", () => {
  const bareArray = parseCodexMcpServerStatus([{ name: "a", tools: {} }]);
  assert.deepEqual(bareArray, [{ name: "a", tools: [] }]);

  const mcpServersEnvelope = parseCodexMcpServerStatus({ mcpServers: [{ name: "b", tools: {} }] });
  assert.deepEqual(mcpServersEnvelope, [{ name: "b", tools: [] }]);

  const currentDataEnvelope = parseCodexMcpServerStatus({
    data: [{ name: "my-hub", tools: { pending: { annotations: { readOnlyHint: true } } } }],
    nextCursor: null,
  });
  assert.deepEqual(currentDataEnvelope, [{
    name: "my-hub",
    tools: [{ name: "pending", description: undefined, readOnlyHint: true }],
  }]);
});

test("parseCodexMcpServerStatus retains read-only and destructive annotations", () => {
  const [server] = parseCodexMcpServerStatus({
    servers: [{
      name: "my-hub",
      tools: {
        pending: {
          description: "List pending work",
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
      },
    }],
  });
  assert.deepEqual(server.tools, [{
    name: "pending",
    description: "List pending work",
    readOnlyHint: true,
    destructiveHint: false,
  }]);
});

test("parseCodexMcpServerStatus tolerates malformed or missing entries without throwing", () => {
  assert.deepEqual(parseCodexMcpServerStatus(null), []);
  assert.deepEqual(parseCodexMcpServerStatus({}), []);
  assert.deepEqual(parseCodexMcpServerStatus({ servers: [{ tools: {} }, { name: "ok" }] }), [{ name: "ok", tools: [] }]);
});

test("CodexCapabilityRegistry.mergeMcpTools preserves existing status/transport and adds a new builtin entry", () => {
  const registry = new CodexCapabilityRegistry(() => {}, "/repo");
  // Seed as if `codex mcp list --json` had already populated this server.
  (registry as any).state.mcpServers = [
    { name: "my-hub", status: "enabled", transport: "stdio", authStatus: "unsupported" },
  ];

  registry.mergeMcpTools([
    { name: "my-hub", tools: [{ name: "core_list" }] },
    { name: "codex_apps", tools: [{ name: "sites.get_site_version" }], builtin: true },
  ]);

  const servers = registry.getState().mcpServers;
  const hub = servers.find((s) => s.name === "my-hub");
  assert.equal(hub?.status, "enabled");
  assert.equal(hub?.transport, "stdio");
  assert.equal(hub?.authStatus, "unsupported");
  assert.deepEqual(hub?.tools, [{ name: "core_list" }]);
  assert.equal(hub?.toolsStatus, "available");

  const apps = servers.find((s) => s.name === "codex_apps");
  assert.equal(apps?.builtin, true);
  assert.equal(apps?.toolsStatus, "available");
});

test("CodexCapabilityRegistry.markMcpToolsUnavailable degrades servers without a catalog, leaving available ones alone", () => {
  const registry = new CodexCapabilityRegistry(() => {}, "/repo");
  registry.mergeMcpTools([{ name: "has-tools", tools: [{ name: "x" }] }]);
  (registry as any).state.mcpServers.push({ name: "no-tools-yet", status: "enabled" });

  registry.markMcpToolsUnavailable();

  const servers = registry.getState().mcpServers;
  assert.equal(servers.find((s) => s.name === "has-tools")?.toolsStatus, "available");
  assert.equal(servers.find((s) => s.name === "no-tools-yet")?.toolsStatus, "error");
});

test("Codex config refresh preserves a tool catalog merged by an in-session reload", () => {
  assert.deepEqual(mergeCodexMcpConfig(
    [{ name: "my-hub", status: "enabled", transport: "stdio" }],
    [{
      name: "my-hub",
      status: "starting",
      toolsStatus: "available",
      tools: [{ name: "list_pending", readOnlyHint: true }],
    }],
  ), [{
    name: "my-hub",
    status: "enabled",
    transport: "stdio",
    toolsStatus: "available",
    tools: [{ name: "list_pending", readOnlyHint: true }],
  }]);
});

test("keeps visible Codex models in catalog priority order", () => {
  assert.deepEqual(
    parseCodexModels(JSON.stringify({ models: [
      { slug: "hidden", display_name: "Hidden", visibility: "hide", priority: 0 },
      { slug: "fast", display_name: "Fast", visibility: "list", priority: 2 },
      { slug: "smart", display_name: "Smart", visibility: "list", priority: 1 },
    ] })),
    [
      { id: "smart", label: "Smart", description: undefined },
      { id: "fast", label: "Fast", description: undefined },
    ],
  );
});
