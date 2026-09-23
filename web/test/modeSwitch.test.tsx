import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModeSwitch, modeIndex } from "../src/components/ModeSwitch";
import { paneAfterSwipe, swipeStep, SWIPE_MIN_DISTANCE, SWIPE_MIN_DISTANCE_CHIP } from "../src/swipeGesture";

/* 工作模式切換在桌面是三顆並排的分段按鈕，在手機收成一顆（左右滑或點開來換）。
   兩種版型都要印在 DOM 裡、由 CSS 決定誰出現——用 JS 判斷螢幕寬度的話，這裡
   （renderToStaticMarkup，沒有 window）就只會看到其中一種，等於測不到另一半。 */

const render = (professional: boolean, black: boolean) =>
  renderToStaticMarkup(<ModeSwitch current={modeIndex(professional, black)} onSelect={() => {}} />);

test("the black window toolbar uses the same control, not its own row of buttons", () => {
  // 兩邊共用同一顆，行為（收合、滑動、選單）只寫一次；外觀由祖先選擇器分開。
  const blackWindow = readFileSync(fileURLToPath(new URL("../src/components/BlackWindowWorkspace.tsx", import.meta.url)), "utf8");
  assert.match(blackWindow, /<ModeSwitch current=\{2\}/);
  assert.doesNotMatch(blackWindow, /black-workspace__modes/);
});

test("both layouts ship in the markup so CSS alone decides which one shows", () => {
  const html = render(false, false);
  assert.match(html, /ui-mode-switch/);
  assert.match(html, /ui-mode-picker/);
  // 桌面三顆 + 手機選單三顆是同一份標籤；目前選到的那個還會多出現在收合把手上。
  for (const label of ["像素", "專業", "黑窗"]) {
    const seen = html.split(`>${label}<`).length - 1;
    assert.equal(seen, label === "像素" ? 3 : 2, `${label} 出現 ${seen} 次`);
  }
});

test("the collapsed handle shows the mode you are actually in", () => {
  const pixel = render(false, false);
  assert.match(pixel, /<summary[^>]*>像素<\/summary>/);
  const pro = render(true, false);
  assert.match(pro, /<summary[^>]*>專業<\/summary>/);
  // 黑窗一開就蓋過專業模式，兩個旗標同時為真時要顯示黑窗。
  const black = render(true, true);
  assert.match(black, /<summary[^>]*>黑窗<\/summary>/);
  assert.equal(modeIndex(true, true), 2);
  assert.equal(modeIndex(true, false), 1);
  assert.equal(modeIndex(false, false), 0);
});

test("the handle names the mode and says it can be swiped", () => {
  // 收合之後畫面上只剩一個標籤，看不出這是一個「可以切換」的控制項——
  // 螢幕閱讀器與長按提示都靠這行字。
  assert.match(render(true, false), /aria-label="工作模式：專業（左右滑動切換）"/);
});

test("the active mode is marked in both layouts, not just the desktop one", () => {
  const html = render(true, false);
  assert.equal(html.split('aria-pressed="true"').length - 1, 2);
});

test("the phone black-window toolbar does not clip the collapsed menu", () => {
  // 那排在 ≤1023 是捲動容器（max-height + overflow-y: auto）。收合選單是從它
  // 底下長出來的絕對定位面板，只要祖先會裁切就整片看不見——實測 details 開著、
  // 選單也有版位，畫面上卻什麼都沒有。手機這排只有一列，不需要捲。
  const css = readFileSync(fileURLToPath(new URL("../src/styles/app-shell-and-focus.css", import.meta.url)), "utf8");
  const phone = css.slice(css.indexOf("@media (max-width: 600px)"));
  const toolbar = phone.slice(phone.indexOf(".black-workspace__toolbar {"));
  assert.match(toolbar.slice(0, toolbar.indexOf("}")), /overflow: visible;/);
});

test("a chip-sized swipe counts at a shorter distance than a full-width one", () => {
  const nudge = { dx: -50, dy: 4, elapsedMs: 180 };
  // 整頁大的目標要 72px，頂欄那顆 100px 的鈕只要 40px——同樣一下滑動，
  // 在黑窗不算換頁，在模式鈕算。
  assert.equal(swipeStep(nudge), 0);
  assert.equal(swipeStep(nudge, SWIPE_MIN_DISTANCE_CHIP), 1);
  assert.ok(SWIPE_MIN_DISTANCE_CHIP < SWIPE_MIN_DISTANCE);
});

test("swiping past either end stays put instead of wrapping", () => {
  // 三個模式，停在兩端：在像素往右滑不會跳到黑窗，在黑窗往左滑也不會回到像素。
  assert.equal(paneAfterSwipe(0, 3, -1), 0);
  assert.equal(paneAfterSwipe(2, 3, 1), 2);
  assert.equal(paneAfterSwipe(0, 3, 1), 1);
  assert.equal(paneAfterSwipe(2, 3, -1), 1);
});
