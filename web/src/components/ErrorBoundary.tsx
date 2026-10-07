import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "../i18n";

// 懶載入 chunk 讀取失敗的指紋。就地冷安裝更新後，開著的分頁仍指向舊的 hash
// 檔名（例如 OutboxModal-<舊hash>.js），點開任何 lazy modal／面板都會去抓一個
// 已被新版覆蓋掉的檔案 → 404。這類 dynamic import 的 reject 在沒有 Error
// Boundary 時會往上冒穿過 <Suspense>，把整棵 React tree 卸載 ＝ 整頁變黑，
// 使用者得手動重新整理才會對上新 chunk。這裡集中辨識這種錯誤。
export function isChunkLoadError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? "";
  const message = (error as { message?: string } | null)?.message ?? "";
  if (name === "ChunkLoadError") return true;
  return /dynamically imported module|importing a module script failed|failed to fetch dynamically|error loading dynamically|loading (css )?chunk/i.test(
    message,
  );
}

// 自動重整的節流：若上一次自動重整就在這個窗口內、卻又炸同一種錯，代表重整
// 救不了（例如新版本真的缺這個檔，而非單純的 stale chunk），改顯示可復原的
// 錯誤卡，避免陷入「炸→重整→又炸」的無限重整迴圈。
const RELOAD_STAMP_KEY = "pixel-crew:chunk-reload-at";
const RELOAD_COOLDOWN_MS = 15000;

function shouldAutoReload(now: number): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_STAMP_KEY) ?? 0);
    if (Number.isFinite(last) && now - last < RELOAD_COOLDOWN_MS) return false;
    sessionStorage.setItem(RELOAD_STAMP_KEY, String(now));
    return true;
  } catch {
    // 沒有 sessionStorage（極罕見）就別自動重整，退回錯誤卡讓使用者手動重整。
    return false;
  }
}

type Props = { children: ReactNode };
type State = { error: Error | null; reloading: boolean };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, reloading: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    // 先樂觀假設 chunk 錯誤會自動重整（render null、不閃錯誤卡）；
    // 真正能不能重整在 componentDidCatch 依冷卻窗決定，不行再翻回錯誤卡。
    return { error, reloading: isChunkLoadError(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 留一筆主控台紀錄，方便日後比對是哪個 chunk／哪段 render 出事。
    console.error("[pixel-crew] UI crashed:", error, info.componentStack);
    if (isChunkLoadError(error)) {
      if (shouldAutoReload(Date.now())) {
        location.reload();
        return;
      }
      // 重整救不了：翻回錯誤卡。
      this.setState({ reloading: false });
    }
  }

  private handleReload = (): void => {
    try {
      sessionStorage.removeItem(RELOAD_STAMP_KEY);
    } catch {
      // ignore
    }
    location.reload();
  };

  render(): ReactNode {
    const { error, reloading } = this.state;
    if (!error) return this.props.children;
    // chunk 錯誤且即將自動重整：render 空白，避免錯誤卡一閃而過。
    if (reloading) return null;
    return (
      <div
        role="alert"
        style={{
          position: "fixed",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "#0b1020",
          zIndex: 99999,
        }}
      >
        <div
          style={{
            maxWidth: 420,
            width: "100%",
            borderRadius: 14,
            border: "1px solid #26304e",
            background: "#101627",
            padding: "22px 24px",
            color: "#dbe4ff",
            boxShadow: "0 18px 50px rgba(0,0,0,0.45)",
          }}
        >
          <div style={{ fontSize: 11, letterSpacing: 1.5, color: "#7d8cb8", marginBottom: 6 }}>PIXEL CREW</div>
          <h2 style={{ fontSize: 17, margin: "0 0 10px", fontWeight: 650 }}>{t("畫面載入時發生問題")}</h2>
          <p style={{ fontSize: 13, lineHeight: 1.7, color: "#9fb0dd", margin: "0 0 18px" }}>
            {t("這通常是更新後舊分頁的快取沒對上新版造成的。重新整理頁面就會恢復正常。")}
          </p>
          <button
            type="button"
            onClick={this.handleReload}
            style={{
              padding: "8px 16px",
              borderRadius: 9,
              border: "1px solid #2b3a63",
              background: "#16203a",
              color: "#cfe0ff",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            {t("重新整理頁面")}
          </button>
        </div>
      </div>
    );
  }
}
