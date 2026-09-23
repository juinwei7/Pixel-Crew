import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createSocketServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// 遠端存取轉接站（repo 根目錄的 _tsproxy.mjs）是零相依的純 JS sidecar，只能整支跑起來測。
// 這裡把 cloudflared 的下載來源與存放位置都導到暫存區，網路一律不出本機。
const RELAY = fileURLToPath(new URL("../../_tsproxy.mjs", import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createSocketServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(label: string, probe: () => Promise<T | null>, timeoutMs = 20000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = await probe();
    if (hit !== null && hit !== undefined) return hit;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(120);
  }
}

type CfInfo = {
  installed: boolean; running: boolean; url: string; downloading: boolean;
  progress: { received: number; total: number; pct: number | null; bytesPerSec: number; etaSec: number | null } | null;
  error: string;
};

/** 一次性的假下載來源。mode 決定這次要正常送完，還是送一半就斷線。 */
function downloadServer(payload: Buffer, plan: Array<"ok" | "truncate">): Promise<{ server: Server; port: number; hits: number }> {
  let hits = 0;
  const server = createServer(async (req, res) => {
    const mode = plan[Math.min(hits, plan.length - 1)];
    hits += 1;
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(payload.length) });
    if (mode === "truncate") {
      res.write(payload.subarray(0, Math.floor(payload.length / 4)));
      await sleep(40);
      res.socket?.destroy();   // 連線中途死掉：舊版就是卡在這裡永遠不 settle
      return;
    }
    // 慢慢送，讓測試觀察得到進度（而不是一瞬間就結束）。
    const chunk = Math.ceil(payload.length / 6);
    for (let at = 0; at < payload.length; at += chunk) {
      res.write(payload.subarray(at, at + chunk));
      await sleep(60);
    }
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, port, hits });
    });
  });
}


// ── 登入關卡與授權模型 ──────────────────────────────────────────────────────

/** 假的本體：把收到的 method/url/headers 原樣回報，用來檢查轉接站怎麼改寫請求。 */
function echoUpstream(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

/** 送出登入表單，回傳 cookie 字串（失敗則回 null）。 */
async function login(api: (path: string, init?: RequestInit) => Promise<Response>, passcode: string): Promise<string | null> {
  const res = await api("/__gate/login", {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ passcode }).toString(),
  });
  const setCookie = res.headers.get("set-cookie") || "";
  const hit = /pc_gate=([^;]+)/.exec(setCookie);
  return hit ? `pc_gate=${hit[1]}` : null;
}

test("登入錯誤不放行；登入成功後的請求會改寫 Host 並拿掉 Origin/Referer", async (t) => {
  const ws = makeWorkspace();
  const upstream = await echoUpstream();
  const relay = await startRelay({
    PC_TSPROXY_CONFIG: ws.config,
    PC_CLOUDFLARED_EXE: ws.exe,
    PC_TSPROXY_TARGET_PORT: String(upstream.port),
  });
  t.after(() => { relay.child.kill(); upstream.server.close(); ws.cleanup(); });

  assert.equal(await login(relay.api, "wrong-passcode"), null);
  assert.equal((await relay.api("/api/anything")).status, 401, "沒登入就不該碰得到本體");

  const cookie = await login(relay.api, "test-passcode");
  assert.ok(cookie, "正確通行碼要換得到登入 cookie");

  const proxied = await (await relay.api("/api/echo", {
    headers: { cookie: cookie!, origin: "https://evil.example", referer: "https://evil.example/x" },
  })).json();
  // 本體只信任 loopback 的 Host/Origin（防 DNS rebinding），所以轉接站必須改寫成本機。
  assert.equal(proxied.headers.host, `127.0.0.1:${upstream.port}`);
  assert.equal(proxied.headers.origin, undefined);
  assert.equal(proxied.headers.referer, undefined);
  assert.equal(proxied.url, "/api/echo");
});

