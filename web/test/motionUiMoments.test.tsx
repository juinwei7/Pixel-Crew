import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createConnectionWatch, type ConnectionPhase, type ConnectionTimers } from "../src/connectionWatch";
import { ConnectionBanner } from "../src/components/ConnectionBanner";
import { BuildDone, PixelBuild } from "../src/components/BuildMoment";
import { CopyButton } from "../src/components/CopyButton";
import { RemoteSteps } from "../src/components/RemoteAccessModal";
import { OutboxList, isFreshOutboxItem } from "../src/components/OutboxModal";

// 手動推進的假時鐘：advance(ms) 依時間順序觸發到期的計時器。
function fakeClock() {
  let now = 1_000;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: ConnectionTimers = {
    set(fn, ms) { const id = ++seq; pending.set(id, { at: now + ms, fn }); return id; },
    clear(handle) { pending.delete(handle as number); },
    now: () => now,
  };
  function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      const next = [...pending.entries()].filter(([, entry]) => entry.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      pending.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = end;
  }
  return { timers, advance, now: () => now };
}

function watch() {
  const clock = fakeClock();
  const phases: Array<[ConnectionPhase, number]> = [];
  const fx: string[] = [];
  const w = createConnectionWatch({
    timers: clock.timers,
    onPhase: (phase, since) => phases.push([phase, since]),
    onFx: (state) => fx.push(state),
  });
  return { clock, phases, fx, w };
}

test("connection blips shorter than the debounce never show anything", () => {
  const { clock, phases, fx, w } = watch();
  w.update(true);
  w.update(false);
  clock.advance(1_400);
  w.update(true);
  clock.advance(5_000);
  assert.deepEqual(phases, []);
  assert.deepEqual(fx, []);
  assert.equal(w.phase, "online");
});

test("the very first connect at page load is silent", () => {
  const { clock, phases, fx, w } = watch();
  w.update(false);
  clock.advance(300);
  w.update(true);
  clock.advance(3_000);
  assert.deepEqual(phases, []);
  assert.deepEqual(fx, []);
});

test("a real drop goes down after the debounce, counts from the drop, then flashes back and settles", () => {
  const { clock, phases, fx, w } = watch();
  w.update(true);
  clock.advance(500);
  const droppedAt = clock.now();
  w.update(false);
  clock.advance(1_499);
  assert.deepEqual(phases, []);
  clock.advance(1);
  assert.deepEqual(phases, [["down", droppedAt]], "since＝實際斷線的時間，不是 debounce 結束");
  assert.deepEqual(fx, ["down"]);
  clock.advance(8_000);
  w.update(true);
  assert.equal(w.phase, "back");
  assert.deepEqual(fx, ["down", "up"]);
  clock.advance(1_599);
  assert.equal(w.phase, "back");
  clock.advance(1);
  assert.equal(w.phase, "online");
  assert.deepEqual(phases.map(([phase]) => phase), ["down", "back", "online"]);
});

test("dropping again while showing 'back' returns straight to down without waiting", () => {
  const { clock, phases, fx, w } = watch();
  w.update(true);
  w.update(false);
  clock.advance(2_000);
  w.update(true);
  clock.advance(300);
  w.update(false);
  assert.equal(w.phase, "down");
  assert.deepEqual(fx, ["down", "up", "down"]);
  clock.advance(5_000);
  assert.equal(w.phase, "down", "原本「已回來」的收尾計時器要被取消");
  assert.deepEqual(phases.map(([phase]) => phase), ["down", "back", "down"]);
});

test("repeated identical readings and dispose are harmless", () => {
  const { clock, phases, w } = watch();
  w.update(true);
  w.update(true);
  w.update(false);
  w.update(false);
  w.dispose();
  clock.advance(10_000);
  assert.deepEqual(phases, []);
});

test("the connection banner renders nothing while online", () => {
  assert.equal(renderToStaticMarkup(<ConnectionBanner ready reason="blip" />), "");
  assert.equal(renderToStaticMarkup(<ConnectionBanner ready={false} reason="restart" />), "", "debounce 之前也不畫");
});

test("build moments expose a status for assistive tech and keep copy text", () => {
  const loader = renderToStaticMarkup(<PixelBuild label="建造工位中…" />);
  assert.match(loader, /role="status"/);
  assert.match(loader, /建造工位中…/);
  const done = renderToStaticMarkup(<BuildDone title="工位已就緒" />);
  assert.match(done, /aria-live="polite"/);
  assert.match(done, /工位已就緒/);
  assert.match(done, /新隊員正走進辦公室/);
});

test("copy button starts in its label state", () => {
  const html = renderToStaticMarkup(<CopyButton text="https://example.test" />);
  assert.match(html, /class="pc-copy"/);
  assert.match(html, /複製/);
  assert.doesNotMatch(html, /data-copied/);
});

test("remote steps mark finished steps and the current one", () => {
  const html = renderToStaticMarkup(<RemoteSteps steps={[
    { label: "啟動轉接站", done: true },
    { label: "設定通行碼", done: false },
    { label: "開通對外通道", done: false },
  ]} />);
  assert.equal((html.match(/data-done="true"/g) ?? []).length, 1);
  assert.equal((html.match(/data-current="true"/g) ?? []).length, 1);
  assert.match(html, /remote-steps__check/);
  assert.match(html, /2\.<\/span> 設定通行碼/);
});

test("outbox shows a skeleton while loading and flags fresh deliverables", () => {
  assert.match(renderToStaticMarkup(<OutboxList items={null} />), /pc-skel__row/);
  assert.match(renderToStaticMarkup(<OutboxList items={[]} />), /pc-empty/);
  const now = Date.now();
  assert.equal(isFreshOutboxItem(now - 60_000, now), true);
  assert.equal(isFreshOutboxItem(now - 16 * 60_000, now), false);
  assert.equal(isFreshOutboxItem(now + 60_000, now), false, "時鐘不準的未來時間不算新");
  const html = renderToStaticMarkup(<OutboxList items={[
    { workerId: "w", owners: "小貝", name: "a.md", size: 10, mtime: now - 1_000 },
    { workerId: "w", owners: "小貝", name: "b.md", size: 10, mtime: now - 3_600_000 },
  ]} />);
  assert.equal((html.match(/data-fresh="true"/g) ?? []).length, 1);
  assert.equal((html.match(/>NEW</g) ?? []).length, 1);
});
