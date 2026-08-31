import assert from "node:assert/strict";
import test from "node:test";
import { readWorkspaceGitSummary, workspaceGitInternals } from "../src/workspaceGit.js";

const result = (stdout: string) => ({ stdout, stderr: "" });

test("reads clean Git workspace state and upstream divergence without mutation", async () => {
  const calls: string[][] = [];
  const summary = await readWorkspaceGitSummary("/repo", async (_command, args) => {
    calls.push(args);
    if (args[1] === "--abbrev-ref") return result("sync-20260828\n");
    if (args[1] === "--short") return result("6a61157\n");
    if (args[1] === "--porcelain") return result("");
    return result("2\t3\n");
  });
  assert.deepEqual(summary, {
    workspacePath: "/repo", available: true, branch: "sync-20260828", head: "6a61157",
    changedFiles: 0, ahead: 3, behind: 2, message: null,
  });
  assert.deepEqual(calls, [
    ["rev-parse", "--abbrev-ref", "HEAD"],
    ["rev-parse", "--short", "HEAD"],
    ["status", "--porcelain"],
    ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
  ]);
  assert.equal(calls.flat().some((part) => /^(checkout|switch|fetch|add|commit|push)$/i.test(part)), false);
});

test("keeps non-Git folders usable and supports detached/no-upstream repositories", async () => {
  const unavailable = await readWorkspaceGitSummary("/folder", async () => { throw new Error("not a repository"); });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.message, "Git 狀態目前無法讀取");

  const detached = await readWorkspaceGitSummary("/repo", async (_command, args) => {
    if (args[1] === "--abbrev-ref") return result("HEAD\n");
    if (args[1] === "--short") return result("abc1234\n");
    if (args[1] === "--porcelain") return result(" M app.ts\n?? notes.md\n");
    throw new Error("no upstream");
  });
  assert.equal(detached.branch, "detached HEAD");
  assert.equal(detached.changedFiles, 2);
  assert.equal(detached.ahead, null);
  assert.equal(detached.behind, null);
  assert.deepEqual(workspaceGitInternals.aheadBehind("bad"), null);
});
