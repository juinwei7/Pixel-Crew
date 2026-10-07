import { StrictMode, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";
import { installInteractionFx } from "./interactionFx";
import { ensureLanguage } from "./i18n";

// 全站互動手感：按鈕長出彈窗、主要按鈕火花、延遲提示框、彩蛋（純視覺）。
installInteractionFx();

// App 改成動態載入：很多模組在載入當下就呼叫 t() 建常數表（篩選標籤、模型說明、快捷鍵表），
// 英文字典也是按需載入的，所以要先等字典到位、再載入 App，模組頂層的字串才會是英文。
// 中文使用者 ensureLanguage() 立即完成，不多等。
// App chunk 下載失敗（更新後舊分頁）時照樣交給 ErrorBoundary 顯示「重新整理」提示。
function LoadFailed({ error }: { error: unknown }): never {
  throw error;
}

async function boot(): Promise<void> {
  await ensureLanguage();
  const root = createRoot(document.getElementById("root")!);
  let content: ReactElement;
  try {
    const { App } = await import("./App");
    // 辦公室場景不進入口 chunk；App 到位後立刻並行抓 GameCanvas 與 scene（Pixi），
    // 省掉「GameCanvas 掛上後才發現要 scene」那段串行（實測場景就緒 898 → 1560 ms 的主因）。
    // 不提早到 App 之前：那會跟 App 搶頻寬，手機遠端連線時介面反而更晚出來。失敗交給真正載入時處理。
    void import("./components/GameCanvas").catch(() => {});
    void import("./game/scene").catch(() => {});
    content = <App />;
  } catch (error) {
    content = <LoadFailed error={error} />;
  }
  root.render(
    <StrictMode>
      <ErrorBoundary>
        {content}
      </ErrorBoundary>
    </StrictMode>,
  );
}

void boot();
