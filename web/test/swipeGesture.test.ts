import assert from "node:assert/strict";
import test from "node:test";
import { paneAfterSwipe, swipeStep, SWIPE_MIN_DISTANCE, SWIPE_MAX_MS } from "../src/swipeGesture";

test("a decisive horizontal flick switches pane", () => {
  assert.equal(swipeStep({ dx: -120, dy: 10, elapsedMs: 180 }), 1);  // 左滑 → 下一個
  assert.equal(swipeStep({ dx: 120, dy: -8, elapsedMs: 180 }), -1);  // 右滑 → 上一個
});

test("scrolling the terminal never counts as a swipe", () => {
  // 捲 scrollback：垂直為主，就算帶一點水平位移也不算。
  assert.equal(swipeStep({ dx: -80, dy: 200, elapsedMs: 200 }), 0);
  assert.equal(swipeStep({ dx: 90, dy: 60, elapsedMs: 200 }), 0); // 水平沒到垂直的兩倍
});

test("slow drags and small jitters never count", () => {
  // 在終端機裡選字是慢動作。
  assert.equal(swipeStep({ dx: -300, dy: 0, elapsedMs: SWIPE_MAX_MS + 1 }), 0);
  // 手指輕碰的微抖。
  assert.equal(swipeStep({ dx: -(SWIPE_MIN_DISTANCE - 1), dy: 0, elapsedMs: 120 }), 0);
  assert.equal(swipeStep({ dx: Number.NaN, dy: 0, elapsedMs: 120 }), 0);
});

test("paging stops at both ends instead of wrapping", () => {
  // 走到最後再往後滑維持原樣：突然跳回第一個會讓人以為滑錯方向。
  assert.equal(paneAfterSwipe(0, 3, -1), 0);
  assert.equal(paneAfterSwipe(2, 3, 1), 2);
  assert.equal(paneAfterSwipe(1, 3, 1), 2);
  assert.equal(paneAfterSwipe(1, 3, -1), 0);
});

test("a single pane or an unknown selection never moves", () => {
  assert.equal(paneAfterSwipe(0, 1, 1), 0);
  assert.equal(paneAfterSwipe(-1, 3, 1), -1);
  assert.equal(paneAfterSwipe(1, 3, 0), 1);
});
