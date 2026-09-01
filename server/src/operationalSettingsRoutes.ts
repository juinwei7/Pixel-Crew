import type { Express } from "express";
import { randomUUID } from "node:crypto";
import type { AppSettingsStore } from "./appSettings.js";
import { buildLocalDiagnostics, type DiagnosticEventKind } from "./diagnostics.js";
import { t } from "./i18n.js";
import type { LocalStore } from "./store.js";

const diagnosticKinds = new Set<DiagnosticEventKind>(["websocket_reconnect", "ui_long_task", "fps_sample", "approval_wait"]);

export function registerOperationalSettingsRoutes(input: {
  app: Express;
  appSettings: AppSettingsStore;
  store: LocalStore;
  localDay(date?: Date): string;
  setLang(lang: "zh" | "en"): void;
}): void {
  const { app, appSettings, store } = input;

  app.get("/api/app-settings", (_req, res) => {
    res.json({ settings: appSettings.get() });
  });

  app.post("/api/app-settings", (req, res) => {
    const patch: Record<string, boolean | string> = {};
    if (typeof req.body?.brainSwapEnabled === "boolean") patch.brainSwapEnabled = req.body.brainSwapEnabled;
    if (typeof req.body?.limitResumeEnabled === "boolean") patch.limitResumeEnabled = req.body.limitResumeEnabled;
    if (typeof req.body?.diagnosticsEnabled === "boolean") patch.diagnosticsEnabled = req.body.diagnosticsEnabled;
    if (req.body?.lang === "zh" || req.body?.lang === "en") patch.lang = req.body.lang;
    const settings = appSettings.update(patch);
    input.setLang(settings.lang);
    res.json({ settings });
  });

  // 只接收數字與分類，永不寫入 prompt、路徑、模型輸出或工具內容，亦不會上傳。
  app.post("/api/diagnostics/events", (req, res) => {
    if (!appSettings.get().diagnosticsEnabled) { res.status(409).json({ error: t("本機診斷已關閉") }); return; }
    const kind = req.body?.kind;
    const value = Number(req.body?.value);
    if (typeof kind !== "string" || !diagnosticKinds.has(kind as DiagnosticEventKind) || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
      res.status(400).json({ error: t("無效的診斷事件") }); return;
    }
    store.saveDiagnosticEvent({ id: randomUUID(), kind: kind as DiagnosticEventKind, value, createdAt: new Date().toISOString() });
    res.status(202).json({ ok: true });
  });

  app.get("/api/diagnostics", (_req, res) => {
    res.json({ enabled: appSettings.get().diagnosticsEnabled, diagnostics: buildLocalDiagnostics(store.listDepartmentMissions(undefined, 500), store.listDiagnosticEvents()) });
  });

  app.get("/api/diagnostics/export", (_req, res) => {
    const payload = buildLocalDiagnostics(store.listDepartmentMissions(undefined, 500), store.listDiagnosticEvents());
    res.attachment(`pixel-crew-local-diagnostics-${input.localDay()}.json`).type("application/json").send(JSON.stringify(payload, null, 2));
  });
}
