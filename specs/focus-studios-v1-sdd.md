# Focus Studios v1 — SDD Specification

## Status

- Decision: approved for implementation from the user's request on 2026-08-31.
- Delivery: local implementation and verification only. Do not push Git.

## Problem

Focus Reader is good for reading one NPC's report, but an engineer working across
repositories or Git worktrees has to infer the current workspace from a long NPC
selector. Switching context is slow and does not expose the information needed to
resume work safely: branch, uncommitted changes, the active agent, and its model.

## Goal

Turn Focus Reader into a lightweight engineering cockpit. It must make the current
workspace explicit and allow a user to move between already-managed workspaces in
one action, without performing Git mutations.

## v1 scope

1. Show a persistent, left-side **STUDIOS** rail in Focus Reader, one entry for
   every managed `workspacePath`. It starts collapsed and can be expanded without
   covering the report index or document canvas.
2. Each entry shows a readable workspace name, worker count, active/attention
   signal, and a compact Git state (branch, short HEAD, clean/changed file count).
3. Selecting a studio switches to its last locally remembered NPC when it still
   exists; otherwise it selects the first worker in that workspace. The visible
   department/boss/search context is cleared exactly as it is for selecting an NPC.
   The Focus Reader NPC selector then lists only NPCs belonging to that studio.
4. The currently selected studio is visibly selected and the Focus Reader header
   displays its Git identity.
5. The existing Focus Energy inspector continues to show the selected NPC's
   provider and concrete model. The studio rail must not claim that provider quota
   is workspace-specific.
6. Add non-editing shortcuts in Focus Reader: `Alt+1` through `Alt+9` select the
   first nine studios. Existing Cmd/Ctrl shortcuts remain unchanged.
7. Git inspection is read-only, bounded, and permitted only for already-managed
   workspace paths. It never checks out, fetches, stages, commits, or changes a
   worktree.

## Non-goals

- Creating, deleting, renaming, or automatically checking out Git worktrees.
- Embedding an unrestricted terminal, split panes, or a file editor.
- Altering worker persistence, authentication, department mission execution, or
  provider usage accounting.
- Persisting server-side workspace configuration in v1. The browser persists only
  the last NPC it selected for each existing managed workspace; server truth for
  managed paths remains the worker registry.

## Data contract

`GET /api/workspaces/git?workspacePath=<managed path>` returns:

```ts
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
```

- `available: false` is a normal outcome for a managed folder that is not a Git
  repository. It returns no internal command output.
- `ahead` and `behind` are `null` when no upstream is configured.
- The server validates the path with the existing managed-workspace guard before
  spawning Git. Every command has a short timeout and bounded output.

## UX requirements

1. The rail uses semantic navigation (`nav`, labelled STUDIOS) and buttons with
   descriptive accessible names.
2. The collapsed rail shows compact studio marks and state dots; expanding it
   reveals name, Git state, worker count, and shortcut. The expansion is a normal
   grid column, never an overlay above the report index.
2. Keyboard shortcuts do nothing while typing in an input, textarea, select, or
   contenteditable element.
3. A studio that has no worker is shown but disabled; this prevents a hidden
   workspace from looking selectable while preserving server truth.
4. The rail stays within the Focus Reader viewport. On narrow screens it becomes a
   horizontally scrollable strip above the report, never causing page overflow.
5. Git summary failure must degrade to a short neutral status, not an error dialog
   or a blocked Focus Reader.

## Acceptance criteria

- With workers in two workspaces, Focus Reader renders two distinct studio entries.
- The collapsed workspace rail does not obscure REPORT INDEX. Expanding it keeps
  both workspaces and report index separately readable.
- Selecting a studio selects a worker belonging to that workspace and displays the
  corresponding report and model/provider identity.
- Returning to a previously selected studio restores its remembered worker when
  that worker still belongs to the studio.
- The selected studio displays its branch, short commit, and clean or changed-file
  state when Git is available; a non-Git folder remains usable.
- `Alt+1` selects the first studio only outside editable controls; it does not
  interfere with Cmd/Ctrl+K, Cmd/Ctrl+J, Cmd/Ctrl+Shift+A, `?`, or Escape.
- The Git endpoint rejects unmanaged paths and never uses a mutating Git command.
- Server and web tests, both package builds, and `git diff --check` pass.

## Verification plan

1. Unit-test Git summary parsing / endpoint helper with clean, dirty, detached,
   no-upstream, and non-repository cases.
2. Unit-test studio ordering, fallback selection, collapse-preference parsing,
   workspace-filtered NPC choices, and shortcut recognition.
3. Static-render the studio rail to check accessible labels and provider/model
   visibility remains in Focus Energy.
4. Run `npm test -w server`, `npm run build -w server`, `npm test -w web`,
   `npm run build -w web`, and `git diff --check`.
5. Inspect the final diff and retain all changes locally without committing or
   pushing.

## Risks and mitigations

- **Slow or broken Git executable:** 5-second timeout, small output cap, neutral
  fallback state.
- **Path probing:** managed-workspace validation runs before Git commands.
- **Workspace context loss:** last selected NPC is persisted locally per path and
  revalidated against the current worker list before use.
- **Narrow layouts:** studio rail switches to horizontal scrolling rather than
  squeezing selector text into multiple lines.
