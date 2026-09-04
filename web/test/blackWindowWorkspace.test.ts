import assert from "node:assert/strict";
import test from "node:test";
import { clampWindow, destroyWorkspaceTerminalTabs, freshBlackWindowLayout, mergeDraggedWindowGeometry, MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, newBlackWindow, newBlackWorkspace, parseBlackWindowLayout, snapWindow } from "../src/blackWindowWorkspace";

test("new black windows begin as isolated raw shells", () => {
  const entry = newBlackWindow("/repo", 2, 9);
  assert.equal(entry.workspacePath, "/repo");
  assert.equal(entry.mode, "raw");
  assert.equal(entry.agentStarted, false);
  assert.equal(entry.provider, null);
  assert.equal(entry.z, 9);
});

test("only explicitly started Agent panes arm automatic recovery", () => {
  const workspace = newBlackWorkspace("/repo");
  const freshAgent = { ...newBlackWindow("/repo", 0, 1, workspace.id), mode: "agent" as const, provider: "codex" as const };
  assert.equal(freshAgent.agentStarted, false);

  // Older layouts had no marker because Agent mode itself used to arm mux
  // recovery. Preserve those already-configured sessions during migration.
  const legacyAgent = { ...freshAgent } as Partial<typeof freshAgent>;
  delete legacyAgent.agentStarted;
  const parsed = parseBlackWindowLayout({ version: 2, workspaces: [workspace], windows: [legacyAgent] }, "/repo");
  assert.equal(parsed.windows[0]?.agentStarted, true);
});

test("legacy maximized panes reopen at their saved window geometry", () => {
  const workspace = newBlackWorkspace("/repo");
  const legacy = { ...newBlackWindow("/repo", 0, 1, workspace.id), maximized: true };
  const parsed = parseBlackWindowLayout({ version: 2, workspaces: [workspace], windows: [legacy] }, "/repo");
  assert.equal(parsed.windows[0]?.maximized, false);
});

test("a Workspace tab owns its CLI panes independently of their cwd", () => {
  const layout = freshBlackWindowLayout("/repo-a");
  const workspace = layout.workspaces[0];
  const second = newBlackWindow("/repo-b", 1, 2, workspace.id);
  assert.equal(layout.windows[0].workspaceId, workspace.id);
  assert.equal(second.workspaceId, workspace.id);
  assert.notEqual(second.workspacePath, workspace.defaultWorkspacePath);
});

test("window geometry is bounded inside the engineering desktop", () => {
  const entry = { ...newBlackWindow("/repo"), x: -100, y: -100, width: 40, height: 30 };
  const bounded = clampWindow(entry, { width: 900, height: 700 });
  assert.equal(bounded.width, MIN_WINDOW_WIDTH);
  assert.equal(bounded.height, MIN_WINDOW_HEIGHT);
  assert.ok(bounded.x >= 8);
  assert.ok(bounded.y >= 8);
});

test("dragging near an edge snaps the window without touching peers", () => {
  const entry = { ...newBlackWindow("/repo"), x: 16, y: 16 };
  const snapped = snapWindow(entry, [], { width: 1200, height: 800 });
  assert.equal(snapped.x, 8);
  assert.equal(snapped.y, 8);
});

test("a new Workspace's title is the trailing repo folder, on POSIX or Windows paths", () => {
  assert.equal(newBlackWorkspace("/Users/dev/repo").title, "repo");
  assert.equal(newBlackWorkspace("C:\\Users\\alice\\AppData\\Local\\repo").title, "repo");
  assert.equal(newBlackWorkspace("C:\\Users\\alice\\repo\\").title, "repo");
});

test("workspace deletion waits for every direct daemon destroy and reports partial failure", async () => {
  const completed: string[] = [];
  let releaseSecond!: () => void;
  const second = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const deleting = destroyWorkspaceTerminalTabs(["terminal-a", "terminal-b"], async (id) => {
    if (id === "terminal-b") await second;
    completed.push(id);
    return id !== "terminal-a";
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(completed, ["terminal-a"]);
  releaseSecond();
  assert.equal(await deleting, false);
  assert.deepEqual(completed, ["terminal-a", "terminal-b"]);
});

test("a remote layout received during dragging keeps remote edits and the local final geometry", () => {
  const workspace = newBlackWorkspace("/repo", 0);
  const dragged = newBlackWindow("/repo", 0, 1, workspace.id);
  const peer = newBlackWindow("/repo", 1, 2, workspace.id);
  const current = { version: 2 as const, workspaces: [workspace], windows: [{ ...dragged, x: 444, y: 222 }, peer], selectedWorkspaceId: workspace.id, selectedId: dragged.id, railCollapsed: false };
  const incoming = { ...current, windows: [{ ...dragged, x: 10, y: 10, title: "remote title" }, { ...peer, minimized: true }] };
  const merged = mergeDraggedWindowGeometry(incoming, current, dragged.id);
  assert.equal(merged.windows[0]?.x, 444);
  assert.equal(merged.windows[0]?.y, 222);
  assert.equal(merged.windows[0]?.title, "remote title");
  assert.equal(merged.windows[1]?.minimized, true);
});

test("a remotely deleted window is not resurrected after its local drag ends", () => {
  const workspace = newBlackWorkspace("/repo", 0);
  const dragged = newBlackWindow("/repo", 0, 1, workspace.id);
  const current = { version: 2 as const, workspaces: [workspace], windows: [dragged], selectedWorkspaceId: workspace.id, selectedId: dragged.id, railCollapsed: false };
  const incoming = { ...current, windows: [] };
  assert.equal(mergeDraggedWindowGeometry(incoming, current, dragged.id).windows.length, 0);
});
