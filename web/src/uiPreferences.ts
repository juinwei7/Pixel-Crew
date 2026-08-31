import { useCallback, useEffect, useState } from "react";

export type TaskLogView = "summary" | "activity";
export type CrewFilter = "all" | "working" | "attention" | "claude" | "codex" | "room";

export type FocusPaneLayout = 1 | 2 | 3 | 4;

export type UiPreferencesV2 = {
  version: 6;
  taskLogWidth: number;
  taskLogHeight: number;
  taskLogView: TaskLogView;
  taskLogOpen: boolean;
  crewRailCollapsed: boolean;
  crewFilter: CrewFilter;
  reducedDetail: boolean;
  notificationsEnabled: boolean;
  taskFocusMode: boolean;
  focusStudioLastWorkerIds: Record<string, string>;
  focusStudiosCollapsed: boolean;
  focusPaneLayout: FocusPaneLayout;
};

export const UI_PREFERENCES_KEY = "pixel-crew:ui-preferences-v2";
export const COMPACT_OFFICE_MAX_WIDTH = 1440;

export const DEFAULT_UI_PREFERENCES: UiPreferencesV2 = {
  version: 6,
  taskLogWidth: 600,
  taskLogHeight: 62,
  taskLogView: "summary",
  taskLogOpen: true,
  crewRailCollapsed: false,
  crewFilter: "all",
  reducedDetail: false,
  notificationsEnabled: false,
  taskFocusMode: false,
  focusStudioLastWorkerIds: {},
  focusStudiosCollapsed: true,
  focusPaneLayout: 1,
};

const VIEWS = new Set<TaskLogView>(["summary", "activity"]);
const FILTERS = new Set<CrewFilter>(["all", "working", "attention", "claude", "codex", "room"]);
const PANE_LAYOUTS = new Set<FocusPaneLayout>([1, 2, 3, 4]);

function studioWorkerIds(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([workspacePath, workerId]) => workspacePath.length > 0 && workspacePath.length <= 2_000 && typeof workerId === "string" && workerId.length > 0 && workerId.length <= 200)
    .slice(0, 100));
}

export function clampTaskLogWidth(width: number, viewportWidth = 916): number {
  return Math.round(Math.max(400, Math.min(width, 860, Math.max(400, viewportWidth - 56))));
}

// Phone-only: the log becomes a bottom sheet whose height (in vh) the user drags.
// Kept between "just a peek" and "almost full screen" so the office and the ▶ toggle
// never get fully swallowed.
export function clampTaskLogHeight(heightVh: number): number {
  if (!Number.isFinite(heightVh)) return DEFAULT_UI_PREFERENCES.taskLogHeight;
  return Math.round(Math.max(34, Math.min(heightVh, 92)));
}

export function enteredCompactOffice(previousWidth: number, currentWidth: number): boolean {
  return Number.isFinite(previousWidth)
    && previousWidth > COMPACT_OFFICE_MAX_WIDTH
    && currentWidth <= COMPACT_OFFICE_MAX_WIDTH;
}

// Focus Reader is a full-screen mode. Its report panel must stay mounted while
// resizing; otherwise the normal office's compact auto-collapse leaves only the
// composer visible and there is no focus-mode control to reopen the report.
export function shouldAutoCollapseTaskLog(previousWidth: number, currentWidth: number, taskFocusMode: boolean): boolean {
  return !taskFocusMode && enteredCompactOffice(previousWidth, currentWidth);
}

// The panel may be collapsed while using the office, but Focus Reader owns the
// full screen and cannot offer a meaningful "re-open panel" affordance. Keep
// this as a single invariant so a stale persisted taskLogOpen=false can never
// render an empty reader after a resize or a reload.
export function isTaskLogVisible(taskLogOpen: boolean, taskFocusMode: boolean): boolean {
  return taskFocusMode || taskLogOpen;
}

