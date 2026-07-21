import assert from "node:assert/strict";
import test from "node:test";
import { resolveCodexAuthStatus } from "../src/providers/codexAuthStatus.js";

test("a clean `codex login status` exit means authenticated", () => {
  assert.equal(resolveCodexAuthStatus(null).status, "authenticated");
});

test("distinguishes a missing CLI from a plain signed-out status", () => {
  const missing = resolveCodexAuthStatus(Object.assign(new Error("missing"), { code: "ENOENT" }));
  assert.equal(missing.status, "cli_missing");
  assert.match(missing.error ?? "", /Codex/);

  const signedOut = resolveCodexAuthStatus(Object.assign(new Error("not logged in"), { code: 1 }));
  assert.equal(signedOut.status, "unauthenticated");
  assert.equal(signedOut.error, null);
});
