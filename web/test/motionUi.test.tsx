import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { paletteMatch, parseMention, CommandPalette } from "../src/components/CommandPalette";
import { mergeToastList } from "../src/components/ToastRegion";
import { diffDeliverables } from "../src/hooks/useDeliverableWatch";
import { RollingNumber } from "../src/components/RollingNumber";
import { TaskComposer } from "../src/components/TaskComposer";

test("palette matching prefers contiguous, early hits and falls back to subsequences", () => {
  assert.deepEqual(paletteMatch("", "任何東西"), { score: 0, hits: [] });
  const exact = paletteMatch("報告", "今日報告")!;
  assert.deepEqual(exact.hits, [2, 3]);
  const sub = paletteMatch("今告", "今日報告")!;
  assert.deepEqual(sub.hits, [0, 3]);
  assert.ok(exact.score > sub.score, "連續命中要排在跳字命中前面");
  assert.equal(paletteMatch("xyz", "今日報告"), null);
  assert.ok(paletteMatch("qa", "QA工程師")!.score > paletteMatch("qa", "前端 QA")!.score, "越前面越高分");
});

test("@mention parses the target fragment and the text to prefill", () => {
  assert.deepEqual(parseMention("@貝 整理今天的成品"), { who: "貝", text: "整理今天的成品" });
  assert.deepEqual(parseMention("@"), { who: "", text: "" });
  assert.equal(parseMention("整理 @貝"), null);
});

test("the palette renders as a shared-shell dialog with a combobox and no submit control", () => {
  const html = renderToStaticMarkup(<CommandPalette
    entries={[{ id: "a", group: "工具", label: "成品匣", icon: "box", run: () => {} }]}
    workers={[]}
    activeWorker={{ id: "w", name: "小助手" }}
    onComposeTo={() => {}}
    onClose={() => {}}
  />);
  assert.match(html, /class="ui-modal pc-palette"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /role="combobox"/);
  assert.match(html, /成品匣/);
  assert.doesNotMatch(html, /type="submit"/);
});

test("toasts that the parent removed stay in place, marked as leaving", () => {
  const a = { id: "a", message: "A" };
  const b = { id: "b", message: "B" };
  const c = { id: "c", message: "C" };
  const merged = mergeToastList([{ toast: a, leaving: false }, { toast: b, leaving: false }], [b, c]);
  assert.deepEqual(merged.map((entry) => [entry.toast.id, entry.leaving]), [["a", true], ["b", false], ["c", false]]);
});

test("new outbox files are credited to the NPC that just finished in the same workspace", () => {
  const workspace: Record<string, string> = { lead: "/repo", helper: "/repo", other: "/elsewhere" };
  const fresh = diffDeliverables(
    new Set(["lead/old.md"]),
    [{ workerId: "lead", name: "old.md", mtime: 1 }, { workerId: "lead", name: "report.pdf", mtime: 2 }],
    ["other", "helper"],
    (id) => workspace[id],
  );
  assert.deepEqual(fresh, [{ workerId: "helper", name: "report.pdf" }]);
});

test("a rolling number renders its value without animating on first paint", () => {
  const html = renderToStaticMarkup(<RollingNumber value={3} />);
  assert.match(html, /class="pc-roll"/);
  assert.match(html, />3</);
  assert.doesNotMatch(html, /pc-roll__in|pc-roll__out/);
});

test("the dock submit button keeps its label accessible and carries the launch visuals", () => {
  const html = renderToStaticMarkup(<TaskComposer
    draftKey="w:claude:/repo"
    placeholder="對 小助手 下指令"
    submitLabel="執行"
    layout="dock"
    launchTarget={{ id: "w", name: "小助手" }}
    onSubmit={async () => null}
  />);
  assert.match(html, /command-composer__submit-label">執行</);
  assert.match(html, /command-composer__submit-fx" aria-hidden="true"/);
  assert.match(html, /command-composer__submit-ok" aria-hidden="true"/);
  // 還沒送出：沒有回執、沒有動畫狀態、沒有忙碌光條。
  assert.doesNotMatch(html, /command-composer__receipt/);
  assert.doesNotMatch(html, /data-launch=/);
  assert.doesNotMatch(html, /data-busy=/);
});
