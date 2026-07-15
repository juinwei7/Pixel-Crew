import { useState } from "react";
import type { ProviderAuthState, ProviderId } from "../types";

type Props = {
  auth: ProviderAuthState;
  providers: Record<ProviderId, ProviderAuthState>;
  onRefresh(provider?: ProviderId): void | Promise<void>;
  onUseProvider(provider: ProviderId): void;
};

export function AuthGate({ auth, providers, onRefresh, onUseProvider }: Props) {
  const [copied, setCopied] = useState(false);
  if (auth.status === "authenticated") return null;

  const missing = auth.status === "cli_missing";
  const checking = auth.status === "checking";
  const alternatives = (Object.keys(providers) as ProviderId[]).filter(
    (provider) => provider !== auth.provider && providers[provider].status === "authenticated",
  );

  async function copyLoginCommand() {
    try {
      await navigator.clipboard.writeText(auth.loginCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="auth-gate" role="dialog" aria-modal="true" aria-labelledby="auth-title">
      <div className="auth-gate__card">
        <div className="auth-gate__eyebrow">AGENT CONNECTION</div>
        <h1 id="auth-title" className="auth-gate__title">
          {checking
            ? `正在檢查 ${auth.displayName}…`
            : missing
              ? `找不到 ${auth.displayName} CLI`
              : `${auth.displayName} 尚未登入`}
        </h1>
        <p className="auth-gate__body">
          {missing
            ? `請先安裝 ${auth.displayName} CLI，確認終端機可以執行 ${auth.provider}，再回來重新檢查。`
            : "Pixel Crew 不會接收帳號、密碼或 token。請在終端機完成官方 CLI 登入，成功後這個畫面會自動消失。"}
        </p>

        {!missing && (
          <div className="auth-gate__command">
            <code>{auth.loginCommand}</code>
            <button type="button" onClick={copyLoginCommand} disabled={checking}>
              {copied ? "已複製" : "複製"}
            </button>
          </div>
        )}

        {auth.status === "error" && auth.error && (
          <div className="auth-gate__error">{auth.error}</div>
        )}

        <div className="auth-gate__actions">
          {alternatives.map((provider) => (
            <button
              key={provider}
              type="button"
              className="auth-gate__alternative"
              onClick={() => onUseProvider(provider)}
            >
              使用 {providers[provider].displayName}
            </button>
          ))}
          {checking && <span className="spinner" />}
          <button
            type="button"
            className="auth-gate__refresh"
            onClick={() => void onRefresh(auth.provider)}
            disabled={checking}
          >
            {checking ? "檢查中…" : "重新檢查"}
          </button>
        </div>
        <div className="auth-gate__hint">系統也會每 3 秒自動重新檢查</div>
      </div>
    </div>
  );
}
