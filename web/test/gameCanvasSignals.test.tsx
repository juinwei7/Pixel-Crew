import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GameCanvas } from "../src/components/GameCanvas";
import { emptyWorker } from "../src/workerState";
import type { Turn, WorkerState } from "../src/types";

function failedWorker(id: string): WorkerState {
  const turn: Turn = { key: `${id}-t1`, command: "跑測試", status: "error", items: [{ kind: "system_error", key: "e", text: "boom" }] };
  return { ...emptyWorker(id, id === "w1" ? "小助手" : "二號", null, false, 0, "claude", "/repo"), turns: [turn] };
}

test("a failed, unseen NPC gets a red mark on its nameplate", () => {
  const html = renderToStaticMarkup(
    <GameCanvas workers={[failedWorker("w1"), failedWorker("w2")]} activeId="w2" onSelect={() => {}} />,
  );
  // w1 失敗且沒被選取 → 一個紅點；w2 正被選取（畫面正對著他）→ 不標。
  assert.equal(html.match(/npc-nameplate__failed/g)?.length, 1);
  assert.equal(html.match(/npc-nameplate--failed/g)?.length, 1);
  assert.match(html, /上一回合失敗/);
});

test("selecting the failed NPC clears its mark", () => {
  const html = renderToStaticMarkup(
    <GameCanvas workers={[failedWorker("w1")]} activeId="w1" onSelect={() => {}} />,
  );
  assert.doesNotMatch(html, /npc-nameplate__failed/);
});
