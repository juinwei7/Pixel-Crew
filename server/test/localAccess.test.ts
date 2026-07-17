import assert from "node:assert/strict";
import test from "node:test";
import {
  isAllowedLocalRequest,
  isAllowedLoopbackHost,
  isAllowedLoopbackOrigin,
} from "../src/localAccess.js";

test("only accepts local UI origins and origin-less local clients", () => {
  assert.equal(isAllowedLoopbackOrigin(), true);
  assert.equal(isAllowedLoopbackOrigin("http://localhost:5173"), true);
  assert.equal(isAllowedLoopbackOrigin("http://127.0.0.1:4173"), true);
  assert.equal(isAllowedLoopbackOrigin("https://[::1]:5173"), true);
  assert.equal(isAllowedLoopbackOrigin("https://example.com"), false);
  assert.equal(isAllowedLoopbackOrigin("https://localhost.example.com"), false);
  assert.equal(isAllowedLoopbackOrigin("https://user@localhost:5173"), false);
  assert.equal(isAllowedLoopbackOrigin("https://localhost:5173/unexpected"), false);
  assert.equal(isAllowedLoopbackOrigin("null"), false);
});

test("only accepts loopback Host headers, with an optional port", () => {
  assert.equal(isAllowedLoopbackHost("localhost:8787"), true);
  assert.equal(isAllowedLoopbackHost("127.0.0.1:8787"), true);
  assert.equal(isAllowedLoopbackHost("[::1]:8787"), true);
  assert.equal(isAllowedLoopbackHost(), false);
  assert.equal(isAllowedLoopbackHost("pixel-crew.example:8787"), false);
  assert.equal(isAllowedLoopbackHost("127.0.0.1.example:8787"), false);
  assert.equal(isAllowedLoopbackHost("localhost@example.com"), false);
  assert.equal(isAllowedLoopbackHost("localhost:8787/unexpected"), false);
  assert.equal(isAllowedLoopbackHost("localhost:8787?unexpected"), false);
});

test("blocks cross-origin and DNS-rebinding requests before routing", () => {
  assert.equal(isAllowedLocalRequest("localhost:8787"), true);
  assert.equal(isAllowedLocalRequest("127.0.0.1:8787", "http://localhost:5173"), true);
  assert.equal(isAllowedLocalRequest("pixel-crew.example:8787", "http://pixel-crew.example:8787"), false);
  assert.equal(isAllowedLocalRequest("localhost:8787", "https://evil.example"), false);
});
