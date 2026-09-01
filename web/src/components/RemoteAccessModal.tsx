import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n";
import { apiRequest } from "../api";
import { Modal } from "./Modal";
import { QrTree } from "./QrTree";

type TsInfo = { installed: boolean; running: boolean; dnsName: string; mode: "public" | "private" | "off" };
type CfInfo = { installed: boolean; running: boolean; url: string; downloading: boolean };
type State = {
  port: number;
  passcodeSet: boolean;
  channel: "off" | "tailscale" | "cloudflared";
  tailscale: TsInfo;
  cloudflared: CfInfo;
  autostart: { supported: boolean; enabled: boolean };
  google: { enabled: boolean; clientIdSet: boolean; allowedEmails: string[] };
  share: { enabled: boolean; active: boolean; expiresAt: number; sessionTtlHours: number };
  guardian: { set: boolean };
  publicUrl: string;
};

type Props = {
  notify(message: string, tone?: "ok" | "error" | "info"): void;
  onClose(): void;
};

// run＝呼叫 8790 JSON API（經本體同源代理），成功回完整 state。
type Run = (name: string, body: unknown, key: string, longMs?: number) => Promise<boolean>;

const card = { border: "1px solid #26304e", borderRadius: 12, padding: 14, background: "#0e1424" } as const;
const btn = {
  padding: "9px 14px", border: 0, borderRadius: 10, cursor: "pointer",
  fontSize: 14, fontWeight: 600, color: "#fff",
} as const;
const btnBlue = { ...btn, background: "#5b8cff" } as const;
const btnGhost = { ...btn, background: "transparent", color: "#9fb0dd", border: "1px solid #2c3860" } as const;
const label = { display: "block", fontSize: 12.5, color: "#8ea0d0", margin: "0 0 6px" } as const;
const input = {
  width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #2c3860",
  background: "#0b0f1c", color: "#e6ecff", fontSize: 14, boxSizing: "border-box" as const,
  colorScheme: "dark" as const, // 讓 date/number 等原生彈出選單也套深色
  accentColor: "#5b8cff", // 原生選單選中格套主題藍
};
const summary = { cursor: "pointer", fontSize: 13.5, fontWeight: 600, color: "#c7d3f5", padding: "6px 0" } as const;

