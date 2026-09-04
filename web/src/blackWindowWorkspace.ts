import type { AccountWithAuth, AutoApproveMode, ProviderId } from "./types";

export type BlackWindowMode = "raw" | "agent";
export type AccountSource = "ambient" | "managed";

export type BlackWorkspace = { id: string; title: string; defaultWorkspacePath: string };

export type BlackWindow = {
  id: string;
  /** The Workspace tab this CLI pane belongs to; it is not its cwd. */
  workspaceId: string;
  title: string;
  workspacePath: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  minimized: boolean;
  maximized: boolean;
  mode: BlackWindowMode;
  agentStarted: boolean;
  provider: ProviderId | null;
  accountSource: AccountSource;
  accountId: string | null;
  model: string;
  autoApproveMode: AutoApproveMode;
  fontSize: number;
};

export type BlackWindowLayout = { version: 2; workspaces: BlackWorkspace[]; windows: BlackWindow[]; selectedId: string | null; selectedWorkspaceId: string | null; railCollapsed: boolean };

export type BlackWindowAgentConfig = Pick<BlackWindow, "provider" | "accountSource" | "accountId" | "model" | "autoApproveMode">;

export function blackWindowAccountValue(provider: ProviderId, accountId: string | null): string {
  return `${provider}:${accountId ?? ""}`;
}

export function parseBlackWindowAccountValue(value: string): Pick<BlackWindowAgentConfig, "provider" | "accountSource" | "accountId"> | null {
  const separator = value.indexOf(":");
  if (separator < 0) return null;
  const provider = value.slice(0, separator);
  if (provider !== "codex" && provider !== "claude") return null;
  const accountId = value.slice(separator + 1) || null;
  return { provider, accountSource: accountId ? "managed" : "ambient", accountId };
}

function shellQuote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }

export function blackWindowAgentStartCommand(entry: BlackWindow, account: AccountWithAuth | undefined): string | null {
  if (!entry.provider) return null;
  if (entry.accountSource === "managed" && (!account || account.provider !== entry.provider || account.id !== entry.accountId)) return null;
  const home = entry.accountSource === "managed" && account?.homeDir
    ? (entry.provider === "codex" ? "CODEX_HOME=" : "CLAUDE_CONFIG_DIR=") + shellQuote(account.homeDir) + " "
    : "";
  if (entry.provider === "codex") {
    const options = ["--no-alt-screen", entry.model ? "--model " + shellQuote(entry.model) : ""];
    if (entry.autoApproveMode === "safe") options.push("--ask-for-approval on-request");
    if (entry.autoApproveMode === "full") options.push("--approve-for-me");
    if (entry.autoApproveMode === "invincible") options.push("--dangerously-bypass-approvals-and-sandbox");
    return home + "codex " + options.filter(Boolean).join(" ");
  }
  const permission = entry.autoApproveMode === "off" ? "manual" : entry.autoApproveMode === "safe" ? "acceptEdits" : entry.autoApproveMode === "full" ? "auto" : "bypassPermissions";
  return home + "claude " + [entry.model ? "--model " + shellQuote(entry.model) : "", "--permission-mode " + permission, entry.autoApproveMode === "invincible" ? "--dangerously-skip-permissions" : ""].filter(Boolean).join(" ");
}

/** Destroy every daemon-owned terminal before its workspace disappears. */
export async function destroyWorkspaceTerminalTabs(
  ids: string[],
  destroy: (id: string) => Promise<boolean>,
): Promise<boolean> {
  const results = await Promise.all(ids.map((id) => destroy(id)));
  return results.every(Boolean);
}

/** Rebase the geometry controlled by an active pointer gesture onto a newer
 * shared layout without discarding unrelated remote edits. */
export function mergeDraggedWindowGeometry(incoming: BlackWindowLayout, current: BlackWindowLayout, id: string): BlackWindowLayout {
  const local = current.windows.find((window) => window.id === id);
  if (!local || !incoming.windows.some((window) => window.id === id)) return incoming;
  return {
    ...incoming,
    windows: incoming.windows.map((window) => window.id === id
      ? { ...window, x: local.x, y: local.y, width: local.width, height: local.height, z: local.z }
      : window),
  };
}

export const BLACK_WINDOW_LAYOUT_KEY = "pixel-crew:black-window-layout-v1";
export const MIN_WINDOW_WIDTH = 360;
export const MIN_WINDOW_HEIGHT = 240;
export const BLACK_WINDOW_FONT_SIZE_DEFAULT = 13;
export const BLACK_WINDOW_FONT_SIZE_MIN = 10;
export const BLACK_WINDOW_FONT_SIZE_MAX = 24;

