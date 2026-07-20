import assert from "node:assert/strict";
import test from "node:test";
import { buildProviderWorkflowEntries, composerEnterAction, mergePaletteNames } from "../src/commandInteraction";

test("merges project commands with built-in slash commands without dropping either", () => {
  // A room whose only disk command is finish-work must still surface built-ins.
  const merged = mergePaletteNames(
    [{ name: "finish-work", description: "收尾" }],
    ["clear", "compact", "finish-work", "usage"],
  );
  assert.deepEqual(merged.map((entry) => entry.name), ["finish-work", "clear", "compact", "usage"]);
  assert.equal(merged[0].description, "收尾"); // project metadata preserved
  assert.equal(merged.filter((entry) => entry.name === "finish-work").length, 1); // de-duplicated
});

test("falls back to the full slash set when a room has no project commands", () => {
  const merged = mergePaletteNames([], ["clear", "compact", "usage"]);
  assert.deepEqual(merged.map((entry) => entry.name), ["clear", "compact", "usage"]);
});

test("keeps Codex native slash commands separate from repo skills", () => {
  const entries = buildProviderWorkflowEntries(
    "codex",
    [{ name: "sdd", description: "規格驅動開發" }, { name: "review", description: "團隊審查流程" }],
    ["compact", "review"],
  );

  assert.deepEqual(entries.map((entry) => entry.label), ["$sdd", "$review", "/compact", "/review"]);
  assert.deepEqual(entries.map((entry) => entry.value), ["$sdd ", "$review ", "/compact ", "/review "]);
  assert.equal(entries[0].description, "規格驅動開發");
  assert.equal(entries[2].description, "Codex 原生指令");
});

test("keeps Claude project and native commands on slash syntax", () => {
  const entries = buildProviderWorkflowEntries(
    "claude",
    [{ name: "ship", description: "發佈" }],
    ["clear", "ship"],
  );

  assert.deepEqual(entries.map((entry) => entry.label), ["/ship", "/clear"]);
});

test("never submits palette text while command choices are loading or empty", () => {
  assert.equal(composerEnterAction(true, true, 4, false), "ignore");
  assert.equal(composerEnterAction(true, false, 0, false), "ignore");
  assert.equal(composerEnterAction(true, false, 2, false), "choose");
});

test("submits only a normal closed-palette Enter", () => {
  assert.equal(composerEnterAction(false, false, 0, false), "submit");
  assert.equal(composerEnterAction(false, false, 0, true), "ignore");
});
