import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthGate, providerInstallCommand, providerVerifyCommand } from "../src/components/AuthGate";
import type { ClaudeLoginState, CodexAccountLoginState, ProviderAuthState, ProviderId, ProviderInstallState } from "../src/types";

function auth(provider: ProviderId, status: ProviderAuthState["status"]): ProviderAuthState {
  return {
    provider,
    displayName: provider === "claude" ? "Claude Code" : "Codex",
    status,
    loginCommand: provider === "claude" ? "claude auth login" : "codex login",
    checkedAt: null,
    error: status === "cli_missing" ? `找不到 ${provider} CLI` : null,
    debug: null,
  };
}

function installs(): Record<ProviderId, ProviderInstallState> {
  return Object.fromEntries((["claude", "codex"] as ProviderId[]).map((provider) => [provider, {
    provider, status: "idle", phase: "尚未開始", command: "", sourceUrl: "",
    startedAt: null, finishedAt: null, output: "", error: null,
  }])) as Record<ProviderId, ProviderInstallState>;
}

const noop = {
  defaultCodexLogin: null as CodexAccountLoginState | null,
  onStartDefaultCodexLogin: async () => null,
  onCancelDefaultCodexLogin: async () => {},
  defaultClaudeLogin: null as ClaudeLoginState | null,
  onStartDefaultClaudeLogin: async () => null,
  onSubmitDefaultClaudeLoginCode: async () => null,
  onCancelDefaultClaudeLogin: async () => {},
  onRefresh: () => {},
  onInstall: () => null,
  onUseProvider: () => {},
};

test("does not block the office when Codex is ready and Claude is missing", () => {
  const providers = { claude: auth("claude", "cli_missing"), codex: auth("codex", "authenticated") };
  const html = renderToStaticMarkup(<AuthGate
    {...noop}
    auth={providers.claude}
    providers={providers}
    installs={installs()}
    platform="win32"
  />);

  assert.match(html, /role="region"/);
  assert.doesNotMatch(html, /aria-modal="true"/);
  assert.match(html, /辦公室仍可使用 Codex/);
  assert.match(html, /改用 Codex/);
  assert.match(html, /winget install Anthropic\.ClaudeCode/);
});

test("does not block the office when Claude is ready and Codex is missing", () => {
  const providers = { claude: auth("claude", "authenticated"), codex: auth("codex", "cli_missing") };
  const html = renderToStaticMarkup(<AuthGate
    {...noop}
    auth={providers.codex}
    providers={providers}
    installs={installs()}
    platform="darwin"
  />);

  assert.match(html, /辦公室仍可使用 Claude Code/);
  assert.match(html, /改用 Claude Code/);
  assert.match(html, /chatgpt\.com\/codex\/install\.sh/);
});

test("shows provider-neutral installation guides when neither provider is ready", () => {
  const providers = { claude: auth("claude", "cli_missing"), codex: auth("codex", "cli_missing") };
  const html = renderToStaticMarkup(<AuthGate
    {...noop}
    auth={providers.claude}
    providers={providers}
    installs={installs()}
    platform="darwin"
  />);

  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /連接一位 AI 隊員/);
  assert.match(html, /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/);
  assert.match(html, /chatgpt\.com\/codex\/install\.sh/);
  assert.match(html, /一鍵安裝／修復/);
  assert.match(html, /claude auth login/);
  assert.match(html, /codex login/);
  assert.match(html, /官方安裝說明/);
});

test("renders no onboarding UI for an authenticated active provider", () => {
  const providers = { claude: auth("claude", "authenticated"), codex: auth("codex", "cli_missing") };
  const html = renderToStaticMarkup(<AuthGate
    {...noop}
    auth={providers.claude}
    providers={providers}
    installs={installs()}
    platform="linux"
  />);
  assert.equal(html, "");
});

test("shows collapsible diagnostic info when a debug snippet is present", () => {
  const providers = {
    claude: { ...auth("claude", "error"), debug: "resolved executable: /usr/local/bin/claude\nexit: 1\nstdout: not json" },
    codex: auth("codex", "authenticated"),
  };
  const html = renderToStaticMarkup(<AuthGate
    {...noop}
    auth={providers.claude}
    providers={providers}
    installs={installs()}
    platform="darwin"
  />);
  assert.match(html, /診斷資訊/);
  assert.match(html, /resolved executable: \/usr\/local\/bin\/claude/);
});

test("selects official platform install and verification commands", () => {
  assert.equal(providerInstallCommand("claude", "win32"), "winget install Anthropic.ClaudeCode");
  assert.equal(providerInstallCommand("claude", "linux"), "curl -fsSL https://claude.ai/install.sh | bash");
  assert.equal(providerInstallCommand("codex", "win32"), "$env:CODEX_NON_INTERACTIVE=1; irm https://chatgpt.com/codex/install.ps1 | iex");
  assert.equal(providerVerifyCommand("claude"), "claude --version");
  assert.equal(providerVerifyCommand("codex"), "codex --version");
});

// --- Codex's app-managed default login (no ambient $CODEX_HOME dependency) ---

test("offers in-app login buttons for Codex, with the manual terminal steps tucked behind a details toggle", () => {
  const providers = { claude: auth("claude", "authenticated"), codex: auth("codex", "unauthenticated") };
  const html = renderToStaticMarkup(<AuthGate
    {...noop}
    auth={providers.codex}
    providers={providers}
    installs={installs()}
    platform="darwin"
  />);
  assert.match(html, /直接在 app 內登入（不用開終端機）/);
  assert.match(html, /瀏覽器登入/);
  assert.match(html, /API Key 登入/);
  assert.match(html, /<details/);
  assert.match(html, /進階：手動在終端機安裝／登入/);
  // The manual codex login command is still present (inside the collapsed details), just not primary.
  assert.match(html, /codex login/);
});