export function clampBlackWindowFontSize(value: unknown): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : BLACK_WINDOW_FONT_SIZE_DEFAULT;
  return Math.min(BLACK_WINDOW_FONT_SIZE_MAX, Math.max(BLACK_WINDOW_FONT_SIZE_MIN, numeric));
}

function id(prefix: string): string { return `${prefix}-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`; }
function titleFromPath(path: string): string { return path.split(/[/\\]/).filter(Boolean).at(-1) || "WORKSPACE"; }

export function newBlackWorkspace(workspacePath: string, index = 0): BlackWorkspace {
  return { id: id("workspace"), title: index ? `WORKSPACE ${index + 1}` : titleFromPath(workspacePath), defaultWorkspacePath: workspacePath };
}

export function newBlackWindow(workspacePath: string, offset = 0, z = 1, workspaceId = "workspace-default"): BlackWindow {
  return {
    id: id("terminal"), workspaceId, title: "CODEX", workspacePath,
    x: 28 + (offset % 7) * 26, y: 30 + (offset % 7) * 22,
    width: 720, height: 500, z, minimized: false, maximized: false,
    mode: "agent", agentStarted: false, provider: "codex", accountSource: "ambient", accountId: null,
    model: "", autoApproveMode: "off", fontSize: BLACK_WINDOW_FONT_SIZE_DEFAULT,
  };
}

/** Replace the daemon tab identity while retaining the pane itself. Account or
 * launch-option changes cannot mutate a running CLI process, so confirmed
 * changes restart it as a fresh terminal and propagate that identity to every
 * browser through the shared layout. */
export function restartBlackWindow(layout: BlackWindowLayout, windowId: string, config: BlackWindowAgentConfig, nextId = id("terminal")): BlackWindowLayout {
  if (!layout.windows.some((window) => window.id === windowId)) return layout;
  return {
    ...layout,
    selectedId: layout.selectedId === windowId ? nextId : layout.selectedId,
    windows: layout.windows.map((window) => window.id === windowId ? {
      ...window,
      ...config,
      id: nextId,
      title: config.provider?.toUpperCase() ?? "CODEX",
      mode: "agent",
      agentStarted: true,
      minimized: false,
    } : window),
  };
}

function validWindow(value: unknown): value is BlackWindow {
  if (!value || typeof value !== "object") return false;
  const w = value as Record<string, unknown>;
  return typeof w.id === "string" && typeof w.workspacePath === "string" && typeof w.x === "number" && typeof w.y === "number"
    && typeof w.width === "number" && typeof w.height === "number" && typeof w.z === "number";
}

function validWorkspace(value: unknown): value is BlackWorkspace {
  if (!value || typeof value !== "object") return false;
  const workspace = value as Record<string, unknown>;
  return typeof workspace.id === "string" && typeof workspace.title === "string" && typeof workspace.defaultWorkspacePath === "string";
}

function normalizeWindow(window: BlackWindow, workspacePath: string, index: number, workspaceId: string): BlackWindow {
  const provider = window.provider === "codex" || window.provider === "claude" ? window.provider : "codex";
  return {
    ...newBlackWindow(window.workspacePath || workspacePath, index, Math.max(1, window.z), workspaceId), ...window, workspaceId,
    title: window.title === "RAW SHELL" ? provider.toUpperCase() : window.title,
    width: Math.max(MIN_WINDOW_WIDTH, window.width), height: Math.max(MIN_WINDOW_HEIGHT, window.height),
    // Maximize was removed from the Black Window UI. Clear legacy persisted
    // state so an old layout cannot leave a pane stuck without a restore button.
    maximized: false,
    mode: "agent",
    // Layouts written before this field existed already configured daemon
    // recovery whenever they were in Agent mode, so preserve that behavior.
    agentStarted: typeof window.agentStarted === "boolean" ? window.agentStarted : window.mode === "agent",
    provider,
    accountSource: window.accountSource === "managed" ? "managed" as const : "ambient" as const,
    accountId: window.accountSource === "managed" && typeof window.accountId === "string" ? window.accountId : null,
    model: typeof window.model === "string" ? window.model : "",
    autoApproveMode: ["off", "safe", "full", "invincible"].includes(String(window.autoApproveMode)) ? window.autoApproveMode as BlackWindow["autoApproveMode"] : "off",
    fontSize: clampBlackWindowFontSize(window.fontSize),
  };
}

export function freshBlackWindowLayout(workspacePath: string): BlackWindowLayout {
  const workspace = newBlackWorkspace(workspacePath);
  const first = newBlackWindow(workspacePath, 0, 1, workspace.id);
  return { version: 2, workspaces: [workspace], windows: [first], selectedId: first.id, selectedWorkspaceId: workspace.id, railCollapsed: false };
}

