import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CodexCapabilityRegistry, DEFAULT_CODEX_SLASH_COMMANDS, parseCodexMcpList, parseCodexModels } from "../src/codexCapabilities.js";
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

test("parses Codex MCP configuration without exposing transport secrets", () => {
  assert.deepEqual(
    parseCodexMcpList(JSON.stringify([
      { name: "docs", enabled: true, transport: { type: "stdio", env: { TOKEN: "secret" } } },
      { name: "browser", enabled: false, transport: { type: "stdio" } },
    ])),
    [
      { name: "docs", status: "enabled" },
      { name: "browser", status: "disabled" },
    ],
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