export function RemoteAccessModal({ notify, onClose }: Props) {
  const [st, setSt] = useState<State | null>(null);
  const [running, setRunning] = useState<boolean | null>(null);
  const [busy, setBusy] = useState("");
  const [pass, setPass] = useState("");
  const [demo, setDemo] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await apiRequest<{ running: boolean }>("/api/remote-access/status");
      setRunning(s.running);
      if (s.running) setSt(await apiRequest<State>("/api/remote-access/state"));
    } catch {
      setRunning(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function startProxy() {
    setBusy("start");
    try {
      const r = await apiRequest<{ ok: boolean; running: boolean; error?: string }>("/api/remote-access/start", { method: "POST", timeoutMs: 30000 });
      if (r.running) { notify(t("轉接站已啟動"), "ok"); await load(); }
      else notify(r.error || t("轉接站啟動失敗，請稍後再試"), "error");
    } catch (e) { notify((e as Error).message, "error"); }
    finally { setBusy(""); }
  }

  const run: Run = useCallback(async (name, body, key, longMs = 15000) => {
    setBusy(key);
    try {
      const s = await apiRequest<State>(`/api/remote-access/api/${name}`, { method: "POST", body, timeoutMs: longMs });
      setSt(s); setRunning(true);
      return true;
    } catch (e) { notify((e as Error).message, "error"); return false; }
    finally { setBusy(""); }
  }, [notify]);

  async function savePasscode() {
    if (pass.length < 6) { notify(t("通行碼至少 6 碼"), "error"); return; }
    if (await run("passcode", { passcode: pass }, "pass")) { setPass(""); notify(t("通行碼已設定"), "ok"); }
  }

  // === 0→100 步驟計算 ===
  const steps = [
    { label: t("啟動轉接站"), done: running === true },
    { label: t("設定通行碼"), done: !!st?.passcodeSet },
    { label: t("開通對外通道"), done: !!st?.publicUrl },
  ];
  const doneN = steps.filter((s) => s.done).length;
  const pct = Math.round((doneN / steps.length) * 100);

  return (
    <Modal
      label={t("遠端存取／手機控制")}
      eyebrow="REMOTE ACCESS"
      title={t("🔗 遠端存取／手機控制")}
      overlayClassName="warroom-result remote-access-modal"
      cardClassName="warroom-result__card remote-access-modal__card"
      onClose={onClose}
    >
      <div className="remote-access-modal__content" style={{ padding: "2px 2px 8px", color: "#e6ecff", lineHeight: 1.6 }}>
        {/* 進度條 */}
        <div className="remote-access-modal__steps" style={{ display: "flex", gap: 8, alignItems: "center", margin: "0 0 4px" }}>
          {steps.map((s, i) => (
            <div key={i} style={{ flex: 1 }}>
              <div style={{ height: 6, borderRadius: 4, background: s.done ? "#5b8cff" : "#232c46" }} />
              <div style={{ fontSize: 11, marginTop: 4, color: s.done ? "#9fc0ff" : "#5f6f9c" }}>{i + 1}. {s.label}</div>
            </div>
          ))}
        </div>
        <p style={{ margin: "6px 0 12px", fontSize: 12, color: "#7d8cb8" }}>
          {t("完成度")} {pct}%
          <button style={{ ...btnGhost, padding: "3px 8px", fontSize: 11, marginLeft: 10 }} onClick={() => setDemo((v) => !v)}>
            {demo ? t("← 離開預覽") : t("🎬 預覽新手引導")}
          </button>
        </p>

        {demo ? <DemoWalkthrough onDone={() => setDemo(false)} /> : running === null ? (
          <p style={{ color: "#8ea0d0" }}>{t("讀取中…")}</p>
        ) : running !== true ? (
          <div style={card}>
            <p style={{ margin: "0 0 12px", fontSize: 14 }}>{t("第一步：把轉接站（對外通道的門房）啟動起來。")}</p>
            <button style={busy ? { ...btnBlue, opacity: 0.6 } : btnBlue} disabled={!!busy} onClick={() => void startProxy()}>
              {busy === "start" ? t("啟動中…") : t("啟動轉接站")}
            </button>
          </div>
        ) : !st ? (
          <p style={{ color: "#8ea0d0" }}>{t("讀取狀態中…")}</p>
        ) : !st.passcodeSet ? (
          <div style={card}>
            <p style={{ margin: "0 0 10px", fontSize: 14 }}>{t("第二步：設定一組通行碼，之後手機要用它才能連進來。")}</p>
            <label style={label}>{t("通行碼（至少 6 碼，建議夠長）")}</label>
            <input style={input} type="text" value={pass} onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void savePasscode(); }} placeholder="••••••••" />
            <button style={{ ...btnBlue, marginTop: 12 }} disabled={!!busy} onClick={() => void savePasscode()}>
              {busy === "pass" ? t("儲存中…") : t("設定通行碼")}
            </button>
          </div>
        ) : (
          <Dashboard st={st} busy={busy} run={run} notify={notify} onReload={() => void load()} />
        )}
      </div>
    </Modal>
  );
}

