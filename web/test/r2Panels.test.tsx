import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Skeleton } from "../src/components/Skeleton";
import { KanbanModal } from "../src/components/KanbanModal";
import { DayReportModal } from "../src/components/DayReportModal";
import { OpsModal } from "../src/components/OpsModal";

/* 第二輪 D 面板：骨架載入、日報換日、分頁亮塊、看板 FLIP、新交辦落入。
   SSR 不跑 effect，所以這裡看到的就是「資料還沒回來」的第一幀。 */

test("Skeleton announces loading to screen readers and hides the grey blocks", () => {
  for (const variant of ["lines", "list", "bars", "tiles", "columns"] as const) {
    const html = renderToStaticMarkup(<Skeleton variant={variant} />);
    assert.match(html, /role="status"/);
    assert.match(html, /aria-busy="true"/);
    assert.match(html, /class="r2-sr-only">讀取中…</);
    assert.match(html, /class="r2-skeleton__body" aria-hidden="true"/);
    assert.match(html, new RegExp(`r2-skeleton--${variant}`));
  }
  assert.match(renderToStaticMarkup(<Skeleton label="正在讀取本機指令…" />), /正在讀取本機指令…/);
});

test("Skeleton widths are deterministic so the placeholder never flickers between renders", () => {
  const a = renderToStaticMarkup(<Skeleton variant="list" rows={5} />);
  const b = renderToStaticMarkup(<Skeleton variant="list" rows={5} />);
  assert.equal(a, b);
});

test("Kanban shows a four-column skeleton before missions load instead of a bare loading line", () => {
  const html = renderToStaticMarkup(<KanbanModal workers={[]} onOpenBoss={() => {}} onClose={() => {}} />);
  assert.match(html, /r2-skeleton--columns/);
  assert.doesNotMatch(html, /ops-modal__empty/);
});

test("Day report and ops panels load with skeletons and expose the selected tab", () => {
  const day = renderToStaticMarkup(<DayReportModal notify={() => {}} onClose={() => {}} />);
  assert.match(day, /r2-skeleton--tiles/);
  assert.match(day, /aria-selected="true"[^>]*>報告</);
  assert.match(day, /aria-selected="false"[^>]*>一日回放</);

  const ops = renderToStaticMarkup(<OpsModal workers={[]} notify={() => {}} onClose={() => {}} />);
  assert.match(ops, /r2-skeleton--bars/);
});

test("r2 panel motion respects prefers-reduced-motion and stays on translate/opacity", () => {
  const css = readFileSync(fileURLToPath(new URL("../src/styles/r2-modals.css", import.meta.url)), "utf8");
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.ok(reduced.length > 0);
  for (const keyframes of ["r2-day-in-next", "r2-day-in-prev", "r2-drop-in"]) {
    assert.match(reduced, new RegExp(`@keyframes ${keyframes} \\{ from \\{ opacity: 0; \\}`));
  }
  assert.match(reduced, /\.r2-skeleton__line \{ animation: none;/);
  assert.match(reduced, /\.r2-tab-ink \{ transition: none; \}/);
  assert.doesNotMatch(css, /transform\s*:/, "independent translate only — transform would clobber positioning");
  assert.doesNotMatch(css, /box-shadow:\s*0 0 \d+px/, "no glow halos");
});
