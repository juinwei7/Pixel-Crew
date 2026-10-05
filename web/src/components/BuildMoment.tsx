import type { CSSProperties } from "react";
import { t } from "../i18n";
import { ElapsedSeconds } from "./ConnectionBanner";

// 建立 NPC／部門的兩個介面瞬間（樣式在 styles/motion-ui.css）：
//   PixelBuild：建造中——四塊像素磚一塊一塊疊上去、疊滿再重來，取代「請稍候…」
//   BuildDone ：建好了——工位（桌＋螢幕）由下而上搭起來、螢幕亮起打勾，
//               接著卡片收掉，辦公室那邊由場景接手演新人走進來。

/** 建立成功後停留多久才關閉視窗（含工位搭建＋打勾）。reduced-motion 下也維持，
 *  讓「建好了」至少被看見一眼。 */
export const BUILD_DONE_MS = 1150;

export function PixelBuild({ label }: { label: string }) {
  return (
    <span className="pc-build" role="status">
      <span className="pc-build__bricks" aria-hidden="true"><i /><i /><i /><i /></span>
      <span>{label}</span>
    </span>
  );
}

export function BuildDone({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="pc-build-done" role="status" aria-live="polite">
      <span className="pc-build-done__station" aria-hidden="true">
        <i className="pc-build-done__monitor"><svg viewBox="0 0 24 24"><path d="M6 12.5l4 4L18 8.5" /></svg></i>
        <i className="pc-build-done__stand" />
        <i className="pc-build-done__desk" />
        <i className="pc-build-done__spark pc-build-done__spark--a" />
        <i className="pc-build-done__spark pc-build-done__spark--b" />
        <i className="pc-build-done__spark pc-build-done__spark--c" />
      </span>
      <strong>{title}</strong>
      <small>{detail ?? t("新隊員正走進辦公室")}</small>
    </div>
  );
}

/** 視窗載入中的骨架卡（App 的 lazy 視窗 Suspense fallback）。樣式在 motion-ux.css。 */
export function PanelSkeleton() {
  return (
    <div className="pc-panel-skel" role="status" aria-label={t("載入中…")}>
      <div className="pc-panel-skel__card">
        <i className="pc-panel-skel__title" />
        <div className="pc-skel">
          {[0, 1, 2].map((index) => <span key={index} className="pc-skel__row" style={{ "--i": index } as CSSProperties}><i className="pc-skel__icon" /><i className="pc-skel__line" /><i className="pc-skel__meta" /></span>)}
        </div>
      </div>
    </div>
  );
}

/** 長時間動作的等待條：一段光在像素軌道裡跑＋「已進行 N 秒」。 */
export function WaitingStatus({ label, since }: { label: string; since: number }) {
  return (
    <span className="pc-waiting" role="status" aria-live="polite">
      <span>{label}</span>
      <span className="pc-waiting__elapsed">{t("已進行")} <ElapsedSeconds since={since} /> {t("秒")}</span>
      <span className="pc-indeterminate" aria-hidden="true" />
    </span>
  );
}