// === 已設好：儀表板（狀態卡＋通道二選一＋進階設定）===
function Dashboard({ st, busy, run, notify, onReload }: {
  st: State; busy: string; run: Run;
  notify: Props["notify"]; onReload(): void;
}) {
  const active = st.channel;
  const chanBox = (on: boolean) => ({
    ...card, padding: 12,
    borderColor: on ? "#5b8cff" : "#26304e",
    boxShadow: on ? "0 0 0 1px #5b8cff inset" : "none",
  } as const);

  async function chooseCloudflared() {
    if (!st.cloudflared.installed) { if (!(await run("cloudflared/install", {}, "cfinstall", 120000))) return; }
    if (await run("channel", { type: "cloudflared" }, "chan", 40000)) notify(t("已開通公開網址"), "ok");
  }
  async function chooseTailscale(mode: "public" | "private") {
    if (await run("channel", { type: "tailscale", mode }, "chan", 30000)) notify(t("已切換到 Tailscale"), "ok");
  }
  async function turnOff() { if (await run("channel", { type: "off" }, "chan", 20000)) notify(t("已關閉對外通道"), "ok"); }
  async function copyUrl(u: string) { try { await navigator.clipboard.writeText(u); notify(t("已複製"), "ok"); } catch { /* noop */ } }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {/* 目前對外網址 */}
      {st.publicUrl ? (
        <div className="remote-access-modal__url-card" style={{ ...card, borderColor: "#2e6f4e", background: "#0d1a14" }}>
          <div className="remote-access-modal__url-layout" style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 240px", minWidth: 0 }}>
              <div style={{ fontSize: 12, color: "#7ee0a2", marginBottom: 6 }}>{t("● 已上線，手機用這個網址＋通行碼連進來")}</div>
              <div className="remote-access-modal__url-actions" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <code style={{ flex: 1, color: "#cfe0ff", fontSize: 13, wordBreak: "break-all" }}>{st.publicUrl}</code>
                <button style={btnGhost} onClick={() => void copyUrl(st.publicUrl)}>{t("複製")}</button>
              </div>
              {st.channel === "cloudflared" && (
                <div style={{ fontSize: 11, color: "#7d8cb8", marginTop: 6 }}>{t("※ 免安裝通道的網址每次重啟會變，重開後記得重新複製。")}</div>
              )}
            </div>
            <div className="remote-access-modal__qr" style={{ textAlign: "center", margin: "0 auto" }}>
              <QrTree text={st.publicUrl} px={200} />
              <div style={{ fontSize: 11, color: "#7ee0a2", marginTop: 4 }}>{t("📱 掃碼開啟・點一下逛夜城")}</div>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ ...card, borderColor: "#5a4a20", background: "#191405" }}>
          <div style={{ fontSize: 13, color: "#ffd479" }}>{t("尚未開通對外通道，選下面一種：")}</div>
        </div>
      )}

      {/* 通道二選一 */}
      <div>
        <label style={label}>{t("對外通道（二選一）")}</label>
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ ...chanBox(active === "cloudflared"), cursor: busy ? "default" : "pointer" }} onClick={() => !busy && void chooseCloudflared()}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>☁️ {t("免安裝公開網址（cloudflared）")}</div>
            <div style={{ fontSize: 12, color: "#9fb0dd", marginTop: 3 }}>
              {t("推薦分享給別人。對方零安裝、零註冊，打開網址＋通行碼就能用。網址每次重啟會變。")}
            </div>
            {busy === "cfinstall" && <div style={{ fontSize: 11, color: "#ffd479", marginTop: 4 }}>{t("首次使用，正在下載 cloudflared…")}</div>}
            {busy === "chan" && active !== "cloudflared" && <div style={{ fontSize: 11, color: "#ffd479", marginTop: 4 }}>{t("開通中…")}</div>}
          </div>

          <div style={chanBox(active === "tailscale")}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>
              🔒 {t("Tailscale（固定網址・較私密）")}
              {!st.tailscale.installed && <span style={{ fontSize: 11, color: "#ff9a9a", fontWeight: 400 }}> {t("未安裝")}</span>}
              {st.tailscale.installed && !st.tailscale.running && <span style={{ fontSize: 11, color: "#ffd479", fontWeight: 400 }}> {t("未登入")}</span>}
            </div>
            <div style={{ fontSize: 12, color: "#9fb0dd", marginTop: 3 }}>
              {t("網址固定不變、更穩更私密，但你和要連的人都得先裝並登入 Tailscale。")}
            </div>
            {!st.tailscale.installed ? (
              <a href="https://tailscale.com/download" target="_blank" rel="noopener" style={{ ...btnGhost, display: "inline-block", marginTop: 8, textDecoration: "none" }}>
                {t("前往安裝 Tailscale")}
              </a>
            ) : (
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button style={active === "tailscale" && st.tailscale.mode === "private" ? btnBlue : btnGhost} disabled={!!busy || !st.tailscale.running} onClick={() => void chooseTailscale("private")}>{t("私有")}</button>
                <button style={active === "tailscale" && st.tailscale.mode === "public" ? btnBlue : btnGhost} disabled={!!busy || !st.tailscale.running} onClick={() => void chooseTailscale("public")}>{t("公開")}</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 開機自啟＋關閉通道 */}
      <div className="remote-access-modal__channel-actions" style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
        {st.autostart.supported && (
          <label style={{ display: "flex", gap: 7, alignItems: "center", fontSize: 13, cursor: "pointer" }}>
            <input type="checkbox" checked={st.autostart.enabled} disabled={busy === "auto"} onChange={(e) => void run("autostart", { on: e.target.checked }, "auto")} />
            {t("開機自動啟動轉接站")}
          </label>
        )}
        {active !== "off" && (
          <button style={{ ...btnGhost, marginLeft: "auto" }} disabled={!!busy} onClick={() => void turnOff()}>{t("關閉對外通道")}</button>
        )}
      </div>

      {/* 進階設定 */}
      <div style={{ borderTop: "1px solid #202a44", paddingTop: 4 }}>
        <PasscodeSection busy={busy} run={run} notify={notify} />
        <GuardianSection st={st} busy={busy} run={run} notify={notify} />
        <ShareSection st={st} busy={busy} run={run} notify={notify} />
        <GoogleSection st={st} busy={busy} run={run} notify={notify} onReload={onReload} />
      </div>
    </div>
  );
}

