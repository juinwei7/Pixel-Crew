import assert from "node:assert/strict";
import test from "node:test";
import { ScheduleBudgetNotices, scheduleOverDailyBudget } from "../src/scheduleRoutes.js";

test("scheduled runs respect the worker's daily budget like queued and direct messages do", () => {
  assert.equal(scheduleOverDailyBudget(null, 999), false, "沒設上限＝不擋");
  assert.equal(scheduleOverDailyBudget(undefined, 999), false);
  assert.equal(scheduleOverDailyBudget(5, 4.99), false);
  assert.equal(scheduleOverDailyBudget(5, 5), true, "剛好花到上限就停，與 /message、drain 一致");
  assert.equal(scheduleOverDailyBudget(0, 0), true);
});

test("an over-budget schedule is explained once per schedule per day, not on every scan", () => {
  const notices = new ScheduleBudgetNotices();
  assert.equal(notices.shouldNote("every-5-min", "2026-10-07"), true);
  assert.equal(notices.shouldNote("every-5-min", "2026-10-07"), false, "每 30 秒掃一次也只說一次");
  assert.equal(notices.shouldNote("daily-9am", "2026-10-07"), true, "不同排程各自說明");
  assert.equal(notices.shouldNote("every-5-min", "2026-10-08"), true, "隔天重新說明");
});
