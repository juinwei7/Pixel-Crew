import assert from "node:assert/strict";
import test from "node:test";
import { parseCommandLine } from "../src/platform/commandLine.js";

test("keeps quoted Windows paths as one MCP argument", () => {
  assert.deepEqual(
    parseCommandLine('"C:\\Program Files\\nodejs\\node.exe" "C:\\My Tools\\server.js" --name crew'),
    ["C:\\Program Files\\nodejs\\node.exe", "C:\\My Tools\\server.js", "--name", "crew"],
  );
});

test("keeps ordinary Windows backslashes", () => {
  assert.deepEqual(parseCommandLine("C:\\tools\\server.exe --stdio"), ["C:\\tools\\server.exe", "--stdio"]);
  assert.throws(() => parseCommandLine('node "unfinished'), /引號/);
});
