import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveProjectCommand } from "../src/commandLibrary.js";
import { saveProjectSkill } from "../src/skillLibrary.js";
import { WorkflowLibraryWatcher, type WorkflowLibraryUpdate } from "../src/workflowWatcher.js";

test("reports external command and skill library changes per workspace", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pixel-crew-watch-"));
  const updates: WorkflowLibraryUpdate[] = [];
  const watcher = new WorkflowLibraryWatcher(() => [workspace], (update) => updates.push(update));
  try {
    await watcher.scanNow();
    await saveProjectCommand(workspace, "review", "---\ndescription: Review\n---\nDo it");
    await watcher.scanNow();
    await saveProjectSkill(
      workspace,
      "verify",
      "---\nname: verify\ndescription: Verify changes\n---\nDo it",
    );
    await watcher.scanNow();
    assert.deepEqual(updates.map(({ provider, revision }) => ({ provider, revision })), [
      { provider: "claude", revision: 1 },
      { provider: "codex", revision: 1 },
    ]);
  } finally {
    watcher.stop();
    rmSync(workspace, { recursive: true, force: true });
  }
});