test("分享訪客：讀取放行、高危操作 owner 專屬、其餘要監護密碼", async (t) => {
  const ws = makeWorkspace();
  const upstream = await echoUpstream();
  const relay = await startRelay({
    PC_TSPROXY_CONFIG: ws.config,
    PC_CLOUDFLARED_EXE: ws.exe,
    PC_TSPROXY_TARGET_PORT: String(upstream.port),
  });
  t.after(() => { relay.child.kill(); upstream.server.close(); ws.cleanup(); });

  const opened = await relay.api("/__gate/api/share", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true, hours: 1, passcode: "share-passcode" }),
  });
  assert.equal(opened.status, 200);

  const guest = await login(relay.api, "share-passcode");
  assert.ok(guest, "分享密碼要換得到訪客 cookie");
  const as = (path: string, init?: RequestInit) => relay.api(path, { ...init, headers: { ...(init?.headers || {}), cookie: guest! } });

  assert.equal((await as("/api/workers")).status, 200, "讀取應直接放行");
  assert.equal((await as("/api/boss-tasks", { method: "POST" })).status, 200, "安全建立在白名單內");

  // 最高危：連監護解鎖都不給，訪客永遠碰不到。
  const exportRes = await as("/api/backup/export");
  assert.equal(exportRes.status, 403);
  assert.equal((await exportRes.json()).error, "owner_only");
  // 轉接站自己的管理端點也一樣——否則訪客能改主通行碼、開關 tunnel。
  assert.equal((await as("/api/remote-access/state")).status, 403);

  // 動到既有資料：要先過監護密碼 step-up。
  const del = await as("/api/boss-tasks/someone-elses-task", { method: "DELETE" });
  assert.equal(del.status, 403);
  assert.equal((await del.json()).error, "guardian_required");
});

test("分享密碼下限與前端一致（6 碼）", async (t) => {
  const ws = makeWorkspace();
  const relay = await startRelay({ PC_TSPROXY_CONFIG: ws.config, PC_CLOUDFLARED_EXE: ws.exe });
  t.after(() => { relay.child.kill(); ws.cleanup(); });

  const res = await relay.api("/__gate/api/share", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true, hours: 1, passcode: "abcd" }),
  });
  assert.equal(res.status, 400);
});

// 舊版只 destroy 不回應，'end' 永遠不會來，瀏覽器就一直空轉。
test("超長表單回 413，不會讓瀏覽器一直等", async (t) => {
  const ws = makeWorkspace();
  const relay = await startRelay({ PC_TSPROXY_CONFIG: ws.config, PC_CLOUDFLARED_EXE: ws.exe });
  t.after(() => { relay.child.kill(); ws.cleanup(); });

  const res = await relay.api("/__gate/login", {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `passcode=${"x".repeat(20000)}`,
  });
  assert.equal(res.status, 413);
});

test("登出會一併清掉監護解鎖 cookie", async (t) => {
  const ws = makeWorkspace();
  const relay = await startRelay({ PC_TSPROXY_CONFIG: ws.config, PC_CLOUDFLARED_EXE: ws.exe });
  t.after(() => { relay.child.kill(); ws.cleanup(); });

  const res = await relay.api("/__gate/logout", { method: "GET", redirect: "manual" });
  const cookies = res.headers.getSetCookie();
  assert.ok(cookies.some((c) => /^pc_gate=;/.test(c)), "要清登入 cookie");
  assert.ok(cookies.some((c) => /^pc_grd=;/.test(c)), "監護解鎖 cookie 也要一起清");
});

async function startRelay(env: Record<string, string>): Promise<{ child: ChildProcess; port: number; api: (path: string, init?: RequestInit) => Promise<Response> }> {
  const port = await freePort();
  const child = spawn(process.execPath, [RELAY], {
    env: { ...process.env, PC_TSPROXY_PORT: String(port), ...env },
    stdio: "ignore",
  });
  const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
  await waitFor("relay to listen", async () => {
    try { return (await api("/__gate/api/state")).ok ? true : null; } catch { return null; }
  }, 15000);
  return { child, port, api };
}

