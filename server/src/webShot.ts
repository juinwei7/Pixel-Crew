// 工作小窗 Tier 3：用原生 CDP 驅動「單一常駐」headless Chrome，替 NPC 的「上網查」抓真實
// 瀏覽器畫面。截圖只回給前端小窗顯示（不回餵模型＝零額外 token）。設計原則（照使用者硬需求）：
//   - 只有真的有人上網查時才開瀏覽器；閒置 IDLE_MS 自動關掉，不常駐吃記憶體。
//   - 全域並發 1（排隊），避免同時開一堆 Chrome 搶 host 資源。
//   - 只 kill 我們自己記下的 PID，絕不掃 chrome.exe（會誤殺使用者的瀏覽器）。
//   - 同查詢 CACHE_TTL_MS 內複用截圖，重畫小窗不重截。
//   - 低解析度 JPEG，小窗根本不需要高清。
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import net from "node:net";
import { lookup } from "node:dns/promises";
import { WebSocket } from "ws";

// 依平台列出常見的 Chromium 系瀏覽器路徑（Windows/macOS/Linux 都要能找到，否則「上網查」在
// 非 Windows 上永遠開不起來）。環境變數指定的執行檔優先；其餘只保留確實存在的路徑。
export function chromeCandidates(
  platform: NodeJS.Platform = process.platform,
  configured = process.env.WEBSHOT_CHROME ?? "",
  isPresent: (path: string) => boolean = existsSync,
): string[] {
  const platformPaths = (() => {
  if (platform === "win32") {
    const pf = process.env.PROGRAMFILES || "C:\\Program Files";
    const pfx86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    const local = process.env.LOCALAPPDATA || "";
    return [
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pfx86}\\Google\\Chrome\\Application\\chrome.exe`,
      local && `${local}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pfx86}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ].filter(Boolean) as string[];
  }
  if (platform === "darwin") {
    const home = homedir();
    return ["", home].flatMap((base) => [
      `${base}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      `${base}/Applications/Chromium.app/Contents/MacOS/Chromium`,
      `${base}/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`,
      `${base}/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`,
    ]);
  }
  return [
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/snap/bin/chromium", "/usr/bin/microsoft-edge",
  ];
  })();
  return [configured, ...platformPaths].filter((path) => Boolean(path) && isPresent(path));
}

const DEBUG_PORT = Number(process.env.WEBSHOT_CDP_PORT ?? 9333);
const IDLE_MS = 90_000;            // 閒置 90 秒 → 自動關閉 Chrome 省資源
const CACHE_TTL_MS = 5 * 60_000;   // 同查詢 5 分鐘內複用截圖
// 小窗很小，重點是「文字讀得出來」＝寧可窄一點、內容大一點，再用 2× 像素密度讓縮小後仍清晰。
const VIEW_W = 760, VIEW_H = 680;  // 較窄版面＝搜尋結果欄位相對更大，塞進小窗後字比較讀得出來
const VIEW_SCALE = 1;              // deviceScaleFactor 1＝截圖快又穩（可讀性靠下方 PAGE_ZOOM，不靠像素密度）
const PAGE_ZOOM = 1.4;             // 整頁放大＝小窗只顯示上方少數大字結果，優先可讀（透過 CSS zoom 注入）
const JPEG_QUALITY = 70;
const BLANK_BYTES = 20_000;        // 小於這個大小的 JPEG 幾乎確定是純白空白（正常結果頁 60KB 起跳）
const NAV_TIMEOUT_MS = 12_000;
const LAUNCH_TIMEOUT_MS = 10_000;

type Cached = { buf: Buffer; ts: number };

let chrome: ChildProcess | null = null;
let chromePid: number | null = null;
let profileDir: string | null = null;
const cache = new Map<string, Cached>();
let queue: Promise<unknown> = Promise.resolve();
let idleTimer: NodeJS.Timeout | null = null;

function log(msg: string) { console.log(`[webshot] ${msg}`); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 截圖 buffer 佔記憶體（每筆 60–200KB）；插入前先清掉過期項，再對總量設上限（丟最舊），
// 避免長命伺服器上 NPC 累月瀏覽把 heap 塞爆。
const CACHE_MAX = 60;
function pruneCache() {
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.ts >= CACHE_TTL_MS) cache.delete(k);
  while (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function bumpIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { closeChrome("idle").catch(() => {}); }, IDLE_MS);
  idleTimer.unref?.();
}

async function closeChrome(reason: string) {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  try { sess?.ws.close(); } catch {}
  sess = null;
  const pid = chromePid;
  chrome = null; chromePid = null;
  if (pid != null) {
    log(`closing chrome pid=${pid} (${reason})`);
    // 只殺我們記下的這個 PID 樹（headless 會有子行程），絕不掃 chrome.exe。
    try {
      if (process.platform === "win32") spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      else process.kill(pid);
    } catch {}
  }
  const dir = profileDir; profileDir = null;
  if (dir) setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} }, 1500);
}

function cdpHttp(path: string, method: "GET" | "PUT" = "GET"): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: DEBUG_PORT, path, method }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e as Error); } });
    });
    req.on("error", reject);
    req.end();
  });
}

async function ensureChrome() {
  if (chrome && chromePid) return;
  // 環境變數優先（使用者明確指定，可能在 PATH 上而非絕對路徑，照用不檢查存在）；否則挑第一個實際存在的。
  const envBin = process.env.WEBSHOT_CHROME?.trim();
  const bin = envBin || chromeCandidates().find((path) => existsSync(path));
  if (!bin) throw new Error("找不到可用的 Chrome/Chromium/Edge 瀏覽器（可設環境變數 WEBSHOT_CHROME 指定執行檔路徑）");
  profileDir = mkdtempSync(join(tmpdir(), "pc-webshot-"));
  const args = [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
    "--no-default-browser-check", "--disable-extensions", "--mute-audio",
    "--disable-background-networking", "--disable-features=Translate,BackForwardCache",
    `--window-size=${VIEW_W},${VIEW_H}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    "--remote-allow-origins=*",           // 新版 Chrome 沒這個會拒絕 node 的 ws 連線
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ];
  const proc = spawn(bin, args, { stdio: "ignore", windowsHide: true });
  const launchError = await new Promise<Error | null>((resolve) => {
    proc.once("spawn", () => resolve(null));
    proc.once("error", (error) => resolve(error));
  });
  // spawn() reports a missing executable asynchronously. Observe its error
  // event instead of letting Node turn it into an uncaught server exception.
  if (launchError) {
    const dir = profileDir; profileDir = null;
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
    throw new Error(`無法啟動 Chrome：${launchError.message}`);
  }
  chrome = proc; chromePid = proc.pid ?? null;
  proc.on("error", (error) => {
    log(`chrome process error: ${error.message}`);
    if (chrome === proc) { chrome = null; chromePid = null; }
  });
  proc.on("exit", () => { if (chrome === proc) { chrome = null; chromePid = null; } });
  log(`launched chrome pid=${chromePid} port=${DEBUG_PORT}`);
  // 等 DevTools 起來
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  for (;;) {
    try { await cdpHttp("/json/version"); break; } catch {
      if (Date.now() > deadline) throw new Error("Chrome DevTools 未在時限內就緒");
      await sleep(250);
    }
  }
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

type Send = (method: string, params?: Record<string, unknown>) => Promise<any>;
let sess: { ws: WebSocket; send: Send } | null = null;

// 重用 Chrome 啟動時那個「使用中的分頁」（永遠有合成 surface＝截圖不會卡；不像新開的背景分頁）。
// 跨查詢的殘留 DOM 問題改由每次截圖前先導到 about:blank 清空來解（見 doCapture）。
async function getSession(): Promise<{ send: Send }> {
  await ensureChrome();
  if (sess && sess.ws.readyState === WebSocket.OPEN) return sess;
  let targets: any[] = [];
  try { targets = await cdpHttp("/json/list"); } catch { targets = []; }
  let page = Array.isArray(targets) ? targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl) : null;
  if (!page) page = await cdpHttp("/json/new?about:blank", "PUT");
  const wsUrl = page?.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error("拿不到 page 的 webSocketDebuggerUrl");
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let msgId = 0;
  // Unlike every CDP round trip below, this handshake previously had no
  // timeout. Headless Chrome can accept the TCP connection but never
  // complete the WS upgrade in some sandboxes; since captureWebShot serializes
  // all requests through one global queue, a single hung handshake here
  // wedged every future screenshot request until the server restarted.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("CDP WebSocket handshake timeout"));
    }, NAV_TIMEOUT_MS + 3000);
    ws.once("open", () => { clearTimeout(timer); resolve(); });
    ws.once("error", (e) => { clearTimeout(timer); reject(e as Error); });
  });
  ws.on("message", (raw) => {
    let msg: any; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id)!; pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || "CDP error"));
      else p.resolve(msg.result);
    }
  });
  ws.on("close", () => { pending.forEach((p) => p.reject(new Error("ws closed"))); pending.clear(); if (sess?.ws === ws) sess = null; });
  ws.on("error", () => { if (sess?.ws === ws) sess = null; });
  const send: Send = (method, params) =>
    new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) return reject(new Error("page ws not open"));
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params ?? {} }));
      setTimeout(() => { if (pending.delete(id)) reject(new Error(`CDP ${method} timeout`)); }, NAV_TIMEOUT_MS + 3000);
    });
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: VIEW_W, height: VIEW_H, deviceScaleFactor: VIEW_SCALE, mobile: false });
  // 去掉 "HeadlessChrome" 特徵＋給正常 UA，否則搜尋引擎會丟 CAPTCHA（DDG html 版必擋）。
  await send("Emulation.setUserAgentOverride", { userAgent: UA, acceptLanguage: "zh-TW,zh;q=0.9,en;q=0.8" });
  // 每個新文件（含 Bing 的 rdr= 重導頁）一載入就套用：砍掉 Bing 自己的頁首/分頁列/通知條（跟我們的網址列
  // 重複、又擠掉真正結果），並整頁放大＝小窗直接從第一筆大字結果開始。用 addScriptToEvaluateOnNewDocument
  // 才不會像事後注入那樣被重導後的新文件洗掉。
  try {
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source:
        "(function(){function ap(){try{if(!document.getElementById('__pcss')){" +
        "var st=document.createElement('style');st.id='__pcss';" +
        "st.textContent='#b_header,.b_scopebar,#b_scopebar,#b_notificationContainer,.b_ad,#b_pole{display:none!important}body{margin-top:0!important}';" +
        "(document.head||document.documentElement).appendChild(st);}}catch(e){}}" +
        "ap();document.addEventListener('DOMContentLoaded',ap);})();",
    });
  } catch {}
  // 熱身：headless 剛啟動時第一張 captureScreenshot 常卡住（合成器未就緒）。先丟一張低品質截圖暖機，
  // 用 race 設 3 秒上限＝就算這張卡住也不擋後面（它自己之後會 timeout/resolve，無害）。
  try { await Promise.race([send("Page.captureScreenshot", { format: "jpeg", quality: 20 }), sleep(3000)]); } catch {}
  sess = { ws, send };
  return sess;
}

