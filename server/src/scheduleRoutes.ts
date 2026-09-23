import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { t } from "./i18n.js";
import type { LocalStore } from "./store.js";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60; // 一週，避免手滑設出無界值

// 解析「每 N 分鐘重複」間隔：undefined＝未提供；null／空＝清除(回到每日模式)；
// 數字＝夾在 [5, 10080] 的整數分鐘。回 ok:false＝格式無效（非正數）。
function normalizeInterval(value: unknown): { ok: true; value: number | null | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null || value === "") return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return { ok: false };
  return { ok: true, value: Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.floor(n))) };
}

export function registerScheduleRoutes(input: {
  app: Express;
  store: LocalStore;
  workerExists(workerId: string): boolean;
}): void {
  const { app, store } = input;

  app.get("/api/schedules", (_req, res) => {
    res.json({ schedules: store.listSchedules() });
  });

  app.post("/api/schedules", (req, res) => {
    const workerId = String(req.body?.workerId ?? "");
    const time = String(req.body?.time ?? "");
    const prompt = String(req.body?.prompt ?? "").trim();
    if (!input.workerExists(workerId)) { res.status(400).json({ error: "unknown worker" }); return; }
    if (!TIME.test(time)) { res.status(400).json({ error: t("時間格式須為 HH:MM") }); return; }
    if (!prompt) { res.status(400).json({ error: t("請提供要執行的指示") }); return; }
    const interval = normalizeInterval(req.body?.intervalMinutes);
    if (!interval.ok) { res.status(400).json({ error: t("重複間隔需為正整數分鐘（至少 {min} 分鐘）", { min: MIN_INTERVAL_MINUTES }) }); return; }
    // 未提供間隔＝每日模式（null）；有值＝每 N 分鐘重複。time 兩種模式都存（重複模式忽略）。
    store.addSchedule(randomUUID(), workerId, time, prompt, interval.value ?? null);
    res.json({ ok: true, schedules: store.listSchedules() });
  });

  app.patch("/api/schedules/:id", (req, res) => {
    const fields: { time?: string; prompt?: string; enabled?: boolean; intervalMinutes?: number | null } = {};
    if (req.body?.time !== undefined) {
      const time = String(req.body.time);
      if (!TIME.test(time)) { res.status(400).json({ error: t("時間格式須為 HH:MM") }); return; }
      fields.time = time;
    }
    if (req.body?.prompt !== undefined) {
      const prompt = String(req.body.prompt).trim();
      if (!prompt) { res.status(400).json({ error: t("指示不可為空") }); return; }
      fields.prompt = prompt;
    }
    if (req.body?.enabled !== undefined) fields.enabled = Boolean(req.body.enabled);
    const interval = normalizeInterval(req.body?.intervalMinutes);
    if (!interval.ok) { res.status(400).json({ error: t("重複間隔需為正整數分鐘（至少 {min} 分鐘）", { min: MIN_INTERVAL_MINUTES }) }); return; }
    if (interval.value !== undefined) fields.intervalMinutes = interval.value;
    store.updateSchedule(req.params.id, fields);
    res.json({ ok: true, schedules: store.listSchedules() });
  });

  app.delete("/api/schedules/:id", (req, res) => {
    store.deleteSchedule(req.params.id);
    res.json({ ok: true, schedules: store.listSchedules() });
  });
}
