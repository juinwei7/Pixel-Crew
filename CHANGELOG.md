# Changelog

All notable changes to Pixel Crew are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- Expert advisor: hand the boss desk a rough idea and a senior-advisor model lays out several professional directions — each with the insight an insider would raise, how the work is actually done, the risks you would not have thought of, and an objective you can assign as-is. Pick one and the existing plan/execute/report pipeline takes it from there. A "suggest something" mode proposes directions without an idea to start from, and any direction can be sent to the round-table debate instead of straight to work.
- Autopilot for boss assignments: when one assignment finishes, the decision model reads what was completed plus the workspace and picks the next objective itself, up to a step limit you set (15 by default).
- A boss assignment with no suitable department can open a dedicated team for itself — 2 to 4 short-lived members that plan, execute, and disband when the work is done. Off by default; turn it on per assignment.
- Department discussions are now visible: the NPCs' actual messages and tool calls appear as an activity feed on the mission, expanded while it runs, and readable from the assignment page.
- The work queue moved to the server, so an NPC drains its own queue when it goes idle — in the background, and a queue made on the phone runs on the computer too.
- Schedules can repeat every N minutes instead of only once a day.
- Video understanding: upload a video, or paste a link from a public video site. Frames are extracted with `ffmpeg` and the audio is transcribed with the existing local whisper engine, so the NPC both sees and hears it. Needs `ffmpeg`/`ffprobe` locally, plus `yt-dlp` for links; only the video features are unavailable without them.
- The top bar shows how many NPCs are running across every workspace. Open it to list them, including the sub-agents running inside an NPC, and jump to one.
- A message can carry 10 images instead of 4 (30 MiB total).

### Changed

- A simple boss assignment uses 40–70% fewer tokens: it goes straight to the department that will do the work instead of building a summarizing/pruning decision pass first.
- Assignment status reads "executing" rather than "running", and a busy NPC carries a pulsing dot so background work is visible at a glance.

### Fixed

- The department task log and the assignment and mission lists came back empty on Windows: entries are stored under the workspace path, and the lookup normalized the path (lower-case on Windows) while the write did not — so an exact match never found anything, for every workspace. Both sides now normalize, and existing rows are migrated.
- Archiving a boss assignment that had used a dedicated department destroyed that assignment's mission records, even though archiving promises to keep every conversation, stage, and report. Disbanding a team now keeps the rows the records point at.
- A queued message could be lost for good: it was removed from the queue before being sent, so any send failure dropped it along with its attachments. The item now stays queued until the send succeeds.
- A failed automatic retry after a lost `--resume` conversation could take down every worker at once instead of failing that one turn, and a later unrelated failure in a resumed session could silently discard the whole conversation.
- The initial snapshot could still send a worker's entire retained history when one long turn pushed the cut past the window, undoing the size work that keeps a phone connection usable.
- On a phone, scrolling up to read earlier messages no longer yanks you back to the bottom, and a streaming reply no longer makes the thread jump.
- Reinstalling a provider CLI repeatedly no longer wedges the installer until a reboot: stale lock files and dead process ids are cleared first.
- A planned restart on Windows no longer reports "the service stopped unexpectedly".
- A stuck assignment can be deleted.

## [2.5.0] - 2026-09-23

### Added

- Remote access now shows a real progress bar while it downloads cloudflared for the first time, with transferred size, speed, remaining time, and a cancel button.
- On a phone the work-mode switch collapses to a single chip: swipe it left or right to move between Pixel, Professional, and Black Window, or tap it to pick one.
- The black window's CLI panes can be swiped between on a phone, one pane at a time.

### Changed

- Rebuilt the phone layout on one shared responsive layer: three breakpoints instead of twenty-four, one dialog shell behind every modal, and a single set of tap-target and spacing values. Phone screens no longer overflow sideways at any width down to 320px.
- The top bar now carries only the essentials — work mode, Assign work, usage, health — and splits the rest into two menus by what they affect: "This NPC" (workspace, provider, model, account, auto-approve, MCP) and "App settings" (language, notifications, boards, backup, restart). The two menus replace three overlapping ones that had drifted apart.
- All three work modes share one identical nav bar on a phone, so switching no longer shifts the controls.
- Professional mode switches NPCs with the same chip strip as Pixel mode instead of a dropdown, and its studio shortcuts and report index now share one row. The report gets 80px more height than before.
- Replaced every emoji used as an interface icon with one line-icon set that follows the surrounding colour and weight, instead of whatever glyph the operating system happened to supply.
- Share passwords now need at least 6 characters, the same minimum the owner passcode already had.
- Signing out of remote access also clears the guardian unlock, so the next person to sign in on that device has to enter the guardian password again.

