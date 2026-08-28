import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppSettingsStore, DEFAULT_APP_SETTINGS, normalizeAppSettings } from "../src/appSettings.js";

test("normalize：空值與垃圾輸入回預設", () => {
  assert.deepEqual(normalizeAppSettings(null), DEFAULT_APP_SETTINGS);
  assert.deepEqual(normalizeAppSettings("junk"), DEFAULT_APP_SETTINGS);
  assert.deepEqual(normalizeAppSettings({ brainSwapEnabled: "yes" }), DEFAULT_APP_SETTINGS);
});

test("normalize：合法布林值保留", () => {
  assert.deepEqual(
    normalizeAppSettings({ brainSwapEnabled: false, limitResumeEnabled: true }),
    { brainSwapEnabled: false, limitResumeEnabled: true, lang: "zh" },
  );
});

test("normalize：lang 只收 zh/en，垃圾值回預設 zh", () => {
  assert.equal(normalizeAppSettings({ lang: "en" }).lang, "en");
  assert.equal(normalizeAppSettings({ lang: "fr" }).lang, "zh");
  assert.equal(normalizeAppSettings({}).lang, "zh");
});

test("store：update 寫檔、重開讀回", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-settings-"));
  try {
    const store = new AppSettingsStore(dir);
    assert.deepEqual(store.get(), DEFAULT_APP_SETTINGS);
    store.update({ brainSwapEnabled: false });
    const reopened = new AppSettingsStore(dir);
    assert.equal(reopened.get().brainSwapEnabled, false);
    assert.equal(reopened.get().limitResumeEnabled, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("store：壞掉的 JSON 檔回預設不炸", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-settings-"));
  try {
    fs.writeFileSync(path.join(dir, "app-settings.json"), "{not json");
    assert.deepEqual(new AppSettingsStore(dir).get(), DEFAULT_APP_SETTINGS);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
