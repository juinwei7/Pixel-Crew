import { useState } from "react";
import type { ProviderAuthState, ProviderId, ProviderInstallState } from "../types";

type Props = {
  auth: ProviderAuthState;
  providers: Record<ProviderId, ProviderAuthState>;
  installs: Record<ProviderId, ProviderInstallState>;
  platform?: string;
  onRefresh(provider?: ProviderId): void | Promise<void>;
  onInstall(provider: ProviderId): void | Promise<string | null>;
  onUseProvider(provider: ProviderId): void;
};

const DOCS: Record<ProviderId, string> = {
  claude: "https://code.claude.com/docs/en/setup",
  codex: "https://learn.chatgpt.com/docs/codex/cli",
};

export function providerInstallCommand(provider: ProviderId, platform = ""): string {
  if (provider === "codex") return platform === "win32"
    ? "$env:CODEX_NON_INTERACTIVE=1; irm https://chatgpt.com/codex/install.ps1 | iex"
    : "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh";
  return platform === "win32"
    ? "winget install Anthropic.ClaudeCode"
    : "curl -fsSL https://claude.ai/install.sh | bash";
}

export function providerVerifyCommand(provider: ProviderId): string {
  return provider === "claude" ? "claude --version" : "codex --version";
}

function statusLabel(auth: ProviderAuthState): string {
  if (auth.status === "authenticated") return "已就緒";
  if (auth.status === "checking") return "檢查中";
  if (auth.status === "cli_missing") return "尚未安裝";
  if (auth.status === "unauthenticated") return "需要登入";
  return "連線異常";
}

