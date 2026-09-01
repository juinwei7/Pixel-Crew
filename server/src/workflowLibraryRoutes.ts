import type { Express } from "express";
import { deleteProjectCommand, listProjectCommands, saveProjectCommand } from "./commandLibrary.js";
import { t } from "./i18n.js";
import { deleteProjectSkill, listProjectSkills, saveProjectSkill } from "./skillLibrary.js";

type CapabilityRefresher = { refresh(force?: boolean): Promise<unknown> };

export function registerWorkflowLibraryRoutes(input: {
  app: Express;
  normalizeWorkspacePath(value: unknown): string;
  restartIdleWorkers(provider: "claude" | "codex", workspacePath: string): void;
  claudeCapabilitiesFor(workspacePath: string): CapabilityRefresher;
  scanWorkflowLibrary(): Promise<unknown>;
}): void {
  const { app } = input;

  app.get("/api/commands", async (req, res) => {
    try {
      const workspacePath = input.normalizeWorkspacePath(req.query.workspacePath);
      res.json({ commands: await listProjectCommands(workspacePath), workspacePath });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message || t("無法讀取專案指令") });
    }
  });

  app.put("/api/commands", async (req, res) => {
    try {
      const workspacePath = input.normalizeWorkspacePath(req.body?.workspacePath);
      const command = await saveProjectCommand(
        workspacePath,
        String(req.body?.name ?? ""),
        String(req.body?.content ?? ""),
        req.body?.originalName ? String(req.body.originalName) : undefined,
      );
      input.restartIdleWorkers("claude", workspacePath);
      void input.claudeCapabilitiesFor(workspacePath).refresh(true).catch((error) => {
        console.error("failed to refresh Claude capabilities after saving a command", error);
      });
      void input.scanWorkflowLibrary();
      res.json({ command });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message || t("無法儲存專案指令") });
    }
  });

  app.delete("/api/commands", async (req, res) => {
    try {
      const workspacePath = input.normalizeWorkspacePath(req.body?.workspacePath);
      await deleteProjectCommand(workspacePath, String(req.body?.name ?? ""));
      input.restartIdleWorkers("claude", workspacePath);
      void input.claudeCapabilitiesFor(workspacePath).refresh(true).catch((error) => {
        console.error("failed to refresh Claude capabilities after deleting a command", error);
      });
      void input.scanWorkflowLibrary();
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message || t("無法刪除專案指令") });
    }
  });

  app.get("/api/skills", async (req, res) => {
    try {
      const workspacePath = input.normalizeWorkspacePath(req.query.workspacePath);
      res.json({ skills: await listProjectSkills(workspacePath), workspacePath });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message || t("無法讀取 Codex Skills") });
    }
  });

  app.put("/api/skills", async (req, res) => {
    try {
      const workspacePath = input.normalizeWorkspacePath(req.body?.workspacePath);
      const skill = await saveProjectSkill(
        workspacePath,
        String(req.body?.name ?? ""),
        String(req.body?.content ?? ""),
        req.body?.originalName ? String(req.body.originalName) : undefined,
      );
      input.restartIdleWorkers("codex", workspacePath);
      void input.scanWorkflowLibrary();
      res.json({ skill });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message || t("無法儲存 Codex Skill") });
    }
  });

  app.delete("/api/skills", async (req, res) => {
    try {
      const workspacePath = input.normalizeWorkspacePath(req.body?.workspacePath);
      await deleteProjectSkill(workspacePath, String(req.body?.name ?? ""));
      input.restartIdleWorkers("codex", workspacePath);
      void input.scanWorkflowLibrary();
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message || t("無法刪除 Codex Skill") });
    }
  });
}
