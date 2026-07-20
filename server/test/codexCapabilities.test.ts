import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildCodexMcpAddArgs, CodexCapabilityRegistry, DEFAULT_CODEX_SLASH_COMMANDS, parseCodexMcpList, parseCodexModels } from "../src/codexCapabilities.js";
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
