import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CapabilityRegistry } from "../src/capabilities.js";
import { LocalStore } from "../src/store.js";

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
