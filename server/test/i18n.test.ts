import assert from "node:assert/strict";
import test from "node:test";
import { getLang, setLang, t, tc } from "../src/i18n.js";

test("i18n：預設 zh 原文直出，插值可用", () => {
  assert.equal(getLang(), "zh");
  assert.equal(t("剩餘 {pct}%", { pct: 55 }), "剩餘 55%");
});

test("i18n：en 查不到退回中文原文；tc 無語境條目退回 t", () => {
  setLang("en");
  try {
    assert.equal(t("這句不在字典裡"), "這句不在字典裡");
    assert.equal(tc("不存在的語境", "這句也不在"), "這句也不在");
  } finally {
    setLang("zh");
  }
});