### Fixed

- Fixed the microphone button's icon sitting against its left edge, and the round-table "..." menu opening past the right edge of a phone screen.
- Translated the last 199 interface strings that still showed Chinese in the English build — accounts, backup and restore, the boss assignment's effort limits, the black window workbench, the studio rail, the guardian prompt, and the tool-call status lines. The English interface no longer mixes the two languages.
- Fixed the first-run cloudflared download never completing. The install request used to block until the whole 19–70 MB file arrived, so it always hit the 40-second proxy timeout on a normal connection, and a dropped connection left the relay permanently stuck reporting "download in progress" until it was restarted.
- Verified the downloaded cloudflared against its declared size instead of accepting a truncated file, cleaned up the partial file, and aborted stalled downloads instead of waiting forever.
- Stopped leaving an orphaned cloudflared tunnel running when opening it timed out or when the relay exited, and reported cloudflared's own error output instead of a bare "failed to start".
- Stopped the remote-access login throttle from being bypassed by a spoofed `X-Forwarded-For` entry, and treated any forwarding header as proof a request is not a local owner request.
- Created the relay's config file, which holds the passcode in plain text, with owner-only permissions from the start instead of leaving it briefly readable by other accounts on the machine.
- Kept the remote-access window's status fresh while it is open, and capped Tailscale detection so a slow or hung `tailscale` CLI can no longer make the window time out.

## [2.4.0] - 2026-09-22

### Added

- Gave the macOS app and the Windows executable a real icon; downloads previously showed the blank generic-application icon on both platforms. The mark is the office crew itself, generated from a single source with `npm run icons`.
- Paste an image into a Black Window terminal with Cmd+V. The image is staged as a private local file and its path handed to the Claude Code or Codex composer, so it also works over remote access, where the browser and the CLI are on different machines.

### Fixed

- Parsed Claude usage lines that report no reset time instead of discarding the whole reading.

## [2.3.1] - 2026-09-09

### Changed

- Hardened the persistent Black Window workbench across terminal lifecycle recovery, pane interactions, responsive layouts, keyboard use, and screen-reader semantics.
- Rebuilt the bilingual product website with dedicated feature, download, and changelog pages.

### Fixed

- Made remote access work in source development by routing the Vite UI separately from API and WebSocket traffic, while keeping phone requests on the authenticated tunnel origin.
- Blocked Vite's filesystem route at the remote gateway so development-mode remote access cannot expose arbitrary workspace files.
- Stabilized cross-platform PTY lifecycle coverage, including Windows ConPTY sizing and delayed cleanup.

## [2.3.0] - 2026-09-04

### Added

- Added a persistent Black Window workbench for real Claude Code and Codex CLI sessions, with workspace tabs, movable/resizable/splittable panes, minimize/maximize controls, provider account and model settings, terminal font sizing, and editable local voice input.
- Added a shared local Markdown memory that is applied to Claude and Codex through their native instruction mechanisms and included in backup export and restore.

### Changed

- Improved per-account Claude and Codex work-energy reporting, including clearer reset timing and synchronized native controls.
- Refined Professional mode navigation, responsive layout, and mode-specific keyboard handling.

### Fixed

- Persist and synchronize Black Window terminal identity and layout without orphaning daemon sessions or allowing stale browser-tab updates to overwrite newer state.
- Replaced browser-native confirmation and alert prompts with accessible in-app dialogs and toasts, centralized destructive-action confirmation, and revalidated live state after asynchronous confirmations.

## [2.2.2] - 2026-09-01

### Fixed

- Improve Windows microphone capture for local voice input by enabling browser gain control, accepting quieter speech, and explaining the specific permission, device, or in-use failure.

## [2.2.1] - 2026-09-01

### Fixed

- Keep local Whisper model download progress visible instead of repeatedly reopening its confirmation dialog, including while the download request is still starting.
- Make the Windows local Whisper engine installer fall back to the inbox `tar.exe` extractor when PowerShell extraction is unavailable.

## [2.2.0] - 2026-09-01

### Added

- Shipped Windows as one double-clickable `Pixel Crew.exe`: a native control center with a recognizable Task Manager name, tray controls, clear error notifications, automatic startup, and private per-user installation without administrator rights.