function PasscodeSection({ busy, run, notify }: { busy: string; run: Run; notify: Props["notify"] }) {
  const [v, setV] = useState("");
  async function submit() {
    if (v.length < 6) { notify(t("通行碼至少 6 碼"), "error"); return; }
    if (await run("passcode", { passcode: v }, "pass")) { setV(""); notify(t("通行碼已更新"), "ok"); }
  }
  return (
    <details>
      <summary style={summary}>🔑 {t("變更通行碼")}</summary>
      <div style={{ padding: "8px 2px 14px" }}>
        <label style={label}>{t("新通行碼（至少 6 碼）")}</label>
        <div className="remote-access-modal__input-row" style={{ display: "flex", gap: 8 }}>
          <input style={input} type="text" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} placeholder="••••••••" />
          <button style={btnBlue} disabled={!!busy} onClick={() => void submit()}>{busy === "pass" ? t("儲存中…") : t("更新")}</button>
        </div>
      </div>
    </details>
  );
}

function GuardianSection({ st, busy, run, notify }: { st: State; busy: string; run: Run; notify: Props["notify"] }) {
  const [v, setV] = useState("");
  async function submit() {
    if (v && v.length < 4) { notify(t("監護密碼至少 4 碼"), "error"); return; }
    if (await run("guardian", { passcode: v }, "guardian")) {
      setV("");
      notify(v ? t("監護密碼已設定") : t("監護密碼已清除"), "ok");
    }
  }
  return (
    <details>
      <summary style={summary}>
        🛡️ {t("監護密碼")} {st.guardian.set
          ? <span style={{ color: "#7ee0a2", fontSize: 12 }}>· {t("已設定")}</span>
          : <span style={{ color: "#ffd479", fontSize: 12 }}>· {t("未設定")}</span>}
      </summary>
      <div style={{ padding: "8px 2px 14px" }}>
        <p style={{ fontSize: 12.5, color: "#8ea0d0", lineHeight: 1.6, margin: "0 0 10px" }}>
          {t("分享訪客可以讀取、建立，並刪改自己這次建立的東西；但要動到既有／別人建立的資料或高危操作（還原備份、重啟、換 provider…）時，需先輸入這組監護密碼。與登入通行碼分開，訪客看到也學不到你的主碼。未設定＝訪客一律無法執行受限操作。")}
        </p>
        <label style={label}>{t("監護密碼（至少 4 碼，留空＝清除）")}</label>
        <div className="remote-access-modal__input-row" style={{ display: "flex", gap: 8 }}>
          <input style={input} type="text" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} placeholder={st.guardian.set ? t("已設定，留空＝清除") : "••••"} />
          <button style={btnBlue} disabled={!!busy} onClick={() => void submit()}>{busy === "guardian" ? t("儲存中…") : t("更新")}</button>
        </div>
      </div>
    </details>
  );
}

