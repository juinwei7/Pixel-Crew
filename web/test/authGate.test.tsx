import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthGate, providerInstallCommand, providerVerifyCommand } from "../src/components/AuthGate";
import type { ProviderAuthState, ProviderId } from "../src/types";

function auth(provider: ProviderId, status: ProviderAuthState["status"]): ProviderAuthState {
  return {
    provider,
    displayName: provider === "claude" ? "Claude Code" : "Codex",
    status,
    loginCommand: provider === "claude" ? "claude auth login" : "codex login",
    checkedAt: null,
    error: status === "cli_missing" ? `找不到 ${provider} CLI` : null,
  };
}

test("does not block the office when Codex is ready and Claude is missing", () => {
  const providers = { claude: auth("claude", "cli_missing"), codex: auth("codex", "authenticated") };
  const html = renderToStaticMarkup(<AuthGate
    auth={providers.claude}
    providers={providers}
    platform="win32"
    onRefresh={() => {}}
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
    platform="darwin"
    onRefresh={() => {}}
    onUseProvider={() => {}}
  />);

  assert.match(html, /辦公室仍可使用 Claude Code/);
  assert.match(html, /改用 Claude Code/);
  assert.match(html, /npm install --global @openai\/codex/);
});

test("shows provider-neutral installation guides when neither provider is ready", () => {
  const providers = { claude: auth("claude", "cli_missing"), codex: auth("codex", "cli_missing") };
  const html = renderToStaticMarkup(<AuthGate
    auth={providers.claude}
    providers={providers}
    platform="darwin"
    onRefresh={() => {}}
    onUseProvider={() => {}}
  />);

  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /連接一位 AI 隊員/);
  assert.match(html, /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/);
  assert.match(html, /npm install --global @openai\/codex/);
  assert.match(html, /claude auth login/);
  assert.match(html, /codex login/);
  assert.match(html, /官方安裝說明/);
});

test("renders no onboarding UI for an authenticated active provider", () => {
  const providers = { claude: auth("claude", "authenticated"), codex: auth("codex", "cli_missing") };
  const html = renderToStaticMarkup(<AuthGate
    auth={providers.claude}
    providers={providers}
    platform="linux"
    onRefresh={() => {}}
    onUseProvider={() => {}}
  />);
  assert.equal(html, "");
});

test("selects official platform install and verification commands", () => {
  assert.equal(providerInstallCommand("claude", "win32"), "winget install Anthropic.ClaudeCode");
  assert.equal(providerInstallCommand("claude", "linux"), "curl -fsSL https://claude.ai/install.sh | bash");
  assert.equal(providerInstallCommand("codex", "win32"), "npm install --global @openai/codex");
  assert.equal(providerVerifyCommand("claude"), "claude --version");
  assert.equal(providerVerifyCommand("codex"), "codex --version");
});
