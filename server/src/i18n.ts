import { enServerA } from "./i18n/en-server-a.js";
import { enServerB } from "./i18n/en-server-b.js";
import { enServerC } from "./i18n/en-server-c.js";

export type Lang = "zh" | "en";

/** server 端語言是全域單一值，來源 app-settings（web 🌐 切換時會 POST 同步過來）。
 *  跟 web 版同一套 gettext 風格 API：中文原文即 key，en 查不到退回中文。
 *  注意：t() 要在「用到的當下」呼叫，不要在模組載入期先算成常數，否則切語言不生效。 */
let lang: Lang = "zh";
// 註：server 端全站字串已於 i18n Phase 2 完成轉換（en-server-a/b/c 三檔，685 key）。

const en: Record<string, string> = { ...enServerA, ...enServerB, ...enServerC };

export function setLang(next: Lang): void {
  lang = next;
}

export function getLang(): Lang {
  return lang;
}

function interpolate(text: string, params?: Record<string, string | number>): string {
  let out = text;
  if (params) {
    for (const key of Object.keys(params)) out = out.split(`{${key}}`).join(String(params[key]));
  }
  return out;
}

/** 插值用 {name} 佔位：t("剩餘 {pct}%", { pct: 55 })。 */
export function t(text: string, params?: Record<string, string | number>): string {
  return interpolate(lang === "en" ? en[text] ?? text : text, params);
}

/** pgettext：同一句中文在不同語境需要不同英譯時用，字典 key 寫成 "語境::原文"。 */
export function tc(context: string, text: string, params?: Record<string, string | number>): string {
  if (lang === "en") {
    const hit = en[`${context}::${text}`];
    if (hit !== undefined) return interpolate(hit, params);
  }
  return t(text, params);
}