export function parseBlackWindowLayout(value: unknown, workspacePath: string): BlackWindowLayout {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    if (record?.version === 2 && Array.isArray(record.workspaces) && Array.isArray(record.windows)) {
      const workspaces = record.workspaces.filter(validWorkspace).slice(0, 24);
      const fallback = workspaces[0] ?? newBlackWorkspace(workspacePath);
      const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
      const windows = record.windows.filter(validWindow).slice(0, 48).map((window, index) => normalizeWindow(window, workspacePath, index, workspaceIds.has(window.workspaceId) ? window.workspaceId : fallback.id));
      const stableWorkspaces = workspaces.length ? workspaces : [fallback];
      return {
        version: 2, workspaces: stableWorkspaces, windows,
        selectedId: typeof record.selectedId === "string" && windows.some((window) => window.id === record.selectedId) ? record.selectedId : windows[0]?.id ?? null,
        selectedWorkspaceId: typeof record.selectedWorkspaceId === "string" && stableWorkspaces.some((workspace) => workspace.id === record.selectedWorkspaceId) ? record.selectedWorkspaceId : windows[0]?.workspaceId ?? stableWorkspaces[0].id,
        railCollapsed: record.railCollapsed === true,
      };
    }
    // Migrate the original floating-window layout: each distinct cwd becomes
    // one Workspace tab, while every terminal id (and thus its mux tab)
    // stays exactly the same.
    if (record?.version === 1 && Array.isArray(record.windows)) {
      const legacy = record.windows.filter(validWindow).slice(0, 48);
      const byPath = new Map<string, BlackWorkspace>();
      for (const entry of legacy) if (!byPath.has(entry.workspacePath)) byPath.set(entry.workspacePath, newBlackWorkspace(entry.workspacePath, byPath.size));
      const workspaces = [...byPath.values()];
      if (!workspaces.length) return freshBlackWindowLayout(workspacePath);
      const windows = legacy.map((entry, index) => normalizeWindow(entry, workspacePath, index, byPath.get(entry.workspacePath)!.id));
      const selected = typeof record.selectedId === "string" ? windows.find((entry) => entry.id === record.selectedId) : undefined;
      return { version: 2, workspaces, windows, selectedId: selected?.id ?? windows[0]?.id ?? null, selectedWorkspaceId: selected?.workspaceId ?? workspaces[0].id, railCollapsed: false };
    }
  } catch { /* First run or malformed old layout. */ }
  return freshBlackWindowLayout(workspacePath);
}

export function loadBlackWindowLayout(workspacePath: string): BlackWindowLayout {
  try { return parseBlackWindowLayout(localStorage.getItem(BLACK_WINDOW_LAYOUT_KEY), workspacePath); }
  catch { return freshBlackWindowLayout(workspacePath); }
}

export function saveBlackWindowLayout(layout: BlackWindowLayout): void {
  try { localStorage.setItem(BLACK_WINDOW_LAYOUT_KEY, JSON.stringify(layout)); } catch { /* private browsing */ }
}

export function clampWindow(entry: BlackWindow, viewport = { width: globalThis.window.innerWidth, height: globalThis.window.innerHeight }): BlackWindow {
  const width = Math.min(Math.max(MIN_WINDOW_WIDTH, entry.width), Math.max(MIN_WINDOW_WIDTH, viewport.width - 20));
  const height = Math.min(Math.max(MIN_WINDOW_HEIGHT, entry.height), Math.max(MIN_WINDOW_HEIGHT, viewport.height - 20));
  return { ...entry, width, height, x: Math.max(8, Math.min(entry.x, Math.max(8, viewport.width - width - 8))), y: Math.max(8, Math.min(entry.y, Math.max(8, viewport.height - height - 8))) };
}

export function snapWindow(window: BlackWindow, peers: BlackWindow[], viewport = { width: globalThis.window.innerWidth, height: globalThis.window.innerHeight }): BlackWindow {
  const gap = 14;
  let { x, y } = clampWindow(window, viewport);
  const edges = [8, viewport.width - window.width - 8];
  const topBottom = [8, viewport.height - window.height - 8];
  for (const edge of edges) if (Math.abs(x - edge) <= gap) x = edge;
  for (const edge of topBottom) if (Math.abs(y - edge) <= gap) y = edge;
  for (const peer of peers) {
    if (peer.id === window.id || peer.minimized || peer.maximized) continue;
    for (const edge of [peer.x, peer.x + peer.width]) if (Math.abs(x - edge) <= gap) x = edge;
    for (const edge of [peer.y, peer.y + peer.height]) if (Math.abs(y - edge) <= gap) y = edge;
  }
  return { ...window, x, y };
}