function toLocalInput(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 每隔 ms 觸發一次重繪，on=false 時不啟動；卸載自動清除（不留孤兒計時器）。
function useTick(ms: number, on: boolean) {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setN((v) => v + 1), ms);
    return () => clearInterval(id);
  }, [ms, on]);
}

// 把「剩餘毫秒」轉成可讀倒數字串。
function fmtRemain(ms: number): string {
  if (ms <= 0) return t("即將到期");
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? t("還有 {h} 小時 {m} 分鐘", { h, m }) : t("還有 {m} 分鐘", { m });
}

function ShareSection({ st, busy, run, notify }: { st: State; busy: string; run: Run; notify: Props["notify"] }) {
  const [mode, setMode] = useState<"quick" | "custom" | "at">("quick");
  const [quickH, setQuickH] = useState(4);
  const [customH, setCustomH] = useState("6");
  const [when, setWhen] = useState(() => toLocalInput(new Date(Date.now() + 4 * 3600 * 1000)));
  const [sp, setSp] = useState("");
  const active = st.share.active;
  useTick(30000, active && st.share.expiresAt > 0); // 分享中才每 30 秒更新倒數

  async function startShare() {
    if (sp.length < 6) { notify(t("分享密碼至少 6 碼"), "error"); return; }
    const body: Record<string, unknown> = { enabled: true, passcode: sp };
    if (mode === "at") {
      const ms = new Date(when).getTime();
      if (!when || !Number.isFinite(ms) || ms <= Date.now()) { notify(t("請選一個未來的時間"), "error"); return; }
      body.expiresAt = ms;
    } else {
      const h = mode === "custom" ? Number(customH) : quickH;
      if (!(h >= 1)) { notify(t("有效時數至少 1 小時"), "error"); return; }
      if (h > 720) { notify(t("最長 720 小時（30 天）"), "error"); return; }
      body.hours = h;
    }
    if (await run("share", body, "share")) { setSp(""); notify(t("已開啟限時分享"), "ok"); }
  }

  const tab = (m: typeof mode, txt: string) => (
    <button style={{ ...(mode === m ? btnBlue : btnGhost), padding: "6px 12px", fontSize: 12.5 }} onClick={() => setMode(m)}>{txt}</button>
  );

  return (
    <details>
      <summary style={summary}>
        ⏱️ {t("限時分享")} {active && <span style={{ color: "#7ee0a2", fontSize: 12 }}>· {t("分享中")}</span>}
      </summary>
      <div style={{ padding: "8px 2px 14px" }}>
        <p style={{ fontSize: 12, color: "#9fb0dd", margin: "0 0 10px" }}>
          {t("開一個「臨時分享密碼」給別人短期使用，到期自動關；跟你的主通行碼分開，關掉後對方立刻失效。")}
        </p>
        {active ? (
          <>
            {st.share.expiresAt > 0 && (
              <div style={{ fontSize: 12.5, color: "#7ee0a2", margin: "0 0 10px" }}>
                {t("到期時間")}：{new Date(st.share.expiresAt).toLocaleString()}
                <span style={{ color: "#9fb0dd", marginLeft: 8 }}>（{fmtRemain(st.share.expiresAt - Date.now())}）</span>
              </div>
            )}
            <button style={btnGhost} disabled={!!busy} onClick={async () => {
              if (await run("share", { enabled: false }, "share")) notify(t("已關閉分享"), "ok");
            }}>{busy === "share" ? t("處理中…") : t("關閉分享")}</button>
          </>
        ) : (
          <>
            <label style={label}>{t("到期方式")}</label>
            <div className="remote-access-modal__choice-row" style={{ display: "flex", gap: 6, marginBottom: 10 }}>
              {tab("quick", t("快捷"))}
              {tab("custom", t("自訂時數"))}
              {tab("at", t("指定到某時刻"))}
            </div>

            {mode === "quick" && (
              <div className="remote-access-modal__choice-row" style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                {[1, 4, 12, 24].map((h) => (
                  <button key={h} style={quickH === h ? btnBlue : btnGhost} onClick={() => setQuickH(h)}>{h}h</button>
                ))}
              </div>
            )}
            {mode === "custom" && (
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
                <input style={{ ...input, width: 110 }} type="number" min={1} max={720} value={customH} onChange={(e) => setCustomH(e.target.value)} />
                <span style={{ fontSize: 13, color: "#9fb0dd" }}>{t("小時（1〜720）")}</span>
              </div>
            )}
            {mode === "at" && (
              <div style={{ marginBottom: 12 }}>
                <input style={input} type="datetime-local" min={toLocalInput(new Date())} value={when} onChange={(e) => setWhen(e.target.value)} />
                <div style={{ fontSize: 11.5, color: "#7d8cb8", marginTop: 4 }}>{t("到這個時刻自動關閉分享")}</div>
              </div>
            )}

            <label style={label}>{t("臨時分享密碼（至少 6 碼）")}</label>
            <div className="remote-access-modal__input-row" style={{ display: "flex", gap: 8 }}>
              <input style={input} type="text" value={sp} onChange={(e) => setSp(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void startShare(); }} placeholder="••••••••" />
              <button style={btnBlue} disabled={!!busy} onClick={() => void startShare()}>{busy === "share" ? t("處理中…") : t("開始分享")}</button>
            </div>
          </>
        )}
      </div>
    </details>
  );
}

