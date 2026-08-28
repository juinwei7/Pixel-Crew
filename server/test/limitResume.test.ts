import assert from "node:assert/strict";
import test from "node:test";
import { parseLimitReset } from "../src/limitResume.js";

const NOON = new Date("2026-08-22T12:00:00");

test("實際格式：session limit · resets 2:50pm", () => {
  const at = parseLimitReset("You've hit your session limit · resets 2:50pm (Asia/Taipei)", NOON);
  assert.ok(at);
  assert.equal(at.getHours(), 14);
  assert.equal(at.getMinutes(), 50);
  assert.equal(at.getDate(), NOON.getDate());
});

test("整點無分鐘：resets 3pm", () => {
  const at = parseLimitReset("Usage limit reached — resets 3pm", NOON);
  assert.ok(at);
  assert.equal(at.getHours(), 15);
  assert.equal(at.getMinutes(), 0);
});

test("重置時刻已過 → 排到隔天", () => {
  const at = parseLimitReset("You've hit your session limit · resets 9:00am", NOON);
  assert.ok(at);
  assert.equal(at.getHours(), 9);
  assert.equal(at.getDate(), NOON.getDate() + 1);
});

test("12am/12pm 邊界", () => {
  const midnight = parseLimitReset("hit your usage limit, resets 12:30am", NOON);
  assert.equal(midnight?.getHours(), 0);
  const noonReset = parseLimitReset("hit your usage limit, resets 12:15pm", new Date("2026-08-22T08:00:00"));
  assert.equal(noonReset?.getHours(), 12);
});

test("非上限錯誤／沒有 resets 時間 → null", () => {
  assert.equal(parseLimitReset("Error: ENOENT no such file", NOON), null);
  assert.equal(parseLimitReset("You've hit your session limit", NOON), null);
  assert.equal(parseLimitReset("meeting resets 3pm tomorrow", NOON), null);
});
