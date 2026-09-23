import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PHONE_MAX_WIDTH } from "../src/hooks/useIsPhone";

const stylesDir = fileURLToPath(new URL("../src/styles/", import.meta.url));
const sheets = readdirSync(stylesDir)
  .filter((name) => name.endsWith(".css"))
  .map((name) => ({ name, source: readFileSync(stylesDir + name, "utf8") }));

/* 手機級斷點只准這三個值。1024px 以上是桌面密度斷點，不歸這層管。 */
const PHONE_MAX = 600;
const TABLET_MIN = 601;
const TABLET_MAX = 1023;
const SHORT_MAX = 500;
const DESKTOP_FLOOR = 1024;

type Line = { sheet: string; line: number; text: string };

/* 註解裡提到 .ui-modal / 44px 是說明，不是規則。比對前先把註解拿掉。 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
}

function eachLine(visit: (line: Line) => void, skip?: (name: string) => boolean) {
  for (const { name, source } of sheets) {
    if (skip?.(name)) continue;
    source.split("\n").forEach((text, index) => visit({ sheet: name, line: index + 1, text }));
  }
}

/* 手機規則集中在 phone 斷點裡。判斷某一行「屬於手機段落」用的是括號計數，
   夠準也夠便宜——這些 stylesheet 裡沒有巢狀 @media。 */
