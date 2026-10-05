import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createConnectionWatch, type ConnectionPhase } from "../connectionWatch";
import { emitFx } from "../fxBus";
import { t } from "../i18n";
import { RollingNumber } from "./RollingNumber";

// 本機服務斷線／重啟／安裝新版時的提示。取代原本一閃一閃的紅色橫條：
//   - 斷線 1.5 秒以上才出現（connectionWatch 的 debounce），閃斷不打擾
//   - 等待中：像素機櫃的燈號依序跑、底下一排像素格來回掃，已等待秒數往上滾
//   - 回來時：格子由左到右點亮成綠色、打勾，停一下自己收掉
// 重啟／更新是「預期中的斷線」，用比較大的卡片置中顯示；一般閃斷只用頂部小卡。
// 場景那邊同時收到 connection down/up：辦公室熄燈打瞌睡，回來時燈閃一下亮回來。

export type ConnectionReason = "blip" | "restart" | "update";

const SEGMENTS = 12;

export function useConnectionPhase(ready: boolean): { phase: ConnectionPhase; since: number } {
  const [state, setState] = useState<{ phase: ConnectionPhase; since: number }>({ phase: "online", since: 0 });
  const watchRef = useRef<ReturnType<typeof createConnectionWatch> | null>(null);
  if (!watchRef.current) {
    watchRef.current = createConnectionWatch({
      onPhase: (phase, since) => setState({ phase, since }),
      onFx: (fxState) => emitFx({ type: "connection", state: fxState }),
    });
  }
  useEffect(() => { watchRef.current?.update(ready); }, [ready]);
  useEffect(() => () => watchRef.current?.dispose(), []);
  return state;
}

function useElapsedSeconds(since: number, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, since]);
  return Math.max(0, Math.floor((now - since) / 1000));
}

/** 「已等待 N 秒」那顆會往上滾的數字，給其他長時間等待（作戰室…）共用。 */
export function ElapsedSeconds({ since }: { since: number }) {
  return <RollingNumber value={useElapsedSeconds(since, true)} />;
}

export function ConnectionBanner({ ready, reason }: { ready: boolean; reason: ConnectionReason }) {
  const { phase, since } = useConnectionPhase(ready);
  // 原因在「斷掉那一刻」定案：重連後 App 會把 restartPending 清掉，不能讓「已回來」
  // 那一拍突然從大卡縮回小卡。
  const latched = useRef<ConnectionReason>(reason);
  if (phase === "online" || (phase === "down" && reason !== "blip")) latched.current = reason;
  const variant = phase === "online" ? reason : latched.current;
  const elapsed = useElapsedSeconds(since, phase === "down");
  if (phase === "online") return null;

  const down = phase === "down";
  const title = down
    ? variant === "restart" ? t("伺服器重啟中") : variant === "update" ? t("正在安裝新版") : t("本機服務連線中斷")
    : t("已回來");
  const eyebrow = down ? (variant === "blip" ? "RECONNECTING" : "REBOOTING") : "ONLINE";
  return (
    <div className={`pc-conn pc-conn--${variant === "blip" ? "blip" : "reboot"}`} data-phase={phase} role="status" aria-live="polite">
      <div className="pc-conn__card">
        <span className="pc-conn__rack" aria-hidden="true"><i /><i /><i /></span>
        <div className="pc-conn__copy">
          <span className="pc-conn__eyebrow">{eyebrow}</span>
          <strong key={phase} className="pc-conn__title">{title}</strong>
          <small>
            {down
              ? <>{t("正在重新上線…")} <span className="pc-conn__elapsed">{t("已等待")} <RollingNumber value={elapsed} /> {t("秒")}</span></>
              : t("連線恢復，畫面已同步")}
          </small>
          <span className="pc-conn__bar" aria-hidden="true">
            {Array.from({ length: SEGMENTS }, (_, index) => <i key={index} style={{ "--seg": index } as CSSProperties} />)}
          </span>
          {down && variant === "blip" && <small className="pc-conn__note">{t("現有畫面會保留，不用重新整理")}</small>}
        </div>
        {!down && <svg className="pc-conn__check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>}
      </div>
    </div>
  );
}
