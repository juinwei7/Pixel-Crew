# Security Policy / 安全政策

## Reporting a vulnerability / 回報弱點

Please **do not** open a public issue for security vulnerabilities.
請**不要**用公開 issue 回報安全弱點。

Instead, use GitHub's private vulnerability reporting:
請改用 GitHub 的私密弱點回報：

**[Report a vulnerability](https://github.com/juinwei7/Pixel-Crew/security/advisories/new)**

You should get a response within 7 days. / 我們會在 7 天內回覆。

## Scope notes / 範圍說明

Pixel Crew is a **local-first** tool: the server binds to localhost and drives
the Claude Code / Codex CLIs already installed and authenticated on your
machine. Reports we especially care about:

- Anything that lets a web page or remote host reach the local server or its
  approval bridge（CSRF/DNS rebinding/WebSocket origin 相關）
- Auto-approve ("safe"/"full") policy bypasses that run dangerous commands
  without a prompt（繞過危險指令攔截）
- Packaged release leaking local paths, tokens, or data（打包產物洩漏本機資訊）

Out of scope: vulnerabilities in the upstream CLIs themselves — report those
to Anthropic / OpenAI directly.