function GoogleSection({ st, busy, run, notify, onReload }: { st: State; busy: string; run: Run; notify: Props["notify"]; onReload(): void }) {
  const [cid, setCid] = useState("");
  const [csec, setCsec] = useState("");
  const [emails, setEmails] = useState(st.google.allowedEmails.join(", "));
  // redirect URI 必須固定 → 用 Tailscale 網址（cloudflared 每次變不適合 Google 登入）
  const base = st.tailscale.dnsName ? `https://${st.tailscale.dnsName}` : "";
  const redirectUri = base ? `${base}/__gate/google/callback` : "";

  // Google 登入需要固定 redirect URI，cloudflared 網址每次會變 → 這格灰掉、不讓展開
  const blocked = st.channel === "cloudflared" || !st.tailscale.dnsName;
  if (blocked) {
    return (
      <div style={{ ...summary, cursor: "default", color: "#5f6f9c", display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ opacity: 0.6 }}>🟢 {t("Google 登入（進階）")}</span>
        <span style={{ fontSize: 11.5, color: "#7d8cb8", fontWeight: 400 }}>
          {t("· 需搭配 Tailscale 固定網址（cloudflared 網址每次會變，無法登入）")}
        </span>
      </div>
    );
  }

  return (
    <details>
      <summary style={summary}>
        🟢 {t("Google 登入（進階）")} {st.google.enabled && <span style={{ color: "#7ee0a2", fontSize: 12 }}>· {t("已啟用")}</span>}
      </summary>
      <div style={{ padding: "8px 2px 14px" }}>
        <p style={{ fontSize: 12, color: "#9fb0dd", margin: "0 0 8px" }}>
          {t("讓指定的 Google 帳號免通行碼登入。需先到")} <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener" style={{ color: "#9fc0ff" }}>Google Cloud Console</a> {t("建立 OAuth 2.0 用戶端，取得 ID／密鑰。")}
        </p>
        <p style={{ fontSize: 12, color: "#ffd479", margin: "0 0 8px" }}>
          {t("⚠ 重新導向 URI 必須固定，建議搭 Tailscale（cloudflared 每次網址會變，不適合）。")}
        </p>
        <label style={label}>{t("把這個「已授權的重新導向 URI」貼到 Google Cloud：")}</label>
        <div className="remote-access-modal__input-row" style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <code style={{ ...input, padding: "8px 10px", color: redirectUri ? "#cfe0ff" : "#6b7aa0" }}>{redirectUri || t("（先開通 Tailscale 才會有）")}</code>
          {redirectUri && <button style={btnGhost} onClick={async () => { try { await navigator.clipboard.writeText(redirectUri); notify(t("已複製"), "ok"); } catch { /* noop */ } }}>{t("複製")}</button>}
        </div>
        <label style={label}>{t("Client ID")} {st.google.clientIdSet && <span style={{ color: "#7ee0a2" }}>（{t("已設定，留空不變")}）</span>}</label>
        <input style={input} type="text" value={cid} onChange={(e) => setCid(e.target.value)} placeholder="xxxx.apps.googleusercontent.com" />
        <label style={{ ...label, marginTop: 10 }}>{t("Client Secret")}（{t("留空不變")}）</label>
        <input style={input} type="password" value={csec} onChange={(e) => setCsec(e.target.value)} placeholder="••••••••" />
        <label style={{ ...label, marginTop: 10 }}>{t("允許的 Email（可多個，用逗號分隔）")}</label>
        <input style={input} type="text" value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="you@gmail.com, friend@gmail.com" />
        <button style={{ ...btnBlue, marginTop: 12 }} disabled={!!busy} onClick={async () => {
          const body: Record<string, unknown> = { allowedEmails: emails.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean) };
          if (cid.trim()) body.clientId = cid.trim();
          if (csec.trim()) body.clientSecret = csec.trim();
          if (await run("google", body, "google")) { setCid(""); setCsec(""); notify(t("Google 設定已儲存"), "ok"); onReload(); }
        }}>{busy === "google" ? t("儲存中…") : t("儲存 Google 設定")}</button>
      </div>
    </details>
  );
}

