/* 英文字典按需載入：中文使用者（預設）完全不下載 ~80 kB 的英文字串。
   en 時由 main.tsx 在 render 前 await ensureLanguage()，之後 t() 照舊同步查表；
   字典到位前 t() 退回中文原文（永不顯示空白），所以任何時候呼叫都安全。 */
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

/* 把語言同步到 <html lang>。兩個用途：
   1. 無障礙——螢幕報讀器要靠它決定用哪種語音唸，頁面不能永遠宣稱自己是
      zh-Hant。
   2. 版面——英文標籤普遍比中文長（Assign work / Auto-approve: off），頂欄
      的收合門檻本來就該跟著語言走，CSS 用 html[lang^="en"] 判斷。 */
if (typeof document !== "undefined") document.documentElement.lang = lang === "en" ? "en" : "zh-Hant";

let dict: Record<string, string> = {};
let loading: Promise<void> | null = null;

/** 載入目前語言需要的字典（只有 en 需要）；重複呼叫共用同一個 Promise。
 *  載入失敗不丟錯：介面退回中文原文，總比白畫面好。 */
export function ensureLanguage(): Promise<void> {
  if (lang !== "en") return Promise.resolve();
  loading ??= Promise.all([
    import("./i18n/en-core").then((m) => m.enCore),
    import("./i18n/en-modals-a").then((m) => m.enModalsA),
    import("./i18n/en-modals-b").then((m) => m.enModalsB),
    import("./i18n/en-modals-c").then((m) => m.enModalsC),
    import("./i18n/en-modals-d").then((m) => m.enModalsD),
    import("./i18n/en-app").then((m) => m.enApp),
    import("./i18n/en-root").then((m) => m.enRoot),
    import("./i18n/en-remote-access").then((m) => m.enRemoteAccess),
    import("./i18n/en-voice-input").then((m) => m.enVoiceInput),
    import("./i18n/en-motion").then((m) => m.enMotion),
    import("./i18n/en-scene").then((m) => m.enScene),
    import("./i18n/en-r2-scene").then((m) => m.enR2Scene),
    import("./i18n/en-r2-composer").then((m) => m.enR2Composer),
    import("./i18n/en-r2-app").then((m) => m.enR2App),
    import("./i18n/en-r2-modals").then((m) => m.enR2Modals),
    import("./i18n/en-r3-roundtable").then((m) => m.enR3Roundtable),
    import("./i18n/en-r3-warroom").then((m) => m.enR3Warroom),
    import("./i18n/en-r3-autopilot").then((m) => m.enR3Autopilot),
  ]).then((parts) => {
    // 後面的檔案覆蓋前面的（跟原本 spread 順序一致）。
    dict = Object.assign({}, ...parts);
  }).catch(() => {
    // 網路或部署問題：留在中文原文。
  });
  return loading;
}

/** 字典是否已就緒（中文永遠就緒）。 */
export function languageReady(): boolean {
  return lang !== "en" || Object.keys(dict).length > 0;
}

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
