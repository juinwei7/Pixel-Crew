import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CrewChips } from "../src/components/CrewChips";
import { emptyWorker } from "../src/workerState";

/* 換 NPC 這件事在手機上只有一種長相：一排橫向 chip。像素模式的隊員列與
   專業模式的報告標題列共用同一個元件——以前專業模式是 <select>，看不出
   「現在有誰、誰在等你」，同一件事在兩個模式長得完全不一樣。 */

const crew = [
  emptyWorker("w1", "小辰", "sonnet", false, 0, "claude", "/repo/a"),
  emptyWorker("w2", "七號機", "sonnet", false, 1, "codex", "/repo/a"),
];

test("a chip per NPC, with the current one marked for assistive tech too", () => {
  const html = renderToStaticMarkup(<CrewChips workers={crew} activeId="w2" onSelect={() => {}} />);
  assert.equal(html.split("crew-strip__chip").length - 1, 2 + 1); // 兩顆 chip，其中一顆多一個 --active
  assert.match(html, /aria-selected="true"[^>]*class="crew-strip__chip crew-strip__chip--active"|class="crew-strip__chip crew-strip__chip--active"/);
  assert.match(html, /小辰/);
  assert.match(html, /七號機/);
  // role="tablist" + role="tab"：這排就是分頁列，讀螢幕的人要聽得出來。
  assert.match(html, /role="tablist"/);
  assert.equal(html.split('role="tab"').length - 1, 2);
});

test("unread is a marker on the chip, not something only the label can carry", () => {
  // 下拉選單時代的未讀是在文字前面加「● 」。chip 沒有那個位置，所以要有自己的標記。
  const html = renderToStaticMarkup(
    <CrewChips workers={crew} activeId="w1" unread={(worker) => worker.id === "w2"} onSelect={() => {}} />,
  );
  assert.match(html, /crew-strip__chip--unread/);
  assert.equal(html.split("crew-strip__chip--unread").length - 1, 1);
});

test("both phone surfaces go through the shared component", () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
  const tabs = read("../src/components/WorkerTabs.tsx");
  const app = read("../src/App.tsx");
  // 隊員列不再自己手刻一份 chip。
  assert.match(tabs, /<CrewChips workers=\{renderOrder\}/);
  assert.doesNotMatch(tabs, /className=\{`crew-strip__chip/);
  // 專業模式：手機用 chip，桌面維持下拉（橫向空間有限，滑鼠也不需要 44px 目標）。
  assert.match(app, /focusPhone \? <div className="focus-worker-switch focus-worker-switch--chips">/);
  assert.match(app, /<select aria-label=\{t\("切換專業模式的 NPC 工作介面"\)\}/);
});
