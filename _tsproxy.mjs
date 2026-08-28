// Tailscale 轉接站 + 手機登入關卡：127.0.0.1:8790 -> 127.0.0.1:8787
//
// 設計：
//  - 本體(8787)只信任 loopback Host/Origin（防 DNS rebinding），這裡把 Host 改寫成
//    127.0.0.1、拿掉 Origin/Referer，讓手機經 tailnet 進來時本體肯放行。
//  - 兩層信任登入（登入狀態＝HMAC 簽章 cookie，密鑰放 _tsproxy.secret.json，不在原始碼裡）：
//      owner 級：主通行碼（30天）或 Google 登入（email 白名單）。
//      share 級：臨時分享密碼；預設關、可一鍵開 N 小時、到期自動關、session 短時效。
//  - 設定精靈 /__gate/admin（owner 專用）：Tailscale 偵測與引導、通行碼、公開/私有切換、限時分享、Google。
//  - 首次啟動（尚未設通行碼）：只在「主機本機直連」顯示設定頁，遠端一律擋，避免公網搶先佔用。
//  - 零第三方相依，只用 node 內建模組。祕密永不進 repo（見 _tsproxy.secret.example.json）。
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.PC_TSPROXY_CONFIG || path.join(__dirname, '_tsproxy.secret.json');

const LISTEN_PORT = Number(process.env.PC_TSPROXY_PORT) || 8790;
const TARGET_HOST = '127.0.0.1';
const TARGET_PORT = Number(process.env.PC_TSPROXY_TARGET_PORT) || 8787; // 可覆寫（測試對 mock 上游用）
const TARGET_HOSTHEADER = `${TARGET_HOST}:${TARGET_PORT}`;

const COOKIE = 'pc_gate';
const STATE_COOKIE = 'pc_oauth_state';
const GUARDIAN_COOKIE = 'pc_grd';                 // 分享訪客暫時取得的「監護解鎖」狀態
const OWNER_TTL_MS = 30 * 24 * 3600 * 1000;       // owner 登入 30 天
const GUARDIAN_TTL_MS = 15 * 60 * 1000;           // 監護解鎖有效 15 分鐘，到期要重輸

function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}; } catch {}
  let dirty = false;
  // 注意：passcode 不自動產生——留空代表「尚未設定」，會觸發首次設定精靈。
  if (typeof cfg.passcode !== 'string') { cfg.passcode = ''; dirty = true; }
  if (!cfg.signingSecret) { cfg.signingSecret = crypto.randomBytes(32).toString('hex'); dirty = true; }
  if (!cfg.google) { cfg.google = { clientId: '', clientSecret: '', allowedEmails: [] }; dirty = true; }
  if (!Array.isArray(cfg.google.allowedEmails)) { cfg.google.allowedEmails = []; dirty = true; }
  if (!cfg.share) { cfg.share = { enabled: false, expiresAt: 0, passcode: '', sessionTtlHours: 12 }; dirty = true; }
  // guardian（監護密碼）：分享訪客要刪除/動到既有或高危操作時，需輸入這組密碼 step-up 才放行。
  // 與 owner 通行碼分開，訪客看到也學不到主碼。留空＝未設定（受限操作一律擋）。
  if (!cfg.guardian) { cfg.guardian = { passcode: '' }; dirty = true; }
  if (typeof cfg.guardian.passcode !== 'string') { cfg.guardian.passcode = ''; dirty = true; }
  // channel＝目前選用的對外通道偏好：'off' | 'tailscale' | 'cloudflared'
  if (typeof cfg.channel !== 'string') { cfg.channel = 'off'; dirty = true; }
  if (dirty) saveConfig(cfg);
  return cfg;
}
function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); } catch {}
}
const CONFIG = loadConfig();
const googleEnabled = () => !!(CONFIG.google && CONFIG.google.clientId && CONFIG.google.clientSecret);
// Google 登入需要固定的 redirect URI；cloudflared 網址每次會變 → 只在 Tailscale 固定網址通道下顯示。
const googleLoginUsable = () => googleEnabled() && CONFIG.channel === 'tailscale';
const needsSetup = () => !CONFIG.passcode;

// --- Tailscale CLI（用來偵測狀態與切換公開/私有）---
const TS_CANDIDATES = [
  process.env.TAILSCALE_EXE,
  'tailscale',
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
  '/usr/bin/tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale',
].filter(Boolean);
function tsExec(args) {
  return new Promise((resolve) => {
    let i = 0;
    const tryNext = () => {
      if (i >= TS_CANDIDATES.length) { resolve({ ok: false, notFound: true, stdout: '', stderr: '' }); return; }
      const bin = TS_CANDIDATES[i++];
      execFile(bin, args, { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT') { tryNext(); return; }
        resolve({ ok: !err, notFound: false, stdout: stdout || '', stderr: stderr || '', bin });
      });
    };
    tryNext();
  });
}
// 回傳 { installed, running, dnsName, mode: 'public'|'private'|'off' }
async function tsInfo() {
  const st = await tsExec(['status', '--json']);
  if (st.notFound) return { installed: false, running: false, dnsName: '', mode: 'off' };
  let running = false, dnsName = '';
  try {
    const j = JSON.parse(st.stdout);
    running = j.BackendState === 'Running';
    dnsName = String((j.Self && j.Self.DNSName) || '').replace(/\.$/, '');
  } catch {}
  let mode = 'off';
  const sv = await tsExec(['serve', 'status']);
  const txt = sv.stdout || '';
  const proxied = new RegExp(`\\b${LISTEN_PORT}\\b`).test(txt);
  const funnelOn = /Funnel on/i.test(txt);
  if (proxied) mode = funnelOn ? 'public' : 'private';
  return { installed: true, running, dnsName, mode };
}
async function tsSetMode(mode) {
  if (mode === 'public') {
    return tsExec(['funnel', '--bg', String(LISTEN_PORT)]);
  } else if (mode === 'private') {
    await tsExec(['funnel', '--https=443', 'off']);
    return tsExec(['serve', '--bg', String(LISTEN_PORT)]);
  }
  await tsExec(['funnel', '--https=443', 'off']);
  return tsExec(['serve', '--https=443', 'off']);
}

