import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CapabilityRegistry } from "../src/capabilities.js";
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
