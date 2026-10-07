import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WarroomVerdictBody, warroomActionDelegationText, type WarRoomResult } from "../src/components/WarroomVerdictBody";

const base: WarRoomResult = {
  verdict: "先做 A", consensus: [], disputes: [],
  actions: [{ priority: "P1", title: "加快取", how: "改 server/src/cache.ts" }],
  structured: true,
};

test("old reports without the new fields render as before, with no delegate button", () => {
  const html = renderToStaticMarkup(<WarroomVerdictBody result={base} />);
  assert.match(html, /先做 A/);
  assert.doesNotMatch(html, /warroom-result__confidence|warroom-result__delegate|被否決|推翻/);
});

test("confidence, early consensus, rejected options and flip conditions are shown when present", () => {
  const html = renderToStaticMarkup(<WarroomVerdictBody result={{
    ...base, confidence: "low", earlyConsensus: true,
    rejected: [{ option: "全面重寫", reason: "風險太高" }], flipIf: ["p95 超過 300ms"],
  }} />);
  assert.match(html, /信心 低/);
  assert.match(html, /省略反駁輪/);
  assert.match(html, /全面重寫/);
  assert.match(html, /風險太高/);
  assert.match(html, /p95 超過 300ms/);
});

test("delegate button appears per action when a handler is given, with an optional custom label", () => {
  const html = renderToStaticMarkup(<WarroomVerdictBody result={base} onDelegate={() => true} />);
  assert.match(html, /warroom-result__delegate[^>]*>交給召集人/);
  const labelled = renderToStaticMarkup(<WarroomVerdictBody result={base} onDelegate={() => true} delegateLabel="交給 一號機" />);
  assert.match(labelled, /交給 一號機/);
});

test("delegation text carries topic, priority, title and how, and asks to check before risky changes", () => {
  const text = warroomActionDelegationText("要不要加快取", base.actions[0]);
  assert.match(text, /要不要加快取/);
  assert.match(text, /P1 行動：加快取/);
  assert.match(text, /server\/src\/cache\.ts/);
  assert.match(text, /先跟使用者確認/);
  assert.doesNotMatch(warroomActionDelegationText("", { priority: "P2", title: "x", how: "" }), /建議做法/);
});
