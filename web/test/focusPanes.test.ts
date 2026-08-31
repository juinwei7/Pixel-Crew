import assert from "node:assert/strict";
import test from "node:test";
import { addPane, createFocusPanes, cyclePaneFocus, MAX_FOCUS_PANES, paneCycleShortcut, removePane, setPaneWorker } from "../src/focusPanes";

test("creates panes seeded from worker ids, clamped to [1, MAX_FOCUS_PANES]", () => {
  const panes = createFocusPanes(2, ["w1"]);
  assert.equal(panes.length, 2);
  assert.equal(panes[0].workerId, "w1");
  assert.equal(panes[1].workerId, null);

  assert.equal(createFocusPanes(0).length, 1);
  assert.equal(createFocusPanes(99).length, MAX_FOCUS_PANES);

  const ids = new Set(panes.map((pane) => pane.id));
  assert.equal(ids.size, panes.length);
});

test("setPaneWorker only updates the matching pane", () => {
  const panes = createFocusPanes(2);
  const updated = setPaneWorker(panes, panes[1].id, "w2");
  assert.equal(updated[0].workerId, null);
  assert.equal(updated[1].workerId, "w2");
});

test("addPane appends up to maxPanes and removePane keeps at least one pane", () => {
  let panes = createFocusPanes(1);
  panes = addPane(panes, 2);
  assert.equal(panes.length, 2);
  panes = addPane(panes, 2);
  assert.equal(panes.length, 2, "does not exceed maxPanes");

  panes = removePane(panes, panes[0].id);
  assert.equal(panes.length, 1);
  panes = removePane(panes, panes[0].id);
  assert.equal(panes.length, 1, "keeps at least one pane");
});

test("cyclePaneFocus wraps forward and backward", () => {
  const panes = createFocusPanes(3);
  const [a, b, c] = panes;
  assert.equal(cyclePaneFocus(panes, a.id, 1), b.id);
  assert.equal(cyclePaneFocus(panes, c.id, 1), a.id);
  assert.equal(cyclePaneFocus(panes, a.id, -1), c.id);
  assert.equal(cyclePaneFocus(panes, "missing", 1), a.id);
});

test("recognizes Alt+] and Alt+[ only outside editable controls", () => {
  assert.equal(paneCycleShortcut({ key: "]", altKey: true, metaKey: false, ctrlKey: false, shiftKey: false }), 1);
  assert.equal(paneCycleShortcut({ key: "[", altKey: true, metaKey: false, ctrlKey: false, shiftKey: false }), -1);
  assert.equal(paneCycleShortcut({ key: "]", altKey: false, metaKey: false, ctrlKey: false, shiftKey: false }), null);
  assert.equal(paneCycleShortcut({ key: "]", altKey: true, metaKey: true, ctrlKey: false, shiftKey: false }), null);
  assert.equal(paneCycleShortcut({ key: "]", altKey: true, metaKey: false, ctrlKey: false, shiftKey: false }, true), null);
  assert.equal(paneCycleShortcut({ key: "a", altKey: true, metaKey: false, ctrlKey: false, shiftKey: false }), null);
});
