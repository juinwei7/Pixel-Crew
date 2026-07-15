import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedLoopbackOrigin } from "../src/localAccess.js";

test("only accepts local UI origins and origin-less local clients", () => {
  assert.equal(isAllowedLoopbackOrigin(), true);
  assert.equal(isAllowedLoopbackOrigin("http://localhost:5173"), true);
  assert.equal(isAllowedLoopbackOrigin("http://127.0.0.1:4173"), true);
  assert.equal(isAllowedLoopbackOrigin("https://[::1]:5173"), true);
  assert.equal(isAllowedLoopbackOrigin("https://example.com"), false);
  assert.equal(isAllowedLoopbackOrigin("https://localhost.example.com"), false);
  assert.equal(isAllowedLoopbackOrigin("null"), false);
});
