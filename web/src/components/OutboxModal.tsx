import { useEffect, useState, type CSSProperties } from "react";
import { t } from "../i18n";
import { apiRequest } from "../api";
import { Modal } from "./Modal";
import { Icon, type IconName } from "./Icon";

// OUTBOX 成品匣：隊員完成的交付物（放在各工作區 outbox/ 的真實檔案）一覽＋一鍵開啟。
// 工作有前門——不用去聊天記錄裡考古找檔案。

export type OutboxItem = { workerId: string; owners: string; name: string; size: number; mtime: number };

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  const today = new Date();
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 15 分鐘內出現的成品算「新」：卡片左緣亮一條、標 NEW，一進來掃一道光。
const FRESH_MS = 15 * 60 * 1000;
export function isFreshOutboxItem(mtime: number, now = Date.now()): boolean {
  return now - mtime >= 0 && now - mtime < FRESH_MS;
}

function iconFor(name: string): IconName {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
  if (["pdf"].includes(ext)) return "file";
  if (["md", "txt", "doc", "docx", "rtf"].includes(ext)) return "file";
  if (["csv", "xls", "xlsx"].includes(ext)) return "table";
  if (["zip", "7z", "rar", "tar", "gz"].includes(ext)) return "archive";
  if (["html", "htm"].includes(ext)) return "globe";
  if (["js", "ts", "py", "sh", "ps1", "json"].includes(ext)) return "code";
  return "box";
}

export function OutboxModal({ onClose }: { onClose(): void }) {
  const [items, setItems] = useState<OutboxItem[] | null>(null);
  const [error, setError] = useState("");

  const load = async () => {
    setError("");
    try {
      const r = await apiRequest<{ items: OutboxItem[] }>("/api/outbox");
      setItems(r.items);
    } catch (e) {
      setError((e as Error).message || t("載入失敗"));
      setItems([]);
    }
  };
  useEffect(() => { void load(); }, []);

  return (
    <Modal label={t("成品匣")} eyebrow="OUTBOX" title={t("成品匣")} cardClassName="warroom-result__card outbox-modal" onClose={onClose}>
      <p style={{ fontSize: 12.5, color: "#8ea0d0", lineHeight: 1.6, margin: "2px 0 12px" }}>
        {t("隊員完成的交付物會放進各自工作區的 outbox 資料夾，並集中顯示在這裡。想收東西時，直接跟隊員說「完成後把檔案放進 outbox」。")}
      </p>
      {error && <div style={{ color: "#ff9a9a", fontSize: 13, marginBottom: 10 }}>{error}</div>}
      <OutboxList items={items} />
      <div className="outbox-modal__actions" style={{ marginTop: 12, textAlign: "right" }}>
        <button
          type="button"
          onClick={() => { setItems(null); void load(); }}
          style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid #2b3a63", background: "#16203a", color: "#cfe0ff", fontSize: 12.5, cursor: "pointer" }}
        >
          <Icon name="refresh" /> {t("重新整理")}
        </button>
      </div>
    </Modal>
  );
}

// 清單本體（載入骨架／空狀態／項目），跟資料載入分開，方便單獨渲染與測試。
export function OutboxList({ items }: { items: OutboxItem[] | null }) {
  return (
    <>
      {items === null ? (
        <div className="pc-skel outbox-modal__skeleton" role="status" aria-label={t("載入中…")}>
          {[0, 1, 2].map((index) => <span key={index} className="pc-skel__row" style={{ "--i": index } as CSSProperties}><i className="pc-skel__icon" /><i className="pc-skel__line" /><i className="pc-skel__meta" /></span>)}
        </div>
      ) : items.length === 0 ? (
        <div className="pc-empty" style={{ color: "#7d8cb8", fontSize: 13, padding: "18px 0", lineHeight: 1.7 }}>
          <span className="pc-empty__art" aria-hidden="true"><Icon name="box" size={26} /><i /></span>
          <span>{t("目前沒有成品。交辦任務時附一句「完成後把最終檔案放進 outbox 資料夾」，成品就會出現在這裡。")}</span>
        </div>
      ) : (
        <div className="outbox-modal__list" style={{ display: "grid", gap: 6, maxHeight: "52vh", overflowY: "auto" }}>
          {items.map((it, index) => (
            <a
              key={`${it.workerId}/${it.name}`}
              data-fresh={isFreshOutboxItem(it.mtime) || undefined}
              href={`/api/outbox/file?worker=${encodeURIComponent(it.workerId)}&name=${encodeURIComponent(it.name)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="outbox-modal__item"
              style={{
                "--i": Math.min(index, 10),
                display: "flex", alignItems: "center", gap: 10, padding: "9px 12px",
                borderRadius: 10, border: "1px solid #26304e", background: "#101627",
                textDecoration: "none", color: "#dbe4ff",
              } as CSSProperties}
            >
              <span className="outbox-modal__icon"><Icon name={iconFor(it.name)} size={18} /></span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 13.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</span>
                <span style={{ display: "block", fontSize: 11, color: "#7d8cb8", marginTop: 2 }}>{it.owners} · {fmtSize(it.size)}</span>
              </span>
              {isFreshOutboxItem(it.mtime) && <span className="outbox-modal__new">NEW</span>}
              <span style={{ fontSize: 11, color: "#9fb0dd", flexShrink: 0 }}>{fmtTime(it.mtime)}</span>
            </a>
          ))}
        </div>
      )}
    </>
  );
}
