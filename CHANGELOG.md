# Changelog

All notable changes to Pixel Crew are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/juinwei7/Pixel-Crew/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/juinwei7/Pixel-Crew/releases/tag/v1.0.0
