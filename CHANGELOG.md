# Changelog

All notable changes to Pixel Crew are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/juinwei7/Pixel-Crew/compare/v1.0.2...HEAD
[1.0.2]: https://github.com/juinwei7/Pixel-Crew/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/juinwei7/Pixel-Crew/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/juinwei7/Pixel-Crew/releases/tag/v1.0.0
