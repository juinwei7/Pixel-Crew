import { useCallback, useEffect, useState } from "react";

export type TaskLogView = "summary" | "activity";
export type CrewFilter = "all" | "working" | "attention" | "claude" | "codex" | "room";

export type UiPreferencesV2 = {
  version: 2;
  taskLogWidth: number;
  taskLogView: TaskLogView;
  taskLogOpen: boolean;
  crewRailCollapsed: boolean;
  crewFilter: CrewFilter;
  reducedDetail: boolean;
  notificationsEnabled: boolean;
};

export const UI_PREFERENCES_KEY = "pixel-crew:ui-preferences-v2";

export const DEFAULT_UI_PREFERENCES: UiPreferencesV2 = {
  version: 2,
  taskLogWidth: 600,
  taskLogView: "summary",
  taskLogOpen: true,
  crewRailCollapsed: false,
  crewFilter: "all",
  reducedDetail: false,
  notificationsEnabled: false,
};

const VIEWS = new Set<TaskLogView>(["summary", "activity"]);
const FILTERS = new Set<CrewFilter>(["all", "working", "attention", "claude", "codex", "room"]);

export function clampTaskLogWidth(width: number, viewportWidth = 916): number {
  return Math.round(Math.max(400, Math.min(width, 860, Math.max(400, viewportWidth - 56))));
}

export function parseUiPreferences(value: unknown, viewportWidth?: number): UiPreferencesV2 {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const width = typeof raw.taskLogWidth === "number" && Number.isFinite(raw.taskLogWidth)
    ? raw.taskLogWidth
    : DEFAULT_UI_PREFERENCES.taskLogWidth;
  return {
    version: 2,
    taskLogWidth: clampTaskLogWidth(width, viewportWidth),
    taskLogView: typeof raw.taskLogView === "string" && VIEWS.has(raw.taskLogView as TaskLogView)
      ? raw.taskLogView as TaskLogView
      : DEFAULT_UI_PREFERENCES.taskLogView,
    taskLogOpen: typeof raw.taskLogOpen === "boolean" ? raw.taskLogOpen : DEFAULT_UI_PREFERENCES.taskLogOpen,
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
