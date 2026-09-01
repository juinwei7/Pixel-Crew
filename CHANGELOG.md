# Changelog

All notable changes to Pixel Crew are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/juinwei7/Pixel-Crew/compare/v2.1.1...HEAD
[2.1.1]: https://github.com/juinwei7/Pixel-Crew/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/juinwei7/Pixel-Crew/compare/v2.0.1...v2.1.0
[2.0.1]: https://github.com/juinwei7/Pixel-Crew/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/juinwei7/Pixel-Crew/compare/v1.0.3...v2.0.0
[1.0.3]: https://github.com/juinwei7/Pixel-Crew/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/juinwei7/Pixel-Crew/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/juinwei7/Pixel-Crew/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/juinwei7/Pixel-Crew/releases/tag/v1.0.0
