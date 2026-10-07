import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { AppSettingsStore } from "../src/appSettings.js";
import { appSettingsPatchFromBody, registerOperationalSettingsRoutes } from "../src/operationalSettingsRoutes.js";
import type { LocalStore } from "../src/store.js";

test("app-settings patch：owner 可改全部欄位，垃圾值忽略", () => {
  assert.deepEqual(
    appSettingsPatchFromBody({ brainSwapEnabled: false, remoteAccessAutoStart: true, lang: "en", diagnosticsEnabled: "no" }, { shareGuest: false }),
    { patch: { brainSwapEnabled: false, remoteAccessAutoStart: true, lang: "en" } },
  );
  assert.deepEqual(appSettingsPatchFromBody(null, { shareGuest: false }), { patch: {} });
});

test("app-settings patch：分享訪客動不了「開機自動啟動遠端存取」，其餘功能開關照常", () => {
  assert.deepEqual(appSettingsPatchFromBody({ remoteAccessAutoStart: false }, { shareGuest: true }), { error: "owner_only" });
  // 夾帶在其他欄位裡也一樣整筆拒絕，不能部分套用後讓人誤以為成功。
  assert.deepEqual(appSettingsPatchFromBody({ brainSwapEnabled: true, remoteAccessAutoStart: true }, { shareGuest: true }), { error: "owner_only" });
  assert.deepEqual(appSettingsPatchFromBody({ limitResumeEnabled: false }, { shareGuest: true }), { patch: { limitResumeEnabled: false } });
});

test("POST /api/app-settings 依轉接站蓋上的 x-pc-access 判斷訪客", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-app-settings-"));
  const app = express();
  app.use(express.json());
  const appSettings = new AppSettingsStore(dir);
  registerOperationalSettingsRoutes({ app, appSettings, store: {} as LocalStore, localDay: () => "2026-01-01", setLang: () => undefined });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/app-settings`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });

  const guest = await post({ remoteAccessAutoStart: true }, { "x-pc-access": "shr" });
  assert.equal(guest.status, 403);
  assert.equal((await guest.json()).error, "owner_only");
  assert.equal(appSettings.get().remoteAccessAutoStart, false);

  const owner = await post({ remoteAccessAutoStart: true }, { "x-pc-access": "own" });
  assert.equal(owner.status, 200);
  assert.equal(appSettings.get().remoteAccessAutoStart, true);

  const local = await post({ remoteAccessAutoStart: false });
  assert.equal(local.status, 200, "主機上本機直連（沒有 x-pc-access）＝owner");
  assert.equal(appSettings.get().remoteAccessAutoStart, false);
});
