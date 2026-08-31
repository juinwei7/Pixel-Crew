import { useState } from "react";
import type { AccountLoginState, AccountWithAuth, ClaudeLoginState, CodexAccountLoginMode, ProviderAuthState, ProviderId } from "../types";
import { t } from "../i18n";
import { Modal } from "./Modal";

function authStatusLabel(status: string | undefined, provider: ProviderId): string {
  switch (status) {
    case "authenticated": return t("已登入");
    case "checking": return t("檢查中…");
    case "unauthenticated": return t("尚未登入");
    case "cli_missing": return provider === "codex" ? t("找不到 Codex CLI") : t("找不到 Claude Code CLI");
    case "error": return t("檢查失敗");
    default: return t("未知");
  }
}

function maskHome(homeDir: string): string {
  const parts = homeDir.split(/[/\\]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : homeDir;
}

const TABS: Array<{ provider: ProviderId; label: string; eyebrow: string }> = [
  { provider: "codex", label: t("Codex"), eyebrow: "CODEX ACCOUNTS" },
  { provider: "claude", label: t("Claude Code"), eyebrow: "CLAUDE ACCOUNTS" },
];

const HINT_BY_PROVIDER: Record<ProviderId, string> = {
  codex: t("提醒：NPC 一旦開始對話就無法直接換帳號（避免默默重置 Codex 端的對話記憶）——要換的話請先清除該 NPC 的工作階段。"),
  claude: t("提醒：NPC 一旦開始對話就無法直接換帳號（避免默默重置 Claude 端的對話記憶）——要換的話請先清除該 NPC 的工作階段。"),
};

type Props = {
  accounts: AccountWithAuth[];
  accountLogins: Record<string, AccountLoginState>;
  onCreate(provider: ProviderId, label: string): Promise<{ data?: AccountWithAuth; error?: string }>;
  onDelete(id: string): Promise<{ orphanedWorkerIds?: string[]; error?: string }>;
  onRefresh(id: string): Promise<string | null>;
  onLogin(id: string, opts?: { mode?: CodexAccountLoginMode; apiKey?: string }): Promise<string | null>;
  onSubmitLoginCode(id: string, code: string): Promise<string | null>;
  onCancelLogin(id: string): Promise<void>;
  onClose(): void;
  initialProvider?: ProviderId;
  // The shared/global default login (no named account) — the same one AuthGate
  // drives before any worker exists. Surfaced here too, as an always-present
  // first row, so "帳號管理" reflects the owner's actual login state instead of
  // only ever showing named accounts (which can legitimately be zero).
  defaultAuth: Record<ProviderId, ProviderAuthState>;
  defaultCodexLogin: AccountLoginState | null;
  defaultClaudeLogin: ClaudeLoginState | null;
  onRefreshDefaultAuth(provider: ProviderId): void | Promise<void>;
  onStartDefaultCodexLogin(mode: CodexAccountLoginMode, apiKey?: string): Promise<string | null>;
  onCancelDefaultCodexLogin(): Promise<void>;
  onStartDefaultClaudeLogin(): Promise<string | null>;
  onSubmitDefaultClaudeLoginCode(code: string): Promise<string | null>;
  onCancelDefaultClaudeLogin(): Promise<void>;
};

export function AccountsModal({
  accounts, accountLogins, onCreate, onDelete, onRefresh, onLogin, onSubmitLoginCode, onCancelLogin, onClose, initialProvider,
  defaultAuth, defaultCodexLogin, defaultClaudeLogin, onRefreshDefaultAuth,
  onStartDefaultCodexLogin, onCancelDefaultCodexLogin,
  onStartDefaultClaudeLogin, onSubmitDefaultClaudeLoginCode, onCancelDefaultClaudeLogin,
}: Props) {
  const [tab, setTab] = useState<ProviderId>(initialProvider ?? "codex");
  const [newLabel, setNewLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [apiKeyOpenFor, setApiKeyOpenFor] = useState<string | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [codeDraftFor, setCodeDraftFor] = useState<Record<string, string>>({});
  const [defaultApiKeyOpen, setDefaultApiKeyOpen] = useState(false);
  const [defaultApiKeyDraft, setDefaultApiKeyDraft] = useState("");
  const [defaultCodeDraft, setDefaultCodeDraft] = useState("");
  const [defaultPending, setDefaultPending] = useState(false);

  const tabAccounts = accounts.filter((account) => account.provider === tab);
  const defaultLogin = tab === "codex" ? defaultCodexLogin : defaultClaudeLogin;
  const defaultLoggingIn = defaultLogin?.status === "running";
  const defaultAwaitingCode = defaultLogin?.status === "awaiting_code";
  const defaultAuthenticated = defaultAuth[tab]?.status === "authenticated";

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!newLabel.trim()) return;
    setCreating(true);
    setNotice(null);
    const result = await onCreate(tab, newLabel.trim());
    setCreating(false);
    if (result.error) setNotice({ ok: false, text: result.error });
    else setNewLabel("");
  }

  async function remove(account: AccountWithAuth) {
    setPendingId(account.id);
    setNotice(null);
    const result = await onDelete(account.id);
    setPendingId(null);
    if (result.error) {
      setNotice({ ok: false, text: result.error });
    } else if (result.orphanedWorkerIds?.length) {
      setNotice({ ok: true, text: t("已刪除「{label}」；{count} 個 NPC 已改回共用登入", { label: account.label, count: result.orphanedWorkerIds.length }) });
    } else {
      setNotice({ ok: true, text: t("已刪除「{label}」", { label: account.label }) });
    }
  }

  async function refresh(id: string) {
    setPendingId(id);
    const error = await onRefresh(id);
    setPendingId(null);
    if (error) setNotice({ ok: false, text: error });
  }

  async function loginOauth(id: string) {
    const error = await onLogin(id, { mode: "oauth" });
    if (error) setNotice({ ok: false, text: error });
  }

  async function loginApiKey(id: string) {
    if (!apiKeyDraft.trim()) return;
    const error = await onLogin(id, { mode: "api-key", apiKey: apiKeyDraft.trim() });
    setApiKeyDraft("");
    setApiKeyOpenFor(null);
    if (error) setNotice({ ok: false, text: error });
  }

  async function submitCode(id: string) {
    const code = (codeDraftFor[id] ?? "").trim();
    if (!code) return;
    const error = await onSubmitLoginCode(id, code);
    if (error) setNotice({ ok: false, text: error });
    else setCodeDraftFor((current) => ({ ...current, [id]: "" }));
  }

  async function defaultRefresh() {
    setDefaultPending(true);
    await onRefreshDefaultAuth(tab);
    setDefaultPending(false);
  }

  async function defaultLoginOauth() {
    const error = tab === "codex" ? await onStartDefaultCodexLogin("oauth") : await onStartDefaultClaudeLogin();
    if (error) setNotice({ ok: false, text: error });
  }

  async function defaultLoginApiKey() {
    if (!defaultApiKeyDraft.trim()) return;
    const error = await onStartDefaultCodexLogin("api-key", defaultApiKeyDraft.trim());
    setDefaultApiKeyDraft("");
    setDefaultApiKeyOpen(false);
    if (error) setNotice({ ok: false, text: error });
  }

  async function defaultSubmitCode() {
    const code = defaultCodeDraft.trim();
    if (!code) return;
    const error = await onSubmitDefaultClaudeLoginCode(code);
    if (error) setNotice({ ok: false, text: error });
    else setDefaultCodeDraft("");
  }

  async function defaultCancel() {
    if (tab === "codex") await onCancelDefaultCodexLogin();
    else await onCancelDefaultClaudeLogin();
  }

  return (
    <Modal label={t("帳號管理")} overlayClassName="mcp-modal" cardClassName="mcp-modal__card" closeClassName="mcp-modal__close" closeLabel={t("關閉帳號管理")} onClose={onClose}>
      <header className="mcp-modal__header">
        <span className="mcp-modal__eyebrow">{TABS.find((item) => item.provider === tab)?.eyebrow}</span>
        <h2>{t("{count} 個帳號", { count: tabAccounts.length })}</h2>
      </header>

      <div className="accounts-modal__tabs" role="tablist">
        {TABS.map((item) => (
          <button
            key={item.provider}
            type="button"
            role="tab"
            aria-selected={tab === item.provider}
            className={`accounts-modal__tab ${tab === item.provider ? "accounts-modal__tab--active" : ""}`}
            onClick={() => { setTab(item.provider); setNotice(null); }}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="mcp-modal__hint">
        {t("每個帳號各自獨立登入；建立 NPC 時可以指定要用哪個帳號，不指定就沿用共用登入。")}
        <br />
        {HINT_BY_PROVIDER[tab]}
      </div>

      <section className="mcp-modal__list">
        <div className="mcp-modal__row">
          <span className={`mcp-modal__dot ${defaultAuthenticated ? "mcp-modal__dot--on" : ""}`} />
          <div className="mcp-modal__info">
            <div className="mcp-modal__info-top">
              <span className="mcp-modal__name">{t("共用登入")}</span>
            </div>
            <div className="mcp-modal__status-line">
              <span className="mcp-modal__status">{authStatusLabel(defaultAuth[tab]?.status, tab)}</span>
            </div>
            <div className="mcp-modal__detail">{t("沒有指定帳號的 NPC 都用這個")}</div>
            {tab === "codex" && defaultApiKeyOpen && (
              <div className="mcp-modal__row-inputs">
                <input
                  aria-label={t("API key")}
                  type="password"
                  placeholder="sk-..."
                  value={defaultApiKeyDraft}
                  onChange={(e) => setDefaultApiKeyDraft(e.target.value)}
                />
                <button type="button" disabled={!defaultApiKeyDraft.trim()} onClick={() => void defaultLoginApiKey()}>{t("送出")}</button>
                <button type="button" onClick={() => { setDefaultApiKeyOpen(false); setDefaultApiKeyDraft(""); }}>×</button>
              </div>
            )}
            {tab === "claude" && defaultAwaitingCode && (
              <div className="mcp-modal__row-inputs">
                <input
                  aria-label={t("驗證碼")}
                  placeholder={t("完成瀏覽器授權後，把驗證碼貼在這裡")}
                  value={defaultCodeDraft}
                  onChange={(e) => setDefaultCodeDraft(e.target.value)}
                />
                <button type="button" disabled={!defaultCodeDraft.trim()} onClick={() => void defaultSubmitCode()}>{t("送出")}</button>
              </div>
            )}
            {(defaultLoggingIn || defaultAwaitingCode) && defaultLogin?.loginUrl && (
              <div className="mcp-modal__hint-inline">
                {t("瀏覽器沒有自動跳出來？")}{" "}
                <a href={defaultLogin.loginUrl} target="_blank" rel="noreferrer">{t("點這裡開啟登入頁面")}</a>
              </div>
            )}
          </div>
          <div className="mcp-modal__actions">
            {defaultLoggingIn || defaultAwaitingCode ? (
              <span className="mcp-modal__login-pending">
                {defaultAwaitingCode ? t("等待驗證碼…") : t("登入中…")}
                <button type="button" onClick={() => void defaultCancel()}>{t("取消")}</button>
              </span>
            ) : (
              <>
                <button type="button" className="mcp-modal__login" onClick={() => void defaultLoginOauth()}>{t("瀏覽器登入")}</button>
                {tab === "codex" && (
                  <button type="button" className="mcp-modal__login" onClick={() => setDefaultApiKeyOpen((current) => !current)}>{t("API Key 登入")}</button>
                )}
              </>
            )}
            <button type="button" className="mcp-modal__refresh" disabled={defaultPending} onClick={() => void defaultRefresh()}>↻</button>
          </div>
        </div>

        {tabAccounts.length === 0 && <div className="mcp-modal__empty">{t("尚未建立其他具名帳號")}</div>}
        {tabAccounts.map((account) => {
          const login = accountLogins[account.id];
          const loggingIn = login?.status === "running";
          const awaitingCode = login?.status === "awaiting_code";
          const authenticated = account.auth?.status === "authenticated";
          return (
            <div key={account.id} className="mcp-modal__row">
              <span className={`mcp-modal__dot ${authenticated ? "mcp-modal__dot--on" : ""}`} />
              <div className="mcp-modal__info">
                <div className="mcp-modal__info-top">
                  <span className="mcp-modal__name">{account.label}</span>
                </div>
                <div className="mcp-modal__status-line">
                  <span className="mcp-modal__status">{authStatusLabel(account.auth?.status, account.provider)}</span>
                </div>
                <div className="mcp-modal__detail">{maskHome(account.homeDir)}</div>
                {account.provider === "codex" && apiKeyOpenFor === account.id && (
                  <div className="mcp-modal__row-inputs">
                    <input
                      aria-label={t("API key")}
                      type="password"
                      placeholder="sk-..."
                      value={apiKeyDraft}
                      onChange={(e) => setApiKeyDraft(e.target.value)}
                    />
                    <button type="button" disabled={!apiKeyDraft.trim()} onClick={() => void loginApiKey(account.id)}>{t("送出")}</button>
                    <button type="button" onClick={() => { setApiKeyOpenFor(null); setApiKeyDraft(""); }}>×</button>
                  </div>
                )}
                {account.provider === "claude" && awaitingCode && (
                  <div className="mcp-modal__row-inputs">
                    <input
                      aria-label={t("驗證碼")}
                      placeholder={t("完成瀏覽器授權後，把驗證碼貼在這裡")}
                      value={codeDraftFor[account.id] ?? ""}
                      onChange={(e) => setCodeDraftFor((current) => ({ ...current, [account.id]: e.target.value }))}
                    />
                    <button type="button" disabled={!(codeDraftFor[account.id] ?? "").trim()} onClick={() => void submitCode(account.id)}>{t("送出")}</button>
                  </div>
                )}
                {(loggingIn || awaitingCode) && login?.loginUrl && (
                  <div className="mcp-modal__hint-inline">
                    {t("瀏覽器沒有自動跳出來？")}{" "}
                    <a href={login.loginUrl} target="_blank" rel="noreferrer">{t("點這裡開啟登入頁面")}</a>
                  </div>
                )}
              </div>
              <div className="mcp-modal__actions">
                {loggingIn || awaitingCode ? (
                  <span className="mcp-modal__login-pending">
                    {awaitingCode ? t("等待驗證碼…") : t("登入中…")}
                    <button type="button" onClick={() => void onCancelLogin(account.id)}>{t("取消")}</button>
                  </span>
                ) : (
                  <>
                    <button type="button" className="mcp-modal__login" onClick={() => void loginOauth(account.id)}>{t("瀏覽器登入")}</button>
                    {account.provider === "codex" && (
                      <button type="button" className="mcp-modal__login" onClick={() => setApiKeyOpenFor(apiKeyOpenFor === account.id ? null : account.id)}>{t("API Key 登入")}</button>
                    )}
                  </>
                )}
                <button type="button" className="mcp-modal__refresh" disabled={pendingId === account.id} onClick={() => void refresh(account.id)}>↻</button>
                <button type="button" className="mcp-modal__remove" disabled={pendingId === account.id} onClick={() => void remove(account)}>{t("刪除")}</button>
              </div>
            </div>
          );
        })}
      </section>

      <form className="mcp-modal__add" onSubmit={create}>
        <div className="mcp-modal__add-title">{t("新增帳號")}</div>
        <input className="mcp-modal__input" placeholder={t("帳號名稱，例如：公司帳號")} value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
        <button className="mcp-modal__submit" type="submit" disabled={creating || !newLabel.trim()}>
          {creating ? t("處理中…") : t("建立")}
        </button>
        {notice && <div className={`mcp-modal__notice ${notice.ok ? "" : "mcp-modal__notice--err"}`}>{notice.text}</div>}
      </form>
    </Modal>
  );
}
