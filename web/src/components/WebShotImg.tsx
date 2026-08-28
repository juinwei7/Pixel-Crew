import { useEffect, useRef, useState, type CSSProperties } from "react";
import { t } from "../i18n";

// 工作小窗的真實網頁截圖。純 <img onError> 一失敗就永久空白，這裡補齊體驗：
//   - 載入中顯示「實況擷取中…」（後端冷啟動第一張常要 3~10 秒）
//   - 失敗自動重試最多 3 次（退避 1.5s/3s/4.5s；&r= 參數避開瀏覽器對失敗回應的快取）
//   - 整塊可點：新分頁開啟真正的搜尋頁/網址（小窗看不清就直接看本尊）
const MAX_RETRY = 3;

export function WebShotImg({ query, imgClassName, imgStyle, hintStyle }: {
  query: string;
  imgClassName?: string;
  imgStyle?: CSSProperties;
  hintStyle?: CSSProperties;
}) {
  const [state, setState] = useState<"loading" | "ok" | "failed">("loading");
  const [attempt, setAttempt] = useState(0);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    setState("loading");
    setAttempt(0);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [query]);

  const onError = () => {
    setAttempt((a) => {
      if (a >= MAX_RETRY) { setState("failed"); return a; }
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setAttempt((x) => x + 1), 1500 * (a + 1));
      return a;
    });
  };

  // 載入逾時保險：25 秒沒 onLoad 也沒 onError（後端排隊/連線懸掛）就當失敗走重試
  useEffect(() => {
    if (state !== "loading") return;
    const hang = window.setTimeout(onError, 25_000);
    return () => window.clearTimeout(hang);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, attempt, query]);

  const openUrl = /^https?:\/\//i.test(query)
    ? query
    : `https://www.bing.com/search?q=${encodeURIComponent(query)}`;

  return (
    <a
      href={openUrl}
      target="_blank"
      rel="noopener noreferrer"
      title={t("在新分頁開啟這個網頁")}
      style={{ display: "block", textDecoration: "none", cursor: "pointer" }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {state !== "ok" && (
        <div className="npc-workwindow__loading" style={hintStyle}>
          {state === "failed" ? t("截圖失敗・點這裡直接開網頁") : t("實況擷取中…")}
        </div>
      )}
      <img
        className={imgClassName}
        style={{ ...imgStyle, display: state === "ok" ? undefined : "none" }}
        src={`/api/webshot?q=${encodeURIComponent(query)}&r=${attempt}`}
        alt=""
        onLoad={() => setState("ok")}
        onError={onError}
      />
    </a>
  );
}
