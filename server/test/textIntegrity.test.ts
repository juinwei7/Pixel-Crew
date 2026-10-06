import assert from "node:assert/strict";
import test from "node:test";
import { detectGarbledText, garbledTextError } from "../src/textIntegrity.js";

// 伺服器實際看到的樣子：ANSI 代碼頁位元組被當 UTF-8 解。
const asUtf8 = (hex: string) => Buffer.from(hex, "hex").toString("utf8");

test("detectGarbledText：實測重現的 Git Bash curl 亂碼（CP936）會被擋", () => {
  // `curl -d "{\"note\":\"使用者偏好繁體中文，喜歡咖啡☕ 測試\"}"` 實際送出的 note 位元組
  const cp936 = asUtf8("cab9d3c3d5dfc6abbac3b7b1f377d6d0cec4a3accfb29a67bfa7b7c83f209c79d487");
  assert.equal(detectGarbledText(cp936), "replacement-char");
  assert.equal(detectGarbledText(asUtf8("d39b919b8179b4619c79d48720616263")), "replacement-char");
});

test("detectGarbledText：CP950（繁中 Windows）位元組被當 UTF-8 解也會被擋", () => {
  assert.ok(detectGarbledText(asUtf8("a8cfa5ceaaccb0bea66ec163c5e9a4a4a4e5")));
  assert.ok(detectGarbledText(asUtf8("b14daed7a5ce20706e706d")));
});

test("detectGarbledText：整串中文被換成問號", () => {
  assert.equal(detectGarbledText("?????????"), "question-marks");
  assert.equal(detectGarbledText("???? pnpm"), "question-marks");
  assert.equal(detectGarbledText("?? ?? ????"), "question-marks");
});

test("detectGarbledText：UTF-8 被當 latin1/cp1252 解的 mojibake", () => {
  const latin1 = Buffer.from("使用者偏好深色主題", "utf8").toString("latin1");
  assert.equal(detectGarbledText(latin1), "utf8-as-latin1");
  assert.equal(detectGarbledText("ä½¿ç”¨è€…åå¥½"), "utf8-as-latin1");
});

test("detectGarbledText：短串雙位元組剛好拼成合法 UTF-8 的雜字（跨三個以上文字區塊）", () => {
  assert.equal(detectGarbledText("ʹӛԇ֒"), "mixed-scripts");
});

test("detectGarbledText：正常中英文、emoji、標點、單一或少量問號不誤殺", () => {
  const ok = [
    "",
    "使用者偏好繁體中文，喜歡咖啡☕",
    "專案用 pnpm，Node >= 22.13.0",
    "使用者的貓叫「小花」😺🐱 👨‍👩‍👧",
    "真的嗎??",
    "what???",
    "為什麼會這樣？？？",
    "API 路徑是 /api/memory?limit=10&offset=0",
    "Café crème brûlée, naïve résumé, Straße, Ærø",
    "Привет, мир — пользователь говорит по-русски",
    "Γειά σου κόσμε",
    "שלום עולם",
    "مرحبا بالعالم",
    "日本語：ありがとう、한국어：감사합니다",
    "price: €30 — “quoted” ‘text’ … ™",
    "數學 α + β = γ，溫度 25°C ± 0.5",
    "Tabs\tand\nnewlines are fine",
  ];
  for (const text of ok) assert.equal(detectGarbledText(text), null, text);
});

test("garbledTextError 告訴 NPC 改用 Write + --data-binary @檔名", () => {
  const message = garbledTextError();
  assert.match(message, /Write/);
  assert.match(message, /--data-binary @/);
  assert.match(message, /刪檔/);
});
