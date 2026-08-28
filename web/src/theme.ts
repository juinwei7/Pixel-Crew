// 視覺主題全域開關，比照 i18n 的 lang 模式做：出生時讀一次 localStorage，
// 切換就寫回並整頁重載——主題散布在 canvas 與 React 樣式，重載最簡單可靠，
// 切主題本來就是罕見操作。像素風（pixel）是深色遊戲世界；現代（modern）是亮色工作台，
// 兩套版面／字體／NPC 呈現完全不同的介面，共用同一份資料。
export type Theme = "pixel" | "modern";

const THEME_KEY = "pixel-crew:theme";

function detect(): Theme {
  try {
    // 網址 ?theme=modern|pixel 可覆寫（僅本次載入，方便測試與分享連結）。
    const q = new URLSearchParams(location.search).get("theme");
    if (q === "modern" || q === "pixel") return q;
    return localStorage.getItem(THEME_KEY) === "modern" ? "modern" : "pixel";
  } catch {
    // node（測試）環境沒有 localStorage——退回像素風底線。
    return "pixel";
  }
}

export const theme: Theme = detect();

export function setTheme(next: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // ignore
  }
  location.reload();
}
