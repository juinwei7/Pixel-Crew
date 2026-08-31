# Focus Workbench UX SDD

## Outcome

Make Focus Reader a dependable engineering work surface: a user can identify the
active AI context, switch repositories without losing their place, assess local
Git state without a network fetch, and recover a locally launched Windows app
without a terminal window or hidden failure.

## Scope and decisions

| Need | Decision | Verification |
| --- | --- | --- |
| Fast workspace selection | Keep stable `Alt+1`–`Alt+9` shortcuts and add an in-rail, name/path search. Filtering never renumbers shortcuts. | Search is labelled, keyboard-accessible, and the original shortcut stays on each matching card. |
| Git confidence | Read each managed workspace through the existing local Git summary endpoint; manual refresh is explicit and records the local update time. | Refresh control says it does not fetch; unavailable repositories show a contained state. |
| Reading continuity | Keep the reader scroll offset per workspace, plus report search, heading navigation, pinning, copy and Markdown export. | Switching reader contexts and returning restores the saved offset. |
| Context clarity | Use the existing Focus header and Work Energy subject card to show the active workspace/NPC/provider/model. | The model is visible without opening an extra panel. |
| Windows recovery | Default launch is hidden; a tray controller exposes status, open, restart, stop and logs. | No persistent console window; failures are logged and surfaced with a dialog. |

## Interaction rules

1. The workspace rail may collapse without removing accessible studio labels.
2. A search with no match shows an explicit empty state; it cannot clear the
   active workspace or alter the global `Alt+number` mapping.
3. Git refresh is bounded by the existing six-second client timeout and makes
   no remote fetch, pull, or write operation.
4. Background Windows failures leave diagnostic output in `%LOCALAPPDATA%\Pixel Crew\logs`.

## Acceptance checks

- Server and web test suites pass.
- Production web build succeeds.
- Windows package tests assert the hidden VBS launcher, log redirection,
  recovery dialog, and tray commands.
- Package output includes the VBS launcher and Windows tray controller.
