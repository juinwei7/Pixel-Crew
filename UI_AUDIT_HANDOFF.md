# Pixel Crew UI audit handoff

Last updated: 2026-09-08 (Asia/Taipei)
Branch / base commit: `main` / `1bc2749`
Goal: continue finding and fixing UI errors and worthwhile UX improvements autonomously.

## Current state

### Active follow-up: Black Window on Windows and macOS

Work resumed at the user's request on 2026-09-08. The cross-platform goal is not
complete. The earlier audit below was committed as
`322e593`; the new terminal changes are not yet committed.

Review status: implementation and local verification are complete. Native
desktop coverage still needs a Windows test desktop and an uninterrupted native
IME session. Do not count synthetic input events or the local macOS build as
evidence that those remaining checks passed.

- Added a keyboard-accessible control-claim button for read-only terminals.
- Distinguished automatic reconnection from a shell that actually exited;
  disabled terminal input until the server grants write access and during
  recoverable connection failures.
- Avoided fitting hidden terminal hosts, including delayed font-size fits.
- Improved footer readability and added Windows monospace font fallbacks.
- Fixed account/advanced dropdown clipping inside the compact toolbar by using
  viewport-bounded fixed panels below 820px. Both menus now support Escape and
  return focus to their summary.
- An isolated CSS fixture rendered the advanced panel at 760 x 500 and
  375 x 500. Bounds were respectively 12..748 and 12..363, bottom 488;
  hit testing reached the Save button and document widths matched the viewport.
  The temporary fixture has been removed. Web production build passes.
- Local macOS `npm run check` passes after these changes. Live Chrome confirms
  normal terminal/footer layout at 1728 x 907; this is not proof of Windows
  rendering or of the recovery/claim interactions.

### Latest verification and resume instructions

- Final local `npm run check` exited 0 after all implementation changes:
  server/web tests, TypeScript, production build and bundle budget passed.
- Added an isolated manual fixture at
  `http://localhost:5173/test/fixtures/black-window-terminal.html` using real
  React/xterm and a simulated WebSocket. It never creates a PTY or changes
  account/workspace data. Source lives in `web/test/fixtures/`.
- Verified keyboard Enter on Take control sends exactly one `terminal_claim`
  and focuses the terminal. Hiding the terminal and increasing font size sends
  no resize; restoring sends the new size. Disconnect displays Reconnecting
  and opens a second connection with the same session ID.
- Added IME guards to Workspace rename, settings-menu Escape and global
  shortcuts, including the keyCode 229 fallback. Added `keyboardInput.test.ts`.
  Native Windows/macOS IME sessions have NOT been exercised yet.
- Follow-up verified on macOS Chrome: simulated `terminal_exit` followed by
  socket close stays at one connection after the reconnect delay, with the
  footer showing terminal ended. This verifies client handling of the exit
  protocol; no live user shell was terminated.
- Ordinary `b`, Enter and Chinese multiline paste produced exactly `b`, `\r`
  and `測試 paste\r第二行` terminal-input messages in the isolated fixture.
  Read-only keystrokes produced no terminal-input messages.
- Found and fixed read-only xterm trapping Tab. Its custom key handler now
  lets Tab use native focus navigation while stdin is disabled. Verified
  real Tab reaches Take control, Enter sends one claim, and focus returns to
  the terminal. Writable terminal Tab retains shell completion behavior.
- Found and fixed simultaneous account/advanced menus. Opening either closes
  its sibling through the real component's toggle handler. Verified account
  opening closes Advanced and opening Advanced closes Accounts.
- Verified real account-menu Escape and Escape from the Advanced model field
  close the panel and restore focus to the corresponding summary.
- Full real account menu at 375 x 500: bounds x=12..363, y=180..488;
  document width 375, bottom Manage account action passed hit testing.
  At 812 x 375: account bounds x=12..800, y=125..363; Advanced bounds
  x=12..800, y=206..363; document width 812. Viewport override reset and
  live menus closed after inspection. No account/settings action was submitted.
- Final `npm run check` after these fixes exited 0 (tests, TypeScript,
  production builds, SEO, bundle budget and diff whitespace). Initial sandbox
  attempt failed on tsx IPC EPERM; the permitted outside-sandbox run passed.
  Log: `/tmp/pixel-crew-ui-audit-check.log`.
- Real PTY browser verification completed through `attachTerminalSocket`, the
  production mux daemon, and the real BlackWindowTerminal/xterm component.
  New reusable fixture: `web/test/fixtures/black-window-pty.html` and `.tsx`.
  Run `node --import tsx web/test/fixtures/black-window-pty-server.mjs` from
  repo root, then open the tokenized fixture URL it prints. The bridge binds
  only a random 127.0.0.1 port, checks the Vite origin and per-run token,
  accepts only the fixed audit tab/workspace, and uses temporary data paths.
  Its precreated empty DB prevents legacy user-data migration. Stop it with
  SIGINT/SIGTERM; it also expires after 10 minutes and shuts down its own mux.
- On macOS `/bin/zsh`, `exit 7` produced `terminal_exit` code 7, signal 0.
  Footer stayed "終端已結束", connection count stayed 1 well beyond the
  reconnect delay, and pressing x afterward emitted no input. This now
  proves the actual shell-to-browser exit path, not only a simulated frame.
  The fixture service exited 0 after controlled shutdown, acknowledged mux
  shutdown and removed `/private/tmp/pixel-crew-ui-pty-cmQCB1`.
- Native IME attempt remains unverified: browser-level Ctrl+Space emitted a
  NUL (it did not switch the OS input source). Native Chrome automation then
  reported concurrent user window changes, so it was stopped before typing
  through the native app. No native composition result is claimed.
- Remaining: native Windows keyboard/paste/rendering and native Windows/macOS
  IME candidate confirmation/cancellation. Current computer exposes macOS;
  user has been asked for an available Windows test environment. Synthetic
  composition guards are not proof of native IME behavior.
- The CI workflow runs tests and builds on Windows, macOS and Linux. Its result
  is the next automated cross-platform gate after these changes are pushed;
  it does not replace the remaining native interaction checks.
- Live user terminal tab: `929897357`. Reopen the fixture URL above when
  needed; routine fixture tabs are ephemeral. Prefer it for failure injection.
  No viewport override or test/build command remains running from this work.

### Previous completed audit (committed)

The previous audit changed 15 source/test files. Its full verification completed
successfully after the final editor touch-target pass:

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

## Files changed in the previous completed audit (historical)

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