export function parseUiPreferences(value: unknown, viewportWidth?: number): UiPreferencesV2 {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const recoveringLegacyPanelState = raw.version === 2;
  const width = typeof raw.taskLogWidth === "number" && Number.isFinite(raw.taskLogWidth)
    ? raw.taskLogWidth
    : DEFAULT_UI_PREFERENCES.taskLogWidth;
  return {
    version: 6,
    taskLogWidth: clampTaskLogWidth(width, viewportWidth),
    taskLogHeight: clampTaskLogHeight(
      typeof raw.taskLogHeight === "number" ? raw.taskLogHeight : DEFAULT_UI_PREFERENCES.taskLogHeight,
    ),
    taskLogView: typeof raw.taskLogView === "string" && VIEWS.has(raw.taskLogView as TaskLogView)
      ? raw.taskLogView as TaskLogView
      : DEFAULT_UI_PREFERENCES.taskLogView,
    taskLogOpen: recoveringLegacyPanelState
      ? true
      : typeof raw.taskLogOpen === "boolean" ? raw.taskLogOpen : DEFAULT_UI_PREFERENCES.taskLogOpen,
    crewRailCollapsed: typeof raw.crewRailCollapsed === "boolean"
      ? raw.crewRailCollapsed
      : DEFAULT_UI_PREFERENCES.crewRailCollapsed,
    crewFilter: typeof raw.crewFilter === "string" && FILTERS.has(raw.crewFilter as CrewFilter)
      ? raw.crewFilter as CrewFilter
      : DEFAULT_UI_PREFERENCES.crewFilter,
    reducedDetail: typeof raw.reducedDetail === "boolean" ? raw.reducedDetail : DEFAULT_UI_PREFERENCES.reducedDetail,
    notificationsEnabled: typeof raw.notificationsEnabled === "boolean"
      ? raw.notificationsEnabled
      : DEFAULT_UI_PREFERENCES.notificationsEnabled,
    taskFocusMode: typeof raw.taskFocusMode === "boolean"
      ? raw.taskFocusMode
      : DEFAULT_UI_PREFERENCES.taskFocusMode,
    focusStudioLastWorkerIds: studioWorkerIds(raw.focusStudioLastWorkerIds),
    focusStudiosCollapsed: typeof raw.focusStudiosCollapsed === "boolean"
      ? raw.focusStudiosCollapsed
      : DEFAULT_UI_PREFERENCES.focusStudiosCollapsed,
    focusPaneLayout: typeof raw.focusPaneLayout === "number" && PANE_LAYOUTS.has(raw.focusPaneLayout as FocusPaneLayout)
      ? raw.focusPaneLayout as FocusPaneLayout
      : DEFAULT_UI_PREFERENCES.focusPaneLayout,
  };
}

function readPreferences(): UiPreferencesV2 {
  if (typeof window === "undefined") return DEFAULT_UI_PREFERENCES;
  try {
    const stored = window.localStorage.getItem(UI_PREFERENCES_KEY);
    return parseUiPreferences(stored ? JSON.parse(stored) : null, window.innerWidth);
  } catch {
    return parseUiPreferences(null, window.innerWidth);
  }
}

export function useUiPreferences() {
  const [preferences, setPreferences] = useState<UiPreferencesV2>(readPreferences);

  useEffect(() => {
    try {
      window.localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify(preferences));
    } catch {
      // The UI remains usable when private browsing blocks local storage.
    }
  }, [preferences]);

  useEffect(() => {
    const resize = () => setPreferences((current) => ({
      ...current,
      taskLogWidth: clampTaskLogWidth(current.taskLogWidth, window.innerWidth),
    }));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  const updatePreferences = useCallback((patch: Partial<Omit<UiPreferencesV2, "version">>) => {
    setPreferences((current) => parseUiPreferences({ ...current, ...patch }, window.innerWidth));
  }, []);

  const resetPreferences = useCallback(() => {
    setPreferences(parseUiPreferences(DEFAULT_UI_PREFERENCES, window.innerWidth));
  }, []);

  return { preferences, updatePreferences, resetPreferences };
}
