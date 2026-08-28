import assert from "node:assert/strict";
import test from "node:test";
import { stripMarkdown } from "../src/speechText";

test("粗體／斜體／inline code 標記移除", () => {
  assert.equal(stripMarkdown("**重點**與 `code` 和 __加粗__"), "重點與 code 和 加粗");
  assert.equal(stripMarkdown("這是 *強調* 的字"), "這是 強調 的字");
});

test("shell glob 與 dunder 檔名不被當粗體吃掉", () => {
  assert.equal(stripMarkdown("執行指令：ls src/**/*.ts lib/**/*.js"), "執行指令：ls src/**/*.ts lib/**/*.js");
  assert.equal(stripMarkdown("編輯 __init__.py"), "編輯 __init__.py");
});

test("乘號不被當斜體吃掉", () => {
  assert.equal(stripMarkdown("寬 3 * 4 高，共 2*3 格"), "寬 3 * 4 高，共 2*3 格");
});

test("標題／清單／引用轉可讀形式", () => {
  assert.equal(stripMarkdown("## 進度\n- 完成 A\n- 完成 B\n> 備註"), "進度\n• 完成 A\n• 完成 B\n備註");
});

test("連結與圖片只留文字", () => {
  assert.equal(stripMarkdown("看 [文件](https://x.dev) 和 ![截圖](a.png)"), "看 文件 和 截圖");
});

test("code fence 圍欄行拿掉、內容保留；分隔線移除", () => {
  assert.equal(stripMarkdown("```ts\nconst a = 1;\n```\n---\n完成"), "const a = 1;\n\n完成");
});

test("空字串與純空白 → 空字串", () => {
  assert.equal(stripMarkdown(""), "");
  assert.equal(stripMarkdown("  \n "), "");
});