// --- 開機自啟（Windows 排程：登入時自動把轉接站跑起來，預設關，由精靈開關）---
const AUTOSTART_TASK = process.env.PC_TSPROXY_TASK || 'PixelCrew ts proxy';
const LAUNCH_VBS = path.join(__dirname, '_tsproxy_launch.vbs');
function schtasks(args) {
  return new Promise((resolve) => {
    execFile('schtasks', args, { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}
async function autostartStatus() {
  if (process.platform !== 'win32') return { supported: false, enabled: false };
  const r = await schtasks(['/query', '/tn', AUTOSTART_TASK]);
  return { supported: true, enabled: r.ok };
}
async function autostartSet(on) {
  if (process.platform !== 'win32') return { ok: false, stderr: '開機自啟目前僅支援 Windows' };
  if (on) {
    if (!fs.existsSync(LAUNCH_VBS)) return { ok: false, stderr: '找不到 _tsproxy_launch.vbs' };
    return schtasks(['/create', '/sc', 'onlogon', '/tn', AUTOSTART_TASK, '/tr', `wscript.exe "${LAUNCH_VBS}"`, '/f']);
  }
  return schtasks(['/delete', '/tn', AUTOSTART_TASK, '/f']);
}

// --- Cloudflare Tunnel（cloudflared）：免安裝對外通道，給別人零門檻用 ---
// 單一 exe，可打包或首次自動下載；quick tunnel 給 https://xxx.trycloudflare.com，
// 網址每次重啟會變，安全靠登入關卡。狀態存記憶體（proc/url），偏好存 config.channel。
const CF_BIN = process.env.PC_CLOUDFLARED_EXE
  || path.join(__dirname, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
const CF_DOWNLOAD = process.platform === 'win32'
  ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
  : (process.platform === 'darwin'
    ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz'
    : 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64');
let cfProc = null;      // 執行中的 cloudflared 子行程
let cfUrl = '';         // 目前分配到的 trycloudflare 公開網址
let cfDownloading = false;

function cfInstalled() { return fs.existsSync(CF_BIN); }
function cfInfo() { return { installed: cfInstalled(), running: !!cfProc, url: cfUrl, downloading: cfDownloading }; }

// 下載 cloudflared exe（跟隨 GitHub redirect）。Windows/Linux 是裸執行檔，直接存檔。
function cfDownload() {
  if (process.platform === 'darwin') {
    return Promise.resolve({ ok: false, error: 'macOS 需自行安裝 cloudflared（brew install cloudflared）' });
  }
  if (cfDownloading) return Promise.resolve({ ok: false, error: '下載進行中' });
  cfDownloading = true;
  return new Promise((resolve) => {
    const tmp = CF_BIN + '.download';
    const file = fs.createWriteStream(tmp);
    const get = (u, depth) => {
      if (depth > 6) { cleanup('太多重導向'); return; }
      https.get(u, { headers: { 'User-Agent': 'pixel-crew' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); get(res.headers.location, depth + 1); return;
        }
        if (res.statusCode !== 200) { res.resume(); cleanup('HTTP ' + res.statusCode); return; }
        res.pipe(file);
        file.on('finish', () => file.close(() => {
          try {
            fs.renameSync(tmp, CF_BIN);
            if (process.platform !== 'win32') fs.chmodSync(CF_BIN, 0o755);
            cfDownloading = false; resolve({ ok: true });
          } catch (e) { cleanup(String(e && e.message || e)); }
        }));
      }).on('error', (e) => cleanup(String(e && e.message || e)));
    };
    const cleanup = (msg) => {
      cfDownloading = false;
      try { file.close(); } catch {}
      try { fs.unlinkSync(tmp); } catch {}
      resolve({ ok: false, error: msg });
    };
    get(CF_DOWNLOAD, 0);
  });
}

// 啟動 quick tunnel，解析 stdout/stderr 抓 trycloudflare 網址（最多等 25 秒）。
function cfStart() {
  if (cfProc) return Promise.resolve({ ok: true, url: cfUrl });
  if (!cfInstalled()) return Promise.resolve({ ok: false, error: '尚未安裝 cloudflared' });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
    const proc = spawn(CF_BIN, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${LISTEN_PORT}`], { windowsHide: true });
    cfProc = proc;
    const onData = (buf) => {
      const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m && !cfUrl) { cfUrl = m[0]; finish({ ok: true, url: cfUrl }); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData); // cloudflared 把網址印在 stderr
    proc.on('exit', () => { if (cfProc === proc) { cfProc = null; cfUrl = ''; } finish({ ok: false, error: 'cloudflared 已結束' }); });
    proc.on('error', (e) => { if (cfProc === proc) { cfProc = null; cfUrl = ''; } finish({ ok: false, error: String(e && e.message || e) }); });
    setTimeout(() => finish({ ok: false, error: '啟動逾時，未取得網址' }), 25000);
  });
}
function cfStop() {
  if (cfProc) { try { cfProc.kill(); } catch {} cfProc = null; }
  cfUrl = '';
  return { ok: true };
}

// --- 簽章 / token ---
function mac(s) {
  return crypto.createHmac('sha256', CONFIG.signingSecret).update(String(s)).digest('hex');
}
// token 格式：aud.exp[.extra…].hmac(payload)。shr 會多帶一段 sid 用來識別各分享 session（B 版 id 追蹤）。
function makeToken(aud, ttlMs, extra = []) {
  const exp = Date.now() + ttlMs;
  const payload = [aud, exp, ...extra].join('.');
  return `${payload}.${mac(payload)}`;
}
function parseToken(tok) {
  if (!tok) return null;
  const parts = tok.split('.');
  if (parts.length < 3) return null;
  const m = parts[parts.length - 1];
  const payloadParts = parts.slice(0, -1);
  const aud = payloadParts[0];
  const exp = Number(payloadParts[1]);
  if (!exp || Date.now() > exp) return null;
  if (aud !== 'own' && aud !== 'shr' && aud !== 'grd') return null;
  const expected = mac(payloadParts.join('.'));
  return timingEq(m, expected) ? { aud, exp, sid: payloadParts[2] } : null; // 用本檔統一的定時比較助手
}
function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}

// --- 分享狀態（惰性到期，無背景計時器）---
function shareActive() {
  const s = CONFIG.share;
  if (!s.enabled) return false;
  if (s.expiresAt && Date.now() >= s.expiresAt) {
    s.enabled = false; s.expiresAt = 0; saveConfig(CONFIG); // 到期自動關
    return false;
  }
  return true;
}

// 回傳登入層級：'own' | 'shr' | null
function authLevel(req) {
  const t = parseToken(parseCookies(req.headers.cookie)[COOKIE]);
  if (!t) return null;
  if (t.aud !== 'own' && t.aud !== 'shr') return null; // 登入 cookie 只認 own/shr（grd 走專屬 cookie）
  if (t.aud === 'shr' && !shareActive()) return null;  // 分享關掉/到期，舊 shr token 立刻失效
  return t.aud;
}
// 分享訪客是否持有「監護解鎖」的有效狀態（step-up 通過後 GUARDIAN_TTL_MS 內免再輸）。
function guardianActive(req) {
  const t = parseToken(parseCookies(req.headers.cookie)[GUARDIAN_COOKIE]);
  return !!(t && t.aud === 'grd');
}

// --- 登入爆破防護：同一來源連續失敗就退避（純記憶體、無背景計時器、惰性到期）---
// 公開 tunnel 上，login／guardian／setup 是唯一的猜密碼入口。timingEq 擋時序側信道，
// 但擋不住高速硬猜；這裡對「失敗」計次，超過門檻就鎖一段時間。成功即清零。
const AUTH_FAILS = new Map();                 // ip -> { n, ts, until }
const AUTH_MAX_FAILS = 8;                      // 視窗內容許的失敗次數
const AUTH_WINDOW_MS = 10 * 60 * 1000;        // 計次視窗
const AUTH_LOCK_MS = 15 * 60 * 1000;          // 觸頂後鎖定時長
const AUTH_MAX_ENTRIES = 5000;                // 防記憶體膨脹上限
function clientIp(req) {
  // 經 cloudflared／funnel：真實來源在 x-forwarded-for 第一段；本機直連退回 socket。
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || (req.socket && req.socket.remoteAddress) || 'unknown';
}
// 回傳 { blocked, retryAfter秒 }；blocked=true 代表現在應直接擋。
function authThrottled(ip) {
  const e = AUTH_FAILS.get(ip);
  if (e && e.until && Date.now() < e.until) return { blocked: true, retryAfter: Math.ceil((e.until - Date.now()) / 1000) };
  return { blocked: false, retryAfter: 0 };
}
function authFail(ip) {
  const now = Date.now();
  let e = AUTH_FAILS.get(ip);
  if (!e || now - (e.ts || 0) > AUTH_WINDOW_MS) e = { n: 0, ts: now, until: 0 }; // 視窗過了重算
  e.n += 1; e.ts = now;
  if (e.n >= AUTH_MAX_FAILS) e.until = now + AUTH_LOCK_MS;
  if (AUTH_FAILS.size >= AUTH_MAX_ENTRIES && !AUTH_FAILS.has(ip)) { // 滿了先丟最舊
    let oldK = null, oldT = Infinity;
    for (const [k, v] of AUTH_FAILS) if ((v.ts || 0) < oldT) { oldT = v.ts; oldK = k; }
    if (oldK) AUTH_FAILS.delete(oldK);
  }
  AUTH_FAILS.set(ip, e);
}
function authOk(ip) { AUTH_FAILS.delete(ip); } // 猜對就清零，不留鎖定殘留

// 分享級（shr）授權模型：預設拒絕（allowlist），只有以下幾類直接放行：
//  - 讀取（GET/HEAD/OPTIONS）：全放行。
//  - 「安全建立／互動」白名單：建立任務、聊天、找隊員商量、暫停等不會動到既有重要資料的操作。
// 其餘（所有刪除、修改、還原備份、重啟、換 provider、改系統設定…）一律要監護密碼 step-up。
// 用白名單而非黑名單：日後新增端點預設歸「要密碼」的安全側，不會被忘記補進黑名單而繞過。
const SHARE_SAFE_WRITES = [
  ['POST', /^\/api\/boss-tasks$/],                          // 建立老闆任務
  ['POST', /^\/api\/boss-tasks\/[^/]+\/messages$/],         // 對任務對話
  ['POST', /^\/api\/departments\/[^/]+\/messages$/],        // 對部門對話
  ['POST', /^\/api\/warroom$/],                             // 圓桌／作戰室
  ['POST', /^\/api\/delegate$/],                            // 委派
  ['POST', /^\/api\/assignments$/],                         // 建立指派
  ['POST', /^\/api\/schedules$/],                           // 建立排程
  ['POST', /^\/api\/workers\/[^/]+\/(consult|message|interrupt)$/], // 找隊員商量／傳訊／暫停
  // 純狀態重整（不動任何資料，前端每 3 秒自動輪詢）：不放行會讓訪客一直被監護密碼框轟炸。
  ['POST', /^\/api\/auth\/refresh$/],                       // 重新檢查各 provider 登入狀態
  ['POST', /^\/api\/usage\/refresh$/],                      // 重新抓用量數字
  // 切換 NPC 時前端自動打的：只重整能力偵測＋預熱 session，不動資料。不放行＝每次切人都彈監護框。
  ['POST', /^\/api\/workers\/[^/]+\/activate$/],            // 選取／切換 NPC
];
// 最高危：一律 owner 專屬，連監護解鎖都不放行（分享訪客永遠碰不到）。
// 不可逆／系統級／會外洩全站或動到 host 的操作——把它們從「監護可解」升級成「只有主人能做」。
const SHARE_FORBIDDEN = [
  ['GET',    /^\/api\/backup\/export$/],                      // 整包備份匯出＝全站外洩
  ['POST',   /^\/api\/backup\/import\//],                     // 還原備份（validate／commit）＝覆蓋全站
  ['DELETE', /^\/api\/backup\/import\//],
  ['POST',   /^\/api\/restart-server$/],                      // 重啟後端
  ['POST',   /^\/api\/workers\/[^/]+\/provider\/fresh$/],     // 換 provider
  ['POST',   /^\/api\/providers\/[^/]+\/install$/],           // 安裝 provider CLI
  ['POST',   /^\/api\/mcp\/import-from-claude-desktop$/],     // 拉 host 上的 MCP 設定
  ['GET',    /^\/api\/webshot$/],                             // 伺服器抓任意 URL（SSRF）→ 訪客一律不可直接觸發
  // 轉接站自身管理：本體 /api/remote-access/* 會以 8787→8790 的 127.0.0.1 直連（isLocalDirect＝owner）
  // 呼叫 /__gate/api/*，等於讓分享訪客越權改主通行碼／開關 tunnel。整個子樹一律 owner 專屬。
  ['GET',    /^\/api\/remote-access(\/|$)/],
  ['POST',   /^\/api\/remote-access(\/|$)/],
];
function shrForbidden(method, path) {
  const m = String(method || 'GET').toUpperCase();
  for (const [am, re] of SHARE_FORBIDDEN) if (am === m && re.test(path)) return true;
  return false;
}
// 高敏「讀取」：GET 雖預設放行，但這些會回敏感內容或帶可穿越參數，對 shr 也要監護 step-up。
const SHARE_SENSITIVE_READS = [
  /^\/api\/warroom\/history\/[^/]+$/,                         // 檔名參數，防路徑穿越讀任意檔
];
// 回傳 true 代表「這個 shr 請求需要監護密碼才放行」。
function shrNeedsGuardian(method, path) {
  const m = String(method || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') {
    for (const re of SHARE_SENSITIVE_READS) if (re.test(path)) return true; // 高敏讀取也要 step-up
    return false; // 其餘讀取全放行
  }
  for (const [am, re] of SHARE_SAFE_WRITES) if (am === m && re.test(path)) return false;
  return true; // 預設拒絕 → 要 step-up
}

// --- B 版：追蹤「這個分享 session 自己建立的資源 id」，讓訪客免監護密碼刪改自己剛建的。---
// 記憶體存放；session 由 shr token 內的 sid 識別（簽章保護，偽造不了、也只認自己建的）。
const createdBySession = new Map(); // sid -> { ids:Set<'collection/id'>, ts:number }
const MAX_SESSIONS = 500, MAX_IDS_PER_SESSION = 2000;
function shrSid(req) {
  const t = parseToken(parseCookies(req.headers.cookie)[COOKIE]);
  return (t && t.aud === 'shr' && t.sid) ? t.sid : null;
}
function sessionSet(sid) {
  let e = createdBySession.get(sid);
  if (!e) {
    if (createdBySession.size >= MAX_SESSIONS) { // 超上限先丟最舊的 session
      let oldestK = null, oldestT = Infinity;
      for (const [k, v] of createdBySession) if (v.ts < oldestT) { oldestT = v.ts; oldestK = k; }
      if (oldestK) createdBySession.delete(oldestK);
    }
    e = { ids: new Set(), ts: Date.now() };
    createdBySession.set(sid, e);
  }
  return e;
}
const pathSegs = (p) => p.split('/').filter(Boolean);
// 建立類：POST /api/<collection>（剛好兩段）→ 回傳成功且含 id 就記下 'collection/id'。
function createCollection(method, p) {
  if (String(method).toUpperCase() !== 'POST') return null;
  const s = pathSegs(p);
  return (s.length === 2 && s[0] === 'api') ? s[1] : null;
}
// 單一資源改刪：DELETE/PATCH/PUT /api/<collection>/<id>（剛好三段）→ key 'collection/id'。
function itemKey(method, p) {
  const m = String(method).toUpperCase();
  if (m !== 'DELETE' && m !== 'PATCH' && m !== 'PUT') return null;
  const s = pathSegs(p);
  return (s.length === 3 && s[0] === 'api') ? `${s[1]}/${decodeURIComponent(s[2])}` : null;
}
function ownsItem(sid, method, p) {
  const key = sid && itemKey(method, p);
  if (!key) return false;
  const e = createdBySession.get(sid);
  return !!(e && e.ids.has(key));
}
// 從建立回應抽出 id（頂層 id，或常見包裝物件的 .id），記進該 session。
function recordCreated(sid, collection, buf) {
  if (!sid || !collection || !buf || !buf.length) return;
  let id = null;
  try {
    const j = JSON.parse(buf.toString('utf8'));
    if (j && typeof j === 'object') {
      if (typeof j.id === 'string') id = j.id;
      else for (const k of ['bossTask', 'assignment', 'task', 'schedule', 'item', 'data', 'worker', 'squad', 'department', 'record']) {
        if (j[k] && typeof j[k] === 'object' && typeof j[k].id === 'string') { id = j[k].id; break; }
      }
    }
  } catch {}
  if (!id) return;
  const e = sessionSet(sid);
  if (e.ids.size < MAX_IDS_PER_SESSION) { e.ids.add(`${collection}/${id}`); e.ts = Date.now(); }
}
function timingEq(a, b) {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  if (x.length !== y.length) return false;
  try { return crypto.timingSafeEqual(x, y); } catch { return false; }
}
// 「主機本機直連」：沒有 x-forwarded-for（funnel/serve 一定會加）且 host 指向本機。
// 用來把「首次設定通行碼」限制在主機上操作，避免公網搶先佔用。
function isLocalDirect(req) {
  if (req.headers['x-forwarded-for']) return false;
  const host = String(req.headers.host || '').toLowerCase();
  return host.startsWith('127.0.0.1') || host.startsWith('localhost') || host.startsWith('[::1]');
}
function htmlEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function cookieHeader(aud, ttlMs, name = COOKIE, extra = []) {
  return `${name}=${makeToken(aud, ttlMs, extra)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${Math.floor(ttlMs / 1000)}`;
}
function baseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return `${proto}://${req.headers.host}`;
}

// --- 頁面 ---
function pageShell(inner, wide) {
  const width = wide ? 'min(94vw,560px)' : 'min(88vw,360px)';
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Pixel Crew</title>
<style>*{box-sizing:border-box}body{font-family:system-ui,-apple-system,"Noto Sans TC",sans-serif;background:radial-gradient(1200px 800px at 50% -10%,#1a2650,#080c1a);color:#e6ecff;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:22px 0}
.card{background:#111a33;padding:30px 26px;border-radius:16px;width:${width};box-shadow:0 20px 60px rgba(0,0,0,.5);border:1px solid #223058}
h1{font-size:19px;margin:0 0 4px}h2{font-size:15px;margin:0 0 10px;color:#cdd8ff}p.sub{margin:0 0 18px;font-size:13px;color:#8ea0d0}
input{width:100%;padding:13px;border-radius:11px;border:1px solid #2b365c;background:#0c1428;color:#e6ecff;font-size:16px}
button{width:100%;margin-top:14px;padding:13px;border:0;border-radius:11px;background:#5b8cff;color:#fff;font-size:16px;font-weight:600;cursor:pointer}
button.ghost{background:#20305a}
a.gbtn{display:flex;align-items:center;justify-content:center;gap:9px;width:100%;margin-top:12px;padding:12px;border-radius:11px;background:#fff;color:#1a1a1a;font-size:15px;font-weight:600;text-decoration:none}
.divider{display:flex;align-items:center;gap:10px;color:#5f6f9c;font-size:12px;margin:16px 0}.divider::before,.divider::after{content:"";flex:1;height:1px;background:#2b365c}
.err{color:#ff9a9a;font-size:13px;margin-top:10px;min-height:16px}
.row{display:flex;gap:8px;margin-top:10px}.row button,.row form{flex:1;margin:0}
.stat{font-size:14px;margin:6px 0;color:#b9c6ee}.on{color:#7ee0a2}.off{color:#ff9a9a}
label{font-size:13px;color:#8ea0d0;display:block;margin-top:14px;margin-bottom:6px}
.sec{background:#0d1730;border:1px solid #223058;border-radius:13px;padding:16px 16px 18px;margin-top:16px}
.sec h2{display:flex;align-items:center;gap:8px}
.badge{font-size:12px;font-weight:700;padding:2px 9px;border-radius:999px;margin-left:auto}
.badge.ok{background:#123a26;color:#7ee0a2}.badge.warn{background:#3a3212;color:#ffd479}.badge.bad{background:#3a1620;color:#ff9a9a}
.hint{font-size:12.5px;color:#8ea0d0;line-height:1.6;margin:6px 0 0}
.hint a{color:#8fb0ff}
.modes{display:flex;gap:8px;margin-top:10px}.modes form{flex:1;margin:0}
.modes button{margin:0;background:#1a2544;font-size:13px;padding:11px 4px}
.modes button.active{background:#5b8cff}
.modes button.pub.active{background:#e0873a}
code{background:#08122a;padding:2px 6px;border-radius:6px;font-size:12px;word-break:break-all;color:#cfe0ff}
details{margin-top:6px}summary{cursor:pointer;color:#8fb0ff;font-size:13px}</style></head>
<body><div class="card">${inner}</div></body></html>`;
}
function loginPage(msg) {
  const google = googleLoginUsable()
    ? `<div class="divider">或</div><a class="gbtn" href="/__gate/google/start">
<svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.4 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.2 13.4 17.6 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.5 3-2.2 5.5-4.7 7.2l7.3 5.7c4.3-4 6.8-9.9 6.8-17.4z"/><path fill="#FBBC05" d="M10.4 28.3c-.5-1.5-.8-3.1-.8-4.8s.3-3.3.8-4.8l-7.8-6.1C.9 16 0 19.9 0 23.5s.9 7.5 2.6 10.9l7.8-6.1z"/><path fill="#34A853" d="M24 47c6.2 0 11.4-2 15.2-5.5l-7.3-5.7c-2 1.4-4.7 2.3-7.9 2.3-6.4 0-11.8-3.9-13.6-9.3l-7.8 6.1C6.5 42.6 14.6 47 24 47z"/></svg>
用 Google 登入</a>`
    : '';
  return pageShell(`<h1>Pixel Crew 手機控制</h1><p class="sub">請登入</p>
<form method="POST" action="/__gate/login">
<input type="password" name="passcode" placeholder="通行碼" autofocus autocomplete="current-password">
<button>登入</button><div class="err">${msg || ''}</div></form>${google}`);
}
// 首次設定：只在主機本機直連時顯示
function setupPage(msg) {
  return pageShell(`<h1>🔗 遠端存取・首次設定</h1><p class="sub">歡迎！先為手機控制設定一組通行碼。</p>
<div class="sec"><p class="hint">這組通行碼是你之後在手機/外部瀏覽器登入時要輸入的密碼。設好之後才會開放登入；此頁只能在這台電腦上操作，別人無法搶先設定。</p></div>
<form method="POST" action="/__gate/setup">
<label>設定你的通行碼（至少 6 碼）</label>
<input type="password" name="passcode" placeholder="輸入通行碼" autofocus autocomplete="new-password" minlength="6">
<label>再輸入一次</label>
<input type="password" name="passcode2" placeholder="再次輸入" autocomplete="new-password" minlength="6">
<button>設定並進入控制台</button><div class="err">${msg || ''}</div></form>`);
}
function setupRemotePage() {
  return pageShell(`<h1>尚未完成設定</h1><p class="sub">Pixel Crew 遠端存取還沒設定通行碼。</p>
<div class="sec"><p class="hint">請到<b>執行 Pixel Crew 的那台電腦上</b>，用瀏覽器打開 <code>http://localhost:${LISTEN_PORT}/</code> 完成首次設定，之後就能從這裡登入。</p></div>`);
}
async function adminPage(msg) {
  const s = CONFIG.share;
  const active = shareActive();
  const until = s.expiresAt ? new Date(s.expiresAt).toLocaleString('zh-TW') : '無期限';
  const ts = await tsInfo();
  const as = await autostartStatus();

  // Tailscale 區塊
  let tsBadge, tsBody;
  if (!ts.installed) {
    tsBadge = '<span class="badge bad">未安裝</span>';
    tsBody = `<p class="hint">尚未偵測到 Tailscale。它負責把這台電腦安全地連到外網，手機才連得進來。<br>
請先<a href="https://tailscale.com/download" target="_blank" rel="noopener">下載安裝 Tailscale</a>並用你的帳號登入，然後回到本頁重新整理。</p>`;
  } else if (!ts.running) {
    tsBadge = '<span class="badge warn">未登入</span>';
    tsBody = `<p class="hint">已安裝 Tailscale，但目前未登入/未連線。請開啟 Tailscale 應用並登入（或於終端機執行 <code>tailscale up</code>），再重新整理本頁。</p>`;
  } else {
    tsBadge = '<span class="badge ok">已連線</span>';
    const url = ts.dnsName ? `https://${htmlEsc(ts.dnsName)}` : '（無網域名稱）';
    const modeText = ts.mode === 'public' ? '🌐 公開（任何人都能連，需通行碼）'
      : ts.mode === 'private' ? '🔒 只限自己（僅你 tailnet 內裝置）' : '⚪ 關閉（外部無法連）';
    const mk = (m, label, cls) => `<form method="POST" action="/__gate/expose"><input type="hidden" name="mode" value="${m}"><button class="${cls || ''}${ts.mode === m ? ' active' : ''}">${label}</button></form>`;
    tsBody = `<p class="stat">你的網址：<code>${url}</code></p>
<p class="stat">目前狀態：${modeText}</p>
<div class="modes">${mk('public', '🌐 公開', 'pub')}${mk('private', '🔒 私有')}${mk('off', '⚪ 關閉')}</div>
<p class="hint">公開＝手機免裝 Tailscale、用網址+通行碼就能進；私有＝只有你自己 tailnet 內的裝置能連（最安全）。</p>`;
  }

  // 分享區塊
  const shareStatus = active
    ? `<p class="stat on">● 分享中</p><p class="stat">到期：${htmlEsc(until)}</p><p class="stat">分享密碼：${s.passcode ? '已設定' : '<span class="off">未設定（沒人能用分享登入）</span>'}</p><p class="stat">分享 session 時效：${s.sessionTtlHours} 小時</p>`
    : `<p class="stat off">● 分享已關</p>`;
  const hourBtn = (h) => `<form method="POST" action="/__gate/share"><input type="hidden" name="action" value="enable"><input type="hidden" name="hours" value="${h}"><button class="ghost">開 ${h}h</button></form>`;

  // Google 區塊
  const g = CONFIG.google || {};
  const gBadge = googleEnabled() ? '<span class="badge ok">已啟用</span>' : '<span class="badge warn">未設定（選用）</span>';
  const redirectUri = ts.dnsName ? `https://${htmlEsc(ts.dnsName)}/__gate/google/callback` : `https://<你的網域>/__gate/google/callback`;

  return pageShell(`<h1>🔗 遠端存取・設定精靈</h1><p class="sub">owner 專用控制台</p>
<div class="err">${msg || ''}</div>

<div class="sec"><h2>連線方式 ${tsBadge}</h2>${tsBody}</div>

${as.supported ? `<div class="sec"><h2>開機自啟 ${as.enabled ? '<span class="badge ok">已開啟</span>' : '<span class="badge warn">未開啟</span>'}</h2>
<p class="hint">開啟後，這台電腦每次登入會自動把轉接站跑起來，手機隨時連得到；關閉則需要你自己啟動（雙擊「遠端存取.cmd」）。</p>
<div class="modes">
<form method="POST" action="/__gate/autostart"><input type="hidden" name="on" value="1"><button class="${as.enabled ? 'active' : ''}">開機自啟</button></form>
<form method="POST" action="/__gate/autostart"><input type="hidden" name="on" value="0"><button class="${!as.enabled ? 'active' : ''}">關閉</button></form>
</div></div>` : ''}

<div class="sec"><h2>通行碼</h2>
<form method="POST" action="/__gate/passcode">
<label>變更 owner 通行碼（登入手機控制用）</label>
<input type="password" name="passcode" placeholder="輸入新通行碼（至少 6 碼）" autocomplete="new-password" minlength="6">
<button class="ghost">更新通行碼</button></form></div>

<div class="sec"><h2>監護密碼 ${(CONFIG.guardian && CONFIG.guardian.passcode) ? '<span class="badge ok">已設定</span>' : '<span class="badge warn">未設定</span>'}</h2>
<p class="hint">分享訪客可以讀取、建立、跟隊員互動，並能<b>刪改自己這次建立的東西</b>；但要<b>動到既有／別人建立的資料或高危操作</b>（還原備份、重啟、換 provider、改系統設定…）時，需先輸入這組監護密碼才放行。與 owner 通行碼分開，訪客看到也學不到你的主碼。<b>未設定＝訪客一律無法執行受限操作。</b></p>
<form method="POST" action="/__gate/guardian-config">
<label>設定監護密碼（至少 4 碼，留空＝清除）</label>
<input type="password" name="passcode" placeholder="${(CONFIG.guardian && CONFIG.guardian.passcode) ? '已設定，留空＝清除' : '尚未設定'}" autocomplete="new-password">
<button class="ghost">更新監護密碼</button></form></div>

<div class="sec"><h2>限時分享</h2>${shareStatus}
<div class="row">${hourBtn(1)}${hourBtn(4)}${hourBtn(12)}${hourBtn(24)}</div>
<form method="POST" action="/__gate/share"><input type="hidden" name="action" value="disable"><button style="background:#c0392b">立即關閉分享</button></form>
<form method="POST" action="/__gate/share">
<label>分享密碼（給臨時訪客，可與你的通行碼不同）</label>
<input name="passcode" placeholder="留空＝清除" autocomplete="off">
<label>分享登入 session 時效（小時）</label>
<input name="sessionTtlHours" type="number" min="1" max="168" value="${s.sessionTtlHours}">
<input type="hidden" name="action" value="config"><button>儲存分享設定</button></form></div>

<div class="sec"><h2>Google 登入 ${gBadge}</h2>
<details><summary>怎麼設定？（選用，讓白名單 Google 帳號免通行碼登入）</summary>
<p class="hint">1. 到 <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Google Cloud Console → 憑證</a>，建立「OAuth 用戶端 ID（網頁應用程式）」。<br>
2. 授權重新導向 URI 填：<code>${redirectUri}</code><br>
3. 把 Client ID / Secret 貼到下面，並填允許登入的 email（一行一個）。<br>
4. 同意畫面若為 Testing，登入者要同時列在 Google 的測試使用者＋下面白名單。</p></details>
<form method="POST" action="/__gate/google-config">
<label>Client ID</label><input name="clientId" value="${htmlEsc(g.clientId)}" autocomplete="off">
<label>Client Secret</label><input name="clientSecret" placeholder="${g.clientSecret ? '已設定，留空＝不變' : ''}" autocomplete="off">
<label>允許的 email（一行一個）</label>
<input name="allowedEmails" value="${htmlEsc((g.allowedEmails || []).join(', '))}" placeholder="you@gmail.com" autocomplete="off">
<button class="ghost">儲存 Google 設定</button></form></div>

<div class="divider"></div><a class="gbtn" href="/__gate/logout" style="background:#20305a;color:#e6ecff">登出</a>`, true);
}

function rewriteHeaders(headers) {
  const h = { ...headers };
  h.host = TARGET_HOSTHEADER;
  delete h.origin;
  delete h.referer;
  return h;
}
function proxyHttp(clientReq, clientRes) {
  const proxyReq = http.request({
    host: TARGET_HOST, port: TARGET_PORT, method: clientReq.method,
    path: clientReq.url, headers: rewriteHeaders(clientReq.headers),
  }, (proxyRes) => {
    clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(clientRes);
  });
  proxyReq.on('error', () => { try { clientRes.writeHead(502); clientRes.end('proxy error'); } catch {} });
  clientReq.pipe(proxyReq);
}
// 透傳並緩衝回應（僅用於 shr 建立請求，建立回應通常很小）；2xx 時把 id 記進 session。
function proxyCapture(clientReq, clientRes, onBody) {
  const proxyReq = http.request({
    host: TARGET_HOST, port: TARGET_PORT, method: clientReq.method,
    path: clientReq.url, headers: rewriteHeaders(clientReq.headers),
  }, (proxyRes) => {
    const chunks = [];
    proxyRes.on('data', (c) => chunks.push(c));
    proxyRes.on('end', () => {
      const buf = Buffer.concat(chunks);
      const headers = { ...proxyRes.headers };
      delete headers['transfer-encoding']; // 我們改用固定長度回送
      headers['content-length'] = Buffer.byteLength(buf);
      try { clientRes.writeHead(proxyRes.statusCode, headers); clientRes.end(buf); } catch {}
      if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) { try { onBody(buf); } catch {} }
    });
  });
  proxyReq.on('error', () => { try { clientRes.writeHead(502); clientRes.end('proxy error'); } catch {} });
  clientReq.pipe(proxyReq);
}

function readBody(req, cb) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
  req.on('end', () => cb(new URLSearchParams(body)));
}
function redirect(res, location, setCookie) {
  const h = { Location: location };
  if (setCookie) h['Set-Cookie'] = setCookie;
  res.writeHead(303, h); res.end();
}
function sendHtml(res, code, html) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html);
}

// --- Google OAuth（直接 server-to-server 交換，不驗簽只信任 TLS 直連回傳）---
function httpsPost(host, pathName, form) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(form).toString();
    const r = https.request({ host, path: pathName, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
    r.on('error', reject); r.write(data); r.end();
  });
}
function decodeJwtPayload(jwt) {
  try { return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8')); }
  catch { return null; }
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  const level = authLevel(req);

  // === JSON API（本體 8787 同源代理專用；本機直連或 owner 才可）===
  // 授權＝isLocalDirect（8787→8790 是 127.0.0.1 直連，等同在主機上操作）或 owner cookie。
  if (url.startsWith('/__gate/api/')) {
    const sendJson = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    if (!isLocalDirect(req) && level !== 'own') { sendJson(403, { error: 'forbidden' }); return; }
    const readJson = (cb) => {
      let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
      req.on('end', () => { try { cb(b ? JSON.parse(b) : {}); } catch { cb(null); } });
    };
    const buildState = async () => {
      const [ts, as] = await Promise.all([tsInfo(), autostartStatus()]);
      const cf = cfInfo();
      // 以「實際執行狀態」為準（不只信 config 偏好）：真的在跑的通道才算數。
      const cfLive = cf.running && !!cf.url;
      const tsLive = ts.running && ts.mode !== 'off' && !!ts.dnsName;
      const channel = cfLive ? 'cloudflared' : (tsLive ? 'tailscale' : CONFIG.channel);
      const publicUrl = cfLive ? cf.url : (tsLive ? `https://${ts.dnsName}` : '');
      return {
        port: LISTEN_PORT,
        passcodeSet: !!CONFIG.passcode,
        channel,
        tailscale: ts,
        cloudflared: cf,
        autostart: as,
        google: {
          enabled: googleEnabled(),
          clientIdSet: !!(CONFIG.google && CONFIG.google.clientId),
          allowedEmails: (CONFIG.google && CONFIG.google.allowedEmails) || [],
        },
        share: {
          enabled: !!CONFIG.share.enabled, active: shareActive(),
          expiresAt: CONFIG.share.expiresAt || 0, sessionTtlHours: CONFIG.share.sessionTtlHours || 12,
        },
        guardian: { set: !!(CONFIG.guardian && CONFIG.guardian.passcode) },
        publicUrl,
      };
    };

    if (url === '/__gate/api/state' && req.method === 'GET') {
      buildState().then((s) => sendJson(200, s)).catch(() => sendJson(500, { error: 'state failed' }));
      return;
    }
    if (url === '/__gate/api/passcode' && req.method === 'POST') {
      readJson((body) => {
        if (!body || typeof body.passcode !== 'string' || body.passcode.length < 6) {
          sendJson(400, { error: '通行碼至少 6 碼' }); return;
        }
        CONFIG.passcode = body.passcode; saveConfig(CONFIG);
        buildState().then((s) => sendJson(200, s));
      });
      return;
    }
    if (url === '/__gate/api/guardian' && req.method === 'POST') {
      readJson((body) => {
        if (!body || typeof body.passcode !== 'string') { sendJson(400, { error: 'bad body' }); return; }
        const p = body.passcode;
        if (p && p.length < 4) { sendJson(400, { error: '監護密碼至少 4 碼（或留空清除）' }); return; }
        CONFIG.guardian = CONFIG.guardian || { passcode: '' };
        CONFIG.guardian.passcode = p; // 留空＝清除
        saveConfig(CONFIG);
        buildState().then((s) => sendJson(200, s));
      });
      return;
    }
    if (url === '/__gate/api/cloudflared/install' && req.method === 'POST') {
      cfDownload().then((r) => {
        if (!r.ok) { sendJson(502, { error: r.error || '下載失敗' }); return; }
        buildState().then((s) => sendJson(200, s));
      });
      return;
    }
    if (url === '/__gate/api/channel' && req.method === 'POST') {
      readJson(async (body) => {
        const type = body && body.type;
        if (!['off', 'tailscale', 'cloudflared'].includes(type)) { sendJson(400, { error: 'bad type' }); return; }
        try {
          if (type === 'cloudflared') {
            await tsSetMode('off');
            const r = await cfStart();
            if (!r.ok) { sendJson(502, { error: r.error || 'cloudflared 啟動失敗' }); return; }
          } else if (type === 'tailscale') {
            cfStop();
            const mode = body.mode === 'public' ? 'public' : 'private';
            const r = await tsSetMode(mode);
            if (r.notFound) { sendJson(502, { error: '找不到 Tailscale，請先安裝並登入' }); return; }
            if (!r.ok) { sendJson(502, { error: (r.stderr || '').slice(0, 160) || 'Tailscale 切換失敗' }); return; }
          } else {
            cfStop(); await tsSetMode('off');
          }
          CONFIG.channel = type; saveConfig(CONFIG);
          sendJson(200, await buildState());
        } catch (e) { sendJson(500, { error: String(e && e.message || e) }); }
      });
      return;
    }
    if (url === '/__gate/api/autostart' && req.method === 'POST') {
      readJson((body) => {
        autostartSet(!!(body && body.on)).then(() => buildState().then((s) => sendJson(200, s)));
      });
      return;
    }
    if (url === '/__gate/api/share' && req.method === 'POST') {
      readJson((body) => {
        if (!body) { sendJson(400, { error: 'bad body' }); return; }
        if (body.enabled) {
          const now = Date.now();
          const maxAt = now + 720 * 3600 * 1000; // 上限 30 天
          let expiresAt;
          // 指定絕對到期時刻（毫秒）優先；否則用「從現在起算幾小時」。
          if (Number.isFinite(Number(body.expiresAt)) && Number(body.expiresAt) > now) {
            expiresAt = Math.min(Number(body.expiresAt), maxAt);
          } else {
            const hours = Math.max(1, Math.min(720, Number(body.hours) || 4));
            expiresAt = now + hours * 3600 * 1000;
          }
          CONFIG.share.enabled = true;
          CONFIG.share.expiresAt = expiresAt;
          if (typeof body.passcode === 'string' && body.passcode) CONFIG.share.passcode = body.passcode;
        } else {
          CONFIG.share.enabled = false; CONFIG.share.expiresAt = 0;
        }
        saveConfig(CONFIG);
        buildState().then((s) => sendJson(200, s));
      });
      return;
    }
    if (url === '/__gate/api/google' && req.method === 'POST') {
      readJson((body) => {
        if (!body) { sendJson(400, { error: 'bad body' }); return; }
        CONFIG.google = CONFIG.google || { clientId: '', clientSecret: '', allowedEmails: [] };
        if (typeof body.clientId === 'string') CONFIG.google.clientId = body.clientId.trim();
        if (typeof body.clientSecret === 'string' && body.clientSecret) CONFIG.google.clientSecret = body.clientSecret.trim();
        if (Array.isArray(body.allowedEmails)) {
          CONFIG.google.allowedEmails = body.allowedEmails.map((e) => String(e).toLowerCase().trim()).filter(Boolean);
        }
        saveConfig(CONFIG);
        buildState().then((s) => sendJson(200, s));
      });
      return;
    }
    sendJson(404, { error: 'unknown api' });
    return;
  }

  // === 首次設定（尚未設通行碼）===
  if (url === '/__gate/setup' && req.method === 'POST') {
    if (!needsSetup()) { redirect(res, '/__gate/admin'); return; }
    if (!isLocalDirect(req)) { sendHtml(res, 403, setupRemotePage()); return; }
    readBody(req, (form) => {
      const p1 = form.get('passcode') || '', p2 = form.get('passcode2') || '';
      if (p1.length < 6) { sendHtml(res, 400, setupPage('通行碼至少 6 碼')); return; }
      if (p1 !== p2) { sendHtml(res, 400, setupPage('兩次輸入不一致')); return; }
      CONFIG.passcode = p1; saveConfig(CONFIG);
      redirect(res, '/__gate/admin', cookieHeader('own', OWNER_TTL_MS));
    });
    return;
  }
  if (needsSetup()) {
    if ((req.headers.accept || '').includes('text/html')) {
      sendHtml(res, 200, isLocalDirect(req) ? setupPage('') : setupRemotePage());
    } else { res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' }); res.end('{"error":"setup required"}'); }
    return;
  }

  // === 登入關卡端點 ===
  if (url === '/__gate/login' && req.method === 'POST') {
    const ip = clientIp(req);
    const thr = authThrottled(ip);
    if (thr.blocked) { sendHtml(res, 429, loginPage(`嘗試過於頻繁，請約 ${Math.ceil(thr.retryAfter / 60)} 分鐘後再試`)); return; }
    readBody(req, (form) => {
      const pass = form.get('passcode') || '';
      if (timingEq(pass, CONFIG.passcode)) {
        authOk(ip);
        redirect(res, '/', cookieHeader('own', OWNER_TTL_MS));
      } else if (shareActive() && CONFIG.share.passcode && timingEq(pass, CONFIG.share.passcode)) {
        authOk(ip);
        const sid = crypto.randomBytes(9).toString('hex'); // 這個分享 session 的識別碼（記其建立的資源 id）
        redirect(res, '/', cookieHeader('shr', CONFIG.share.sessionTtlHours * 3600 * 1000, COOKIE, [sid]));
      } else {
        authFail(ip);
        sendHtml(res, 401, loginPage('通行碼錯誤或分享未開啟'));
      }
    });
    return;
  }
  if (url.startsWith('/__gate/logout')) {
    redirect(res, '/', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
    return;
  }

  // 分享訪客「監護解鎖」：輸入監護密碼換取短時效 grd cookie（step-up）。前端在被擋時呼叫。
  if (url === '/__gate/guardian' && req.method === 'POST') {
    const sendJson = (code, obj, cookie) => {
      const h = { 'Content-Type': 'application/json; charset=utf-8' };
      if (cookie) h['Set-Cookie'] = cookie;
      res.writeHead(code, h); res.end(JSON.stringify(obj));
    };
    if (level !== 'shr' && level !== 'own') { sendJson(401, { error: 'auth required' }); return; }
    const ip = clientIp(req);
    const thr = authThrottled(ip);
    if (thr.blocked) { sendJson(429, { error: 'too_many_attempts', retryAfter: thr.retryAfter }); return; }
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 4096) req.destroy(); });
    req.on('end', () => {
      let pass = '';
      try { pass = String((JSON.parse(b || '{}') || {}).passcode || ''); }
      catch { pass = new URLSearchParams(b).get('passcode') || ''; }
      if (!CONFIG.guardian || !CONFIG.guardian.passcode) { sendJson(400, { error: 'guardian_not_set' }); return; }
      if (timingEq(pass, CONFIG.guardian.passcode)) {
        authOk(ip);
        sendJson(200, { ok: true }, cookieHeader('grd', GUARDIAN_TTL_MS, GUARDIAN_COOKIE));
      } else {
        authFail(ip);
        sendJson(401, { error: 'bad_guardian' });
      }
    });
    return;
  }

  // Google OAuth：起手
  if (url.startsWith('/__gate/google/start')) {
    if (!googleLoginUsable()) { sendHtml(res, 404, loginPage('Google 登入需搭配 Tailscale 固定網址')); return; }
    const nonce = crypto.randomBytes(16).toString('hex');
    const state = `${nonce}.${mac(nonce)}`;
    const redirectUri = `${baseUrl(req)}/__gate/google/callback`;
    const auth = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: CONFIG.google.clientId, redirect_uri: redirectUri, response_type: 'code',
      scope: 'openid email', state, access_type: 'online', prompt: 'select_account',
    }).toString();
    res.writeHead(303, { Location: auth, 'Set-Cookie': `${STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=600` });
    res.end();
    return;
  }
  // Google OAuth：回呼
  if (url.startsWith('/__gate/google/callback')) {
    if (!googleEnabled()) { sendHtml(res, 404, loginPage('未設定 Google 登入')); return; }
    const q = new URL(url, baseUrl(req)).searchParams;
    const state = q.get('state') || '';
    const cookieState = parseCookies(req.headers.cookie)[STATE_COOKIE] || '';
    const nonce = state.split('.')[0];
    if (!state || state !== cookieState || state !== `${nonce}.${mac(nonce)}`) {
      sendHtml(res, 400, loginPage('登入驗證失敗，請重試')); return;
    }
    const code = q.get('code');
    if (!code) { sendHtml(res, 400, loginPage('Google 未回傳授權碼')); return; }
    httpsPost('oauth2.googleapis.com', '/token', {
      code, client_id: CONFIG.google.clientId, client_secret: CONFIG.google.clientSecret,
      redirect_uri: `${baseUrl(req)}/__gate/google/callback`, grant_type: 'authorization_code',
    }).then((tok) => {
      const claims = decodeJwtPayload(tok && tok.id_token);
      const email = claims && claims.email_verified && claims.email ? String(claims.email).toLowerCase() : '';
      const allow = (CONFIG.google.allowedEmails || []).map((e) => String(e).toLowerCase());
      if (email && allow.includes(email)) {
        redirect(res, '/', cookieHeader('own', OWNER_TTL_MS));
      } else {
        sendHtml(res, 403, loginPage(`此 Google 帳號無權限${email ? '：' + email : ''}`));
      }
    }).catch(() => sendHtml(res, 502, loginPage('Google 登入交換失敗')));
    return;
  }

  // === owner 專屬：設定精靈 ===
  if (url.startsWith('/__gate/admin')) {
    if (level !== 'own') { sendHtml(res, level ? 403 : 401, loginPage('請以 owner 身分登入')); return; }
    adminPage('').then((html) => sendHtml(res, 200, html)).catch(() => sendHtml(res, 500, loginPage('控制台載入失敗')));
    return;
  }
  if (url === '/__gate/passcode' && req.method === 'POST') {
    if (level !== 'own') { sendHtml(res, 403, loginPage('需 owner 權限')); return; }
    readBody(req, (form) => {
      const p = form.get('passcode') || '';
      if (p.length < 6) { adminPage('通行碼至少 6 碼').then((h) => sendHtml(res, 400, h)); return; }
      CONFIG.passcode = p; saveConfig(CONFIG);
      redirect(res, '/__gate/admin');
    });
    return;
  }
  if (url === '/__gate/guardian-config' && req.method === 'POST') {
    if (level !== 'own') { sendHtml(res, 403, loginPage('需 owner 權限')); return; }
    readBody(req, (form) => {
      const p = form.get('passcode') || '';
      if (p && p.length < 4) { adminPage('監護密碼至少 4 碼（或留空清除）').then((h) => sendHtml(res, 400, h)); return; }
      CONFIG.guardian = CONFIG.guardian || { passcode: '' };
      CONFIG.guardian.passcode = p; // 允許留空＝清除
      saveConfig(CONFIG);
      redirect(res, '/__gate/admin');
    });
    return;
  }
  if (url === '/__gate/expose' && req.method === 'POST') {
    if (level !== 'own') { sendHtml(res, 403, loginPage('需 owner 權限')); return; }
    readBody(req, (form) => {
      const mode = form.get('mode');
      if (!['public', 'private', 'off'].includes(mode)) { redirect(res, '/__gate/admin'); return; }
      tsSetMode(mode).then((r) => {
        const msg = r && r.notFound ? '找不到 Tailscale 指令，請確認已安裝' : (r && !r.ok ? '切換失敗：' + htmlEsc((r.stderr || '').slice(0, 120)) : '');
        adminPage(msg).then((h) => sendHtml(res, 200, h));
      }).catch(() => redirect(res, '/__gate/admin'));
    });
    return;
  }
  if (url === '/__gate/autostart' && req.method === 'POST') {
    if (level !== 'own') { sendHtml(res, 403, loginPage('需 owner 權限')); return; }
    readBody(req, (form) => {
      const on = form.get('on') === '1';
      autostartSet(on).then((r) => {
        const msg = r && !r.ok ? '設定失敗：' + htmlEsc((r.stderr || '').slice(0, 120)) : '';
        adminPage(msg).then((h) => sendHtml(res, 200, h));
      }).catch(() => redirect(res, '/__gate/admin'));
    });
    return;
  }
  if (url === '/__gate/google-config' && req.method === 'POST') {
    if (level !== 'own') { sendHtml(res, 403, loginPage('需 owner 權限')); return; }
    readBody(req, (form) => {
      CONFIG.google.clientId = (form.get('clientId') || '').trim();
      const sec = (form.get('clientSecret') || '').trim();
      if (sec) CONFIG.google.clientSecret = sec; // 留空＝不變
      CONFIG.google.allowedEmails = (form.get('allowedEmails') || '')
        .split(/[\n,]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
      saveConfig(CONFIG);
      redirect(res, '/__gate/admin');
    });
    return;
  }
  if (url === '/__gate/share' && req.method === 'POST') {
    if (level !== 'own') { sendHtml(res, 403, loginPage('需 owner 權限')); return; }
    readBody(req, (form) => {
      const action = form.get('action');
      if (action === 'enable') {
        const hours = Math.max(0, Math.min(720, Number(form.get('hours')) || 0));
        CONFIG.share.enabled = true;
        CONFIG.share.expiresAt = hours ? Date.now() + hours * 3600 * 1000 : 0;
      } else if (action === 'disable') {
        CONFIG.share.enabled = false; CONFIG.share.expiresAt = 0;
      } else if (action === 'config') {
        if (form.has('passcode')) CONFIG.share.passcode = form.get('passcode') || '';
        const ttl = Number(form.get('sessionTtlHours'));
        if (ttl >= 1 && ttl <= 168) CONFIG.share.sessionTtlHours = Math.floor(ttl);
      }
      saveConfig(CONFIG);
      redirect(res, '/__gate/admin');
    });
    return;
  }

  // === 未登入：HTML 給登入頁，其他回 401 ===
  if (!level) {
    if ((req.headers.accept || '').includes('text/html')) sendHtml(res, 200, loginPage(''));
    else { res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' }); res.end('{"error":"auth required"}'); }
    return;
  }

  // === 已登入：分享級受限授權後透傳到本體 ===
  // owner：完整權限，直接透傳。shr：預設拒絕寫入，除非在安全白名單或已監護解鎖。
  if (level === 'shr') {
    const p = url.split('?')[0];
    const sid = shrSid(req);
    // 最高危：owner 專屬，連監護解鎖都擋。
    if (shrForbidden(req.method, p)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'owner_only' }));
      return;
    }
    if (shrNeedsGuardian(req.method, p)) {
      // 自己這個 session 建立的資源→免密碼；否則需監護解鎖。
      if (!ownsItem(sid, req.method, p) && !guardianActive(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'guardian_required' }));
        return;
      }
    } else {
      // 安全建立：緩衝回應抓 id 記進 session，之後可免密碼刪改自己建的。
      const collection = createCollection(req.method, p);
      if (collection && sid) { proxyCapture(req, res, (buf) => recordCreated(sid, collection, buf)); return; }
    }
  }
  proxyHttp(req, res);
});

// WebSocket / HTTP upgrade：同樣要先登入
server.on('upgrade', (req, clientSocket, head) => {
  if (needsSetup() || !authLevel(req)) {
    try { clientSocket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); clientSocket.destroy(); } catch {}
    return;
  }
  const headers = rewriteHeaders(req.headers);
  const upstream = net.connect(TARGET_PORT, TARGET_HOST, () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(headers)) {
      if (Array.isArray(v)) v.forEach((vv) => { raw += `${k}: ${vv}\r\n`; });
      else raw += `${k}: ${v}\r\n`;
    }
    raw += '\r\n';
    upstream.write(raw);
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on('error', () => { try { clientSocket.destroy(); } catch {} });
  clientSocket.on('error', () => { try { upstream.destroy(); } catch {} });
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`tsproxy(wizard) listening 127.0.0.1:${LISTEN_PORT} -> ${TARGET_HOSTHEADER}  setup=${needsSetup()} google=${googleEnabled()}`);
  // 上次選的是免安裝通道 → 開機/重啟後自動重開，拿到新網址（Tailscale 由其自身常駐、不需這裡處理）。
  if (CONFIG.channel === 'cloudflared' && cfInstalled()) {
    cfStart().then((r) => console.log('[cloudflared] auto-start', r.ok ? r.url : ('fail: ' + r.error)));
  }
});
