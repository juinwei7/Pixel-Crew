import assert from "node:assert/strict";
import test from "node:test";
import { buildFocusStudios, focusStudioShortcut, focusStudioWorkers, studioWorkerId } from "../src/focusStudios";

test("builds stable studios from managed paths and worker state", () => {
  const studios = buildFocusStudios(["/repo/a", "/repo/b"], [
    { id: "a1", name: "A", workspacePath: "/repo/a", busy: true, needsAttention: false, unread: true },
    { id: "a2", name: "A2", workspacePath: "/repo/a", busy: false, needsAttention: true },
    { id: "c1", name: "C", workspacePath: "/repo/c", busy: false, needsAttention: false },
  ]);
  assert.deepEqual(studios.map(({ workspacePath, name, workerIds, busyCount, attentionCount, unreadCount }) => ({ workspacePath, name, workerIds, busyCount, attentionCount, unreadCount })), [
    { workspacePath: "/repo/a", name: "a", workerIds: ["a1", "a2"], busyCount: 1, attentionCount: 1, unreadCount: 1 },
    { workspacePath: "/repo/b", name: "b", workerIds: [], busyCount: 0, attentionCount: 0, unreadCount: 0 },
    { workspacePath: "/repo/c", name: "c", workerIds: ["c1"], busyCount: 0, attentionCount: 0, unreadCount: 0 },
  ]);
  assert.equal(studioWorkerId(studios[0], "a2"), "a2");
  assert.equal(studioWorkerId(studios[0], "removed"), "a1");
  assert.equal(studioWorkerId(studios[1], undefined), null);
});

test("limits Focus NPC choices to the selected studio", () => {
  const workers = [
    { id: "a1", workspacePath: "/repo/a" },
    { id: "b1", workspacePath: "/repo/b" },
    { id: "a2", workspacePath: "/repo/a" },
  ];
  assert.deepEqual(focusStudioWorkers(workers, "/repo/a").map((worker) => worker.id), ["a1", "a2"]);
  assert.deepEqual(focusStudioWorkers(workers, "/repo/missing"), []);
});

test("recognizes Alt+1 through Alt+9 only outside editable controls", () => {
  assert.equal(focusStudioShortcut({ key: "1", altKey: true, metaKey: false, ctrlKey: false, shiftKey: false }), 0);
  assert.equal(focusStudioShortcut({ key: "9", altKey: true, metaKey: false, ctrlKey: false, shiftKey: false }), 8);
  assert.equal(focusStudioShortcut({ key: "1", altKey: false, metaKey: false, ctrlKey: false, shiftKey: false }), null);
  assert.equal(focusStudioShortcut({ key: "1", altKey: true, metaKey: true, ctrlKey: false, shiftKey: false }), null);
  assert.equal(focusStudioShortcut({ key: "1", altKey: true, metaKey: false, ctrlKey: false, shiftKey: false }, true), null);
});
