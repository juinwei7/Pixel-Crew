# Pixel Crew — UI Product Refinement V2 SDD

- Status: **Implemented — automated acceptance passed**
- Date: 2026-07-15
- Scope: Web UI information architecture, interaction hierarchy, local UI preferences, responsive behavior
- Out of scope: provider runtime protocol, database schema, authentication flow, NPC capacity, room/session semantics

## 1. Background

Pixel Crew already has a distinct pixel-office identity and a capable local Agent runtime, but the interface still exposes too many concepts at equal visual weight. Provider settings, system health, MCP status, workers, room location, task events, approvals, commands, and rich results all compete on one screen.

The next iteration should feel less like a debug cockpit and more like a calm office product: the room remains the visual anchor, the currently selected worker is obvious, and detailed technical information appears only when it is useful.

## 2. Product principles

1. **Office first.** The pixel office remains fixed and never resizes when floating UI panels open or change width.
2. **Progressive disclosure.** Show task outcome and current state first; reveal raw provider events, INPUT, and OUTPUT on demand.
3. **One primary action per region.** Each section should have a clear dominant action and quieter secondary controls.
4. **Provider honesty.** Claude and Codex differences remain explicit where capabilities differ; the UI does not pretend they are identical.
5. **Local by default.** Presentation preferences stay in browser-local storage. No project files are created for UI preferences.
6. **Pixel restraint.** Pixel art belongs to the office. Panels use clean editorial typography, subtle cyan accents, and limited glow.

## 3. Fixed product decisions

- Maximum permanent NPC count remains 20.
- One local folder equals one room.
- Changing provider or room follows the existing empty-session reuse rules.
- The task log is a floating overlay and may cover the office.
- The office does not reflow around the task log, crew rail, command palette, or top bar.
- Existing interactive approval behavior remains prominent and cannot be hidden by summary mode.
- Existing Markdown and safe HTML rendering remain unchanged.

## 4. Goals

- Reduce the number of always-visible labels and controls.
- Make 10–20 NPCs manageable without turning the left rail into a dense debug list.
- Make long Agent runs readable at a glance while retaining full diagnostic detail.
- Make command discovery useful before the user knows the exact slash command.
- Give loading, waiting, approval, failure, interruption, and reconnect states distinct visual treatment.
- Preserve the current dark office identity while improving spacing, typography, and consistency.

## 5. Non-goals

- A full desktop-window system with freely movable panels.
- Cloud synchronization of UI preferences.
- A mobile-first office editor.
- Replacing PixiJS or redrawing the office assets.
- Adding new Claude or Codex provider capabilities in this iteration.
- Changing server-side task history retention.

