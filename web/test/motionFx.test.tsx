import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { clickStreak, popOriginFor, tipPlacement, POP_SELECTOR, SPARK_SELECTOR } from "../src/interactionFx";
import { Icon } from "../src/components/Icon";
import { RollingNumber } from "../src/components/RollingNumber";

test("popups grow from the centre of the button that opened them, in the card's own coordinates", () => {
  const trigger = { left: 1200, top: 10, width: 40, height: 20 };
  const card = { left: 400, top: 200, width: 600, height: 400 };
  assert.deepEqual(popOriginFor(trigger, card), { x: 820, y: -180 }, "起點可以在卡片外面（右上方的按鈕）");
  assert.deepEqual(popOriginFor({ left: 500, top: 300, width: 10, height: 10 }, card), { x: 105, y: 105 });
});

test("tooltips sit below the anchor, flip above near the bottom, and stay inside the viewport", () => {
  const viewport = { width: 1000, height: 700 };
  const below = tipPlacement({ left: 100, top: 50, width: 40, height: 30 }, { width: 120, height: 30 }, viewport);
  assert.equal(below.side, "below");
  assert.equal(below.top, 88);
  assert.equal(below.left, 60);
  assert.equal(below.arrowX, 60);
  const above = tipPlacement({ left: 100, top: 660, width: 40, height: 30 }, { width: 120, height: 30 }, viewport);
  assert.equal(above.side, "above");
  assert.equal(above.top, 622);
  const clamped = tipPlacement({ left: 980, top: 50, width: 20, height: 20 }, { width: 200, height: 30 }, viewport);
  assert.equal(clamped.left, 794, "右邊不超出視窗");
  assert.equal(clamped.arrowX, 196, "小三角仍指著按鈕");
  const left = tipPlacement({ left: 0, top: 50, width: 20, height: 20 }, { width: 200, height: 30 }, viewport);
  assert.equal(left.left, 6);
});

test("the logo easter egg needs five quick clicks", () => {
  let times: number[] = [];
  for (const at of [0, 300, 600, 900]) {
    const result = clickStreak(times, at);
    assert.equal(result.fired, false);
    times = result.times;
  }
  const fifth = clickStreak(times, 1200);
  assert.equal(fifth.fired, true);
  assert.deepEqual(fifth.times, [], "觸發後重新計算");
  const slow = [0, 1000, 2000, 3000].reduce((acc, at) => clickStreak(acc, at).times, [] as number[]);
  assert.equal(clickStreak(slow, 4000).fired, false, "點太慢不算");
});

test("selectors cover modal cards, menus and only the primary buttons", () => {
  assert.match(POP_SELECTOR, /\.ui-modal__card/);
  assert.match(POP_SELECTOR, /\.top-bar__more-menu/);
  assert.match(SPARK_SELECTOR, /\.command-composer__submit/);
  assert.doesNotMatch(SPARK_SELECTOR, /crew-strip__chip/, "chip 不炸火花");
});

test("icons expose their name for hover micro-animations and the trash lid is its own group", () => {
  assert.match(renderToStaticMarkup(<Icon name="gear" />), /data-icon="gear"/);
  const trash = renderToStaticMarkup(<Icon name="trash" />);
  assert.match(trash, /<g class="ui-icon__lid">/);
});

test("rolling numbers only bump after the value actually changes", () => {
  assert.doesNotMatch(renderToStaticMarkup(<RollingNumber value={3} />), /data-bump/);
});
