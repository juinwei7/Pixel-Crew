/**
 * 文字完整性檢查：擋下「中文經 Windows 命令列送進 curl 後變成亂碼」的寫入。
 *
 * 實測（Git Bash + mingw curl，chcp 936）：`curl -d "{\"note\":\"中文\"}"` 送出的是
 * 系統 ANSI 代碼頁（CP936/CP950）位元組而不是 UTF-8，代碼頁裡沒有的字（☕、emoji）
 * 直接變成 '?'。伺服器以 UTF-8 解碼後就出現：
 *   - U+FFFD 取代字元（最主要的訊號），夾雜零星 ʹ ӛ ԇ 這類 U+0080–U+07FF 的雜字；
 *   - 整串中文被換成 "????"；
 *   - 反方向（UTF-8 被當 cp1252/latin1 解）的 "ä½¿ç”¨" 型態。
 * 只看強訊號，正常中英文、emoji、全形標點、單個問號都不會誤殺。
 */
import { t } from "./i18n.js";

export type GarbledReason = "replacement-char" | "question-marks" | "utf8-as-latin1" | "mixed-scripts";

// cp1252 把 0x80–0x9F 對到的字元，加上 U+0080–U+00BF：UTF-8 續位元組被當 cp1252/latin1 解的樣子。
const LATIN1_CONTINUATION = "[\u0080-\u00BF\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192\u02C6\u02DC\u2013\u2014\u2018-\u201E\u2020-\u2022\u2026\u2030\u2039\u203A\u20AC\u2122]";
// 3-byte UTF-8（CJK 都在這）的首位元組 E0–EF 被當 latin1 解 = à–ï，後面跟兩個續位元組字元。
const UTF8_AS_LATIN1 = new RegExp(`[\u00E0-\u00EF]${LATIN1_CONTINUATION}{2}`, "g");

// CP950/CP936 雙位元組被當 UTF-8 解、剛好合法時落在 U+0250–U+07FF 的各個區塊。
// 正常文字幾乎不會同時混用其中三個以上的區塊（例如 IPA + 西里爾 + 希伯來）。
const MIXED_SCRIPT_BLOCKS: Array<[number, number]> = [
  [0x0250, 0x02af], // IPA
  [0x02b0, 0x02ff], // spacing modifiers
  [0x0300, 0x036f], // combining marks
  [0x0370, 0x03ff], // Greek
  [0x0400, 0x052f], // Cyrillic + supplement
  [0x0530, 0x058f], // Armenian
  [0x0590, 0x05ff], // Hebrew
  [0x0600, 0x06ff], // Arabic
  [0x0700, 0x07ff], // Syriac / Thaana / NKo …
];

/** 判斷文字是否疑似編碼亂碼；不是則回 null。純函式。 */
export function detectGarbledText(text: string): GarbledReason | null {
  if (!text) return null;
  if (text.includes("�")) return "replacement-char";

  // 連續問號取代中文：只算長度 ≥2 的 '?' 連段，總數 ≥4 且佔非空白字元 ≥30%。
  // "真的嗎??"、"what???" 這類語氣問號不會到門檻。
  const nonSpace = text.replace(/\s+/g, "").length;
  const runs = text.match(/\?{2,}/g) ?? [];
  const runChars = runs.reduce((sum, run) => sum + run.length, 0);
  if (runChars >= 4 && runChars / Math.max(nonSpace, 1) >= 0.3) return "question-marks";

  if ((text.match(UTF8_AS_LATIN1) ?? []).length >= 2) return "utf8-as-latin1";

  const blocks = new Set<number>();
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x0250 || code > 0x07ff) continue;
    const index = MIXED_SCRIPT_BLOCKS.findIndex(([lo, hi]) => code >= lo && code <= hi);
    if (index >= 0) blocks.add(index);
  }
  if (blocks.size >= 3) return "mixed-scripts";
  return null;
}

/** 回給 NPC 的 400 錯誤訊息：明講怎麼改寫才不會亂碼。 */
export function garbledTextError(): string {
  return t("內容疑似亂碼（中文直接寫在 curl 命令列會被 Windows 轉成系統代碼頁），已拒絕寫入。請改用 Write 工具把 JSON 寫成 UTF-8 檔，再用 curl --data-binary @檔名 送出，送完刪檔。");
}
