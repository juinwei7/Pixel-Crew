import type { BossTask, DepartmentMission, WorkerState } from "./types";
import { t } from "./i18n";

// 任務看板的純攤平邏輯：把既有的 BOSS 任務（AI 拆解的部門 stages）與部門
// Mission（每步驟有指派 NPC 的執行計畫）攤平成卡片、依狀態分四欄。自
// KanbanModal 的 useMemo 原封搬出，行為不變——資料抓取、5 秒刷新與渲染
// 都留在元件裡，這裡不發起任何執行。

export type ColumnId = "todo" | "doing" | "attention" | "done";

export type Card = {
  key: string;
  icon: string;
  title: string;
  assignee: string;
  group: string;
  detail: string;
  /** ISO timestamp for done-column ordering（新完成的排前面）。 */
  when: string | null;
};

export const COLUMNS: Array<{ id: ColumnId; label: string }> = [
  { id: "todo", label: t("📥 待辦") },
  { id: "doing", label: t("🏃 進行中") },
  { id: "attention", label: t("⚠️ 需要處理") },
  { id: "done", label: t("✅ 已完成") },
];

const STEP_ICON = { execute: "🔧", review: "🔎", consult: "💬", synthesize: "📎" } as const;
const ATTENTION_REASON: Record<string, string> = {
  plan_approval: t("計畫等你核准"),
  review_inconclusive: t("審查沒有結論，等你決定"),
  correction_limit: t("修正次數用完，等你指示"),
  step_failed: t("步驟失敗，等你指示"),
  member_unavailable: t("成員不在了，等你調度"),
};
export const DONE_LIMIT = 30;
/** 完成超過三天的 Mission 不再佔版面。 */
export const DONE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export function buildKanbanColumns(
  missions: DepartmentMission[] | null,
  bossTasks: BossTask[],
  workers: Array<Pick<WorkerState, "id" | "name">>,
  now: number = Date.now(),
): Record<ColumnId, Card[]> {
  const byColumn: Record<ColumnId, Card[]> = { todo: [], doing: [], attention: [], done: [] };
  const workerName = (id: string) => workers.find((worker) => worker.id === id)?.name ?? t("（已離職）");
  const push = (column: ColumnId, card: Card) => byColumn[column].push(card);

  for (const mission of missions ?? []) {
    if (mission.status === "cancelled") continue;
    const finished = mission.status === "completed" || mission.status === "failed";
    if (finished && mission.completedAt && now - Date.parse(mission.completedAt) > DONE_WINDOW_MS) continue;
    const group = mission.objective.slice(0, 60);

    if (mission.status === "needs_attention") {
      push("attention", {
        key: `mission-${mission.id}`,
        icon: "🧑‍💼",
        title: ATTENTION_REASON[mission.attentionReason ?? ""] ?? t("等你處理"),
        assignee: t("老闆（你）"),
        group,
        detail: mission.error ?? mission.planSummary ?? mission.objective,
        when: null,
      });
    }
    if (mission.status === "planning" && mission.steps.length === 0) {
      push("doing", {
        key: `mission-${mission.id}`,
        icon: "🧠",
        title: t("AI 正在拆解任務…"),
        assignee: workerName(mission.bossWorkerId),
        group,
        detail: mission.objective,
        when: null,
      });
    }
    for (const step of mission.steps) {
      const column: ColumnId = step.status === "completed" ? "done"
        : step.status === "failed" ? "attention"
        : step.status === "running" ? "doing"
        : "todo";
      push(column, {
        key: `step-${mission.id}-${step.id}`,
        icon: STEP_ICON[step.kind] ?? "🔧",
        title: step.title,
        assignee: workerName(step.assigneeWorkerId),
        group,
        detail: step.result ?? step.objective,
        when: step.completedAt,
      });
    }
  }

  for (const task of bossTasks) {
    if (task.archivedAt || task.status === "cancelled") continue;
    if (task.status === "needs_input") {
      push("attention", {
        key: `boss-${task.id}`,
        icon: "🧑‍💼",
        title: t("AI 有問題想先問你"),
        assignee: t("老闆（你）"),
        group: task.title.slice(0, 60),
        detail: task.messages[task.messages.length - 1]?.text ?? task.objective,
        when: null,
      });
    }
    for (const stage of task.stages) {
      if (stage.missionId) continue; // 已開成 Mission 的 stage 由步驟卡呈現
      const column: ColumnId = stage.status === "completed" ? "done"
        : stage.status === "needs_attention" || stage.status === "failed" ? "attention"
        : stage.status === "running" ? "doing"
        : "todo";
      push(column, {
        key: `stage-${task.id}-${stage.id}`,
        icon: "🏢",
        title: stage.title,
        assignee: stage.departmentName,
        group: task.title.slice(0, 60),
        detail: stage.report ?? stage.objective,
        when: null,
      });
    }
  }

  byColumn.done.sort((a, b) => (b.when ?? "").localeCompare(a.when ?? ""));
  return byColumn;
}
