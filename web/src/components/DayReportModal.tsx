import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../api";
import { Modal } from "./Modal";
import { t } from "../i18n";

type ReportWorker = {
  workerId: string; name: string; costUsd: number;
  turns: number; userMessages: number; errors: number; dailyBudgetUsd: number | null;
};
type TimelineItem = {
  ts: string; workerId: string; workerName: string;
  kind: "user_message" | "turn_end" | "error"; text: string;
  costUsd?: number; durationMs?: number; isError?: boolean;
};
type DayReport = {
  day: string;
  today: string;
  totals: { costUsd: number; turns: number; userMessages: number; errors: number };
  workers: ReportWorker[];
  tasks: {
    bossCompleted: Array<{ id: string; title: string; completedAt: string | null }>;
    missionsCompleted: Array<{ id: string; title: string; completedAt: string | null }>;
    stepsCompleted: Array<{ missionObjective: string; stepTitle: string; assigneeName: string; completedAt: string | null }>;
    attention: Array<{ kind: "boss" | "mission"; id: string; title: string; status: string }>;
  };
  timeline: TimelineItem[];
};

type Props = {
  notify: (message: string, kind?: "info" | "error") => void;
  onClose(): void;
};

function shiftDay(day: string, delta: number): string {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() + delta);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const KIND_META: Record<TimelineItem["kind"], { icon: string; label: string }> = {
  user_message: { icon: "🗣", label: "指示" },
  turn_end: { icon: "✅", label: "回合完成" },
  error: { icon: "🔥", label: "錯誤" },
};

