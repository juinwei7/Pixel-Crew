import { useState, type FormEvent } from "react";
import type { CapabilityState } from "../types";
import { apiRequest } from "../api";
import { t } from "../i18n";
import { Modal } from "./Modal";

type Props = {
  capabilities: CapabilityState;
  onClose(): void;
};

// Codex's app-server never reports its own slash-command catalog, so
// DEFAULT_CODEX_SLASH_COMMANDS (server/src/codexCapabilities.ts) always lags
// behind whatever Codex ships next. This lets the user grow the *palette*
// list themselves instead of waiting for a Pixel Crew release — but only the
// built-ins (clear/compact/new/review/goal) actually dispatch through a real
// app-server RPC (parseCodexNativeCommand/runNativeCommand in
// codexRunner.ts); anything added here is sent as plain chat text. See the
// customSlashCommands comment on CapabilityState.
export function CodexCommandsModal({ capabilities, onClose }: Props) {
  const custom = capabilities.customSlashCommands ?? [];
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  async function add(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await apiRequest("/api/codex/slash-commands", { method: "POST", body: { name: trimmed } });
      setName("");
      setNotice({ ok: true, text: t("已新增 /{name}", { name: trimmed }) });
    } catch (error) {
      setNotice({ ok: false, text: (error as Error).message });
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(command: string) {
    setPendingRemove(command);
    setNotice(null);
    try {
      await apiRequest(`/api/codex/slash-commands/${encodeURIComponent(command)}`, { method: "DELETE" });
      setNotice({ ok: true, text: t("已移除 /{name}", { name: command }) });
    } catch (error) {
      setNotice({ ok: false, text: (error as Error).message });
    } finally {
      setPendingRemove(null);
    }
  }

  return (
    <Modal label={t("Codex 原生指令管理")} overlayClassName="mcp-modal" cardClassName="mcp-modal__card" closeClassName="mcp-modal__close" closeLabel={t("關閉 Codex 指令管理")} onClose={onClose}>
      <header className="mcp-modal__header">
        <span className="mcp-modal__eyebrow">CODEX COMMANDS</span>
        <h2>{t("Codex 原生指令管理")}</h2>
      </header>
      <div className="mcp-modal__hint">
        {t("目前只有 clear / compact / new / review / goal 這幾個內建指令在 Pixel Crew 這邊有真正對應的執行邏輯。這裡新增的自訂指令只會被當成一般文字送給 codex，能不能被理解、有沒有實際效果，完全取決於 codex 本身。")}
      </div>
      {notice && <div className={`mcp-modal__notice ${notice.ok ? "" : "mcp-modal__notice--err"}`}>{notice.text}</div>}
      <form className="codex-commands-modal__add" onSubmit={(event) => void add(event)}>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("指令名稱，例如 plan")}
          aria-label={t("新指令名稱")}
          maxLength={40}
        />
        <button type="submit" disabled={submitting || !name.trim()}>{submitting ? t("新增中…") : t("新增")}</button>
      </form>
      <section className="mcp-modal__list">
        {custom.length === 0 && <div className="mcp-modal__empty">{t("還沒有自訂指令")}</div>}
        {custom.map((command) => (
          <div key={command} className="mcp-modal__row codex-commands-modal__row">
            <span className="mcp-modal__name">/{command}</span>
            <button type="button" className="codex-commands-modal__remove" onClick={() => void remove(command)} disabled={pendingRemove === command}>
              {pendingRemove === command ? t("移除中…") : t("移除")}
            </button>
          </div>
        ))}
      </section>
    </Modal>
  );
}
