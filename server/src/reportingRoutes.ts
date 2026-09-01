import type { Express } from "express";
import { buildDayReport, localDay, resolveReportDay } from "./dayReport.js";
import type { LocalStore } from "./store.js";

export function registerReportingRoutes(input: {
  app: Express;
  store: LocalStore;
  workerIds(): Iterable<string>;
  workerName(workerId: string): string | undefined;
  dailyBudget(workerId: string): number | null;
}): void {
  const { app, store } = input;

  app.get("/api/costs", (req, res) => {
    const days = Math.min(60, Math.max(1, Number(req.query.days ?? 14) || 14));
    const since = new Date();
    since.setDate(since.getDate() - (days - 1));
    const budgets = [...input.workerIds()]
      .map((workerId) => ({ workerId, dailyUsd: input.dailyBudget(workerId) }))
      .filter((entry) => entry.dailyUsd != null);
    res.json({ costs: store.listDailyCosts(localDay(since)), today: localDay(), budgets });
  });

  // 彙整邏輯由 dayReport.ts 的純函式處理；這個 route 只收集本機資料。
  app.get("/api/day-report", (req, res) => {
    const today = localDay();
    const day = resolveReportDay(req.query.day, today);
    res.json(buildDayReport({
      day,
      today,
      dailyCosts: store.listDailyCosts(day),
      dayEvents: store.listDayEvents(day),
      bossTasks: store.listBossTasks(),
      missions: store.listDepartmentMissions(),
      workerName: input.workerName,
      dailyBudget: input.dailyBudget,
    }));
  });
}
