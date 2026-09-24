import assert from "node:assert/strict";
import test from "node:test";
import { getAdvisorEntry, setAdvisorIdea, subscribeAdvisor } from "../src/advisorStore";

// The whole point of the module-level store is that advisor state outlives
// BossTaskDesk unmounting when the owner switches NPCs. These lock the sync
// semantics useSyncExternalStore relies on and the per-workspace isolation.

test("an idea written for a workspace is still there on a later read (survives remount)", () => {
  const ws = "/repo/advisor-persist";
  setAdvisorIdea(ws, "AI 量化交易");
  // A fresh getAdvisorEntry — as a remounted component would call — sees the value.
  assert.equal(getAdvisorEntry(ws).idea, "AI 量化交易");
});

test("getAdvisorEntry returns a stable reference while unchanged (getSnapshot contract)", () => {
  const ws = "/repo/advisor-stable";
  setAdvisorIdea(ws, "seed");
  const first = getAdvisorEntry(ws);
  const second = getAdvisorEntry(ws);
  // Same object identity → useSyncExternalStore will not loop re-rendering.
  assert.equal(first, second);
});

test("workspaces keep independent advisor state", () => {
  const a = "/repo/advisor-a";
  const b = "/repo/advisor-b";
  setAdvisorIdea(a, "idea-a");
  setAdvisorIdea(b, "idea-b");
  assert.equal(getAdvisorEntry(a).idea, "idea-a");
  assert.equal(getAdvisorEntry(b).idea, "idea-b");
});

test("an unknown workspace reads a safe empty default", () => {
  const entry = getAdvisorEntry("/repo/never-touched");
  assert.equal(entry.idea, "");
  assert.equal(entry.loading, false);
  assert.deepEqual(entry.proposals, []);
});

test("subscribers are notified on change and stop after unsubscribe", () => {
  const ws = "/repo/advisor-notify";
  let hits = 0;
  const unsubscribe = subscribeAdvisor(() => { hits += 1; });
  setAdvisorIdea(ws, "one");
  assert.equal(hits, 1);
  unsubscribe();
  setAdvisorIdea(ws, "two");
  assert.equal(hits, 1);
});
