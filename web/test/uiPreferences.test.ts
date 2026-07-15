import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_UI_PREFERENCES, parseUiPreferences } from "../src/uiPreferences";

test("parses UI preferences field by field and bounds task log width", () => {
  const parsed = parseUiPreferences({
    taskLogWidth: 2_000,
    taskLogView: "activity",
    taskLogOpen: false,
    crewRailCollapsed: true,
    crewFilter: "attention",
    reducedDetail: true,
  }, 1_200);
  assert.equal(parsed.taskLogWidth, 860);
  assert.equal(parsed.taskLogView, "activity");
  assert.equal(parsed.taskLogOpen, false);
  assert.equal(parsed.crewFilter, "attention");
});

test("invalid UI preference fields fall back independently", () => {
  const parsed = parseUiPreferences({ taskLogWidth: "wide", taskLogView: "raw", crewFilter: "unknown" }, 900);
  assert.equal(parsed.taskLogWidth, DEFAULT_UI_PREFERENCES.taskLogWidth);
  assert.equal(parsed.taskLogView, DEFAULT_UI_PREFERENCES.taskLogView);
  assert.equal(parsed.crewFilter, DEFAULT_UI_PREFERENCES.crewFilter);
});
