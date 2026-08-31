import { useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest } from "../api";
import { t } from "../i18n";
import type { FocusStudio } from "../focusStudios";

type WorkspaceGitSummary = {
  workspacePath: string;
  available: boolean;
  branch: string | null;
  head: string | null;
  changedFiles: number;
  ahead: number | null;
  behind: number | null;
  message: string | null;
};

type Props = {
  studios: FocusStudio[];
  activeWorkspace: string;
  collapsed: boolean;
  onCollapsedChange(collapsed: boolean): void;
  onSelect(workspacePath: string): void;
  onCreateNpc(): void;
};

function gitState(summary: WorkspaceGitSummary | undefined): string {
  if (!summary) return t("讀取 Git 狀態中");
  if (!summary.available) return summary.message ?? t("非 Git 工作位置");
  const divergence = summary.ahead == null || summary.behind == null ? "" : ` ↑${summary.ahead} ↓${summary.behind}`;
  return summary.changedFiles > 0 ? `${summary.changedFiles} ${t("個變更")}${divergence}` : `${t("乾淨")}${divergence}`;
}

function gitIdentity(summary: WorkspaceGitSummary | undefined): string {
  if (!summary?.available) return "";
  return [summary.branch, summary.head].filter(Boolean).join(" · ");
}

function studioMark(name: string): string {
  return [...name].slice(0, 2).join("").toLocaleUpperCase();
}

export function FocusStudios({ studios, activeWorkspace, collapsed, onCollapsedChange, onSelect, onCreateNpc }: Props) {
  const [summaries, setSummaries] = useState<Record<string, WorkspaceGitSummary>>({});
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const pathKey = useMemo(() => studios.map((studio) => studio.workspacePath).join("\u0000"), [studios]);
  const visibleStudios = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return studios.map((studio, index) => ({ studio, index }));
    return studios
      .map((studio, index) => ({ studio, index }))
      .filter(({ studio }) => `${studio.name} ${studio.workspacePath}`.toLocaleLowerCase().includes(needle));
  }, [query, studios]);

  const refresh = useCallback(async (cancelled?: () => boolean) => {
    const workspacePaths = pathKey ? pathKey.split("\u0000") : [];
    if (workspacePaths.length === 0) return;
    setLoading(true);
    const results = await Promise.all(workspacePaths.map(async (workspacePath) => {
      try {
        return await apiRequest<WorkspaceGitSummary>(`/api/workspaces/git?workspacePath=${encodeURIComponent(workspacePath)}`, { timeoutMs: 6_000 });
      } catch {
        return { workspacePath, available: false, branch: null, head: null, changedFiles: 0, ahead: null, behind: null, message: t("Git 狀態目前無法讀取") } satisfies WorkspaceGitSummary;
      }
    }));
    if (cancelled?.()) return;
    setSummaries(Object.fromEntries(results.map((summary) => [summary.workspacePath, summary])));
    setUpdatedAt(Date.now());
    setLoading(false);
  }, [pathKey]);

  useEffect(() => {
    let disposed = false;
    void refresh(() => disposed);
    return () => { disposed = true; };
  }, [refresh]);

  if (studios.length === 0) return null;
  return <nav className={`focus-studios ${collapsed ? "focus-studios--collapsed" : ""}`} aria-label={t("工作室快速切換")}>
    <header className="focus-studios__header">
      <span className="focus-studios__eyebrow">STUDIOS</span>
      {!collapsed && <span className="focus-studios__updated" title={updatedAt ? new Date(updatedAt).toLocaleTimeString() : undefined}>{loading ? t("更新中…") : updatedAt ? t("Git 已更新") : t("Git 狀態")}</span>}
      <button type="button" className="focus-studios__refresh" disabled={loading} aria-label={t("重新整理 Git 狀態")} title={t("重新整理 Git 狀態（不會 fetch）")} onClick={() => void refresh()}>{loading ? "…" : "↻"}</button>
      <button type="button" className="focus-studios__collapse" aria-label={collapsed ? t("展開工作室列") : t("收合工作室列")} title={collapsed ? t("展開工作室列") : t("收合工作室列")} aria-pressed={!collapsed} onClick={() => onCollapsedChange(!collapsed)}>{collapsed ? "›" : "‹"}</button>
    </header>
    {!collapsed && <label className="focus-studios__search">
      <span aria-hidden="true">⌕</span>
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("搜尋工作室")} aria-label={t("搜尋工作室")} />
      {query && <button type="button" onClick={() => setQuery("")} aria-label={t("清除工作室搜尋")} title={t("清除工作室搜尋")}>×</button>}
    </label>}
    <div className="focus-studios__list">
      <button type="button" className="focus-studios__create" onClick={onCreateNpc} aria-label={t("＋ 新增 NPC")} title={t("＋ 新增 NPC")}>
        <span className="focus-studios__create-mark" aria-hidden="true">+</span>
        <span className="focus-studios__create-label">{t("新增 NPC")}</span>
      </button>
      {visibleStudios.map(({ studio, index }) => {
        const summary = summaries[studio.workspacePath];
        const selected = studio.workspacePath === activeWorkspace;
        const shortcut = index < 9 ? `Alt+${index + 1}` : null;
        const status = studio.attentionCount > 0 ? t("需處理 {count}", { count: String(studio.attentionCount) }) : studio.busyCount > 0 ? t("工作中 {count}", { count: String(studio.busyCount) }) : t("待命");
        return <button key={studio.workspacePath} type="button" className={`focus-studios__studio ${selected ? "focus-studios__studio--active" : ""}`} disabled={studio.workerIds.length === 0} aria-pressed={selected} aria-keyshortcuts={shortcut ?? undefined} aria-label={`${studio.name} · ${status} · ${gitIdentity(summary) || gitState(summary)}${shortcut ? ` · ${shortcut}` : ""}`} onClick={() => onSelect(studio.workspacePath)}>
          <span className="focus-studios__mark" aria-hidden="true">{studioMark(studio.name)}</span>
          <span className="focus-studios__name"><i className={studio.attentionCount > 0 ? "focus-studios__signal--attention" : studio.busyCount > 0 ? "focus-studios__signal--busy" : ""} />{studio.name}</span>
          <span className="focus-studios__meta"><b>{studio.workerIds.length} NPC</b>{shortcut && <kbd>{shortcut}</kbd>}</span>
          <span className="focus-studios__git">{gitIdentity(summary) || gitState(summary)}</span>
        </button>;
      })}
      {visibleStudios.length === 0 && <p className="focus-studios__empty" role="status">{t("沒有符合的工作室")}</p>}
    </div>
  </nav>;
}
