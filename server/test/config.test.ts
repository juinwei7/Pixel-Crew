import assert from "node:assert/strict";
import test from "node:test";
import { isLoopbackHost } from "../src/config.js";

test("only accepts the three loopback host forms Pixel Crew's no-auth model depends on", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("::1"), true);
});

test("rejects any address that would expose the server beyond this machine", () => {
  // Pixel Crew has no remote authentication, so HOST must never resolve to
  // something other than the loopback interface — these must all be false.
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(isLoopbackHost("192.168.1.1"), false);
  assert.equal(isLoopbackHost("::"), false);
  assert.equal(isLoopbackHost("example.com"), false);
  assert.equal(isLoopbackHost(""), false);
});
