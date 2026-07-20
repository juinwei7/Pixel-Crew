import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { extractMarkdownHeadings, RichText } from "../src/components/RichText.js";

test("renders GFM Markdown and safe inline HTML", () => {
  const html = renderToStaticMarkup(
    <RichText text={'# 標題\n\n- [x] done\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n<strong>HTML</strong>'} />,
  );
  assert.match(html, /<h1>標題<\/h1>/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /<table>/);
  assert.match(html, /<strong>HTML<\/strong>/);
});

test("removes executable HTML, event handlers, and dangerous URLs", () => {
  const html = renderToStaticMarkup(
    <RichText text={'<script>alert(1)</script><img src="x" onerror="alert(2)"><a href="javascript:alert(3)">bad</a>'} />,
  );
  assert.doesNotMatch(html, /<script|onerror|javascript:/i);
  assert.doesNotMatch(html, /alert\([123]\)/);
});

test("adds safe attributes to external links", () => {
  const html = renderToStaticMarkup(<RichText text="[OpenAI](https://openai.com)" />);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test("adds a dedicated copy action to fenced code blocks", () => {
  const html = renderToStaticMarkup(<RichText text={'```ts\nconst answer = 42;\n```'} />);
  assert.match(html, /aria-label="複製程式碼"/);
  assert.match(html, /const answer = 42/);
});

test("builds stable report anchors and highlights visible search text", () => {
  const text = "# 結論\n\n需要修復付款流程。\n\n## 風險\n\n付款可能失敗。";
  assert.deepEqual(extractMarkdownHeadings(text, "report"), [
    { id: "report-heading-結論-1", level: 1, label: "結論" },
    { id: "report-heading-風險-1", level: 2, label: "風險" },
  ]);
  const html = renderToStaticMarkup(<RichText text={text} headingPrefix="report" highlight="付款" />);
  assert.match(html, /id="report-heading-結論-1"/);
  assert.match(html, /id="report-heading-風險-1"/);
  assert.equal((html.match(/class="search-highlight"/g) ?? []).length, 2);
});

test("report outline supports setext headings and ignores fenced code comments", () => {
  const headings = extractMarkdownHeadings("摘要\n====\n\n```sh\n# 不是標題\n```\n\n風險\n----", "report");
  assert.deepEqual(headings, [
    { id: "report-heading-摘要-1", level: 1, label: "摘要" },
    { id: "report-heading-風險-1", level: 2, label: "風險" },
  ]);
});
