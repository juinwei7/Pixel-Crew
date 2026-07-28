import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthGate, providerInstallCommand, providerVerifyCommand } from "../src/components/AuthGate";
import type { ProviderAuthState, ProviderId, ProviderInstallState } from "../src/types";

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

test("does not block the office when Codex is ready and Claude is missing", () => {
  const providers = { claude: auth("claude", "cli_missing"), codex: auth("codex", "authenticated") };
  const html = renderToStaticMarkup(<AuthGate
    auth={providers.claude}
    providers={providers}
    installs={installs()}
    platform="win32"
    onRefresh={() => {}}
    onInstall={() => null}
    onUseProvider={() => {}}
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
    auth={providers.codex}
    providers={providers}
    installs={installs()}
    platform="darwin"
    onRefresh={() => {}}
    onInstall={() => null}
    onUseProvider={() => {}}
  />);

  assert.match(html, /辦公室仍可使用 Claude Code/);
  assert.match(html, /改用 Claude Code/);
  assert.match(html, /chatgpt\.com\/codex\/install\.sh/);
});

test("shows provider-neutral installation guides when neither provider is ready", () => {
  const providers = { claude: auth("claude", "cli_missing"), codex: auth("codex", "cli_missing") };
  const html = renderToStaticMarkup(<AuthGate
    auth={providers.claude}
    providers={providers}
    installs={installs()}
    platform="darwin"
    onRefresh={() => {}}
    onInstall={() => null}
    onUseProvider={() => {}}
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
    auth={providers.claude}
    providers={providers}
    installs={installs()}
    platform="linux"
    onRefresh={() => {}}
    onInstall={() => null}
    onUseProvider={() => {}}
  />);
  assert.equal(html, "");
});

test("shows collapsible diagnostic info when a debug snippet is present", () => {
  const providers = {
    claude: { ...auth("claude", "error"), debug: "resolved executable: /usr/local/bin/claude\nexit: 1\nstdout: not json" },
    codex: auth("codex", "authenticated"),
  };
  const html = renderToStaticMarkup(<AuthGate
    auth={providers.claude}
    providers={providers}
    installs={installs()}
    platform="darwin"
    onRefresh={() => {}}
    onInstall={() => null}
    onUseProvider={() => {}}
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
