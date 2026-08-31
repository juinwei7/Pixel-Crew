import type { ReactNode } from "react";
import type { ApprovalDecision, Department, WorkerState } from "../types";
import type { TaskLogView } from "../uiPreferences";
import type { FocusPane } from "../focusPanes";
import { QuestLog } from "./QuestLog";
import { t } from "../i18n";

type DepartmentGroup = { department: Department; workers: WorkerState[] };

type Props = {
  panes: FocusPane[];
  focusedPaneId: string;
  workers: Record<string, WorkerState>;
  departmentGroups: DepartmentGroup[];
  standaloneWorkers: WorkerState[];
  workerLabel(worker: WorkerState, unread: boolean): string;
  isUnread(worker: WorkerState): boolean;
  view: TaskLogView;
  searchQuery: string;
  maxPanes: number;
  studioRail: ReactNode;
  onFocusPane(paneId: string): void;
  onAssignWorker(paneId: string, workerId: string): void;
  onAddPane(): void;
  onRemovePane(paneId: string): void;
  onApprove(approvalId: string, decision: ApprovalDecision): Promise<string | null>;
};

// Split view trades the single reader's report-nav/pinning chrome (it assumes
// one generous reading column) for compact logs that actually fit side by
// side — each pane still renders inside .holo-panel--focus, so it inherits
// the same dark reader palette as the single-pane reader.
export function FocusPaneGrid({
  panes, focusedPaneId, workers, departmentGroups, standaloneWorkers, workerLabel, isUnread,
  view, searchQuery, maxPanes, studioRail, onFocusPane, onAssignWorker, onAddPane, onRemovePane, onApprove,
}: Props) {
  return (
    <div className="focus-workbench">
      <aside className="focus-workbench__rail">{studioRail}</aside>
      <div className={`focus-pane-grid focus-pane-grid--${panes.length}`}>
        {panes.map((pane) => {
          const worker = pane.workerId ? workers[pane.workerId] : undefined;
          const focused = pane.id === focusedPaneId;
          return (
            <section
              key={pane.id}
              className={`focus-pane ${focused ? "focus-pane--focused" : ""}`}
              aria-label={worker ? worker.name : t("空白分頁")}
              onMouseDownCapture={() => onFocusPane(pane.id)}
            >
              <header className="focus-pane__header">
                <select
                  aria-label={t("切換分頁 NPC")}
                  value={pane.workerId ?? ""}
                  onChange={(event) => onAssignWorker(pane.id, event.target.value)}
                >
                  {!pane.workerId && <option value="" disabled>{t("選擇 NPC")}</option>}
                  {departmentGroups.map(({ department, workers: departmentWorkers }) => (
                    <optgroup key={department.id} label={department.name}>
                      {departmentWorkers.map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {workerLabel(candidate, candidate.id !== pane.workerId && isUnread(candidate))}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                  {standaloneWorkers.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {workerLabel(candidate, candidate.id !== pane.workerId && isUnread(candidate))}
                    </option>
                  ))}
                </select>
                {panes.length > 1 && (
                  <button type="button" className="focus-pane__close" aria-label={t("關閉這個分頁")} title={t("關閉這個分頁")} onClick={() => onRemovePane(pane.id)}>×</button>
                )}
              </header>
              <div className="focus-pane__body">
                {worker ? (
                  <QuestLog
                    key={pane.id}
                    readerKey={`pane:${pane.id}:${worker.id}`}
                    turns={worker.turns}
                    view={view}
                    searchQuery={focused ? searchQuery : ""}
                    onApprove={onApprove}
                  />
                ) : (
                  <div className="focus-pane__empty">{t("這個分頁還沒有指派 NPC，從左側選一個工作區或用上面的選單指派。")}</div>
                )}
              </div>
            </section>
          );
        })}
        {panes.length < maxPanes && (
          <button type="button" className="focus-pane-grid__add" onClick={onAddPane}>{t("＋ 分割視窗")}</button>
        )}
      </div>
    </div>
  );
}
