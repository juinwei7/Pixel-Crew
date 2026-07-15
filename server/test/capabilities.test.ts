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
