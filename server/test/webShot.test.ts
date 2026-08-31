import assert from "node:assert/strict";
import test from "node:test";
import { chromeCandidates, isInternalIp } from "../src/webShot.js";

test("webshot chooses only existing Chrome paths for the current platform", () => {
  const seen: string[] = [];
  const present = (path: string) => { seen.push(path); return path.includes("Google Chrome.app"); };
  const candidates = chromeCandidates("darwin", "C:/missing/chrome.exe", present);
  assert.ok(candidates.includes("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"));
  assert.ok(candidates.every((path) => path.includes("Google Chrome.app")));
  assert.ok(seen.every((path) => !path.includes("Program Files")));
});

test("webshot accepts an explicitly configured executable when it exists", () => {
  assert.deepEqual(chromeCandidates("linux", "/opt/chrome", (path) => path === "/opt/chrome"), ["/opt/chrome"]);
});

test("webshot blocks private, reserved, and IPv4-in-IPv6 destinations", () => {
  for (const address of [
    "127.0.0.1", "10.0.0.1", "169.254.169.254", "198.18.0.1", "224.0.0.1",
    "::1", "fe90::1", "ff02::1", "::127.0.0.1", "::7f00:1", "::ffff:0a00:1",
    "0:0:0:0:0:ffff:7f00:1", "0:0:0:0:0:ffff:c0a8:1",
  ]) {
    assert.equal(isInternalIp(address), true, address);
  }
  assert.equal(isInternalIp("8.8.8.8"), false);
  assert.equal(isInternalIp("2606:4700:4700::1111"), false);
});
