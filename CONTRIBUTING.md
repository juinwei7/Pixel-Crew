# Contributing to Pixel Crew

Thanks for your interest in improving Pixel Crew! This is a local-first tool that
wraps the official Claude Code and Codex CLIs, so most contributions are about
the orchestration layer (server), the UI (web), or documentation.

歡迎貢獻！以下說明如何在本機跑起來、驗證改動、以及送出 PR 的慣例。

## Getting started / 環境準備

```bash
git clone https://github.com/juinwei7/Pixel-Crew.git
cd Pixel-Crew
cp server/.env.example server/.env   # set TARGET_REPO_PATH
cp web/.env.example web/.env
npm install
npm run dev
```

- Node.js 22.5+ (uses the built-in `node:sqlite`).
- Claude Code CLI and/or Codex CLI installed. You don't need to be logged in to
  boot the app, but you do to actually run a worker.

## Before you open a PR / 送 PR 前

Run the checks locally — CI parity matters:

```bash
npm run build --workspaces   # type-check + build both packages
npm test -w server           # server unit tests (node:test)
npm test -w web              # web unit tests (node:test)
```

Guidelines:

- **Match the surrounding style.** No new formatter/lint config; mirror the
  existing code's naming, comment density, and structure.
- **Add a test for behavior changes.** The server (`server/test`) and web
  (`web/test`) both use `node:test`; put a focused regression test next to the
  code you touch.
- **Keep it local-first and safe.** The server binds to `127.0.0.1` by default
  and must never require users to paste API keys/tokens — auth stays in the
  underlying CLIs. Don't add telemetry or remote calls without discussion.
- **CLI behavior is empirical.** When a change depends on how the Claude/Codex
  CLI actually behaves (event shapes, flags, permission prompts), verify it
  against the real CLI and note what you observed in the PR.
- **One logical change per PR** with a clear description of what and why.

## Reporting issues / 回報問題

Please include: OS, Node version, `claude --version` / `codex --version`, the
provider involved, and steps to reproduce. Logs from the terminal running
`npm run dev` are especially helpful.

## Scope

Pixel Crew intentionally stays a single-user, local cockpit. Features that add
multi-tenant accounts, cloud sync, or that bake a specific project's workflow
into the app are generally out of scope — keep workflows in each repo's
`.claude/commands/`, `CLAUDE.md`, or `AGENTS.md` instead.
