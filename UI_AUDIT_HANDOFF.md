# Pixel Crew UI audit handoff

Last updated: 2026-09-08 (Asia/Taipei)
Branch / base commit: `main` / `1bc2749`
Goal: continue finding and fixing UI errors and worthwhile UX improvements autonomously.

## Current state

There are uncommitted UI changes in 15 source/test files. Do not discard or
reset them. The latest full verification completed successfully after the
final editor touch-target pass:

```sh
npm run check
```

This includes SEO validation, server tests, all 315 web tests, TypeScript
builds, Vite production build, bundle-budget validation, and
`git diff --check`.

The local preview used for visual checks is `http://localhost:5173/`. Visual
checks covered 320 x 568, 375 x 812 and 812 x 375 CSS px.

## Completed and verified

### Responsive top bar and feature access

- Restored all feature entry points inside the compact `...` menu. Previously,
  widths at or below 1440px hid the desktop tools menu while the compact menu
  exposed only MCP, making Accounts, Kanban, Operations, Day Report, Outbox,
  Backup, Remote Access, Tour and Restart unreachable.
- The compact menu now has a viewport-bounded height, vertical scrolling and
  44px phone targets.
- Added the translated accessible name `More settings and tools`.
- Added TopBar regression assertions for the compact feature group and key
  entries.
- Verified at 375 x 812: no horizontal overflow; menu bottom remains inside the
  viewport; `clientHeight=738`, `scrollHeight=843`; all 13 visible feature
  buttons were 44px high.

### Modal Escape behavior

- Fixed Escape propagation from feature modals opened inside Professional mode.
  A single Escape previously closed Kanban and also exited Professional mode.
- Added Operations, Remote Access, Kanban, Day Report, Outbox and Tour to the
  global modal-layer guard.
- Verified interactively: Professional -> More -> Kanban -> Escape closes only
  the dialog and preserves `game-root--focus`.

### Professional and Black Window modes

- Reserved space above the Professional composer so its floating toolbar no
  longer covers the last report lines.
- Improved phone controls to 44px and changed the collapsed studio list into a
  single horizontally scrollable row.
- Added a compact layout for short landscape screens and removed redundant
  header/rail content there.
- Prevented the Black Window energy HUD from overlapping wrapped CLI controls;
  enlarged phone toolbar/window controls.
- Previously checked at 320 x 568, 375 x 812, 812 x 375 and 1728 x 963. Later
  changes did not touch the wide layouts.

### Regular phone task log and search

- Raised high-frequency task-log controls to 44px: Summary, Activity, Search,
  width selector, Copy and Latest Content.
- Raised the energy summary to an actual 44px by removing its 0.9 phone scale.
- Kept the sheet resize grabber at the WCAG Web minimum of 24px so it does not
  overlap the header controls.
- Raised search input, scope buttons and close action to 44px.
- Added a real search-input name, `Close search`, search-scope group semantics,
  `aria-pressed` on view/scope choices and `aria-expanded` on Search.
- Verified at 375 x 812: the toolbar remains one row (190px wide), document
  width remains 375px, no visible interactive element is below 24 x 24, and no
  visible control lacks a readable name.

### Motion preference

- Added a final global `prefers-reduced-motion: reduce` rule. It reduces all
  animations/transitions to 0.01ms, runs animations once, and disables smooth
  scrolling. No component depends on transition/animation-end events.

### Kanban, Accounts, Operations and Day Report

- Kanban empty-state primary CTA is now at least 44px.
- Accounts phone controls shared with MCP/Backup are now 44px; refresh buttons
  have a readable `Refresh` name and a 44 x 44 hit area.
- Operations tabs, budget inputs/actions and schedule form controls are now
  44px.
- Operations tabs expose `aria-selected`.
- Budget fields and save actions name the affected NPC; the schedule textarea
  has the label `Scheduled instruction`.
- Verified at 375 x 812:
  - Accounts: no horizontal overflow; all visible controls are at least 44px
    after the refresh-width correction.
  - Operations Costs: all visible controls at least 44px; the card remains
    351px wide inside the viewport.
  - Operations Schedule: Add button is 44 x 317 and the textarea has an
    accessible name.
  - Day Report: no horizontal overflow, no unnamed controls, no visible control
    below 44px.

### Remaining compact-menu dialogs

- Verified Outbox, Remote Access, Backup/Restore, MCP, Global Memory and every
  Onboarding Tour step at 375 x 812 without starting a share, importing a
  backup or changing user data.
- Raised phone controls to 44px across these surfaces, including Remote preview
  navigation, Backup inputs, MCP toggles/actions and Global Memory controls.
- Added MCP pressed/expanded/group semantics for the tools list, JSON mode,
  scope, transport and OAuth advanced settings.
- Fixed the Tour card inheriting a desktop centering transform on phone. Steps
  2–8 were shifted 163px off the left edge; all eight steps now stay within
  `12..363px` and their actions are 44px high.

### Narrow, landscape and English checks

- At 320 x 568, the regular task-log sheet stays within `8..312px`; search and
  composer controls are 44px and the document width remains 320px.
- At 812 x 375, the task-log search row, composer and resize handle remain
  usable without horizontal overflow. Remote, Backup and MCP dialogs scroll
  internally inside the short viewport.
- Completed a 375px English pass. Added missing translations for Black Window,
  Tools, Accounts, Outbox, Agent settings, the composer label and task-log
  resize help; no tested English label overflowed its control.

### Phone editors

- Rendered Avatar Workshop, Persona Editor, Department Creator and Command
  Center at 375 x 812 rather than changing their 40px rules blindly.
- Their visible dialog/editor controls now meet the 44 x 44px phone target and
  the document width remains 375px. Command Center also stacks its library over
  the editor, keeps its provider/mode buttons tappable and avoids a 220px side
  rail on narrow screens.

## Files currently changed

- `web/src/App.tsx`
- `web/src/components/AccountsModal.tsx`
- `web/src/components/McpModal.tsx`
- `web/src/components/OpsModal.tsx`
- `web/src/components/TaskComposer.tsx`
- `web/src/components/TopBar.tsx`
- `web/src/i18n/en-app.ts`
- `web/src/i18n/en-core.ts`
- `web/src/i18n/en-modals-c.ts`
- `web/src/styles/app-shell-and-focus.css`
- `web/src/styles/avatar-workshop.css`
- `web/src/styles/composer-and-operations.css`
- `web/src/styles/workflow-management.css`
- `web/test/mcpModal.test.tsx`
- `web/test/topBar.test.tsx`

This handoff file is an additional uncommitted file.

## Audit status

The compact-dialog, 320px, short-landscape, English-label and phone-editor
passes are complete. The global reduced-motion CSS is present and source-audited;
the attached browser did not expose documented media-emulation controls for a
visual reduced-motion run. Browser zoom/dynamic-text testing remains optional
future exploratory work rather than a known defect.

## Safety notes

- Do not click Restart, Shutdown, Restore, Delete Account, Delete Schedule or
  any action that changes user data while visually auditing.
- Existing data, sessions and worktree changes belong to the user.
- The scoped audit is complete; preserve these changes until they are reviewed
  or committed.
