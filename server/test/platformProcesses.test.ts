import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { commandInvocation, execCli, listPosixDescendants, processTreeInvocation, quoteWindowsCmdArgument, resolveExecutable } from "../src/platform/processes.js";

test("resolves Windows npm shims using PATHEXT", () => {
  const found = new Set(["C:\\tools\\claude.cmd"]);
  assert.equal(resolveExecutable("claude", "win32", {
    PATH: "C:\\tools",
    PATHEXT: ".EXE;.CMD",
  }, (candidate) => found.has(candidate)), "C:\\tools\\claude.cmd");
});

test("runs cmd shims through ComSpec without shell mode", () => {
  const invocation = commandInvocation("claude", ["-p", "hello world"], "win32", {
    PATH: "C:\\tools",
    PATHEXT: ".CMD",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
  }, (candidate) => candidate === "C:\\tools\\claude.cmd");
  assert.equal(invocation.file, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(invocation.args[3], /claude\.cmd/i);
  assert.match(invocation.args[3], /"hello world"/);
});

test("quotes percent signs and rejects command newlines", () => {
  assert.equal(quoteWindowsCmdArgument("100%"), '"100%%"');
  assert.throws(() => quoteWindowsCmdArgument("hello\r\nworld"), /不安全/);
});

test("uses taskkill for a Windows process tree", () => {
  assert.deepEqual(processTreeInvocation(123, "win32"), {
    file: "taskkill.exe",
    args: ["/PID", "123", "/T", "/F"],
  });
  assert.equal(processTreeInvocation(123, "darwin"), null);
});

test("collects POSIX descendants breadth-first before killing", async () => {
  const tree = new Map<number, number[]>([
    [100, [200, 201]],
    [200, [300]],
    [300, [400]],
  ]);
  const listed: number[] = [];
  const descendants = await listPosixDescendants(100, async (parent) => {
    listed.push(parent);
    return tree.get(parent) ?? [];
  });
  assert.deepEqual(descendants, [200, 201, 300, 400]);
  assert.deepEqual(listed, [100, 200, 201, 300, 400]);
});

test("POSIX descendant walk tolerates cycles and bad pids", async () => {
  const tree = new Map<number, number[]>([
    [100, [200, 0, -5, Number.NaN]],
    [200, [100, 300]],
  ]);
  const descendants = await listPosixDescendants(100, async (parent) => tree.get(parent) ?? []);
  assert.deepEqual(descendants, [200, 300]);
});

test("executes an npm-style cmd shim with spaced arguments on Windows", { skip: process.platform !== "win32" }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "pixel-crew-cmd-"));
  try {
    const shim = join(directory, "fixture.cmd");
    writeFileSync(shim, "@echo off\r\necho %~1^|%~2\r\n");
    const { stdout } = await execCli(shim, ["alpha", "hello world"], { timeout: 5_000 });
    assert.equal(stdout.trim(), "alpha|hello world");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