export function AuthGate({ auth, providers, installs, platform, onRefresh, onInstall, onUseProvider }: Props) {
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmProvider, setConfirmProvider] = useState<ProviderId | null>(null);
  const readyProviders = (Object.keys(providers) as ProviderId[]).filter(
    (provider) => providers[provider].status === "authenticated",
  );
  if (auth.status === "authenticated") return null;

  const blocking = readyProviders.length === 0;
  const checkingAll = (Object.values(providers) as ProviderAuthState[]).every(
    (provider) => provider.status === "checking",
  );
  const visibleProviders = blocking
    ? (Object.keys(providers) as ProviderId[])
    : [auth.provider];

  async function copyCommand(key: string, command: string) {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(key);
      setTimeout(() => setCopied((current) => current === key ? null : current), 1600);
    } catch {
      setCopied(null);
    }
  }

  return (
    <div
      className={`auth-gate ${blocking ? "auth-gate--blocking" : "auth-gate--optional"}`}
      role={blocking ? "dialog" : "region"}
      aria-modal={blocking ? "true" : undefined}
      aria-labelledby="auth-title"
    >
      <div className="auth-gate__card">
        <div className="auth-gate__eyebrow">AGENT CONNECTION</div>
        <h1 id="auth-title" className="auth-gate__title">
          {blocking
            ? checkingAll
              ? "正在尋找可用的 AI 隊員…"
              : "連接一位 AI 隊員"
            : `${auth.displayName} 尚未就緒`}
        </h1>
        <p className="auth-gate__body">
          {blocking
            ? "Claude Code 或 Codex 任一完成安裝與登入，就能開始工作。Pixel Crew 不會接收帳號、密碼或 token。"
            : `辦公室仍可使用 ${readyProviders.map((provider) => providers[provider].displayName).join(" 或 ")}。你可以先切換隊員，或依下方步驟設定 ${auth.displayName}。`}
        </p>

        <div className={`auth-provider-grid ${blocking ? "" : "auth-provider-grid--single"}`}>
          {visibleProviders.map((provider) => {
            const state = providers[provider];
            const install = installs[provider];
            const installCommand = providerInstallCommand(provider, platform);
            const verifyCommand = providerVerifyCommand(provider);
            const showInstall = state.status === "cli_missing" || state.status === "error";
            const showSetup = state.status !== "checking" && state.status !== "authenticated";
            return (
              <section key={provider} className={`auth-provider-card auth-provider-card--${state.status}`} aria-label={`${state.displayName} 連線設定`}>
                <header className="auth-provider-card__header">
                  <div>
                    <span>{provider === "claude" ? "CL" : "CX"}</span>
                    <strong>{state.displayName}</strong>
                  </div>
                  <b>{statusLabel(state)}</b>
                </header>

                {state.status === "checking" && <div className="auth-provider-card__checking"><span className="spinner" />正在確認 CLI 與登入狀態</div>}
                {state.status === "authenticated" && <p className="auth-provider-card__ready">已可接收任務。</p>}

                {showSetup && (
                  <ol className="auth-provider-steps">
                    {showInstall && (
                      <li>
                        <span>1</span>
                        <div><strong>安裝 CLI</strong><CommandRow command={installCommand} copyKey={`${provider}:install`} copied={copied} onCopy={copyCommand} /></div>
                      </li>
                    )}
                    <li>
                      <span>{showInstall ? "2" : "1"}</span>
                      <div><strong>在終端機登入</strong><CommandRow command={state.loginCommand} copyKey={`${provider}:login`} copied={copied} onCopy={copyCommand} /></div>
                    </li>
                    <li>
                      <span>{showInstall ? "3" : "2"}</span>
                      <div><strong>確認安裝完成</strong><CommandRow command={verifyCommand} copyKey={`${provider}:verify`} copied={copied} onCopy={copyCommand} /></div>
                    </li>
                  </ol>
                )}

                {showInstall && (
                  <div className={`auth-install-status auth-install-status--${install.status}`}>
                    {install.status !== "idle" && (
                      <div>
                        {install.status === "running" && <span className="spinner" />}
                        <strong>{install.phase}</strong>
                        {install.error && <p>{install.error}</p>}
                        {install.output && <details><summary>安裝器輸出</summary><pre>{install.output}</pre></details>}
                      </div>
                    )}
                    <button
                      type="button"
                      className="auth-install-button"
                      onClick={() => setConfirmProvider(provider)}
                      disabled={install.status === "running"}
                    >
                      {install.status === "running" ? "安裝中…" : install.status === "failed" ? "重新安裝／修復" : "一鍵安裝／修復"}
                    </button>
                  </div>
                )}

                {state.error && <div className="auth-gate__error">{state.error}</div>}
                {state.debug && (
                  <details className="auth-gate__debug">
                    <summary>診斷資訊</summary>
                    <pre>{state.debug}</pre>
                  </details>
                )}
                {state.status !== "authenticated" && (
                  <div className="auth-provider-card__footer">
                    <a href={DOCS[provider]} target="_blank" rel="noreferrer">官方安裝說明 ↗</a>
                    <button type="button" onClick={() => void onRefresh(provider)} disabled={state.status === "checking"}>
                      {state.status === "checking" ? "檢查中…" : "重新檢查"}
                    </button>
                  </div>
                )}
              </section>
            );
          })}
        </div>

        {!blocking && (
          <div className="auth-gate__actions">
            {readyProviders.map((provider) => (
              <button key={provider} type="button" className="auth-gate__alternative" onClick={() => onUseProvider(provider)}>
                改用 {providers[provider].displayName}
              </button>
            ))}
          </div>
        )}
        {blocking && <div className="auth-gate__hint">完成安裝或登入後按「重新檢查」；系統也會每 3 秒自動確認。</div>}

        {confirmProvider && (
          <div className="auth-install-confirm" role="alertdialog" aria-modal="true" aria-labelledby="install-confirm-title">
            <div className="auth-install-confirm__card">
              <div className="auth-gate__eyebrow">OFFICIAL INSTALLER</div>
              <h2 id="install-confirm-title">安裝 {providers[confirmProvider].displayName}？</h2>
              <p>Pixel Crew 將執行下列固定的官方安裝器。它會修改你的使用者程式目錄，但不會安裝 npm，也不會取得帳號密碼或 token。</p>
              <div className="auth-gate__command"><code>{providerInstallCommand(confirmProvider, platform)}</code></div>
              <a href={DOCS[confirmProvider]} target="_blank" rel="noreferrer">查看官方安裝說明 ↗</a>
              <p className="auth-install-confirm__note">安裝完成後仍需由你在官方 CLI 完成登入。</p>
              <div className="auth-install-confirm__actions">
                <button type="button" onClick={() => setConfirmProvider(null)}>取消</button>
                <button type="button" className="auth-install-button" onClick={() => {
                  const provider = confirmProvider;
                  setConfirmProvider(null);
                  void onInstall(provider);
                }}>確認並安裝</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CommandRow({
  command,
  copyKey,
  copied,
  onCopy,
}: {
  command: string;
  copyKey: string;
  copied: string | null;
  onCopy(key: string, command: string): void | Promise<void>;
}) {
  return (
    <div className="auth-gate__command">
      <code>{command}</code>
      <button type="button" onClick={() => void onCopy(copyKey, command)} aria-label={`複製 ${command}`}>
        {copied === copyKey ? "已複製" : "複製"}
      </button>
    </div>
  );
}
