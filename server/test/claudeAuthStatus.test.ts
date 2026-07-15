import assert from "node:assert/strict";
import test from "node:test";
import { resolveClaudeAuthStatus } from "../src/providers/claudeAuthStatus.js";

test("recognizes authenticated and signed-out Claude CLI responses", () => {
  assert.equal(resolveClaudeAuthStatus(null, '{"loggedIn":true}').status, "authenticated");
  assert.equal(
    resolveClaudeAuthStatus(Object.assign(new Error("signed out"), { code: 1 }), '{"loggedIn":false}').status,
    "unauthenticated",
  );
});

test("distinguishes a missing CLI from malformed output", () => {
  assert.equal(
    resolveClaudeAuthStatus(Object.assign(new Error("missing"), { code: "ENOENT" }), "").status,
    "cli_missing",
  );
  assert.equal(resolveClaudeAuthStatus(new Error("bad output"), "not json").status, "error");
});
