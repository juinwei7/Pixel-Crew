import assert from "node:assert/strict";
import test from "node:test";
import { keyboardShortcut, topDismissibleLayer } from "../src/hooks/useKeyboardShortcuts";

const event = (key: string, options: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  ...options,
});

test("routes product shortcuts on macOS and other platforms", () => {
  assert.equal(keyboardShortcut(event("k", { metaKey: true })), "command_palette");
  assert.equal(keyboardShortcut(event("J", { ctrlKey: true })), "toggle_task_log");
  assert.equal(keyboardShortcut(event("a", { metaKey: true, shiftKey: true })), "approval");
  assert.equal(keyboardShortcut(event("Escape")), "escape");
});

test("does not toggle panels from unrelated editable controls", () => {
  assert.equal(keyboardShortcut(event("j", { metaKey: true }), true), null);
  assert.equal(keyboardShortcut(event("a", { ctrlKey: true, shiftKey: true }), true), null);
  assert.equal(keyboardShortcut(event("k", { ctrlKey: true }), true), "command_palette");
});

test("leaves every key chord to a focused black-window terminal", () => {
  assert.equal(keyboardShortcut(event("Escape"), true, true), null);
  assert.equal(keyboardShortcut(event("k", { metaKey: true }), true, true), null);
  assert.equal(keyboardShortcut(event("J", { ctrlKey: true }), true, true), null);
});

test("Escape dismisses nested focus-mode layers from the inside out", () => {
  assert.equal(topDismissibleLayer(true, true, true), "command_palette");
  assert.equal(topDismissibleLayer(false, true, true), "task_search");
  assert.equal(topDismissibleLayer(false, false, true), "focus_mode");
  assert.equal(topDismissibleLayer(false, false, false), null);
});
