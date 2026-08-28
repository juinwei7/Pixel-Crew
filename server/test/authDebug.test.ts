import assert from "node:assert/strict";
import test from "node:test";
import { buildAuthDebug } from "../src/providers/authDebug.js";

test("includes the resolved executable, exit code, and raw output", () => {
  const debug = buildAuthDebug({
    command: "claude",
    args: ["auth", "status", "--json"],
    durationMs: 42,
    stdout: "Checking for updates...\n{\"loggedIn\":true}",
    stderr: "",
    error: null,
  });
  assert.match(debug, /resolved executable:/);
  // Windows（WinGet）會把 claude 解析成 claude.exe；容忍平台副檔名，別把測試綁死在 POSIX 名稱。
  assert.match(debug, /command: .*claude(\.\w+)? auth status --json/);
  assert.match(debug, /duration: 42ms/);
  assert.match(debug, /exit: 0/);
  assert.match(debug, /stdout: Checking for updates/);
});

test("surfaces the spawn error code and message instead of hiding it", () => {
  const error = Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
  const debug = buildAuthDebug({
    command: "codex",
    args: ["login", "status"],
    durationMs: 5,
    error,
  });
  assert.match(debug, /exit: ENOENT/);
  assert.match(debug, /error: spawn codex ENOENT/);
});

test("truncates long stdout/stderr instead of dumping everything", () => {
  const debug = buildAuthDebug({
    command: "claude",
    args: ["auth", "status", "--json"],
    durationMs: 1,
    stdout: "x".repeat(2000),
  });
  const stdoutLine = debug.split("\n").find((line) => line.startsWith("stdout:"))!;
  assert.ok(stdoutLine.length < 600);
  assert.match(stdoutLine, /…$/);
});
