import { t } from "./i18n";

// 分享訪客監護解鎖：當轉接站以 403 { error: "guardian_required" } 擋下受限操作時，
// 跳出深色 modal 收監護密碼，POST /__gate/guardian 換取短時效解鎖 cookie，成功後由呼叫端重試一次。
// 純前端 UI；安全判斷完全在轉接站（_tsproxy.mjs），這裡拿不到密碼也繞不過閘門。

const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
const browserOrigin = typeof window !== "undefined" ? window.location.origin : "http://localhost:8787";
const SERVER_URL = viteEnv?.VITE_SERVER_URL?.trim() || browserOrigin;

let pending: Promise<boolean> | null = null;

// 回傳 true＝解鎖成功（呼叫端可重試），false＝使用者取消或未設定監護密碼。
export function requestGuardianUnlock(): Promise<boolean> {
  if (pending) return pending; // 同時多個請求被擋時共用同一個對話框
  if (typeof document === "undefined") return Promise.resolve(false);
  pending = new Promise<boolean>((resolve) => openModal(resolve)).finally(() => { pending = null; });
  return pending;
}

function openModal(resolve: (ok: boolean) => void): void {
  const overlay = document.createElement("div");
  overlay.setAttribute("style", [
    "position:fixed", "inset:0", "z-index:2147483000",
    "background:rgba(6,10,24,.72)", "backdrop-filter:blur(3px)",
    "display:flex", "align-items:center", "justify-content:center", "padding:20px",
    "font-family:system-ui,-apple-system,'Noto Sans TC',sans-serif",
  ].join(";"));

  const card = document.createElement("div");
  card.setAttribute("style", [
    "background:#111a33", "border:1px solid #223058", "border-radius:16px",
    "box-shadow:0 20px 60px rgba(0,0,0,.5)", "width:min(90vw,360px)",
    "padding:26px 24px", "color:#e6ecff",
  ].join(";"));

  const title = document.createElement("h2");
  title.textContent = t("需要主人授權");
  title.setAttribute("style", "margin:0 0 6px;font-size:17px");

  const sub = document.createElement("p");
  sub.textContent = t("這個操作會動到既有或重要資料，請輸入監護密碼才能繼續。");
  sub.setAttribute("style", "margin:0 0 16px;font-size:13px;color:#8ea0d0;line-height:1.6");

  const input = document.createElement("input");
  input.type = "password";
  input.autocomplete = "off";
  input.placeholder = t("監護密碼");
  input.setAttribute("style", [
    "width:100%", "padding:13px", "border-radius:11px", "border:1px solid #2b365c",
    "background:#0c1428", "color:#e6ecff", "font-size:16px", "box-sizing:border-box",
    "color-scheme:dark",
  ].join(";"));

  const err = document.createElement("div");
  err.setAttribute("style", "color:#ff9a9a;font-size:13px;margin-top:10px;min-height:16px");

  const unlockBtn = document.createElement("button");
  unlockBtn.textContent = t("解鎖並繼續");
  unlockBtn.setAttribute("style", [
    "width:100%", "margin-top:14px", "padding:13px", "border:0", "border-radius:11px",
    "background:#5b8cff", "color:#fff", "font-size:16px", "font-weight:600", "cursor:pointer",
  ].join(";"));

  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = t("取消");
  cancelBtn.setAttribute("style", [
    "width:100%", "margin-top:10px", "padding:12px", "border:0", "border-radius:11px",
    "background:#20305a", "color:#e6ecff", "font-size:15px", "cursor:pointer",
  ].join(";"));

  card.append(title, sub, input, err, unlockBtn, cancelBtn);
  overlay.append(card);
  document.body.append(overlay);
  setTimeout(() => input.focus(), 30);

  let busy = false;
  const close = (ok: boolean) => {
    document.removeEventListener("keydown", onKey);
    overlay.remove();
    resolve(ok);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); close(false); }
    else if (e.key === "Enter" && document.activeElement === input) { e.preventDefault(); submit(); }
  };
  const submit = async () => {
    if (busy) return;
    const pass = input.value;
    if (!pass) { err.textContent = t("請輸入監護密碼"); return; }
    busy = true; unlockBtn.disabled = true; unlockBtn.textContent = t("驗證中…"); err.textContent = "";
    try {
      const r = await fetch(`${SERVER_URL}/__gate/guardian`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode: pass }),
      });
      if (r.ok) { close(true); return; }
      const data = await r.json().catch(() => ({} as { error?: string; retryAfter?: number }));
      if (r.status === 429) {
        const mins = Math.max(1, Math.ceil((data.retryAfter ?? 900) / 60));
        err.textContent = t("嘗試過於頻繁，請約 {mins} 分鐘後再試", { mins: String(mins) });
      } else if (data.error === "guardian_not_set") {
        err.textContent = t("主人尚未設定監護密碼，無法執行此操作。");
      } else {
        err.textContent = t("監護密碼錯誤");
      }
    } catch {
      err.textContent = t("連線失敗，請重試");
    } finally {
      busy = false; unlockBtn.disabled = false; unlockBtn.textContent = t("解鎖並繼續");
    }
  };

  unlockBtn.addEventListener("click", submit);
  cancelBtn.addEventListener("click", () => close(false));
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });
  document.addEventListener("keydown", onKey);
}
