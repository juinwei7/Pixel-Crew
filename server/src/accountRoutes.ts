import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { t } from "./i18n.js";
import { ensurePrivateDirectorySync } from "./platform/fileProtection.js";
import type { ProviderAuthState, ProviderId } from "./providers/types.js";
import type { LocalStore, ProviderAccount } from "./store.js";

type LoginStart = { state: unknown; alreadyRunning: boolean };

export function registerAccountRoutes(input: {
  app: Express;
  store: LocalStore;
  dataDirectory: string;
  accountAuth(accountId: string): ProviderAuthState | null | undefined;
  busyWorkerNames(accountId: string): string[];
  cancelAccountLogin(provider: ProviderId, accountId: string): boolean;
  invalidateAccountAuth(accountId: string): void;
  onAccountDeleted(accountId: string, orphanedWorkerIds: string[]): void;
  refreshAccountAuth(accountId: string): Promise<ProviderAuthState | null | undefined>;
  onAccountAuthUpdated(accountId: string, auth: ProviderAuthState): void;
  startCodexLogin(accountId: string, homeDir: string, mode: "oauth" | "api-key", apiKey?: string): LoginStart;
  startClaudeLogin(accountId: string, homeDir: string): LoginStart;
  accountLoginState(provider: ProviderId, accountId: string): unknown;
  submitClaudeLoginCode(accountId: string, code: string): boolean;
}): void {
  const { app, store } = input;

  app.get("/api/accounts", (_req, res) => {
    const accounts = store.listAccounts().map((account) => ({ ...account, auth: input.accountAuth(account.id) }));
    res.json({ accounts });
  });

  app.post("/api/accounts", (req, res) => {
    const provider: ProviderId = req.body?.provider === "codex" ? "codex" : "claude";
    const label = String(req.body?.label ?? "").trim();
    if (!label) { res.status(400).json({ error: t("請輸入帳號名稱") }); return; }
    const id = randomUUID();
    const homeDir = join(input.dataDirectory, "accounts", id);
    ensurePrivateDirectorySync(homeDir);
    const now = new Date().toISOString();
    const account: ProviderAccount = { id, provider, label, homeDir, createdAt: now, updatedAt: now };
    if (!store.saveAccount(account)) { res.status(500).json({ error: t("儲存帳號失敗") }); return; }
    res.json({ account, auth: input.accountAuth(id) });
  });

  app.delete("/api/accounts/:id", (req, res) => {
    const account = store.getAccount(req.params.id);
    const busyNames = account ? input.busyWorkerNames(account.id) : [];
    if (busyNames.length > 0) {
      res.status(409).json({ error: t("以下 NPC 正在使用這個帳號工作，請等工作結束再刪除：{names}", { names: busyNames.join("、") }) });
      return;
    }
    // Cancel before deleting the home directory: an in-flight OAuth child
    // could otherwise recreate credentials after the account is gone.
    if (account) input.cancelAccountLogin(account.provider, account.id);
    const { deleted, orphanedWorkerIds } = store.deleteAccount(req.params.id);
    if (!deleted) { res.status(500).json({ error: t("刪除帳號失敗") }); return; }
    input.invalidateAccountAuth(req.params.id);
    if (account) {
      try { rmSync(account.homeDir, { recursive: true, force: true }); }
      catch (error) { console.warn(`[accounts] failed to remove ${account.homeDir}:`, (error as Error).message); }
    }
    input.onAccountDeleted(req.params.id, orphanedWorkerIds);
    res.json({ ok: true, orphanedWorkerIds });
  });

  app.post("/api/accounts/:id/refresh", async (req, res) => {
    const account = store.getAccount(req.params.id);
    if (!account) { res.status(404).json({ error: "unknown account" }); return; }
    const auth = await input.refreshAccountAuth(account.id);
    if (auth) input.onAccountAuthUpdated(account.id, auth);
    res.json({ auth });
  });

  app.post("/api/accounts/:id/login", (req, res) => {
    const account = store.getAccount(req.params.id);
    if (!account) { res.status(404).json({ error: "unknown account" }); return; }
    if (account.provider === "codex") {
      const mode = req.body?.mode === "api-key" ? "api-key" : "oauth";
      const apiKey = mode === "api-key" ? String(req.body?.apiKey ?? "").trim() : undefined;
      if (mode === "api-key" && !apiKey) { res.status(400).json({ error: t("請輸入 API key") }); return; }
      const { state, alreadyRunning } = input.startCodexLogin(account.id, account.homeDir, mode, apiKey);
      res.status(alreadyRunning ? 200 : 202).json({ state });
      return;
    }
    const { state, alreadyRunning } = input.startClaudeLogin(account.id, account.homeDir);
    res.status(alreadyRunning ? 200 : 202).json({ state });
  });

  app.get("/api/accounts/:id/login", (req, res) => {
    const account = store.getAccount(req.params.id);
    res.json({ state: account ? input.accountLoginState(account.provider, account.id) ?? null : null });
  });

  app.post("/api/accounts/:id/login/code", (req, res) => {
    const account = store.getAccount(req.params.id);
    if (!account || account.provider !== "claude") { res.status(400).json({ error: t("這個帳號不需要輸入驗證碼") }); return; }
    const code = String(req.body?.code ?? "").trim();
    if (!code) { res.status(400).json({ error: t("請輸入驗證碼") }); return; }
    if (!input.submitClaudeLoginCode(account.id, code)) {
      res.status(409).json({ error: t("目前沒有等待驗證碼的登入流程") }); return;
    }
    res.json({ ok: true });
  });

  app.post("/api/accounts/:id/login/cancel", (req, res) => {
    const account = store.getAccount(req.params.id);
    res.json({ ok: account ? input.cancelAccountLogin(account.provider, account.id) : false });
  });
}
