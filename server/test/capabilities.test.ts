import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CapabilityRegistry, parseMcpList } from "../src/capabilities.js";
import { LocalStore } from "../src/store.js";
import { saveProjectCommand } from "../src/commandLibrary.js";

test("an empty resumed-session meta frame does not erase discovered slash commands", () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-capabilities-"));
  try {
    const updates: string[][] = [];
    const registry = new CapabilityRegistry(
      new LocalStore(join(dir, "test.sqlite")),
      (state) => updates.push(state.slashCommands),
    );

    registry.mergeWorkerMeta({
      slashCommands: ["review", "verify"],
      mcpServers: [],
      toolCount: 2,
    });
    registry.mergeWorkerMeta({
      slashCommands: [],
      mcpServers: [],
      toolCount: 2,
    });

    assert.deepEqual(updates.at(-1), ["review", "verify"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps slash commands isolated by workspace registry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-capabilities-"));
  const first = join(dir, "first");
  const second = join(dir, "second");
  try {
    mkdirSync(first);
    mkdirSync(second);
    await saveProjectCommand(first, "first-only", "---\ndescription: First\n---\nDo first");
    await saveProjectCommand(second, "second-only", "---\ndescription: Second\n---\nDo second");
    const store = new LocalStore(join(dir, "test.sqlite"));
    const firstRegistry = new CapabilityRegistry(store, () => undefined, first);
    const secondRegistry = new CapabilityRegistry(store, () => undefined, second);
    await Promise.all([firstRegistry.refreshCommands(), secondRegistry.refreshCommands()]);
    assert.equal(firstRegistry.getState().slashCommands.includes("first-only"), true);
    assert.equal(firstRegistry.getState().slashCommands.includes("second-only"), false);
    assert.equal(secondRegistry.getState().slashCommands.includes("second-only"), true);
    assert.equal(secondRegistry.getState().slashCommands.includes("first-only"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serves cached Claude models immediately and merges later runtime discovery", () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-capabilities-"));
  try {
    const store = new LocalStore(join(dir, "test.sqlite"));
    store.saveCapabilities("/repo", {
      slashCommands: [],
      mcpServers: [],
      models: [{ id: "cached-model", label: "Cached Model" }],
      toolCount: null,
      loading: false,
      source: "live",
      updatedAt: "2026-07-15T00:00:00.000Z",
      error: null,
    });
    const registry = new CapabilityRegistry(store, () => undefined, "/repo");
    assert.equal(registry.getState().source, "cache");
    assert.equal(registry.getState().loading, true);
    assert.equal(registry.getState().models.some((model) => model.id === "cached-model"), true);
    assert.equal(registry.getState().models.some((model) => model.id === "sonnet"), true);

    registry.mergeWorkerMeta({ model: "runtime-model", slashCommands: [], mcpServers: [], toolCount: 1 });
    assert.equal(registry.getState().models.some((model) => model.id === "runtime-model"), true);

    const reopened = new CapabilityRegistry(store, () => undefined, "/repo");
    assert.equal(reopened.getState().models.some((model) => model.id === "runtime-model"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collapses the CLI's full model id back to its alias instead of adding a duplicate option", () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-capabilities-"));
  try {
    const store = new LocalStore(join(dir, "test.sqlite"));
    const registry = new CapabilityRegistry(store, () => undefined, "/repo");

    registry.mergeWorkerMeta({ model: "claude-sonnet-5", slashCommands: [], mcpServers: [], toolCount: 1 });
    const models = registry.getState().models;
    assert.equal(models.filter((model) => model.id === "sonnet").length, 1);
    assert.equal(models.some((model) => model.id === "claude-sonnet-5"), false);

    registry.mergeWorkerMeta({ model: "claude-fable-5", slashCommands: [], mcpServers: [], toolCount: 1 });
    assert.equal(registry.getState().models.some((model) => model.id === "fable"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collapses full model ids already persisted in the cache when loading", () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-capabilities-"));
  try {
    const store = new LocalStore(join(dir, "test.sqlite"));
    // Simulates a cache written before model-id normalization existed.
    store.saveCapabilities("/repo", {
      slashCommands: [],
      mcpServers: [],
      models: [{ id: "claude-fable-5", label: "claude-fable-5" }, { id: "claude-sonnet-5", label: "claude-sonnet-5" }],
      toolCount: null,
      loading: false,
      source: "live",
      updatedAt: "2026-07-15T00:00:00.000Z",
      error: null,
    });
    const models = new CapabilityRegistry(store, () => undefined, "/repo").getState().models;
    assert.equal(models.some((model) => model.id.startsWith("claude-")), false);
    assert.equal(models.filter((model) => model.id === "fable").length, 1);
    assert.equal(models.filter((model) => model.id === "sonnet").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("seeds native slash commands globally without leaking project commands", () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-capabilities-"));
  try {
    const store = new LocalStore(join(dir, "test.sqlite"));

    // A worker in one room discovers the built-in command set.
    const roomA = new CapabilityRegistry(store, () => undefined, "/repo-a");
    roomA.mergeWorkerMeta({ slashCommands: ["clear", "compact", "usage", "repo-a-only"], mcpServers: [], toolCount: 3 });
    assert.deepEqual(store.loadSlashCommandSeed(), ["clear", "compact", "usage"]);

    // A brand-new room (never messaged) still shows those native commands.
    const roomB = new CapabilityRegistry(store, () => undefined, "/repo-b");
    for (const name of ["clear", "compact", "usage"]) {
      assert.equal(roomB.getState().slashCommands.includes(name), true);
    }
    assert.equal(roomB.getState().slashCommands.includes("repo-a-only"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parses claude mcp list statuses, including remote servers needing authentication", () => {
  const servers = parseMcpList([
    "fontrip: https://mcp.sre.fontrip.com/mcp - ✔ Connected",
    "Notion: https://mcp.notion.com/mcp - ! Needs authentication",
    "broken: /usr/local/bin/broken-server - ✘ Failed to connect",
  ].join("\n"));

  assert.deepEqual(servers, [
    { name: "fontrip", status: "connected" },
    { name: "Notion", status: "needs_auth" },
    { name: "broken", status: "failed" },
  ]);
});