test("Claude also offers an in-app login button, but no API Key mode (there's no --with-api-key equivalent)", () => {
  const providers = { claude: auth("claude", "unauthenticated"), codex: auth("codex", "authenticated") };
  const html = renderToStaticMarkup(<AuthGate
    {...noop}
    auth={providers.claude}
    providers={providers}
    installs={installs()}
    platform="darwin"
  />);
  assert.match(html, /直接在 app 內登入（不用開終端機）/);
  assert.match(html, /瀏覽器登入/);
  assert.doesNotMatch(html, /API Key 登入/);
  assert.match(html, /<details/);
  assert.match(html, /進階：手動在終端機安裝／登入/);
  assert.match(html, /claude auth login/);
});

test("hides the in-app login section while the Codex CLI itself is missing (install steps take over)", () => {
  const providers = { claude: auth("claude", "authenticated"), codex: auth("codex", "cli_missing") };
  const html = renderToStaticMarkup(<AuthGate
    {...noop}
    auth={providers.codex}
    providers={providers}
    installs={installs()}
    platform="darwin"
  />);
  assert.doesNotMatch(html, /直接在 app 內登入/);
  assert.match(html, /安裝 CLI/);
});

test("a running default Codex login shows a cancel action instead of the login buttons", () => {
  const providers = { claude: auth("claude", "authenticated"), codex: auth("codex", "unauthenticated") };
  const login: CodexAccountLoginState = { accountId: "default", status: "running", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null, message: null, loginUrl: null };
  const html = renderToStaticMarkup(<AuthGate
    {...noop}
    defaultCodexLogin={login}
    auth={providers.codex}
    providers={providers}
    installs={installs()}
    platform="darwin"
  />);
  assert.match(html, /登入中…/);
  assert.doesNotMatch(html, /瀏覽器登入/);
});

test("surfaces the fallback OAuth URL as a clickable link when codex's browser auto-open may have failed", () => {
  const providers = { claude: auth("claude", "authenticated"), codex: auth("codex", "unauthenticated") };
  const login: CodexAccountLoginState = {
    accountId: "default", status: "running", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null, message: null,
    loginUrl: "https://auth.openai.com/oauth/authorize?client_id=abc",
  };
  const html = renderToStaticMarkup(<AuthGate
    {...noop}
    defaultCodexLogin={login}
    auth={providers.codex}
    providers={providers}
    installs={installs()}
    platform="darwin"
  />);
  assert.match(html, /瀏覽器沒有自動跳出來/);
  assert.match(html, /href="https:\/\/auth\.openai\.com\/oauth\/authorize\?client_id=abc"/);
});

test("shows the last login failure message once the attempt is no longer running", () => {
  const providers = { claude: auth("claude", "authenticated"), codex: auth("codex", "unauthenticated") };
  const login: CodexAccountLoginState = { accountId: "default", status: "failed", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:05.000Z", message: "登入失敗（exit 1）", loginUrl: null };
  const html = renderToStaticMarkup(<AuthGate
    {...noop}
    defaultCodexLogin={login}
    auth={providers.codex}
    providers={providers}
    installs={installs()}
    platform="darwin"
  />);
  assert.match(html, /登入失敗（exit 1）/);
  assert.match(html, /瀏覽器登入/); // buttons come back once it's no longer running
});

// --- Claude's app-managed default login (two-phase: browser, then paste a code back) ---

test("a running default Claude login shows a cancel action instead of the login button", () => {
  const providers = { claude: auth("claude", "unauthenticated"), codex: auth("codex", "authenticated") };
  const login: ClaudeLoginState = { accountId: "default", status: "running", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null, message: null, loginUrl: null };
  const html = renderToStaticMarkup(<AuthGate
    {...noop}
    defaultClaudeLogin={login}
    auth={providers.claude}
    providers={providers}
    installs={installs()}
    platform="darwin"
  />);
  assert.match(html, /登入中…/);
  assert.doesNotMatch(html, /瀏覽器登入/);
});

test("awaiting_code shows the fallback URL link and a code input, not the initial login button", () => {
  const providers = { claude: auth("claude", "unauthenticated"), codex: auth("codex", "authenticated") };
  const login: ClaudeLoginState = {
    accountId: "default", status: "awaiting_code", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null, message: null,
    loginUrl: "https://claude.com/cai/oauth/authorize?client_id=abc",
  };
  const html = renderToStaticMarkup(<AuthGate
    {...noop}
    defaultClaudeLogin={login}
    auth={providers.claude}
    providers={providers}
    installs={installs()}
    platform="darwin"
  />);
  assert.match(html, /等待貼上驗證碼…/);
  assert.match(html, /瀏覽器沒有自動跳出來/);
  assert.match(html, /href="https:\/\/claude\.com\/cai\/oauth\/authorize\?client_id=abc"/);
  assert.match(html, /完成瀏覽器授權後，把驗證碼貼在這裡/);
  assert.doesNotMatch(html, />瀏覽器登入</);
});

test("shows the last Claude login failure message once the attempt is no longer running", () => {
  const providers = { claude: auth("claude", "unauthenticated"), codex: auth("codex", "authenticated") };
  const login: ClaudeLoginState = { accountId: "default", status: "failed", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", message: "Login failed: Request failed with status code 400", loginUrl: null };
  const html = renderToStaticMarkup(<AuthGate
    {...noop}
    defaultClaudeLogin={login}
    auth={providers.claude}
    providers={providers}
    installs={installs()}
    platform="darwin"
  />);
  assert.match(html, /Login failed: Request failed with status code 400/);
  assert.match(html, /瀏覽器登入/); // button comes back once it's no longer running
});
