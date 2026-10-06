import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GameCanvas } from "../src/components/GameCanvas";
import { emptyWorker } from "../src/workerState";
import type { Turn, WorkerState } from "../src/types";

function finished(worker: WorkerState, command: string, minutesAgo: number): WorkerState {
  const turn: Turn = { key: "t1", command, status: "done", items: [{ kind: "assistant_text", key: "a", text: "好了" }] };
  return { ...worker, turns: [turn], character: { ...worker.character, speechAt: Date.now() - minutesAgo * 60_000 } };
}

test("an idle NPC's nameplate shows when it last finished and what, as a quiet second line", () => {
  const idle = finished(emptyWorker("w1", "小助手", null, false, 0, "claude", "/repo"), "寫完 README", 12);
  const html = renderToStaticMarkup(<GameCanvas workers={[idle]} activeId={null} onSelect={() => {}} />);
  assert.match(html, /npc-nameplate__done[^>]*>12 分前・寫完 README</);
});

test("a busy NPC keeps the activity badge instead of the finished line", () => {
  const base = finished(emptyWorker("w1", "小助手", null, false, 0, "claude", "/repo"), "寫完 README", 12);
  const busy: WorkerState = { ...base, busy: true, character: { ...base.character, activity: "working", station: "code" } };
  const html = renderToStaticMarkup(<GameCanvas workers={[busy]} activeId={null} onSelect={() => {}} />);
  assert.doesNotMatch(html, /npc-nameplate__done/);
  assert.match(html, /npc-nameplate__activity/);
});

test("a camera focus request renders safely before the scene is wired (no follow tag, no markers yet)", () => {
  const worker = emptyWorker("w1", "小助手", null, false, 0, "claude", "/repo");
  const html = renderToStaticMarkup(
    <GameCanvas workers={[worker]} activeId="w1" onSelect={() => {}} focusRequest={{ id: "w1", seq: 3 }} />,
  );
  assert.doesNotMatch(html, /npc-aggbar__seg--follow/);
  assert.doesNotMatch(html, /npc-edge-marker/);
  assert.doesNotMatch(html, /npc-focus-ring/);
});
