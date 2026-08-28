import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../api";
import { t } from "../i18n";
import { Modal } from "./Modal";
import { buildKanbanColumns, COLUMNS, DONE_LIMIT } from "../kanban";
import type { BossTask, DepartmentMission, WorkerState } from "../types";

// 任務看板：把既有的 BOSS 任務（AI 拆解的部門 stages）與部門 Mission（每步驟
// 有指派 NPC 的執行計畫）攤平成卡片，依狀態分四欄。純視圖——資料與流程都復用
// 現有系統，這裡不發起任何執行。開著時每 5 秒刷新，關閉即停。攤平邏輯抽在
// ../kanban.ts（純函式），這裡只負責抓資料與渲染。

type Props = {
  workers: WorkerState[];
  onOpenBoss(): void;
  onClose(): void;
};

export function KanbanModal({ workers, onOpenBoss, onClose }: Props) {
  const [missions, setMissions] = useState<DepartmentMission[] | null>(null);
  const [bossTasks, setBossTasks] = useState<BossTask[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [m, b] = await Promise.all([
          apiRequest<{ missions: DepartmentMission[] }>("/api/missions"),
          apiRequest<{ bossTasks: BossTask[] }>("/api/boss-tasks"),
        ]);
        if (cancelled) return;
        setMissions(m.missions ?? []);
        setBossTasks(b.bossTasks ?? []);
        setError(null);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const columns = useMemo(() => buildKanbanColumns(missions, bossTasks, workers), [missions, bossTasks, workers]);

  const total = COLUMNS.reduce((sum, column) => sum + columns[column.id].length, 0);

  return (
    <Modal label={t("任務看板")} eyebrow="📋 TASK BOARD" title={t("任務看板")} cardClassName="warroom-result__card kanban-modal" onClose={onClose}>
        {error && <p className="kanban__error">{error}</p>}
        {missions === null ? (
          <p className="ops-modal__empty">{t("讀取中…")}</p>
        ) : total === 0 ? (
          <div className="kanban__empty">
            <p>{t("看板還是空的。點「BOSS 交辦工作」，用一句話描述目標，AI 會拆解成卡片、指派給各部門 NPC，進度都會出現在這裡。")}</p>
            <button type="button" onClick={() => { onClose(); onOpenBoss(); }}>{t("🧑‍💼 BOSS 交辦工作")}</button>
          </div>
        ) : (
          <div className="kanban__columns">
            {COLUMNS.map((column) => {
              const cards = column.id === "done" ? columns.done.slice(0, DONE_LIMIT) : columns[column.id];
              const hidden = columns[column.id].length - cards.length;
              return (
                <section key={column.id} className={`kanban__column kanban__column--${column.id}`}>
                  <h3>{column.label}<em>{columns[column.id].length}</em></h3>
                  <div className="kanban__cards">
                    {cards.map((card) => (
                      <details key={card.key} className="kanban__card">
                        <summary>
                          <span className="kanban__card-title">{card.icon} {card.title}</span>
                          <span className="kanban__card-meta">
                            <b>{card.assignee}</b>
                            <i title={card.group}>{card.group}</i>
                          </span>
                        </summary>
                        <p>{card.detail}</p>
                      </details>
                    ))}
                    {hidden > 0 && <small className="kanban__more">{t("…還有 {count} 張較舊的完成卡", { count: hidden })}</small>}
                  </div>
                </section>
              );
            })}
          </div>
        )}
    </Modal>
  );
}