function makeWorkspace(): { dir: string; config: string; exe: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pc-relay-"));
  const config = join(dir, "secret.json");
  // 先寫好通行碼，轉接站就不會停在「首次設定」。
  writeFileSync(config, JSON.stringify({ passcode: "test-passcode", channel: "off" }), { mode: 0o600 });
  return { dir, config, exe: join(dir, "cloudflared"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("cloudflared 下載會回報進度，而且 install 端點不等下載跑完", async (t) => {
  const ws = makeWorkspace();
  const payload = Buffer.alloc(240 * 1024, 7);
  const { server, port: dlPort } = await downloadServer(payload, ["ok"]);
  const relay = await startRelay({
    PC_TSPROXY_CONFIG: ws.config,
    PC_CLOUDFLARED_EXE: ws.exe,
    PC_CLOUDFLARED_URL: `http://127.0.0.1:${dlPort}/cloudflared`,
  });
  t.after(() => { relay.child.kill(); server.close(); ws.cleanup(); });

  // 慢線路上這支若等下載跑完，會撞上本體同源代理的 40 秒逾時。
  const began = Date.now();
  const install = await relay.api("/__gate/api/cloudflared/install", { method: "POST" });
  assert.equal(install.status, 200);
  assert.ok(Date.now() - began < 2000, "install 端點必須立刻回，不能等下載");

  const cf = async (): Promise<CfInfo> => (await (await relay.api("/__gate/api/cloudflared/progress")).json()).cloudflared;

  const mid = await waitFor("download progress", async () => {
    const info = await cf();
    return info.downloading && info.progress && info.progress.received > 0 ? info : null;
  });
  assert.equal(mid.progress?.total, payload.length, "應回報 content-length 當總長度");
  assert.ok(mid.progress!.pct !== null && mid.progress!.pct >= 0, "有總長度就要算得出百分比");

  const done = await waitFor("download to finish", async () => {
    const info = await cf();
    return info.downloading ? null : info;
  });
  assert.equal(done.error, "");
  assert.equal(done.installed, true);
  assert.deepEqual(readFileSync(ws.exe), payload);
  if (process.platform !== "win32") {
    assert.equal(statSync(ws.exe).mode & 0o777, 0o755, "下載回來要能執行");
  }
});

// 迴歸：連線中途被切時，Node 只在 response 上發 'aborted'/'error'，寫入串流的 'finish'
// 永遠不會來。舊版的 boolean 旗標因此卡在「下載進行中」，之後每次點都被自己擋掉，
// 只有重啟轉接站才解得開（實測使用者機器上就是卡在這個狀態）。
test("下載中斷會回報錯誤並允許重試，不會卡在「下載進行中」", async (t) => {
  const ws = makeWorkspace();
  const payload = Buffer.alloc(160 * 1024, 3);
  const { server, port: dlPort } = await downloadServer(payload, ["truncate", "ok"]);
  const relay = await startRelay({
    PC_TSPROXY_CONFIG: ws.config,
    PC_CLOUDFLARED_EXE: ws.exe,
    PC_CLOUDFLARED_URL: `http://127.0.0.1:${dlPort}/cloudflared`,
  });
  t.after(() => { relay.child.kill(); server.close(); ws.cleanup(); });

  const cf = async (): Promise<CfInfo> => (await (await relay.api("/__gate/api/cloudflared/progress")).json()).cloudflared;

  await relay.api("/__gate/api/cloudflared/install", { method: "POST" });
  const failed = await waitFor("failed download to settle", async () => {
    const info = await cf();
    return info.downloading ? null : info;
  });
  assert.equal(failed.installed, false);
  assert.match(failed.error, /不完整|連線中斷/);
  assert.equal(existsSync(ws.exe + ".download"), false, "半成品檔案要清掉");

  // 這才是重點：第二次點下去必須真的重新開始，而不是回「下載進行中」。
  await relay.api("/__gate/api/cloudflared/install", { method: "POST" });
  const done = await waitFor("retry to finish", async () => {
    const info = await cf();
    return info.downloading ? null : info;
  });
  assert.equal(done.installed, true);
  assert.equal(done.error, "");
  assert.deepEqual(readFileSync(ws.exe), payload);
});

test("已經裝好就不會重下，狀態直接回 installed", async (t) => {
  const ws = makeWorkspace();
  writeFileSync(ws.exe, "already here", { mode: 0o755 });
  const { server, port: dlPort } = await downloadServer(Buffer.alloc(1024), ["ok"]);
  const relay = await startRelay({
    PC_TSPROXY_CONFIG: ws.config,
    PC_CLOUDFLARED_EXE: ws.exe,
    PC_CLOUDFLARED_URL: `http://127.0.0.1:${dlPort}/cloudflared`,
  });
  t.after(() => { relay.child.kill(); server.close(); ws.cleanup(); });

  await relay.api("/__gate/api/cloudflared/install", { method: "POST" });
  await sleep(300);
  const info: CfInfo = (await (await relay.api("/__gate/api/cloudflared/progress")).json()).cloudflared;
  assert.equal(info.installed, true);
  assert.equal(info.downloading, false);
  assert.equal(readFileSync(ws.exe, "utf8"), "already here");
});

test("尚未安裝就切到 cloudflared 通道，回 409 而不是含糊的 502", async (t) => {
  const ws = makeWorkspace();
  const relay = await startRelay({ PC_TSPROXY_CONFIG: ws.config, PC_CLOUDFLARED_EXE: ws.exe });
  t.after(() => { relay.child.kill(); ws.cleanup(); });

  const res = await relay.api("/__gate/api/channel", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "cloudflared" }),
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).needsInstall, true);
});
