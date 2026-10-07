import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { attentionSummary, holdKeyAction, holdOutcome, HOLD_CONFIRM_MS, logContentCount, shortcutLabel, takeShortcutHint, trackUnseen } from "../src/uxMotion";
import { emptyWorker } from "../src/workerState";
import { ConfirmDialog } from "../src/components/ConfirmDialog";
import { PanelSkeleton } from "../src/components/BuildMoment";
import type { WorkerState } from "../src/types";

function waitingForApproval(worker: WorkerState): WorkerState {
  return {
    ...worker,
    busy: true,
    turns: [{
      key: "t1",
      command: "deploy",
      status: "running",
      items: [{ kind: "approval", key: "a1", status: "pending", request: { id: "r1", title: "rm -rf build" } } as unknown as WorkerState["turns"][number]["items"][number]],
    }],
  };
}

test("the 'needs you' summary counts NPCs waiting for approval and points at the first in crew order", () => {
  const crew = [
    emptyWorker("w1", "小辰", "sonnet", false, 0, "claude", "/repo"),
    waitingForApproval(emptyWorker("w2", "七號機", "sonnet", false, 1, "codex", "/repo")),
    waitingForApproval(emptyWorker("w3", "阿哲", "sonnet", false, 2, "claude", "/repo")),
  ];
  assert.deepEqual(attentionSummary(crew), { count: 2, firstId: "w2", firstName: "七號機" });
  assert.deepEqual(attentionSummary([crew[0]]), { count: 0, firstId: null, firstName: "" });
});

test("unseen log content counts only what arrived after leaving the bottom", () => {
  let state = trackUnseen(null, true, 5);
  assert.deepEqual(state, { baseline: 5, unseen: 0 });
  state = trackUnseen(state, true, 7);
  assert.equal(state.baseline, 7, "貼在底部時基準跟著最新走");
  state = trackUnseen(state, false, 7);
  assert.equal(state.unseen, 0, "剛捲上去還沒有新內容");
  state = trackUnseen(state, false, 10);
  assert.deepEqual(state, { baseline: 7, unseen: 3 });
  assert.deepEqual(trackUnseen(state, false, 2), { baseline: 2, unseen: 0 }, "內容變少（換 NPC）就重新起算");
  assert.deepEqual(trackUnseen(state, true, 10), { baseline: 10, unseen: 0 }, "回到底部歸零");
  assert.equal(logContentCount([{ items: [1] }, { items: [1, 2, 3] }]), 5);
  assert.equal(logContentCount([]), 0);
});

test("shortcut hints map to the real shortcuts and show once per action", () => {
  assert.equal(shortcutLabel("toggle_task_log", true), "⌘ J");
  assert.equal(shortcutLabel("approval", false), "Ctrl ⇧ A");
  assert.equal(shortcutLabel("nope", false), null);
  const seen = new Set<string>();
  assert.equal(takeShortcutHint("toggle_task_log", seen), true);
  assert.equal(takeShortcutHint("toggle_task_log", seen), false, "同一個動作只提示一次");
  assert.equal(takeShortcutHint("approval", seen), true, "不同動作各自算");
  assert.equal(takeShortcutHint("unknown", seen), false);
});

test("hold-to-confirm only confirms after the full hold", () => {
  assert.equal(holdOutcome(HOLD_CONFIRM_MS - 1), "too-short");
  assert.equal(holdOutcome(HOLD_CONFIRM_MS), "confirm");
});

test("holding Enter/Space starts the hold once and swallows key auto-repeat", () => {
  assert.equal(holdKeyAction("Enter", false), "start");
  assert.equal(holdKeyAction(" ", false), "start");
  // 自動重複的 keydown 要擋預設動作（否則每次都對按鈕觸發 click，提早確認），但不重新計時。
  assert.equal(holdKeyAction("Enter", true), "swallow");
  assert.equal(holdKeyAction(" ", true), "swallow");
  assert.equal(holdKeyAction("Tab", false), "ignore");
  assert.equal(holdKeyAction("Escape", true), "ignore");
});

test("danger confirmations become hold-to-confirm; normal ones stay a plain click", () => {
  const danger = renderToStaticMarkup(<ConfirmDialog tone="danger" message="永久移除？" onConfirm={() => {}} onCancel={() => {}} />);
  assert.match(danger, /confirm-dialog__btn--hold/);
  assert.match(danger, /按住確定/);
  assert.match(danger, /aria-describedby="confirm-dialog-hold-hint"/);
  const plain = renderToStaticMarkup(<ConfirmDialog message="繼續？" onConfirm={() => {}} onCancel={() => {}} />);
  assert.doesNotMatch(plain, /confirm-dialog__btn--hold/);
});

test("the lazy panel fallback is an accessible skeleton", () => {
  const html = renderToStaticMarkup(<PanelSkeleton />);
  assert.match(html, /role="status"/);
  assert.equal((html.match(/pc-skel__row/g) ?? []).length, 3);
});
