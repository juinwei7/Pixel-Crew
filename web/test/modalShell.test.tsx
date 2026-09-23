import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Modal, modalShellClass } from "../src/components/Modal";

/* Modal 是全 app 唯一的 dialog 殼。它吐出的 ui-modal / ui-modal__card /
   ui-modal__close 就是 styles/responsive.css 手機版型唯一的掛鉤——少了任何
   一層，那個 modal 在手機就會退回桌面尺寸（卡片超出視窗、按鈕 28px、輸入框
   一點就整頁放大）。 */

test("every modal carries the shared shell classes on top of its own", () => {
  const html = renderToStaticMarkup(
    <Modal label="t" overlayClassName="mcp-modal" cardClassName="mcp-modal__card" closeClassName="mcp-modal__close" onClose={() => {}}>
      <p>body</p>
    </Modal>,
  );
  assert.match(html, /class="ui-modal mcp-modal"/);
  assert.match(html, /class="ui-modal__card mcp-modal__card"/);
  assert.match(html, /class="ui-modal__close mcp-modal__close"/);
});

test("the default shell is a bottom sheet and the variants are opt-in", () => {
  assert.equal(modalShellClass(), "ui-modal");
  assert.equal(modalShellClass("sheet"), "ui-modal");
  assert.equal(modalShellClass("full"), "ui-modal ui-modal--full");
  assert.equal(modalShellClass("center"), "ui-modal ui-modal--center");

  const full = renderToStaticMarkup(
    <Modal label="t" overlayClassName="command-center" cardClassName="command-center__shell" variant="full" hideClose onClose={() => {}}>
      <p>body</p>
    </Modal>,
  );
  assert.match(full, /class="ui-modal ui-modal--full command-center"/);
  // hideClose 的 modal 不該留下空的關閉鈕。
  assert.doesNotMatch(full, /ui-modal__close/);
});

test("overlays that do not go through Modal still opt into the shared shell", () => {
  // 這三個自己組 overlay（有拖放、有 alertdialog、有 focus gate 的特殊需求），
  // 但版型必須跟其他 modal 一致，否則手機上又會各長各的。
  const componentsDir = fileURLToPath(new URL("../src/components/", import.meta.url));
  const expected: Array<[string, RegExp]> = [
    ["AvatarWorkshop.tsx", /ui-modal ui-modal--full avatar-workshop/],
    ["AuthGate.tsx", /ui-modal ui-modal--center auth-gate/],
    ["AuthGate.tsx", /ui-modal auth-install-confirm/],
  ];
  for (const [file, pattern] of expected) {
    assert.match(readFileSync(componentsDir + file, "utf8"), pattern, `${file} 少了共用殼`);
  }
});

test("no component hand-rolls a modal overlay outside the shared shell", () => {
  // aria-modal="true" 就是「擋住整頁的 overlay」的標記，這種一律要有共用殼
  // （Modal 會自動加，自己組 overlay 的要手動掛）。沒有 aria-modal 的
  // role="dialog"（語音面板、導覽貓、部門重開確認）是就地的小面板，不算。
  const componentsDir = fileURLToPath(new URL("../src/components/", import.meta.url));
  const sources: Array<[string, string]> = readdirSync(componentsDir)
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => [name, readFileSync(componentsDir + name, "utf8")]);
  sources.push(["App.tsx", readFileSync(fileURLToPath(new URL("../src/App.tsx", import.meta.url)), "utf8")]);
  const offenders: string[] = [];
  for (const [name, source] of sources) {
    if (name === "Modal.tsx") continue;
    for (const match of source.matchAll(/<div[^>]*aria-modal="true"[^>]*>/g)) {
      if (!match[0].includes("ui-modal")) offenders.push(`${name}: ${match[0].slice(0, 70)}`);
    }
  }
  assert.deepEqual(offenders, [], `改用 <Modal> 或掛上 ui-modal：\n${offenders.join("\n")}`);
});
