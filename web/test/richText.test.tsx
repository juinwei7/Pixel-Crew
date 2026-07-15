import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RichText } from "../src/components/RichText.js";

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
