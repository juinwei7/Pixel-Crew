import assert from "node:assert/strict";
import test from "node:test";
import { chromeCandidates } from "../src/webShot.js";

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