// === 空白新機的 0→100 教學（純預覽，不會實際變更）===
function DemoWalkthrough({ onDone }: { onDone(): void }) {
  const [i, setI] = useState(0);
  const steps = [
    { t: t("① 啟動轉接站"), d: t("按一下「啟動轉接站」，它是對外的門房，負責驗證通行碼、把手機的連線轉給本機。") },
    { t: t("② 設定通行碼"), d: t("輸入一組夠長的通行碼。之後任何人（含你自己的手機）都要用它才進得來。") },
    { t: t("③ 選對外通道"), d: t("要分享給沒裝東西的人 → 選『免安裝公開網址』；只給自己或想要固定網址 → 選 Tailscale。") },
    { t: t("④ 拿到網址"), d: t("開通後上方會出現一條網址。手機打開它，輸入通行碼，就能遠端操作了。") },
    { t: t("完成！"), d: t("免安裝通道的網址每次重啟會變，重開後回這裡重新複製即可；Tailscale 則固定不變。") },
  ];
  const last = i === steps.length - 1;
  const s = steps[i];
  return (
    <div style={{ ...card, borderColor: "#3a4a80" }}>
      <div style={{ fontSize: 11, color: "#ffd479", marginBottom: 8 }}>{t("預覽模式・示範一台全新空白電腦怎麼從 0 設到能用（不會實際變更任何設定）")}</div>
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>{s.t}</div>
      <div style={{ fontSize: 13, color: "#c7d3f5", minHeight: 48 }}>{s.d}</div>
      <div className="remote-access-modal__demo-actions" style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
        <button style={btnGhost} disabled={i === 0} onClick={() => setI((v) => Math.max(0, v - 1))}>{t("上一步")}</button>
        <button style={btnBlue} onClick={() => (last ? onDone() : setI((v) => v + 1))}>{last ? t("完成（關閉教學）") : t("下一步")}</button>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "#7d8cb8" }}>{i + 1} / {steps.length}</span>
      </div>
    </div>
  );
}
