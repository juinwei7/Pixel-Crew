import { useMemo, useState } from "react";
import type { WorkerState, Department } from "../types";
import { theme, setTheme } from "../theme";
import { t } from "../i18n";
import "./ModernWorkspace.css";

// 第二套介面：亮色「工作台」。跟像素世界共用同一份資料（隊員／部門），
// 但走完全不同的語言——editorial-utility：單色暖底 + 單一橙色重點、細線分隔的名冊
// （不是卡片網格）、資料用等寬字、狀態用文字不用發光圓點。切換鈕切回像素。
// 這是產品介面不是 landing page，取設計技能的反範本原則：鎖一個重點色、統一圓角、去除俗套 tell。

// 頭像底色：同明度、低飽和的一組中性色（不是彩虹），維持「設計過」而非隨機。
const AVATAR_TINTS = ["#6b7280", "#8a6d5b", "#6f7f6a", "#5f7284", "#7d6b82", "#948055"];

function initials(name: string): string {
  const s = name.trim();
  if (!s) return "?";
  if (/[一-鿿]/.test(s)) return s.slice(0, 1);
  const p = s.split(/\s+/);
  return (p[0][0] + (p[1]?.[0] ?? "")).toUpperCase();
}

type Props = {
  workers: WorkerState[];
  departments: Department[];
  active: WorkerState | null;
  onSelect: (id: string) => void;
  totalCostUsd: number;
  completedTurns: number;
};

export function ModernWorkspace({ workers, departments, active, onSelect, totalCostUsd, completedTurns }: Props) {
  const [deptFilter, setDeptFilter] = useState<string | null>(null);

  const shown = useMemo(
    () => (deptFilter ? workers.filter((w) => w.departmentId === deptFilter) : workers),
    [workers, deptFilter],
  );
  const busyCount = workers.filter((w) => w.busy).length;
  const headTitle = deptFilter ? departments.find((d) => d.id === deptFilter)?.name ?? t("全部隊員") : t("全部隊員");

  return (
    <div className="mw">
      <header className="mw-top">
        <div className="mw-top__brand">
          <strong>PIXEL CREW</strong>
          <span>{t("現代工作台")}</span>
        </div>
        <div className="mw-top__stats">
          <span>{workers.length} {t("位隊員")}</span>
          <span className="mw-top__accent">{busyCount} {t("工作中")}</span>
          <span>{completedTurns} {t("累計回合")}</span>
          <span>${totalCostUsd.toFixed(2)}</span>
        </div>
        <button type="button" className="mw-top__toggle" onClick={() => setTheme("pixel")} title={t("切換視覺主題：像素風 / 現代工作台")}>
          {t("像素")} <span className="mw-top__toggle-sep">/</span> <b>{t("現代")}</b>
        </button>
      </header>

      <div className="mw-body">
        <nav className="mw-side" aria-label={t("部門")}>
          <p className="mw-side__label">{t("部門")}</p>
          <button type="button" className={`mw-side__item ${deptFilter === null ? "is-active" : ""}`} onClick={() => setDeptFilter(null)}>
            <span>{t("全部隊員")}</span>
            <em>{workers.length}</em>
          </button>
          {departments.map((dept) => (
            <button
              key={dept.id}
              type="button"
              className={`mw-side__item ${deptFilter === dept.id ? "is-active" : ""}`}
              onClick={() => setDeptFilter(dept.id)}
            >
              <span>{dept.name}</span>
              <em>{workers.filter((w) => w.departmentId === dept.id).length}</em>
            </button>
          ))}
        </nav>

        <main className="mw-main">
          <div className="mw-main__head">
            <h1>{headTitle}</h1>
            <span>{shown.length} {t("位隊員")}</span>
          </div>
          <ul className="mw-roster">
            {shown.map((w) => {
              const role = w.persona?.role ?? w.model ?? t("隊員");
              return (
                <li key={w.id}>
                  <button type="button" className={`mw-row ${active?.id === w.id ? "is-active" : ""}`} onClick={() => onSelect(w.id)}>
                    <span className="mw-row__avatar" style={{ background: AVATAR_TINTS[w.colorIndex % AVATAR_TINTS.length] }}>{initials(w.name)}</span>
                    <span className="mw-row__id">
                      <span className="mw-row__name">{w.name}</span>
                      <span className="mw-row__role">{role}</span>
                    </span>
                    <span className="mw-row__model">{w.model ?? "—"}</span>
                    <span className={`mw-row__status ${w.busy ? "is-busy" : "is-idle"}`}>{w.busy ? t("工作中") : t("待命")}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </main>

        {active && (
          <aside className="mw-detail" aria-label={t("隊員細節")}>
            <span className="mw-detail__avatar" style={{ background: AVATAR_TINTS[active.colorIndex % AVATAR_TINTS.length] }}>{initials(active.name)}</span>
            <h2 className="mw-detail__name">{active.name}</h2>
            <p className="mw-detail__role">{active.persona?.role ?? t("隊員")}</p>
            <span className={`mw-detail__status ${active.busy ? "is-busy" : "is-idle"}`}>{active.busy ? t("工作中") : t("待命")}</span>
            <dl className="mw-detail__meta">
              <dt>{t("供應商")}</dt><dd>{active.provider}</dd>
              <dt>{t("模型")}</dt><dd>{active.model ?? "—"}</dd>
              <dt>{t("工作區")}</dt><dd className="mw-detail__path">{active.workspacePath || "—"}</dd>
            </dl>
          </aside>
        )}
      </div>
    </div>
  );
}
