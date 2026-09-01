import { useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest } from "../api";
import { t } from "../i18n";
import { Modal } from "./Modal";
import type { WorkerState } from "../types";

type CostRow = { day: string; workerId: string; workerName: string; costUsd: number };
type Schedule = { id: string; workerId: string; time: string; prompt: string; enabled: boolean; lastRunDay: string | null };
type Diagnostics = { enabled: boolean; diagnostics: { generatedAt: string; scope: string; privacy: string; missions: { total: number; completed: number; failed: number; successRate: number | null; failuresByReason: Array<{ reason: string; count: number }> }; responsiveness: { websocketReconnects: number; longUiTasks: number; medianFps: number | null; fpsBand: string; medianApprovalWaitSeconds: number | null } } };

type Props = {
  workers: WorkerState[];
  notify: (message: string, kind?: "info" | "error") => void;
  onClose(): void;
};

export function OpsModal({ workers, notify, onClose }: Props) {
  const [tab, setTab] = useState<"costs" | "schedules" | "diagnostics">("costs");
  const [costs, setCosts] = useState<CostRow[] | null>(null);
  const [today, setToday] = useState("");
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [newWorkerId, setNewWorkerId] = useState(workers[0]?.id ?? "");
  const [newTime, setNewTime] = useState("09:00");
  const [newPrompt, setNewPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  // 每日預算草稿：workerId → 輸入框文字（"" = 無上限）。
  const [budgets, setBudgets] = useState<Record<string, string>>({});
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);

  const loadCosts = useCallback(async () => {
    try {
      const data = await apiRequest<{ costs: CostRow[]; today: string; budgets?: Array<{ workerId: string; dailyUsd: number }> }>("/api/costs?days=14");
      setCosts(data.costs);
      setToday(data.today);
      setBudgets(Object.fromEntries((data.budgets ?? []).map((entry) => [entry.workerId, String(entry.dailyUsd)])));
    } catch (error) {
      notify(error instanceof Error ? error.message : t("讀取成本資料失敗"), "error");
    }
  }, [notify]);

  async function saveBudget(workerId: string) {
    const raw = (budgets[workerId] ?? "").trim();
    try {
      await apiRequest(`/api/workers/${encodeURIComponent(workerId)}/budget`, {
        method: "POST",
        body: { dailyUsd: raw === "" ? null : Number(raw) },
      });
      notify(raw === "" ? t("已取消預算上限") : t("每日上限已設為 ${amount}", { amount: Number(raw).toFixed(2) }));
    } catch (error) {
      notify(error instanceof Error ? error.message : t("儲存預算失敗"), "error");
    }
  }

  const loadSchedules = useCallback(async () => {
    try {
      const data = await apiRequest<{ schedules: Schedule[] }>("/api/schedules");
      setSchedules(data.schedules);
    } catch (error) {
      notify(error instanceof Error ? error.message : t("讀取排程失敗"), "error");
    }
  }, [notify]);

  useEffect(() => { void loadCosts(); void loadSchedules(); }, [loadCosts, loadSchedules]);
  const loadDiagnostics = useCallback(async () => {
    try { setDiagnostics(await apiRequest<Diagnostics>("/api/diagnostics")); }
    catch (error) { notify(error instanceof Error ? error.message : t("讀取本機診斷失敗"), "error"); }
  }, [notify]);
  useEffect(() => { if (tab === "diagnostics") void loadDiagnostics(); }, [tab, loadDiagnostics]);

  const dayTotals = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of costs ?? []) map.set(row.day, (map.get(row.day) ?? 0) + row.costUsd);
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [costs]);
  const maxDayTotal = Math.max(0.0001, ...dayTotals.map(([, value]) => value));
  const todayRows = useMemo(
    () => (costs ?? []).filter((row) => row.day === today).sort((a, b) => b.costUsd - a.costUsd),
    [costs, today],
  );
  const maxTodayCost = Math.max(0.0001, ...todayRows.map((row) => row.costUsd));
  const workerName = (id: string) => workers.find((worker) => worker.id === id)?.name;

  async function addSchedule() {
    if (!newWorkerId || !newPrompt.trim()) { notify(t("請選擇 NPC 並填寫指示"), "error"); return; }
    setSaving(true);
    try {
      const data = await apiRequest<{ schedules: Schedule[] }>("/api/schedules", { method: "POST", body: { workerId: newWorkerId, time: newTime, prompt: newPrompt.trim() } });
      setSchedules(data.schedules);
      setNewPrompt("");
      notify(t("排程已建立：每日 {time}", { time: newTime }));
    } catch (error) {
      notify(error instanceof Error ? error.message : t("建立排程失敗"), "error");
    } finally {
      setSaving(false);
    }
  }

  async function toggleSchedule(schedule: Schedule) {
    try {
      const data = await apiRequest<{ schedules: Schedule[] }>(`/api/schedules/${schedule.id}`, { method: "PATCH", body: { enabled: !schedule.enabled } });
      setSchedules(data.schedules);
    } catch (error) {
      notify(error instanceof Error ? error.message : t("更新排程失敗"), "error");
    }
  }

  async function removeSchedule(schedule: Schedule) {
    try {
      const data = await apiRequest<{ schedules: Schedule[] }>(`/api/schedules/${schedule.id}`, { method: "DELETE" });
      setSchedules(data.schedules);
      notify(t("排程已刪除"));
    } catch (error) {
      notify(error instanceof Error ? error.message : t("刪除排程失敗"), "error");
    }
  }

  return (
    <Modal label={t("營運面板")} eyebrow="📊 OPERATIONS" title={t("營運面板")} cardClassName="warroom-result__card ops-modal" onClose={onClose}>
        <div className="ops-modal__tabs" role="tablist">
          <button type="button" role="tab" className={tab === "costs" ? "active" : ""} onClick={() => setTab("costs")}>{t("💰 成本日報")}</button>
          <button type="button" role="tab" className={tab === "schedules" ? "active" : ""} onClick={() => setTab("schedules")}>{t("⏰ 排程任務")}</button>
          <button type="button" role="tab" className={tab === "diagnostics" ? "active" : ""} onClick={() => setTab("diagnostics")}>{t("📈 本機診斷")}</button>
        </div>

        {tab === "costs" && (
          <div className="ops-modal__body">
            <h3>{t("💸 每日預算上限（達標後當天不再接新指示，隔天自動恢復）")}</h3>
            <div className="ops-budget__list">
              {workers.map((worker) => (
                <div key={worker.id} className="ops-budget__row">
                  <span className="ops-costs__label ops-costs__label--npc" title={worker.name}>{worker.name}</span>
                  <span className="ops-budget__input">
                    $<input
                      type="number"
                      min="0"
                      step="0.5"
                      placeholder={t("無上限")}
                      value={budgets[worker.id] ?? ""}
                      onChange={(event) => setBudgets((prev) => ({ ...prev, [worker.id]: event.target.value }))}
                    />
                  </span>
                  <button type="button" onClick={() => void saveBudget(worker.id)}>{t("儲存")}</button>
                </div>
              ))}
            </div>
            {costs === null ? <p className="ops-modal__empty">{t("讀取中…")}</p> : dayTotals.length === 0 ? <p className="ops-modal__empty">{t("最近 14 天還沒有成本紀錄。")}</p> : (
              <>
                <h3>{t("每日總花費（近 14 天）")}</h3>
                <div className="ops-costs__days">
                  {dayTotals.map(([day, total]) => (
                    <div key={day} className={`ops-costs__row ${day === today ? "ops-costs__row--today" : ""}`}>
                      <span className="ops-costs__label">{day.slice(5)}</span>
                      <span className="ops-costs__track"><span className="ops-costs__fill" style={{ width: `${Math.max(2, (total / maxDayTotal) * 100)}%` }} /></span>
                      <span className="ops-costs__value">${total.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
                {todayRows.length > 0 && (
                  <>
                    <h3>{t("今日各 NPC")}</h3>
                    <div className="ops-costs__days">
                      {todayRows.map((row) => (
                        <div key={row.workerId} className="ops-costs__row">
                          <span className="ops-costs__label ops-costs__label--npc" title={workerName(row.workerId) ?? row.workerName}>{workerName(row.workerId) ?? row.workerName ?? t("（已刪除）")}</span>
                          <span className="ops-costs__track"><span className="ops-costs__fill ops-costs__fill--npc" style={{ width: `${Math.max(2, (row.costUsd / maxTodayCost) * 100)}%` }} /></span>
                          <span className="ops-costs__value">${row.costUsd.toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}

        {tab === "schedules" && (
          <div className="ops-modal__body">
            <h3>{t("新增排程（每天固定時間把指示交給 NPC）")}</h3>
            <div className="ops-schedule__form">
              <select value={newWorkerId} onChange={(event) => setNewWorkerId(event.target.value)} aria-label={t("選擇 NPC")}>
                {workers.map((worker) => <option key={worker.id} value={worker.id}>{worker.name}</option>)}
              </select>
              <input type="time" value={newTime} onChange={(event) => setNewTime(event.target.value)} aria-label={t("每日時間")} />
              <textarea
                value={newPrompt}
                onChange={(event) => setNewPrompt(event.target.value)}
                placeholder={t("例：查一下今天的科技新聞，挑三則重要的整理成摘要給我")}
                rows={2}
              />
              <button type="button" disabled={saving} onClick={() => void addSchedule()}>{saving ? t("建立中…") : t("＋ 新增")}</button>
            </div>
            <h3>{t("現有排程")}</h3>
            {schedules === null ? <p className="ops-modal__empty">{t("讀取中…")}</p> : schedules.length === 0 ? <p className="ops-modal__empty">{t("還沒有排程。上面新增一個吧。")}</p> : (
              <ul className="ops-schedule__list">
                {schedules.map((schedule) => (
                  <li key={schedule.id} className={schedule.enabled ? "" : "ops-schedule__item--off"}>
                    <div className="ops-schedule__meta">
                      <strong>{schedule.time}</strong>
                      <span>{workerName(schedule.workerId) ?? t("（NPC 已刪除）")}</span>
                      {schedule.lastRunDay && <small>{t("上次執行 {day}", { day: schedule.lastRunDay })}</small>}
                    </div>
                    <p className="ops-schedule__prompt">{schedule.prompt}</p>
                    <div className="ops-schedule__actions">
                      <button type="button" onClick={() => void toggleSchedule(schedule)}>{schedule.enabled ? t("暫停") : t("啟用")}</button>
                      <button type="button" className="ops-schedule__delete" onClick={() => void removeSchedule(schedule)}>{t("刪除")}</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {tab === "diagnostics" && <div className="ops-modal__body">
          {diagnostics === null ? <p className="ops-modal__empty">{t("讀取中…")}</p> : <>
            <p className="ops-diagnostics__privacy">{t("只儲存在此裝置，不會上傳。診斷包不含 prompt、路徑、模型或工具輸出。")}</p>
            <div className="ops-diagnostics__grid">
              <div><small>{t("Mission 成功率")}</small><strong>{diagnostics.diagnostics.missions.successRate == null ? "—" : `${diagnostics.diagnostics.missions.successRate}%`}</strong></div>
              <div><small>{t("完成／失敗")}</small><strong>{diagnostics.diagnostics.missions.completed}／{diagnostics.diagnostics.missions.failed}</strong></div>
              <div><small>{t("WebSocket 重連")}</small><strong>{diagnostics.diagnostics.responsiveness.websocketReconnects}</strong></div>
              <div><small>{t("3D FPS 分級")}</small><strong>{diagnostics.diagnostics.responsiveness.fpsBand === "unknown" ? "—" : diagnostics.diagnostics.responsiveness.fpsBand}</strong></div>
            </div>
            <h3>{t("Mission 失敗原因")}</h3>
            {diagnostics.diagnostics.missions.failuresByReason.length === 0 ? <p className="ops-modal__empty">{t("尚無失敗紀錄。")}</p> : <ul className="ops-diagnostics__reasons">{diagnostics.diagnostics.missions.failuresByReason.map((entry) => <li key={entry.reason}><span>{entry.reason}</span><strong>{entry.count}</strong></li>)}</ul>}
            <p className="ops-diagnostics__meta">{t("長 UI 工作：{count}；中位 FPS：{fps}；核准中位等待：{wait} 秒", { count: diagnostics.diagnostics.responsiveness.longUiTasks, fps: diagnostics.diagnostics.responsiveness.medianFps ?? "—", wait: diagnostics.diagnostics.responsiveness.medianApprovalWaitSeconds ?? "—" })}</p>
            <a className="ops-diagnostics__export" href="/api/diagnostics/export" download>{t("匯出去識別化診斷包 (.json)")}</a>
          </>}
        </div>}
    </Modal>
  );
}
