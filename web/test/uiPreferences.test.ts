import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_UI_PREFERENCES, enteredCompactOffice, parseUiPreferences } from "../src/uiPreferences";

test("parses UI preferences field by field and bounds task log width", () => {
  const parsed = parseUiPreferences({
    taskLogWidth: 2_000,
    taskLogView: "activity",
    taskLogOpen: false,
    crewRailCollapsed: true,
    crewFilter: "attention",
    reducedDetail: true,
    taskFocusMode: true,
  }, 1_200);
  assert.equal(parsed.taskLogWidth, 860);
  assert.equal(parsed.taskLogView, "activity");
  assert.equal(parsed.taskLogOpen, false);
  assert.equal(parsed.crewFilter, "attention");
  assert.equal(parsed.taskFocusMode, true);
});

test("invalid UI preference fields fall back independently", () => {
  const parsed = parseUiPreferences({ taskLogWidth: "wide", taskLogView: "raw", crewFilter: "unknown", taskFocusMode: "yes" }, 900);
  assert.equal(parsed.taskLogWidth, DEFAULT_UI_PREFERENCES.taskLogWidth);
  assert.equal(parsed.taskLogView, DEFAULT_UI_PREFERENCES.taskLogView);
  assert.equal(parsed.crewFilter, DEFAULT_UI_PREFERENCES.crewFilter);
  assert.equal(parsed.taskFocusMode, DEFAULT_UI_PREFERENCES.taskFocusMode);
});

test("taskFocusMode persists across reload (survives round-trip through JSON)", () => {
  const stored = JSON.parse(JSON.stringify(parseUiPreferences({ taskFocusMode: true }, 900)));
  assert.equal(parseUiPreferences(stored, 900).taskFocusMode, true);
});

test("migrates the panel-layout regression once while preserving other v2 preferences", () => {
  const migrated = parseUiPreferences({
    version: 2,
    taskLogOpen: false,
    taskLogWidth: 544,
    taskLogView: "activity",
    crewRailCollapsed: true,
  }, 1_024);
  assert.equal(migrated.version, 3);
  assert.equal(migrated.taskLogOpen, true);
  assert.equal(migrated.taskLogWidth, 544);
  assert.equal(migrated.taskLogView, "activity");
  assert.equal(migrated.crewRailCollapsed, true);
});

test("only auto-collapses the task log when crossing into compact desktop width", () => {
  assert.equal(enteredCompactOffice(Number.POSITIVE_INFINITY, 1_440), false);
  assert.equal(enteredCompactOffice(1_441, 1_280), true);
  assert.equal(enteredCompactOffice(1_280, 1_100), false);
  assert.equal(enteredCompactOffice(1_280, 1_440), false);
  assert.equal(enteredCompactOffice(1_440, 1_600), false);
});
