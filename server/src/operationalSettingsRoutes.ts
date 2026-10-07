import type { Express } from "express";
import { randomUUID } from "node:crypto";
import type { AppSettingsStore } from "./appSettings.js";
import { buildLocalDiagnostics, type DiagnosticEventKind } from "./diagnostics.js";
import { t } from "./i18n.js";
import type { LocalStore } from "./store.js";

const diagnosticKinds = new Set<DiagnosticEventKind>(["websocket_reconnect", "ui_long_task", "fps_sample", "approval_wait"]);

/**
 * 把 POST /api/app-settings 的 body 轉成設定 patch。「開機自動啟動遠端存取轉接站」雖然存在一般
 * 功能設定裡，本質是遠端存取設定——轉接站把 /api/remote-access/* 整個子樹對分享訪客鎖成 owner
 * 專屬，這裡也一樣，不能讓拿到監護解鎖的訪客從這條路繞過去改。shareGuest 來自轉接站驗證後蓋上
 * 的 x-pc-access: shr（用戶端偽造不了；主機上本機直連沒有這個 header＝owner）。
 */
export function appSettingsPatchFromBody(
  body: unknown,
  options: { shareGuest: boolean },
): { patch: Record<string, boolean | string> } | { error: "owner_only" } {
  const source = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (options.shareGuest && source.remoteAccessAutoStart !== undefined) return { error: "owner_only" };
  const patch: Record<string, boolean | string> = {};
  if (typeof source.brainSwapEnabled === "boolean") patch.brainSwapEnabled = source.brainSwapEnabled;
  if (typeof source.limitResumeEnabled === "boolean") patch.limitResumeEnabled = source.limitResumeEnabled;
  if (typeof source.diagnosticsEnabled === "boolean") patch.diagnosticsEnabled = source.diagnosticsEnabled;
  if (typeof source.remoteAccessAutoStart === "boolean") patch.remoteAccessAutoStart = source.remoteAccessAutoStart;
  if (source.lang === "zh" || source.lang === "en") patch.lang = source.lang;
  return { patch };
}

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
    const parsed = appSettingsPatchFromBody(req.body, { shareGuest: String(req.headers["x-pc-access"] ?? "") === "shr" });
    if ("error" in parsed) { res.status(403).json({ error: parsed.error }); return; }
    const settings = appSettings.update(parsed.patch);
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
