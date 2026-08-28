import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkerState, Department } from "../types";
import { t } from "../i18n";
import type { OfficeSceneController, WorkerLite } from "../three/officeScene";
import { WebShotImg } from "./WebShotImg";

// 現代主題 = 模擬人生風 3D 娃娃屋，但**只當背景場景層**：頂欄 / 任務日誌 / 對話框 / 圓桌 / 各種
// Modal 全部沿用像素風那套共用元件（見 App.tsx），所以功能與像素風完全一致。這個元件只負責
// 掛載 three.js 場景、日夜背景、點角色 = 選取 NPC；three.js 以動態 import 掛載，像素風不會下載到這包。
type Props = {
  workers: WorkerState[];
  departments: Department[];
  active: WorkerState | null;
  onSelect: (id: string) => void;
};

function toLite(w: WorkerState, deptName?: Map<string, string>): WorkerLite {
  return {
    id: w.id,
    name: w.name,
    busy: w.busy,
    departmentId: w.departmentId ?? null,
    departmentLabel: (w.departmentId && deptName?.get(w.departmentId)) || null,
    colorIndex: w.colorIndex,
    station: w.character?.station,
    activity: w.character?.activity,
    speech: w.character?.speech,      // 即時任務/狀態文字＝工作小窗的真內容
    mood: w.character?.mood,          // neutral/success/error＝小窗狀態燈顏色
    webQuery: w.character?.webQuery,  // 上網查的查詢字＝小窗抓真實瀏覽器截圖用
  };
}

// 背景日夜一致：跟 officeScene 同一套關鍵影格算 night 係數（0~1），把背景底色一起漸變。
const DAY_NIGHT: Array<[number, number]> = [[0, 1], [5, 1], [6.5, 0], [9, 0], [17, 0], [18.5, 0], [20, 1], [24, 1]];
function nightFactorNow(): number {
  const d = new Date(), h = d.getHours() + d.getMinutes() / 60;
  let p = DAY_NIGHT[0];
  for (const k of DAY_NIGHT) { if (h <= k[0]) { const t = k[0] === p[0] ? 0 : (h - p[0]) / (k[0] - p[0]); return p[1] + (k[1] - p[1]) * t; } p = k; }
  return 1;
}
function lerpHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const r = Math.round(((pa >> 16) & 255) + (((pb >> 16) & 255) - ((pa >> 16) & 255)) * t);
  const g = Math.round(((pa >> 8) & 255) + (((pb >> 8) & 255) - ((pa >> 8) & 255)) * t);
  const bl = Math.round((pa & 255) + ((pb & 255) - (pa & 255)) * t);
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1);
}

// 焦點大螢幕：選取「忙碌中」NPC 時，左側浮出一塊大面板顯示他即時在做的事——上網查＝放大的真實
// 瀏覽器截圖（大到讀得清楚，如同 SAMS 參考影片的中央大螢幕），寫程式/終端＝放大的任務文字。
// 站點對照沿用工作小窗那套（GameCanvas WORKWINDOW_THEME），標籤/配色一致。
// label＝工作站名稱（終端機…）；plain＝大白話一句話，讓非工程背景的人也一看就懂 NPC 在幹嘛。
const WORKSCREEN_THEME: Record<string, { label: string; accent: string; kind: string; plain: string }> = {
  terminal: { label: t("終端機"), accent: "#58f08a", kind: "term",  plain: t("正在執行指令") },
  code:     { label: t("編輯器"), accent: "#7aa2ff", kind: "code",  plain: t("正在寫程式") },
  web:      { label: t("瀏覽器"), accent: "#3f8cff", kind: "web",   plain: t("正在上網查資料") },
  books:    { label: t("知識庫"), accent: "#e0b060", kind: "docs",  plain: t("正在查閱文件資料") },
  check:    { label: t("驗證"),   accent: "#35d0b0", kind: "check", plain: t("正在驗證測試") },
  board:    { label: t("看板"),   accent: "#b98cff", kind: "board", plain: t("正在更新工作看板") },
  meeting:  { label: t("白板"),   accent: "#8fd0ff", kind: "board", plain: t("正在開會討論") },
};

