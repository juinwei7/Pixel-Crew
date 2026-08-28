import { useEffect, useState } from "react";
import { t } from "../i18n";
import { apiRequest } from "../api";
import { Modal } from "./Modal";

// OUTBOX 成品匣：隊員完成的交付物（放在各工作區 outbox/ 的真實檔案）一覽＋一鍵開啟。
// 工作有前門——不用去聊天記錄裡考古找檔案。

type OutboxItem = { workerId: string; owners: string; name: string; size: number; mtime: number };

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

function iconFor(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "🖼️";
  if (["pdf"].includes(ext)) return "📕";
  if (["md", "txt", "doc", "docx", "rtf"].includes(ext)) return "📄";
  if (["csv", "xls", "xlsx"].includes(ext)) return "📊";
  if (["zip", "7z", "rar", "tar", "gz"].includes(ext)) return "🗜️";
  if (["html", "htm"].includes(ext)) return "🌐";
  if (["js", "ts", "py", "sh", "ps1", "json"].includes(ext)) return "🧩";
  return "📦";
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
    <Modal label={t("成品匣")} eyebrow="OUTBOX" title={`📦 ${t("成品匣")}`} onClose={onClose}>
      <p style={{ fontSize: 12.5, color: "#8ea0d0", lineHeight: 1.6, margin: "2px 0 12px" }}>
        {t("隊員完成的交付物會放進各自工作區的 outbox 資料夾，並集中顯示在這裡。想收東西時，直接跟隊員說「完成後把檔案放進 outbox」。")}
      </p>
      {error && <div style={{ color: "#ff9a9a", fontSize: 13, marginBottom: 10 }}>{error}</div>}
      {items === null ? (
        <div style={{ color: "#7d8cb8", fontSize: 13, padding: "18px 0" }}>{t("載入中…")}</div>
      ) : items.length === 0 ? (
        <div style={{ color: "#7d8cb8", fontSize: 13, padding: "18px 0", lineHeight: 1.7 }}>
          {t("目前沒有成品。交辦任務時附一句「完成後把最終檔案放進 outbox 資料夾」，成品就會出現在這裡。")}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 6, maxHeight: "52vh", overflowY: "auto" }}>
          {items.map((it) => (
            <a
              key={`${it.workerId}/${it.name}`}
              href={`/api/outbox/file?worker=${encodeURIComponent(it.workerId)}&name=${encodeURIComponent(it.name)}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "flex", alignItems: "center", gap: 10, padding: "9px 12px",
                borderRadius: 10, border: "1px solid #26304e", background: "#101627",
                textDecoration: "none", color: "#dbe4ff",
              }}
            >
              <span style={{ fontSize: 18 }}>{iconFor(it.name)}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 13.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</span>
                <span style={{ display: "block", fontSize: 11, color: "#7d8cb8", marginTop: 2 }}>{it.owners} · {fmtSize(it.size)}</span>
              </span>
              <span style={{ fontSize: 11, color: "#9fb0dd", flexShrink: 0 }}>{fmtTime(it.mtime)}</span>
            </a>
          ))}
        </div>
      )}
      <div style={{ marginTop: 12, textAlign: "right" }}>
        <button
          type="button"
          onClick={() => { setItems(null); void load(); }}
          style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid #2b3a63", background: "#16203a", color: "#cfe0ff", fontSize: 12.5, cursor: "pointer" }}
        >
          ↻ {t("重新整理")}
        </button>
      </div>
    </Modal>
  );
}
