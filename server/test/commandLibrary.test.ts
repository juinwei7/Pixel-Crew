import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  commandMetadata,
  deleteProjectCommand,
  listProjectCommands,
  saveProjectCommand,
} from "../src/commandLibrary.js";

test("parses, saves, renames, and deletes project commands", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pixel-crew-commands-"));
  try {
    const content = `---\ndescription: Review changes\nargument-hint: "[branch]"\nallowed-tools: Read, Bash\n---\n\nReview $ARGUMENTS.`;
    assert.deepEqual(commandMetadata(content), {
      description: "Review changes",
      argumentHint: "[branch]",
      allowedTools: "Read, Bash",
      model: "",
    });

    await saveProjectCommand(workspace, "review/code", content);
    assert.equal((await listProjectCommands(workspace))[0].name, "review/code");
    await assert.rejects(() => saveProjectCommand(workspace, "review/code", content), /已經存在/);
    await saveProjectCommand(workspace, "review/final", content, "review/code");
    assert.deepEqual((await listProjectCommands(workspace)).map((item) => item.name), ["review/final"]);
    await deleteProjectCommand(workspace, "review/final");
    assert.deepEqual(await listProjectCommands(workspace), []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("rejects command path traversal and empty content", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pixel-crew-commands-"));
  try {
    await assert.rejects(() => saveProjectCommand(workspace, "../secret", "hello"), /名稱|路徑/);
    await assert.rejects(() => saveProjectCommand(workspace, "valid", "  "), /不能是空白/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("does not follow command directories linked outside the workspace", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pixel-crew-commands-"));
  const external = mkdtempSync(join(tmpdir(), "pixel-crew-external-"));
  try {
    mkdirSync(join(workspace, ".claude"));
    symlinkSync(external, join(workspace, ".claude", "commands"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(() => listProjectCommands(workspace), /符號連結/);
    await assert.rejects(() => saveProjectCommand(workspace, "escaped", "hello"), /符號連結/);
    assert.equal(existsSync(join(external, "escaped.md")), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});