export function Office3D({ workers, departments, active, onSelect }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctrlRef = useRef<OfficeSceneController | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errMsg, setErrMsg] = useState("");
  // 日夜背景（跟場景光影對時）
  const [nightF, setNightF] = useState(nightFactorNow);
  useEffect(() => {
    setNightF(nightFactorNow());
    const iv = setInterval(() => setNightF(nightFactorNow()), 60_000);
    return () => clearInterval(iv);
  }, []);
  const bg = `radial-gradient(120% 120% at 50% 16%, ${lerpHex("#eaf3ff", "#10182a", nightF)} 0%, ${lerpHex("#cfe0f2", "#0c1220", nightF)} 55%, ${lerpHex("#aec4dd", "#070b13", nightF)} 100%)`;
  const creditColor = lerpHex("#7a879a", "#8b98ab", nightF);

  const lite = useMemo(() => {
    const deptName = new Map(departments.map((d) => [d.id, d.name]));
    const real = workers.map((w) => toLite(w, deptName));
    // ?demo=N：放 N 個示範角色分散到各活動站點（預覽站點走動用，不影響真連線邏輯）。
    // 帶了就覆寫真名冊，方便單獨預覽 3D 行為；沒帶則正常顯示真隊員。
    const n = Number(new URLSearchParams(location.search).get("demo"));
    if (n > 0) {
      const demoDepts = [["dev", "開發部"], ["design", "設計部"], ["qa", "品保部"], ["ops", "營運部"]] as const;
      const demoStations = ["home", "terminal", "code", "books", "web", "check", "board", "meeting"];
      return Array.from({ length: Math.min(n, 16) }, (_, i) => {
        const d = demoDepts[Math.floor(i / 3) % demoDepts.length];
        const station = demoStations[i % demoStations.length];
        const demoSpeech: Record<string, string> = {
          terminal: "npm run build — 編譯中，1205 modules…", code: "重構 officeScene.ts：抽出 buildTower()", web: "搜尋：three.js InstancedMesh 效能", books: "讀取 knowledge/agent-rig.md（94 頁）",
          check: "驗證 17 個測試檔 · 品質檢查中", board: "更新看板：plan-41 → 完成", meeting: "🗣️ 圓桌討論：第二主題方向",
        };
        return { id: `demo-${i}`, name: `隊員 ${i + 1}`, busy: station !== "home", departmentId: d[0], departmentLabel: d[1], colorIndex: i, station, activity: station === "home" ? "idle" : "working", speech: demoSpeech[station] ?? "", mood: "neutral" as const, webQuery: station === "web" ? "iPhone 17 台灣 售價 2026" : undefined };
      });
    }
    return real;
  }, [workers, departments]);

  // 掛載場景（只跑一次）
  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const isMobile = matchMedia("(pointer: coarse)").matches || innerWidth < 820;
    import("../three/officeScene")
      .then(({ createOfficeScene }) =>
        createOfficeScene({
          canvas,
          quality: isMobile ? "low" : "high",
          onSelect: (id) => onSelectRef.current(id),
          onExpand: (id) => { pendingExpandId.current = id; setExpanded(true); },
        }),
      )
      .then((ctrl) => {
        if (cancelled) { ctrl.dispose(); return; }
        ctrlRef.current = ctrl;
        setStatus("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        setErrMsg(e instanceof Error ? e.message : String(e));
        setStatus("error");
      });
    return () => {
      cancelled = true;
      ctrlRef.current?.dispose();
      ctrlRef.current = null;
    };
  }, []);

  // 容器尺寸變化 → 通知場景
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => ctrlRef.current?.resize());
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    return () => ro.disconnect();
  }, []);

  // 隊員名冊 / 忙碌狀態變化 → 更新角色
  useEffect(() => {
    if (status === "ready") ctrlRef.current?.setWorkers(lite);
  }, [lite, status]);

  // 選取的 NPC → 綠鑽變金
  useEffect(() => {
    if (status === "ready") ctrlRef.current?.setActive(active?.id ?? null);
  }, [active, status]);

  // 焦點大螢幕：?demo=N 預覽模式直接挑一個 web 示範角色顯示（方便預覽大螢幕）；否則顯示選取且忙碌的 NPC。
  const focus = (() => {
    const demoN = Number(new URLSearchParams(location.search).get("demo"));
    if (demoN > 0) {
      const dw = lite.find((w) => w.station === "web") ?? lite.find((w) => w.station && WORKSCREEN_THEME[w.station]);
      if (dw?.station) {
        const th = WORKSCREEN_THEME[dw.station];
        if (th) return { id: dw.id, theme: th, name: dw.name, speech: dw.speech?.trim() || "", webQuery: dw.webQuery?.trim() || "" };
      }
    }
    if (active && active.busy) {
      const st = active.character?.station;
      const th = st ? WORKSCREEN_THEME[st] : undefined;
      if (th) return { id: active.id, theme: th, name: active.name, speech: active.character?.speech?.trim() || "", webQuery: active.character?.webQuery?.trim() || "" };
    }
    return null;
  })();
  // 焦點大螢幕：預設收成小標籤，點一下才展開成大畫面（想看再放大）。
  // 換到不同 NPC 預設收回；但若那個 NPC 是剛「點頭頂工作小窗」要求展開的（id 相符），就直接展開。
  const [expanded, setExpanded] = useState(false);
  const pendingExpandId = useRef<string | null>(null);
  useEffect(() => { setExpanded(focus?.id != null && focus.id === pendingExpandId.current); }, [focus?.id]);
  // 首次造訪的操作提示：一看就懂怎麼玩這個 3D 辦公室，按「知道了」後記住不再出現。
  const HINT_KEY = "pixel-crew:office3d-hint-done";
  const [showHint, setShowHint] = useState(() => { try { return localStorage.getItem(HINT_KEY) !== "1"; } catch { return true; } });
  const dismissHint = () => { setShowHint(false); try { localStorage.setItem(HINT_KEY, "1"); } catch { /* noop */ } };

  // 手機版：窄螢幕時把浮動面板的位置/寬度改成貼邊、可換行（桌機側欄收起後不再需要留 250px）。
  const [isMobile, setIsMobile] = useState(() => (typeof window !== "undefined" ? window.innerWidth < 820 : false));
  useEffect(() => {
    const onR = () => setIsMobile(window.innerWidth < 820);
    window.addEventListener("resize", onR);
    return () => window.removeEventListener("resize", onR);
  }, []);
  const edge = isMobile ? 12 : 250;   // 面板左緣：桌機避開 CREW 側欄，手機貼邊

  // 焦點大螢幕「上一位／下一位」：在忙碌且有工作站的隊員之間切換（點箭頭直接看別人在忙什麼）。
  const busyList = lite.filter((w) => w.busy && w.station && WORKSCREEN_THEME[w.station]);
  const nav = (dir: number) => {
    if (!focus || busyList.length < 2) return;
    const i = busyList.findIndex((w) => w.id === focus.id);
    const next = busyList[(i + dir + busyList.length) % busyList.length];
    if (!next) return;
    pendingExpandId.current = next.id;   // 保持展開，換人不收合
    setExpanded(true);
    onSelect(next.id);
  };

  return (
    <div style={{ ...S.root, background: bg }}>
      <canvas ref={canvasRef} style={S.canvas} />
      {status === "loading" && <div style={S.overlay}>{t("載入 3D 場景中…")}</div>}
      {status === "error" && <div style={{ ...S.overlay, color: "#ffb4a2" }}>⚠ {t("3D 場景載入失敗")}：{errMsg}</div>}
      {focus && !expanded && (
        // 收合態：一顆小標籤，點一下展開大螢幕（平常不擋畫面）。副標＝大白話一看就懂在幹嘛。
        <button type="button" style={{ ...S.pill, left: edge, borderColor: focus.theme.accent }} onClick={() => setExpanded(true)} title={t("點擊放大")}>
          <span style={{ ...S.pillDot, background: focus.theme.accent }} />
          <span style={S.pillLabel}>{focus.name}・{focus.theme.plain}</span>
          <span style={S.pillLive}>● LIVE</span>
          <span style={S.pillExpand}>⤢</span>
        </button>
      )}
      {focus && expanded && (
        <div style={{ ...S.screen, left: edge, width: isMobile ? "calc(100vw - 24px)" : 380, maxWidth: isMobile ? "none" : "38vw", borderColor: focus.theme.accent }}>
          <div style={{ ...S.screenBar, background: focus.theme.accent }}>
            {busyList.length > 1 && (
              <button type="button" style={S.screenNav} onClick={() => nav(-1)} title={t("上一位")}>‹</button>
            )}
            <span style={S.screenTitle}>{focus.name}・{focus.theme.plain}</span>
            <span style={S.screenLive}>● LIVE</span>
            {busyList.length > 1 && (
              <button type="button" style={S.screenNav} onClick={() => nav(1)} title={t("下一位")}>›</button>
            )}
            <button type="button" style={S.screenClose} onClick={() => setExpanded(false)} title={t("收合")}>–</button>
          </div>
          {focus.theme.kind === "web" ? (
            <div style={S.screenWeb}>
              <div style={S.screenUrl}>{focus.webQuery ? (/^https?:\/\//i.test(focus.webQuery) ? focus.webQuery : `search · ${focus.webQuery}`) : `search · ${focus.name}`}</div>
              {focus.webQuery ? (
                <WebShotImg query={focus.webQuery} imgStyle={S.screenShot} hintStyle={S.screenLoading} />
              ) : (
                <div style={S.screenLoading}>{t("載入實時畫面…")}</div>
              )}
            </div>
          ) : (
            <div style={{ ...S.screenBody, fontFamily: (focus.theme.kind === "term" || focus.theme.kind === "code") ? "var(--mono, monospace)" : "var(--sans, sans-serif)" }}>
              {focus.theme.kind === "term" ? "$ " : focus.theme.kind === "check" ? "☑ " : focus.theme.kind === "board" ? "• " : ""}{focus.speech || t("執行中…")}
            </div>
          )}
        </div>
      )}
      {status === "ready" && showHint && (
        <div style={{ ...S.hint, left: edge, maxWidth: isMobile ? "calc(100vw - 24px)" : "46vw" }}>
          <span style={{ ...S.hintText, whiteSpace: isMobile ? "normal" : "nowrap" }}>
            {isMobile ? "👆 " : "🖱 "}{isMobile ? t("單指拖曳旋轉") : t("拖曳旋轉")} · {isMobile ? t("雙指縮放") : t("滾輪縮放")} · {t("點角色看詳情")} · 🔍 {t("點頭頂視窗放大")}
          </span>
          <button type="button" style={S.hintBtn} onClick={dismissHint}>{t("知道了")}</button>
        </div>
      )}
      {status === "ready" && !showHint && !focus && (
        // 空手提示：沒選任何忙碌隊員時，淡淡提醒可以點誰（看過操作提示後才出現，避免一次擠兩條）
        <div style={{ ...S.emptyHint, left: edge }}>👆 {t("點任何一位隊員，看他正在忙什麼")}</div>
      )}
      <footer style={{ ...S.credit, color: creditColor }}>
        {t("角色/傢俱模型")}: <b>Quaternius</b> (CC0/CC-BY) · {t("飲水機")} J-Toastie via Poly Pizza (CC-BY)
      </footer>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  root: { position: "absolute", inset: 0, zIndex: 0, overflow: "hidden", background: "radial-gradient(120% 120% at 50% 16%,#eaf3ff 0%,#cfe0f2 55%,#aec4dd 100%)" },
  canvas: { position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" },
  overlay: { position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", fontSize: 15, fontWeight: 600, color: "#5a6b82", zIndex: 1 },
  credit: { position: "absolute", bottom: 8, left: 0, right: 0, textAlign: "center", fontSize: 11, color: "#7a879a", zIndex: 1, pointerEvents: "none" },
  // 焦點大螢幕（左側浮出）：展開態才顯示，吃點擊（右上角「–」可收合）
  // 位置：避開左側 CREW 隊員列（約 230px）與右側任務日誌，落在中間可見的 3D 空檔
  screen: { position: "absolute", top: 76, left: 250, width: 380, maxWidth: "38vw", borderRadius: 12, overflow: "hidden", background: "rgba(9,14,24,0.94)", border: "2px solid #3f8cff", boxShadow: "0 12px 34px rgba(0,0,0,0.5)", zIndex: 3, pointerEvents: "auto" },
  screenBar: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 12px", color: "#0b0f16" },
  screenTitle: { font: "700 13px var(--sans, sans-serif)", letterSpacing: 0.3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1 },
  screenLive: { font: "700 10px var(--sans, sans-serif)", color: "#0b0f16", opacity: 0.85, marginLeft: 8 },
  screenClose: { marginLeft: 8, width: 22, height: 22, borderRadius: 6, border: "none", background: "rgba(0,0,0,0.18)", color: "#0b0f16", font: "700 16px var(--sans, sans-serif)", lineHeight: "18px", cursor: "pointer", padding: 0 },
  screenNav: { flexShrink: 0, width: 22, height: 22, marginRight: 4, borderRadius: 6, border: "none", background: "rgba(0,0,0,0.18)", color: "#0b0f16", font: "700 18px var(--sans, sans-serif)", lineHeight: "16px", cursor: "pointer", padding: 0 },
  // 收合態小標籤：平常只佔一小條，點一下展開
  pill: { position: "absolute", top: 76, left: 250, display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderRadius: 20, background: "rgba(9,14,24,0.9)", border: "2px solid #3f8cff", boxShadow: "0 6px 18px rgba(0,0,0,0.4)", zIndex: 3, pointerEvents: "auto", cursor: "pointer", color: "#e6eefc" },
  pillDot: { width: 9, height: 9, borderRadius: "50%", flexShrink: 0 },
  pillLabel: { font: "700 12px var(--sans, sans-serif)", whiteSpace: "nowrap", maxWidth: "22vw", overflow: "hidden", textOverflow: "ellipsis" },
  pillLive: { font: "700 9px var(--sans, sans-serif)", color: "#ff5a5a" },
  pillExpand: { font: "700 13px var(--sans, sans-serif)", opacity: 0.75 },
  // 首次操作提示（底部置中一條，按「知道了」收起）
  hint: { position: "absolute", top: 120, left: 250, display: "flex", alignItems: "center", gap: 12, maxWidth: "46vw", padding: "8px 10px 8px 16px", borderRadius: 22, background: "rgba(12,18,30,0.92)", border: "1px solid rgba(120,150,190,0.45)", boxShadow: "0 8px 24px rgba(0,0,0,0.45)", zIndex: 4, pointerEvents: "auto" },
  hintText: { font: "600 13px var(--sans, sans-serif)", color: "#dbe6f5", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  hintBtn: { flexShrink: 0, padding: "5px 14px", borderRadius: 16, border: "none", background: "#3f8cff", color: "#fff", font: "700 12px var(--sans, sans-serif)", cursor: "pointer" },
  // 空手提示：淡淡一行，不吃點擊
  emptyHint: { position: "absolute", top: 120, left: 250, padding: "6px 14px", borderRadius: 18, background: "rgba(12,18,30,0.62)", font: "600 12px var(--sans, sans-serif)", color: "rgba(219,230,245,0.82)", zIndex: 2, pointerEvents: "none", maxWidth: "80vw", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  screenWeb: { background: "#f3f6fb" },
  screenUrl: { margin: "7px 8px", padding: "5px 10px", borderRadius: 7, background: "#e2e8f0", font: "500 12px var(--sans, sans-serif)", color: "#4a5a68", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  screenShot: { display: "block", width: "100%", height: 300, objectFit: "cover", objectPosition: "top", background: "#fff" },
  screenLoading: { height: 300, display: "flex", alignItems: "center", justifyContent: "center", font: "500 13px var(--sans, sans-serif)", color: "#9aa7b4", background: "#fff" },
  screenBody: { padding: "12px 14px", font: "500 14px var(--sans, sans-serif)", lineHeight: 1.5, color: "#dbe4f2", maxHeight: 260, overflow: "hidden", whiteSpace: "pre-wrap", wordBreak: "break-word" },
};