## [2.1.2] - 2026-09-01

### Fixed

- Preserve existing Claude NPC conversations across the managed-account upgrade, so older session IDs resume from the Claude home that created them instead of failing during execution.

## [2.1.1] - 2026-09-01

### Fixed

- Made Focus Reader, remote access, workflow management, and supporting dialogs fit phone-sized viewports with touch-friendly controls.
- Surface local relay startup failures in Remote Access instead of reporting only a generic failure.

## [2.1.0] - 2026-09-01

### Added

- Added managed, per-NPC provider accounts for both Codex and Claude Code. Named accounts use isolated local CLI homes, support browser login (plus Codex's API-key flow), and cannot replace a worker's active native conversation without an explicit reset.
- Added Codex thread goals through `/goal`, including set, inspect, and clear operations, and added a command manager that distinguishes real built-ins from custom text-only palette entries.
- Added a Focus workbench: split the reader into up to four panes, cycle panes with `Alt+[` / `Alt+]`, and keep workspace/provider/model context visible alongside the existing read-only Git summary.
- Added a hidden Windows launcher and tray controls for open, restart, stop, and logs; background startup now records actionable diagnostics instead of leaving a persistent console window.
- Added optional local voice input for NPC composers: browser-recorded audio is transcribed by a local Whisper engine into an editable Traditional Chinese draft, with a one-time verified model download and no automatic send.

### Changed

- Improved Focus Studios, responsive reader layouts, model visibility, and the modern workspace shell.
- Hardened the local runtime against planned restarts, stalled background work, optional dialog timing, and screenshot-browser failures.
- Simplified first launch so people can begin immediately in Pixel Crew's managed workspace or choose an existing project when they need one.

### Fixed

- Removed obsolete one-click Squad templates from the product and documentation.
- Hardened remote sharing passcode handling and screenshot navigation against unsafe local/private targets.

## [2.0.1] - 2026-07-28

### Added

- Added a persistent Boss task log: assign work through one chat-first Boss Desk, with tasks, discovery questions, replies, department progress, and final reports persisting across navigation and restarts.
- Added multi-department orchestration: the decision model builds a validated dependency graph across real departments and NPC roles, passes each department its upstream reports, and returns one consolidated result to the Boss.
- Added mid-session model switching and a fresh-session flow for restarting a worker's context without losing its configuration.
- Added a live MCP configuration watcher that detects external edits to Claude/Codex MCP config files and refreshes capabilities automatically instead of requiring a manual refresh.

### Changed

- Replaced `CommandComposer` with a modularized `TaskComposer` and supporting composer hooks/helpers.

### Fixed

- Surfaced diagnostic info (resolved CLI executable, exit code, raw CLI output) when Claude/Codex authentication detection disagrees with reality, so machines where login isn't detected despite being logged in can be debugged instead of guessed at.

## [2.0.0] - 2026-07-22

### Added

- Added department management: create a department by providing a purpose, headcount, and provider, and have AI draft complementary NPC roles and personas before you pick a lead.
- Added read-only Quick Consult and Quick Review collaboration modes, each a fixed two-step handoff (expert advises or reviews, then the lead executes and finalizes) with no file writes from the consulted or reviewing NPC.
- Added Department Mission: a 2-to-5-step task chain that always starts with an execute step, requires a different NPC for each review step, and automatically retries a failed review up to two correction rounds before surfacing it for a decision.
- Added a `needs_attention` state that only interrupts for plan approval, an inconclusive review, an exhausted correction budget, a failed step, or a member becoming unavailable; every other handoff between department steps happens automatically.
- Added hard guardrails so no department workflow can auto-commit, push, merge, tag, or release, or touch CLI authentication; normal per-command approval prompts remain in effect throughout.

### Changed

- Rebuilt the marketing site (`PixelCrew/`) around the department and collaboration feature set, extracted its inline styles into a shared `assets/style.css`, and rewrote the English page to mirror the Chinese page's structure instead of maintaining a separately hand-authored layout.

## [1.0.3] - 2026-07-21

### Added

- Added a full MCP management modal with scoped add/remove, OAuth login/logout, connection details, and Codex MCP tool catalogs.
- Added validated local backup export and restore for workers, conversation history, settings, and custom avatars, including automatic pre-restore snapshots and rollback.
- Added cumulative Claude cost tracking alongside provider usage and quota information.
- Added complete NPC and workspace controls inside focus mode, including rename, provider/model settings, persona, avatar, room, and guarded removal.

### Changed

- Persisted focus mode across reloads, added keyboard focus traps and Escape handling to dialogs, and limited long task logs to recent chunks with on-demand history loading.
- Improved dangerous-command detection, Codex authentication checks, workflow refresh behavior, and MCP capability discovery.

### Fixed

- Prevented unsafe or oversized backup archives from escaping staging or exhausting local storage, and made restore shutdown reliable after client disconnects.
- Kept required first-launch workspace setup non-dismissible and aligned NPC removal confirmation across every UI entry point.

## [1.0.2] - 2026-07-20

### Added

- Added a focus workspace for long-form reading with NPC switching, report outlines, cross-NPC search, pins, Markdown export, and account usage context.
- Added full-window image and document drag-and-drop, manageable queued messages, and persistent per-session drafts and attachments.
- Added provider-scoped Codex command discovery that is available before the first conversation and remains available in new sessions.
- Added persistent NPC ordering across restarts.

### Changed

- Improved task-log readability with calmer colors, clearer typography, responsive layouts, search highlighting, and low-usage warnings.

### Fixed

- Kept composer state isolated while switching NPCs and prevented attachment drops from leaking through modal upload surfaces.
- Preserved failed-turn readable output in focus mode and guarded asynchronous persistence against stale writes.

## [1.0.1] - 2026-07-17

### Added
- Self-contained Windows x64 release ZIP with a bundled verified Node.js runtime and production dependencies.
- Stable latest-release download link for the Windows ZIP.

## [1.0.0] - 2026-07-17

First public release. / 首次公開發布。

### Added
- Multi-agent pixel office: run multiple **Claude Code** and **Codex** sessions as NPCs in one canvas, with real-time streaming of output, thinking, and tool calls.
- Per-NPC persona (role + instructions) with a reusable template library, injected through each CLI's native mechanism.
- Interactive approvals: floating approve/deny bar on the sprite, task-log approval cards, and a 3-level auto-approve mode（off / 安全 / 完全）with dangerous-command blocking.
- Radial quick menu on right-click（rename / persona / avatar / room / remove）.
- Camera controls: drag to pan, wheel & slider zoom, double-click / button reset.
- Living office: NPC mood reactions, idle socializing, office cat, milestone decorations unlocked by all-time completed turns.
- Desktop notifications for task completion and pending approvals（optional, off by default）.
- In-app update check against GitHub Releases with an update button.
- Cross-LLM handoff（Claude ⇄ Codex）with checkpoint summaries.
- NPC avatar workshop with animated GIF support; provider workflows; global work-energy HUD.
- Windows portable packaging（GitHub Actions release workflow, zip + tar.gz with SHA-256）.

[Unreleased]: https://github.com/juinwei7/Pixel-Crew/compare/v2.5.0...HEAD
[2.5.0]: https://github.com/juinwei7/Pixel-Crew/compare/v2.4.0...v2.5.0
[2.4.0]: https://github.com/juinwei7/Pixel-Crew/compare/v2.3.1...v2.4.0
[2.3.1]: https://github.com/juinwei7/Pixel-Crew/compare/v2.3.0...v2.3.1
[2.3.0]: https://github.com/juinwei7/Pixel-Crew/compare/v2.2.2...v2.3.0
[2.2.2]: https://github.com/juinwei7/Pixel-Crew/compare/v2.2.1...v2.2.2
[2.2.1]: https://github.com/juinwei7/Pixel-Crew/compare/v2.2.0...v2.2.1
[2.2.0]: https://github.com/juinwei7/Pixel-Crew/compare/v2.1.2...v2.2.0
[2.1.2]: https://github.com/juinwei7/Pixel-Crew/compare/v2.1.1...v2.1.2
[2.1.1]: https://github.com/juinwei7/Pixel-Crew/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/juinwei7/Pixel-Crew/compare/v2.0.1...v2.1.0
[2.0.1]: https://github.com/juinwei7/Pixel-Crew/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/juinwei7/Pixel-Crew/compare/v1.0.3...v2.0.0
[1.0.3]: https://github.com/juinwei7/Pixel-Crew/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/juinwei7/Pixel-Crew/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/juinwei7/Pixel-Crew/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/juinwei7/Pixel-Crew/releases/tag/v1.0.0