function phoneBlocks(source: string): Array<{ line: number; text: string }> {
  const lines = withoutComments(source).split("\n");
  const inside: Array<{ line: number; text: string }> = [];
  let depth = 0;
  let active = false;
  lines.forEach((text, index) => {
    if (!active && /@media[^{]*max-width:\s*600px/.test(text)) {
      active = true;
      depth = 0;
    }
    if (active) {
      if (depth > 0) inside.push({ line: index + 1, text });
      depth += (text.match(/\{/g) ?? []).length - (text.match(/\}/g) ?? []).length;
      if (depth <= 0) active = false;
    }
  });
  return inside;
}

test("stylesheets only use the three canonical mobile breakpoints", () => {
  const offenders: string[] = [];
  eachLine(({ sheet, line, text }) => {
    // @container 量的是元素自己的寬度，不是視窗，本來就不該被綁在視窗斷點上。
    if (text.includes("@container")) return;
    for (const match of text.matchAll(/\((max|min)-(width|height):\s*(\d+)px\)/g)) {
      const [, bound, axis, raw] = match;
      const px = Number(raw);
      if (axis === "height") {
        if (px !== SHORT_MAX) offenders.push(`${sheet}:${line} ${bound}-height: ${px}px`);
        continue;
      }
      if (px >= DESKTOP_FLOOR) continue;
      const allowed = bound === "max" ? px === PHONE_MAX || px === TABLET_MAX : px === TABLET_MIN;
      if (!allowed) offenders.push(`${sheet}:${line} ${bound}-width: ${px}px`);
    }
  });
  assert.deepEqual(offenders, [], `非標準斷點（只准 ${PHONE_MAX}/${TABLET_MIN}/${TABLET_MAX}/height ${SHORT_MAX}）:\n${offenders.join("\n")}`);
});

test("safe-area insets are read through the shared tokens, not raw env()", () => {
  const offenders: string[] = [];
  eachLine(({ sheet, line, text }) => {
    if (text.includes("env(safe-area-inset")) offenders.push(`${sheet}:${line}`);
  }, (name) => name === "responsive.css");
  assert.deepEqual(offenders, [], `改用 var(--safe-t/-r/-b/-l):\n${offenders.join("\n")}`);
});

test("full viewport height is read through --vh, not raw 100vh/100dvh", () => {
  // 100vh 在 iOS Safari 量到的是「網址列收起後」的高度，面板會被切掉一截；
  // --vh 在支援 dvh 的瀏覽器上自動換成 100dvh。比例值（62dvh…）不在此限。
  const offenders: string[] = [];
  eachLine(({ sheet, line, text }) => {
    if (/\b100d?vh\b/.test(text)) offenders.push(`${sheet}:${line}`);
  }, (name) => name === "responsive.css");
  assert.deepEqual(offenders, [], `改用 var(--vh):\n${offenders.join("\n")}`);
});

test("phone tap targets come from --tap instead of repeated 44px literals", () => {
  // 以前每個 modal / 每條工具列都自己寫一次 min-height: 44px（超過 100 次）。
  // 現在點擊目標只有一個來源：responsive.css 的 --tap。
  const offenders: string[] = [];
  for (const { name, source } of sheets) {
    if (name === "responsive.css") continue;
    for (const { line, text } of phoneBlocks(source)) {
      if (/min-(height|width):\s*44px/.test(text)) offenders.push(`${name}:${line}`);
    }
  }
  assert.deepEqual(offenders, [], `改用 var(--tap):\n${offenders.join("\n")}`);
});

test("phone input sizing comes from --fs-input instead of repeated 16px literals", () => {
  // <16px 的輸入框會讓 iOS 放大整頁且縮不回來。同樣只留一個來源。
  const offenders: string[] = [];
  for (const { name, source } of sheets) {
    if (name === "responsive.css") continue;
    for (const { line, text } of phoneBlocks(source)) {
      // 只管可輸入元素——標題寫 16px 是排版，不是 iOS 放大的成因。
      if (/font-size:\s*16px/.test(text) && /\b(input|select|textarea)\b/.test(text)) offenders.push(`${name}:${line}`);
    }
  }
  assert.deepEqual(offenders, [], `改用 var(--fs-input):\n${offenders.join("\n")}`);
});

test("the shared dialog shell is defined once, in responsive.css", () => {
  // Modal.tsx 一律吐出 ui-modal / ui-modal__card / ui-modal__close。版型只准
  // 在 responsive.css 定義，否則又會退回「每個 modal 自己寫一套殼」。
  const shell = sheets.find((sheet) => sheet.name === "responsive.css");
  assert.ok(shell, "responsive.css 不見了");
  for (const selector of [".ui-modal", ".ui-modal__card", ".ui-modal__close", ".ui-modal--full", ".ui-modal--center"]) {
    assert.match(shell.source, new RegExp(`\\${selector}\\b`), `responsive.css 少了 ${selector}`);
  }
  const strays = sheets
    .filter((sheet) => sheet.name !== "responsive.css" && withoutComments(sheet.source).includes(".ui-modal"))
    .map((sheet) => sheet.name);
  assert.deepEqual(strays, [], `ui-modal 的樣式只該寫在 responsive.css：${strays.join(", ")}`);
});

test("the JS phone breakpoint is the same number as the CSS one", () => {
  // 有些控制項要換 DOM 位置（黑窗把用量/帳號搬進 ⋯），只能用 JS 判斷斷點。
  // 兩邊各寫一個 600 遲早會走鐘，這裡把它們綁在一起。
  assert.equal(PHONE_MAX_WIDTH, PHONE_MAX);
});

test("the viewport meta opts into the safe area", () => {
  const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
  // 沒有 viewport-fit=cover，env(safe-area-inset-*) 在 iOS 上一律是 0，
  // 所有瀏海/home indicator 的閃避都會靜默失效。
  assert.match(html, /viewport-fit=cover/);
});

test("the shared layer's :has() rules can never beat a component's own", () => {
  // :has() 會把參數的權重一起算進去：button:has(> .ui-icon) 是 (0,1,1)，壓過
  // .top-bar__capability { display: none } 的 (0,1,0)，該收起來的按鈕就會莫名
  // 其妙冒出來。共用層要用 :has()，整條就得包進 :where() 把權重歸零——它只是
  // 「沒人管時的預設值」，任何元件自己的規則都要贏過它。
  const shell = sheets.find((sheet) => sheet.name === "responsive.css");
  assert.ok(shell);
  const rules = shell.source.replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = (rules.match(/[^{};]*:has\([^{]*\{/g) ?? []).map((text) => text.replace(/\{$/, "").trim());
  assert.ok(selectors.length > 0, "找不到 :has() 規則，這個測試的前提變了");
  for (const selector of selectors) {
    assert.ok(selector.startsWith(":where("), `:has() 沒包在 :where() 裡：${selector}`);
  }
});
