import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountLoginState, AccountWithAuth, ClaudeLoginState, ProviderAuthState, ProviderId } from "../src/types";
import { AccountsModal } from "../src/components/AccountsModal";

function account(provider: ProviderId, overrides: Partial<AccountWithAuth> = {}): AccountWithAuth {
  return {
    id: "acct-1",
    provider,
    label: "alice",
    homeDir: `/data/accounts/acct-1`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    auth: { provider, displayName: provider === "codex" ? "Codex" : "Claude Code", status: "authenticated", loginCommand: `${provider} login`, checkedAt: null, error: null, debug: null },
    ...overrides,
  };
}

function defaultAuthState(status: ProviderAuthState["status"] = "unauthenticated"): Record<ProviderId, ProviderAuthState> {
  return {
    codex: { provider: "codex", displayName: "Codex", status, loginCommand: "codex login", checkedAt: null, error: null, debug: null },
    claude: { provider: "claude", displayName: "Claude Code", status, loginCommand: "claude auth login", checkedAt: null, error: null, debug: null },
  };
}

function renderModal(
  accounts: AccountWithAuth[],
  accountLogins: Record<string, AccountLoginState> = {},
  initialProvider: ProviderId = "codex",
  defaultAuth: Record<ProviderId, ProviderAuthState> = defaultAuthState(),
  defaultCodexLogin: AccountLoginState | null = null,
  defaultClaudeLogin: ClaudeLoginState | null = null,
) {
  return renderToStaticMarkup(
    <AccountsModal
      accounts={accounts}
      accountLogins={accountLogins}
      onCreate={async () => ({})}
      onDelete={async () => ({})}
      onRefresh={async () => null}
      onLogin={async () => null}
      onSubmitLoginCode={async () => null}
      onCancelLogin={async () => {}}
      onClose={() => {}}
      initialProvider={initialProvider}
      defaultAuth={defaultAuth}
      defaultCodexLogin={defaultCodexLogin}
      defaultClaudeLogin={defaultClaudeLogin}
      onRefreshDefaultAuth={async () => {}}
      onStartDefaultCodexLogin={async () => null}
      onCancelDefaultCodexLogin={async () => {}}
      onStartDefaultClaudeLogin={async () => null}
      onSubmitDefaultClaudeLoginCode={async () => null}
      onCancelDefaultClaudeLogin={async () => {}}
    />,
  );
}

test("shows the empty state for named accounts when the active tab has none (the shared/default login row still always shows)", () => {
  const html = renderModal([]);
  assert.match(html, /尚未建立其他具名帳號/);
  assert.match(html, /共用登入/);
});

test("the shared/default login always shows as its own row, reflecting the owner's real login even with zero named accounts", () => {
  const html = renderModal([], {}, "claude", { ...defaultAuthState(), claude: { provider: "claude", displayName: "Claude Code", status: "authenticated", loginCommand: "claude auth login", checkedAt: null, error: null, debug: null } });
  const sharedRowStart = html.indexOf("共用登入");
  const sharedRow = html.slice(sharedRowStart, sharedRowStart + 800);
  assert.match(sharedRow, /已登入/);
  assert.match(html, /mcp-modal__dot--on/);
});

test("renders an authenticated Codex account with its masked home directory and login status", () => {
  const html = renderModal([account("codex")]);
  assert.match(html, /alice/);
  assert.match(html, /已登入/);
  assert.match(html, /accounts\/acct-1/);
  assert.match(html, /mcp-modal__dot--on/);
});

test("an unauthenticated Codex account shows both login options and no --on dot", () => {
  const html = renderModal([account("codex", { auth: { provider: "codex", displayName: "Codex", status: "unauthenticated", loginCommand: "codex login", checkedAt: null, error: null, debug: null } })]);
  assert.match(html, /尚未登入/);
  assert.match(html, /瀏覽器登入/);
  assert.match(html, /API Key 登入/);
  assert.doesNotMatch(html, /mcp-modal__dot--on/);
});

test("a Codex login in progress shows a cancel action instead of that row's login buttons", () => {
  const html = renderModal(
    [account("codex")],
    { "acct-1": { accountId: "acct-1", status: "running", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null, message: null, loginUrl: null } },
  );
  const aliceRowStart = html.indexOf("alice");
  const aliceRow = html.slice(aliceRowStart, aliceRowStart + 1500);
  assert.match(aliceRow, /登入中…/);
  assert.match(aliceRow, /取消/);
  assert.doesNotMatch(aliceRow, /瀏覽器登入/);
});

test("switching to the Claude tab only shows Claude accounts, with no API key option", () => {
  const html = renderModal(
    [account("codex", { id: "codex-1", label: "codex-alice" }), account("claude", { id: "claude-1", label: "claude-bob" })],
    {},
    "claude",
  );
  assert.match(html, /claude-bob/);
  assert.doesNotMatch(html, /codex-alice/);
  assert.doesNotMatch(html, /API Key 登入/);
});

test("a Claude account awaiting its pasted verification code shows the code input, not that row's login buttons", () => {
  const html = renderModal(
    [account("claude", { id: "claude-1" })],
    { "claude-1": { accountId: "claude-1", status: "awaiting_code", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null, message: null, loginUrl: "https://example.com/authorize" } },
    "claude",
  );
  const aliceRowStart = html.indexOf("alice");
  const aliceRow = html.slice(aliceRowStart, aliceRowStart + 1500);
  assert.match(aliceRow, /等待驗證碼…/);
  assert.match(aliceRow, /完成瀏覽器授權後，把驗證碼貼在這裡/);
  assert.doesNotMatch(aliceRow, /瀏覽器登入/);
});