## 6. Desktop information architecture

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ PIXEL CREW     Room                         Agent settings   System health │
├────────────┬─────────────────────────────────────────────────────────────┤
│ Crew rail  │                                                             │
│            │                    FIXED PIXEL OFFICE                       │
│ Filters    │                                                             │
│ Workers    │                              ┌────────────────────────────┐ │
│            │                              │ Floating task log          │ │
│ + Add      │                              │ Summary / Activity         │ │
│            │                              │ Approval / Result          │ │
├────────────┴──────────────────────────────┴────────────────────────────┤
│                Command composer / command palette                       │
└──────────────────────────────────────────────────────────────────────────┘
```

The diagram describes visual ownership, not a CSS grid. The office remains full-stage; the rail and log are overlays.

## 7. Workstream A — top bar and room identity

### Current issue

MCP count, provider, model, provider readiness, server readiness, and room identity have similar emphasis. Long readiness labels consume space without helping during normal operation.

### Proposed design

- Keep `PIXEL CREW` as the visual anchor on the left.
- Place the current room beside the title as a compact breadcrumb:
  - room name is always visible;
  - full path appears in a tooltip or expanded popover;
  - clicking opens the existing room picker.
- Group provider and model into one `Agent settings` cluster.
- Replace verbose green readiness strings with two quiet status lights:
  - Provider CLI;
  - Local server.
- Hovering or clicking a light opens the detailed status and login action.
- MCP becomes a capability button with connected count and warning state, visually subordinate to provider selection.
- Remove the separate large room banner after the compact room control is complete.

### States

- Healthy: low-emphasis green dot.
- Checking: cyan pulse with `檢查中` tooltip.
- Login required: amber dot and visible action badge.
- Missing CLI or server offline: red dot and concise diagnostic popover.

## 8. Workstream B — scalable crew rail

### Current issue

The vertical worker list works for three NPCs but becomes difficult to scan at 10–20. Names, provider, room, model, busy state, rename, avatar, and remove actions compete inside each row.

### Proposed design

- Add a compact rail header with:
  - `CREW n/20`;
  - search button/input;
  - filter button;
  - primary `+` add action.
- Default row shows only:
  - color/avatar marker;
  - name;
  - one status glyph;
  - provider badge.
- Room and model move to a hover card or selected-row detail.
- Secondary actions appear in a row overflow menu: rename, avatar, change room, remove.
- Status priority:
  1. waiting for approval;
  2. failed;
  3. working;
  4. completed recently;
  5. idle.
- Filters:
  - All;
  - Working;
  - Needs attention;
  - Claude;
  - Codex;
  - Current room.
- Search matches NPC name and room name.
- The selected NPC remains visible when filters change. If it does not match, it appears in a small pinned section above results.
- Rows stay in stable existing order; filtering never reorders them.
- Destructive removal uses a compact confirmation only when the worker has conversation history or is busy.

### Optional follow-up, not required for V2

- Drag-and-drop manual ordering.
- Named teams or departments.

## 9. Workstream C — task log reading hierarchy

### Current issue

Provider events, tool calls, thinking, raw output, final responses, and approvals share the same vertical stream. Long tasks force users to read the implementation process to find the answer.

### Proposed views

The task log keeps its existing resize rail and width presets, and gains two view modes:

#### Summary — default

- Turn header: command, status, duration, cost when available.
- Current step: one live activity row.
- Approvals: always expanded and sticky below the panel header until resolved.
- Failures: always expanded with the real reason.
- Final response: expanded.
- Completed tool calls: collapsed into a single summary group.
- Thinking: hidden behind an explicit disclosure.

#### Activity

- Shows the full chronological event stream.
- INPUT and live OUTPUT remain available.
- Consecutive tools continue to group, but individual rows are expandable.
- Background Agent activity is visually nested under its parent Agent call.

### Additional behavior

- Add a `jump to latest` button only when the user has scrolled away from the bottom.
- Do not force-scroll while the user is reading older content.
- Add `copy` to command, final response, code block, and tool output regions.
- Add in-panel search for the current worker's rendered turns; search is client-side and does not modify persisted history.
- Preserve the current panel width locally.
- A panel width below 500px automatically hides nonessential metadata but does not change the selected view mode.

## 10. Workstream D — command composer and discovery

### Current issue

The composer supports slash completion, but command discovery is still based on already knowing that `/` exists. Claude commands and Codex workflows also need clearer provider context.

### Proposed design

- Keep one stable bottom composer.
- Replace the large provider-specific library label with a compact command icon and provider badge.
- Opening the palette can be triggered by:
  - `/`;
  - command button;
  - `Cmd/Ctrl + K`.
- Palette sections:
  - recent commands;
  - project commands/workflows;
  - suggested built-in actions;
  - manage commands.
- Each result shows name, one-line description, provider, and source.
- Selecting a command with parameters inserts a template into the composer instead of immediately running it.
- Command history:
  - `ArrowUp/ArrowDown` when the palette is closed;
  - last 50 commands per workspace and provider;
  - derived from the existing locally persisted Worker turn history, with no duplicate browser storage;
  - duplicate consecutive entries collapse.
- `Enter` runs; `Shift+Enter` is reserved for a future multiline composer and must not submit unexpectedly.
- Busy worker behavior remains explicit: the input is disabled and the primary action becomes `中止`.

## 11. Workstream E — office interaction and speech

- Preserve the current fixed scene and construction/removal animation.
- Selected NPC:
  - full nameplate;
  - complete recent speech bubble;
  - desk outline.
- Background busy NPC:
  - one-line compact bubble;
  - subtle animated status mark on the nameplate.
- Background idle NPC:
  - no speech bubble;
  - subdued nameplate.
- Bubble collision avoidance remains selected-first.
- Clicking an NPC selects it; double-clicking opens the task log if closed.
- Hovering a permanent NPC shows a compact identity card with provider, model, room, and current state.
- Temporary subagents remain visually distinct and never appear as permanent crew rows.
- Office animations must not move DOM controls or change the office camera.

## 12. Workstream F — feedback and error states

Create a shared visual vocabulary instead of placing arbitrary error strings inside the composer.

### Toasts

Use for short, non-blocking outcomes:

- renamed;
- avatar updated;
- room changed;
- MCP refreshed;
- preference saved.

Toasts dismiss automatically and are also announced through an ARIA live region.

### Inline errors

Use beside the action that failed:

- command submission;
- approval resolution;
- rename;
- file/folder selection;
- avatar validation.

### Persistent banners

Use only for conditions requiring user action:

- provider login required;
- CLI missing;
- server disconnected;
- current worker session could not resume.

### Skeletons

- Model list, MCP status, and workflow library use quiet skeleton rows while loading.
- Never display an empty dropdown as if loading had completed.

## 13. Workstream G — visual system cleanup

### Spacing

Adopt a 4px base scale with primary steps: 4, 8, 12, 16, 24, 32.

### Radius

- Small controls: 6–8px.
- Cards: 10–12px.
- Floating panels: 16px.
- Pills only for status and compact filters.

### Typography

- UI text uses the system sans stack.
- Monospace is reserved for paths, commands, provider names, model names, status codes, and pixel-office labels.
- Avoid letter spacing on Chinese body text.
- Final responses use the most generous line height; raw output uses the most compact.

### Color

- Cyan: navigation and selection.
- Green: completed or healthy only.
- Amber: waiting for user action.
- Red: failure or destructive action.
- Purple: temporary subagents and secondary Agent orchestration.
- Reduce decorative glow by approximately 30%; retain glow for focus, active work, and alerts.

### Motion

- Micro interaction: 120–180ms.
- Panel transition: 220–280ms.
- Office/NPC transition: 700–1400ms.
- Respect `prefers-reduced-motion`; state must remain understandable with motion disabled.

## 14. Responsive behavior

### ≥ 1280px

- Full crew rail.
- Floating task log with all width presets.
- Full top-bar clusters.

### 900–1279px

- Crew rail may collapse to avatar/name rows.
- Task log remains overlay; maximum width is viewport minus 24px.
- Health text is tooltip-only.

### 600–899px

- Crew rail becomes a slide-over drawer.
- Task log opens as a nearly full-width overlay.
- Top bar shows room, provider, and a single system menu.

### < 600px

- Supported for task review and simple commands, not for full office management.
- Office stays visible behind overlays but may be partially cropped at its existing minimum pixel scale.
- Modals use full-screen sheets.

## 15. Accessibility and keyboard behavior

- All icon-only controls require an accessible label and tooltip.
- Visible focus rings use cyan without relying on glow alone.
- Minimum pointer target: 32×32px desktop, 40×40px touch layouts.
- Status is communicated with text or icon shape in addition to color.
- `Escape` closes the topmost popover, palette, drawer, or modal.
- `Cmd/Ctrl + K`: command palette.
- `Cmd/Ctrl + J`: toggle task log.
- `Cmd/Ctrl + Shift + A`: jump to the worker needing approval.
- Focus returns to the invoking control when a modal or popover closes.
- Task updates and toasts use polite ARIA announcements; approval requests use assertive announcement once.

## 16. Local preference model

Use one versioned browser-local object:

```ts
type UiPreferencesV2 = {
  version: 2;
  taskLogWidth: number;
  taskLogView: "summary" | "activity";
  taskLogOpen: boolean;
  crewRailCollapsed: boolean;
  crewFilter: "all" | "working" | "attention" | "claude" | "codex" | "room";
  reducedDetail: boolean;
};
```

- Invalid or unknown values fall back independently instead of discarding the whole object.
- Preference migration is client-only.
- Command history is derived at runtime from existing Worker turns and is not copied into the preference object.
- No conversation content, command text, tool input, tool output, token, or absolute path is added to preference storage.

## 17. Component boundaries

Proposed additions/refactors:

- `TopBar`
  - `RoomControl`
  - `AgentSettings`
  - `SystemHealth`
- `CrewRail`
  - `CrewFilters`
  - `WorkerRow`
  - `WorkerActions`
- `TaskLogPanel`
  - `TaskLogToolbar`
  - `ApprovalShelf`
  - existing `QuestLog`
- `CommandComposer`
  - `CommandPalette`
  - `CommandHistory`
- `ToastRegion`
- `useUiPreferences`
- `useKeyboardShortcuts`

The existing provider/session hooks remain the source of runtime truth. Presentation preferences must not leak into `useWorkers`.

## 18. Delivery sequence

Although this SDD covers one product iteration, implementation should land in reviewable slices:

1. Visual tokens, local preferences, and keyboard infrastructure.
2. Top bar and room-control consolidation.
3. Crew rail redesign and filters.
4. Task log Summary/Activity modes, approval shelf, and scroll behavior.
5. Command composer, palette, and local history.
6. Toasts, persistent health banners, skeletons, and error normalization.
7. Responsive layouts, accessibility audit, and final visual polish.

Each slice must leave the app usable and keep provider runtime behavior unchanged.

## 19. Test strategy

### Unit

- preference parsing, migration, and bounds;
- crew filtering and selected-worker pinning;
- command history deduplication and workspace/provider isolation;
- task-log summary projection;
- keyboard shortcut routing;
- bubble placement remains bounded and collision-aware.

### Component

- top-bar health states;
- 20-worker rail at idle, busy, failed, and approval states;
- approval shelf visibility in both log modes;
- command palette provider-specific results;
- summary/activity switching without loss of turn data;
- responsive drawers and focus return.

### Integration

- reconnect preserves runtime state while retaining local view preferences;
- provider and room changes refresh the correct command palette context;
- task-log search and copy never mutate Worker history;
- keyboard shortcuts do not fire while typing in unrelated editable controls.

### Visual review matrix

- widths: 1920, 1440, 1280, 1024, 768;
- worker counts: 1, 3, 10, 20;
- panel states: closed, compact, reading, wide;
- runtime states: idle, streaming, tool output, waiting approval, failed, disconnected;
- themes: normal motion and reduced motion.

## 20. Acceptance criteria

1. A new user can identify the current room, selected NPC, provider, model, and primary command action without opening a secondary panel.
2. Twenty workers remain searchable and filterable without horizontal overflow.
3. The default task view exposes the current step, approvals, failures, and final answer without requiring users to read every tool event.
4. Activity mode retains full INPUT, live OUTPUT, tool, MCP, thinking, and subagent detail.
5. Opening or resizing any overlay does not move or rescale the office.
6. Provider health problems present one clear recovery action and do not rely on a long top-bar label.
7. Command palette content is correctly separated between Claude and Codex.
8. Approval requests remain visible and keyboard reachable in every task-log view and width.
9. All new preferences survive reload and can be reset without touching Worker data.
10. Existing provider, approval, avatar, room, workflow, Markdown, and Worker tests continue to pass.
11. No new secret, tool payload, conversation result, or absolute path is written to UI preference storage.
12. Production build completes without new runtime warnings or accessibility-critical violations.

## 21. Approved product decisions

Recommended defaults are included below for approval:

1. **Task-log default:** Summary view. Activity remains one click away.
2. **Crew organization:** stable existing order with filters; no automatic reordering by status.
3. **Top-bar room treatment:** compact breadcrumb replaces the separate room banner.
4. **Command history:** enabled from existing local Worker history, last 50 entries per provider/workspace, without duplicating command content into browser preferences.
5. **Visual density:** balanced desktop density, with reduced decorative glow and more whitespace in reading surfaces.

These defaults were approved before implementation.

## 22. Implementation and verification record

Implemented on 2026-07-15 in the seven delivery slices described above.

- Office stage remains fixed; the crew rail, task log, top bar, palette, and composer are absolute overlays.
- Top bar consolidates room, provider, model, MCP count, provider health, and server health.
- Crew rail supports stable ordering, search, six filters, selected-worker pinning, overflow actions, and the 20-NPC limit.
- Task log defaults to Summary, retains full Activity detail, keeps approvals sticky, expands failures, preserves live output, avoids forced scrolling, supports search, and adds copy actions.
- Command composer separates Claude commands from Codex Skills, supports parameter templates, command history, keyboard navigation, and explicit interrupt behavior.
- UI preferences use one versioned local-storage object with field-level recovery and a reset action; no Worker content is stored in it.
- Responsive pointer targets, focus-visible styles, reduced-motion behavior, loading skeletons, persistent health feedback, inline errors, and ARIA live regions were added.

Verification completed:

- Web tests: 42 passed.
- Server tests: 26 passed.
- Production TypeScript and Vite builds passed.
- Local Web, Worker, auth, capability, Claude command, and Codex Skill endpoints returned HTTP 200.
- Interactive browser automation was unavailable in the execution environment; responsive behavior is covered by component rendering, pure interaction tests, CSS media/container rules, and production build validation.

Corrective verification on 2026-07-16 additionally covered:

- command palette Enter behavior while loading or empty;
- draft, search, scroll, and palette isolation when switching NPC, provider, or room;
- explicit failures for model changes, interruption, and worker removal;
- mutually exclusive/outside-click popovers;
- 20-worker and collapsed-rail rendering;
- compact top-bar overflow breakpoints.
