import { useEffect, useState, type CSSProperties } from "react";
import { t } from "../i18n";

// 首次進站自動播放一次；跳過或走完都算看過
export const TOUR_DONE_KEY = "pixel-crew:onboarding-tour-done";

export function hasSeenTour(): boolean {
  try { return localStorage.getItem(TOUR_DONE_KEY) === "1"; } catch { return true; }
}

type Step = {
  anchor?: string; // CSS selector；沒給就置中純對話
  title: string;
  text: string;
};

const STEPS: Step[] = [
  {
    title: t("新人報到！"),
    text: t("歡迎加入 PIXEL CREW！今天是你上任老闆的第一天，我是辦公室的導覽貓。跟我巡一圈，走完你就知道怎麼帶這群 AI 員工了。"),
  },
  {
    anchor: ".game-host",
    title: t("這裡是辦公室"),
    text: t("你的 AI 員工就在這裡走動辦公，點任何一位就能對話或下指令。窗外天色會跟著現實時間日夜變化，晚上還看得到星星。"),
  },
  {
    anchor: ".crew-rail",
    title: t("你的團隊名單"),
    text: t("全體員工都列在這裡：點頭像切換對象，按＋招募新員工。滑鼠停在頭像上，可以看到他目前的狀態和腦容量量條。"),
  },
  {
    anchor: ".top-bar__boss",
    title: t("BOSS 交辦"),
    text: t("有大案子就按這顆金色按鈕。你用一句話描述目標，AI 會自動拆解步驟、指派給合適的員工，全程幫你盯進度。"),
  },
  {
    anchor: ".top-bar__mcp",
    title: t("功能選單"),
    text: t("日常營運都收在這顆 ⚙ 功能：📋看板看任務卡片、📊營運看每日成本、🌙下班看今日報告與回放、⟳ 優雅重啟伺服器、MCP 連線狀態。"),
  },
  {
    anchor: ".holo-panel",
    title: t("任務面板"),
    text: t("右側是對話與任務紀錄。員工要動用工具時，審批卡會用白話說明「它想做什麼、有什麼風險」，紅黃綠燈一看就懂，你再決定放不放行。"),
  },
  {
    anchor: ".command-composer",
    title: t("指令輸入框"),
    text: t("最直接的用法：在這裡打字交代目前選中的員工做事。可以直接拖檔案進來，按上下鍵翻歷史指令。"),
  },
  {
    title: t("導覽結束！"),
    text: t("辦公室交給你了，老闆！忘記的話隨時按頂欄的 ❓導覽 再找我。現在去下第一道指令吧！"),
  },
];

const DIALOG_W = 380;
const DIALOG_H = 220; // 估高，用來決定對話框放上面還是下面

export function OnboardingTour({ onClose }: { onClose(): void }) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = STEPS[index];
  const last = index === STEPS.length - 1;

  // 一彈出就記為看過：中途 F5 或直接關頁也不會下次又自動播
  useEffect(() => {
    try { localStorage.setItem(TOUR_DONE_KEY, "1"); } catch { /* 無痕模式等情況直接略過 */ }
  }, []);

  useEffect(() => {
    const measure = () => {
      const el = step.anchor ? document.querySelector(step.anchor) : null;
      const r = el?.getBoundingClientRect() ?? null;
      // 目標被收合或不存在時退回置中對話，不擋流程
      setRect(r && r.width > 4 && r.height > 4 ? r : null);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [step.anchor]);

  const finish = onClose;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish();
      if (event.key === "ArrowRight" || event.key === "Enter") setIndex((i) => Math.min(i + 1, STEPS.length - 1));
      if (event.key === "ArrowLeft") setIndex((i) => Math.max(i - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pad = 6;
  const holeStyle = rect
    ? { left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }
    : undefined;

  let dialogStyle: CSSProperties;
  if (rect) {
    const left = Math.min(Math.max(rect.left + rect.width / 2 - DIALOG_W / 2, 12), Math.max(12, window.innerWidth - DIALOG_W - 12));
    // 先試放目標下方，放不下改上方；滿版目標兩邊都放不下時夾回視窗內（會蓋在目標上，至少看得到）
    let top = rect.bottom + pad + 14;
    if (top + DIALOG_H > window.innerHeight) top = rect.top - pad - 14 - DIALOG_H;
    top = Math.min(Math.max(top, 12), Math.max(12, window.innerHeight - DIALOG_H - 12));
    dialogStyle = { left, top };
  } else {
    dialogStyle = { left: "50%", top: "50%", transform: "translate(-50%, -50%)" };
  }

  return (
    <div className={`tour-overlay ${rect ? "" : "tour-overlay--plain"}`} role="dialog" aria-label={t("新手導覽")}>
      {rect && <div className="tour-hole" style={holeStyle} />}
      <div className="tour-dialog" style={dialogStyle}>
        <div className="tour-dialog__speaker">🐈 {t("導覽貓")}</div>
        <h3>{step.title}</h3>
        <p>{step.text}</p>
        <div className="tour-dialog__actions">
          {!last && <button type="button" className="tour-dialog__skip" onClick={finish}>{t("跳過導覽")}</button>}
          <span className="tour-dialog__progress">{index + 1} / {STEPS.length}</span>
          {index > 0 && <button type="button" className="tour-dialog__btn tour-dialog__btn--ghost" onClick={() => setIndex(index - 1)}>{t("← 上一步")}</button>}
          {last
            ? <button type="button" className="tour-dialog__btn" onClick={finish}>{t("開始上班！")}</button>
            : <button type="button" className="tour-dialog__btn" onClick={() => setIndex(index + 1)}>{t("下一步 →")}</button>}
        </div>
      </div>
    </div>
  );
}