// 導覽到 url 後輪詢 readyExpr（回傳 true 才算就緒），最多 ~5 秒。回傳是否就緒。
async function navAndWait(send: Send, url: string, readyExpr: string): Promise<boolean> {
  await send("Page.navigate", { url });
  for (let i = 0; i < 24; i++) {
    try {
      const r = await send("Runtime.evaluate", { expression: readyExpr, returnByValue: true });
      if (r?.result?.value === true) return true;
    } catch {}
    await sleep(200);
  }
  return false;
}

function targetUrl(query: string): string {
  const q = query.trim();
  if (/^https?:\/\//i.test(q)) return q;
  // Bing 對 headless 相對友善（DDG html 版必丟 CAPTCHA、Google 擋 headless）。
  return "https://www.bing.com/search?q=" + encodeURIComponent(q) + "&setlang=zh-TW";
}

// --- SSRF 防護：直連 URL 時，拒絕指向本機／內網／雲端 metadata 的位址 ---
// webshot 會用 headless 瀏覽器「真的去導覽」呼叫端給的網址；不擋等於讓伺服器替人打內網。
function isInternalIp(ip: string): boolean {
  const v = ip.replace(/^::ffff:/i, "").toLowerCase(); // 拆 IPv4-mapped IPv6
  if (net.isIPv4(v)) {
    const p = v.split(".").map(Number);
    if (p[0] === 0 || p[0] === 127 || p[0] === 10) return true;   // 未指定／loopback／私有
    if (p[0] === 169 && p[1] === 254) return true;                // link-local ＋ 雲端 metadata
    if (p[0] === 192 && p[1] === 168) return true;                // 私有
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;    // 私有
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;   // CGNAT
    return false;
  }
  if (net.isIPv6(v)) {
    if (v === "::1" || v === "::") return true;                   // loopback／未指定
    if (v.startsWith("fe80")) return true;                       // link-local
    if (v.startsWith("fc") || v.startsWith("fd")) return true;   // ULA 私有
    return false;
  }
  return false;
}
async function assertPublicUrl(raw: string): Promise<void> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("不支援的網址"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("只允許 http/https 網址");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase(); // 去 IPv6 方括號
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error("拒絕存取內部位址");
  if (net.isIP(host)) {
    if (isInternalIp(host)) throw new Error("拒絕存取內部位址");
    return;
  }
  // 主機名：解析所有 IP，任一落在內網就擋（順帶擋掉刻意指向內網的網域）。
  let addrs: { address: string }[] = [];
  try { addrs = await lookup(host, { all: true }); } catch { throw new Error("無法解析網址"); }
  if (addrs.some((a) => isInternalIp(a.address))) throw new Error("拒絕存取內部位址");
}

async function doCapture(query: string): Promise<{ buf: Buffer; ready: boolean }> {
  const url = targetUrl(query);
  const wantBing = !/^https?:\/\//i.test(query.trim());
  if (!wantBing) await assertPublicUrl(url); // 直連 URL 才需 SSRF 防護；Bing 搜尋走固定網域免驗
  const { send } = await getSession();
  // 1) 先確實清空成 about:blank（等到舊結果 DOM 真的不見了）＝下面的就緒輪詢不會被上一筆殘留騙。
  await navAndWait(send, "about:blank",
    "(function(){try{return !document.querySelector('#b_results')&&(!document.body||document.body.innerText.trim().length<20);}catch(e){return true;}})()");
  // 2) 載入目標，等「真正的結果節點」出現（不只容器）＝不會在轉場純白時就截圖。
  const readyExpr = "(function(){try{var b=document.body;if(!b||document.readyState!=='complete')return false;" +
    (wantBing ? "return !!document.querySelector('#b_results li.b_algo,#b_results .b_ans');"
              : "return b.innerText.trim().length>120;") + "}catch(e){return false;}})()";
  const ready = await navAndWait(send, url, readyExpr);
  // 頁首隱藏／放大已由 addScriptToEvaluateOnNewDocument 於載入時套用；這裡只需捲回頂部＋等版面沉澱再截。
  try { await send("Runtime.evaluate", { expression: "window.scrollTo(0,0)" }); await sleep(180); } catch {}
  let buf = Buffer.from((await send("Page.captureScreenshot", { format: "jpeg", quality: JPEG_QUALITY })).data, "base64");
  // 4) 純白防呆：內容已就緒卻截到超小（純白）＝稍等再截一次（涵蓋偶發的合成延遲）。
  if (ready && buf.length < BLANK_BYTES) {
    await sleep(450);
    try { buf = Buffer.from((await send("Page.captureScreenshot", { format: "jpeg", quality: JPEG_QUALITY })).data, "base64"); } catch {}
  }
  return { buf, ready };
}

/** 擷取一筆查詢/網址的截圖（JPEG buffer）。全域排隊、帶快取、閒置自動關瀏覽器。 */
export function captureWebShot(query: string): Promise<Buffer> {
  const key = query.trim().slice(0, 300).toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) { bumpIdle(); return Promise.resolve(hit.buf); }
  const task = queue.then(async () => {
    const again = cache.get(key);
    if (again && Date.now() - again.ts < CACHE_TTL_MS) return again.buf;
    try {
      const { buf, ready } = await doCapture(query);
      // 只有「確定抓到內容」才進快取；轉場空白/沒讀到內容就不快取，下次請求會重截＝不會把純白卡 5 分鐘。
      if (ready) { pruneCache(); cache.set(key, { buf, ts: Date.now() }); }
      bumpIdle();
      return buf;
    } catch (e) {
      log(`capture failed: ${(e as Error).message}`);
      await closeChrome("error"); // 壞掉就整個重來，下次乾淨重開
      throw e;
    }
  });
  // 保持鏈不因單筆失敗而中斷
  queue = task.then(() => undefined, () => undefined);
  return task;
}

export function shutdownWebShot() { return closeChrome("shutdown"); }