export function DayReportModal({ notify, onClose }: Props) {
  const [tab, setTab] = useState<"report" | "replay">("report");
  // day = "" 表示還沒載入過，首載讓後端決定「今天」是哪天（用伺服器本地時區）。
  const [day, setDay] = useState("");
  const [report, setReport] = useState<DayReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [filterWorkerId, setFilterWorkerId] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiRequest<DayReport>(`/api/day-report${day ? `?day=${day}` : ""}`)
      .then((data) => {
        if (cancelled) return;
        setReport(data);
        if (!day) setDay(data.day);
      })
      .catch((error) => {
        if (!cancelled) notify(error instanceof Error ? error.message : t("讀取下班報告失敗"), "error");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [day, notify]);

  const isToday = !report || report.day >= report.today;
  const timeline = useMemo(
    () => (report?.timeline ?? []).filter((item) => !filterWorkerId || item.workerId === filterWorkerId),
    [report, filterWorkerId],
  );
  const maxCost = Math.max(0.0001, ...(report?.workers ?? []).map((worker) => worker.costUsd));
  const completedCount = report
    ? report.tasks.bossCompleted.length + report.tasks.missionsCompleted.length + report.tasks.stepsCompleted.length
    : 0;

  // 時間軸依小時分段，回放時好找「幾點發生了什麼」。
  const timelineGroups = useMemo(() => {
    const groups: Array<{ hour: string; items: TimelineItem[] }> = [];
    for (const item of timeline) {
      const hour = `${item.ts.slice(0, 2)}:00`;
      const last = groups[groups.length - 1];
      if (last && last.hour === hour) last.items.push(item);
      else groups.push({ hour, items: [item] });
    }
    return groups;
  }, [timeline]);

  return (
    <Modal label={t("下班報告")} eyebrow="🌙 DAY REPORT" title={t("下班報告")} cardClassName="warroom-result__card ops-modal day-report" onClose={onClose}>

        <div className="day-report__nav">
          <button type="button" onClick={() => day && setDay(shiftDay(day, -1))} disabled={!day || loading}>{t("◀ 前一天")}</button>
          <strong>{report?.day ?? "…"}{isToday && report ? t("（今天）") : ""}</strong>
          <button type="button" onClick={() => day && setDay(shiftDay(day, 1))} disabled={!day || loading || isToday}>{t("後一天 ▶")}</button>
        </div>

        <div className="ops-modal__tabs" role="tablist">
          <button type="button" role="tab" className={tab === "report" ? "active" : ""} onClick={() => setTab("report")}>{t("📋 報告")}</button>
          <button type="button" role="tab" className={tab === "replay" ? "active" : ""} onClick={() => setTab("replay")}>{t("🎬 一日回放")}</button>
        </div>

        {report === null ? <p className="ops-modal__empty">{t("讀取中…")}</p> : tab === "report" ? (
          <div className="ops-modal__body">
            <div className="day-report__totals">
              <div><small>{t("總花費")}</small><strong>${report.totals.costUsd.toFixed(2)}</strong></div>
              <div><small>{t("回合")}</small><strong>{report.totals.turns}</strong></div>
              <div><small>{t("收到指示")}</small><strong>{report.totals.userMessages}</strong></div>
              <div className={report.totals.errors > 0 ? "day-report__stat--bad" : ""}><small>{t("錯誤")}</small><strong>{report.totals.errors}</strong></div>
            </div>

            <h3>{t("各 NPC 表現")}</h3>
            {report.workers.length === 0 ? <p className="ops-modal__empty">{t("這一天沒有任何活動。")}</p> : (
              <div className="ops-costs__days">
                {report.workers.map((worker) => (
                  <div key={worker.workerId} className="ops-costs__row">
                    <span className="ops-costs__label ops-costs__label--npc" title={worker.name}>{worker.name}</span>
                    <span className="ops-costs__track">
                      <span className="ops-costs__fill ops-costs__fill--npc" style={{ width: `${Math.max(2, (worker.costUsd / maxCost) * 100)}%` }} />
                    </span>
                    <span className="ops-costs__value">
                      ${worker.costUsd.toFixed(2)}{worker.dailyBudgetUsd != null ? ` / $${worker.dailyBudgetUsd.toFixed(2)}` : ""}
                    </span>
                    <small className="day-report__worker-meta">
                      {t("{turns} 回合", { turns: worker.turns })}{worker.errors > 0 ? t(" · {errors} 錯誤", { errors: worker.errors }) : ""}
                    </small>
                  </div>
                ))}
              </div>
            )}

            <h3>{t("完成的任務（{count}）", { count: completedCount })}</h3>
            {completedCount === 0 ? <p className="ops-modal__empty">{t("這一天沒有完成的任務。")}</p> : (
              <ul className="day-report__tasks">
                {report.tasks.bossCompleted.map((task) => <li key={`b-${task.id}`}>🏁 <strong>BOSS</strong> {task.title}</li>)}
                {report.tasks.missionsCompleted.map((mission) => <li key={`m-${mission.id}`}>🎯 <strong>Mission</strong> {mission.title}</li>)}
                {report.tasks.stepsCompleted.map((step, index) => (
                  <li key={`s-${index}`}>✅ {step.stepTitle} <small>{step.assigneeName} ・ {step.missionObjective}</small></li>
                ))}
              </ul>
            )}

            {report.tasks.attention.length > 0 && (
              <>
                <h3>{t("需要老闆處理（{count}）", { count: report.tasks.attention.length })}</h3>
                <ul className="day-report__tasks day-report__tasks--warn">
                  {report.tasks.attention.map((item) => (
                    <li key={`${item.kind}-${item.id}`}>⚠️ <strong>{item.kind === "boss" ? "BOSS" : "Mission"}</strong> {item.title}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ) : (
          <div className="ops-modal__body">
            <div className="day-report__filter">
              <select value={filterWorkerId} onChange={(event) => setFilterWorkerId(event.target.value)} aria-label={t("篩選 NPC")}>
                <option value="">{t("全部 NPC")}</option>
                {report.workers.map((worker) => <option key={worker.workerId} value={worker.workerId}>{worker.name}</option>)}
              </select>
              <small>{t("{count} 筆事件", { count: timeline.length })}</small>
            </div>
            {timeline.length === 0 ? <p className="ops-modal__empty">{t("這一天沒有事件。")}</p> : timelineGroups.map((group) => (
              <div key={group.hour} className="day-report__hour">
                <h3>{group.hour}</h3>
                {group.items.map((item, index) => {
                  const meta = KIND_META[item.kind];
                  const bad = item.kind === "error" || item.isError;
                  return (
                    <div key={`${item.ts}-${index}`} className={`day-report__event ${bad ? "day-report__event--bad" : ""} day-report__event--${item.kind}`}>
                      <span className="day-report__event-ts">{item.ts.slice(0, 5)}</span>
                      <span className="day-report__event-icon">{bad && item.kind === "turn_end" ? "❌" : meta.icon}</span>
                      <span className="day-report__event-body">
                        <strong>{item.workerName}</strong>
                        {item.text && <em>{item.text}</em>}
                        {item.kind === "turn_end" && (
                          <small>${(item.costUsd ?? 0).toFixed(2)} · {Math.round((item.durationMs ?? 0) / 1000)}s</small>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
    </Modal>
  );
}
