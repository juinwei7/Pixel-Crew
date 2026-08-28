import { enCore } from "./i18n/en-core";
import { enModalsA } from "./i18n/en-modals-a";
import { enModalsB } from "./i18n/en-modals-b";
import { enModalsC } from "./i18n/en-modals-c";
import { enModalsD } from "./i18n/en-modals-d";
import { enApp } from "./i18n/en-app";
import { enRoot } from "./i18n/en-root";
import { enRemoteAccess } from "./i18n/en-remote-access";

export type Lang = "zh" | "en";

const LANG_KEY = "pixel-crew:lang";

function detect(): Lang {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored === "en" || stored === "zh") return stored;
    return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
  } catch {
    // node（測試）環境沒有 localStorage/navigator——維持中文原文，測試斷言不受影響。
    return "zh";
  }
}

export const lang: Lang = detect();

const dict: Record<string, string> = lang === "en"
  ? { ...enCore, ...enModalsA, ...enModalsB, ...enModalsC, ...enModalsD, ...enApp, ...enRoot, ...enRemoteAccess }
  : {};

function interpolate(text: string, params?: Record<string, string | number>): string {
  let out = text;
  if (params) {
    for (const key of Object.keys(params)) out = out.split(`{${key}}`).join(String(params[key]));
  }
  return out;
}

/** 中文原文即 key（gettext 風格）：en 字典查不到就退回中文原文，永不顯示空白。
 *  插值用 {name} 佔位：t("剩餘 {pct}%", { pct: 55 })。 */
export function t(text: string, params?: Record<string, string | number>): string {
  return interpolate(dict[text] ?? text, params);
}

/** pgettext：同一句中文在不同語境需要不同英譯時用（gettext msgctxt，:: 分隔）。
 *  字典 key 寫成 "語境::原文"；查不到退回一般 t()。 */
export function tc(context: string, text: string, params?: Record<string, string | number>): string {
  const hit = dict[`${context}::${text}`];
  return hit !== undefined ? interpolate(hit, params) : t(text, params);
}

/** 語言存進 localStorage 後整頁重載：字串散布在 React 與 canvas 模組，
 *  重載換語言最簡單可靠，切語言本來就是罕見操作。 */
export function setLang(next: Lang): void {
  try {
    localStorage.setItem(LANG_KEY, next);
  } catch {
    // ignore
  }
  location.reload();
}
