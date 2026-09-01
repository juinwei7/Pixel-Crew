import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { t } from "./i18n.js";
import type { LocalStore } from "./store.js";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

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
    store.addSchedule(randomUUID(), workerId, time, prompt);
    res.json({ ok: true, schedules: store.listSchedules() });
  });

  app.patch("/api/schedules/:id", (req, res) => {
    const fields: { time?: string; prompt?: string; enabled?: boolean } = {};
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
    store.updateSchedule(req.params.id, fields);
    res.json({ ok: true, schedules: store.listSchedules() });
  });

  app.delete("/api/schedules/:id", (req, res) => {
    store.deleteSchedule(req.params.id);
    res.json({ ok: true, schedules: store.listSchedules() });
  });
}
