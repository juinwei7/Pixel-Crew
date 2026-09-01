import type { Express } from "express";
import { t } from "./i18n.js";

export type ApprovalDecision = "allow_once" | "allow_session" | "deny";

function parseDecision(value: unknown): ApprovalDecision | null {
  return value === "allow_once" || value === "allow_session" || value === "deny" ? value : null;
}

export function registerApprovalRoutes(input: {
  app: Express;
  resolveWorkerApproval(workerId: string, approvalId: string, decision: ApprovalDecision): "not_found" | "resolved" | "unavailable";
  resolveMissionApproval(missionId: string, approvalId: string, decision: ApprovalDecision): "not_found" | "resolved" | "unavailable";
  findBridgeResponse(token: string, payload: unknown): Promise<{ found: boolean; response?: unknown }>;
}): void {
  const { app } = input;

  app.post("/api/workers/:id/approvals/:approvalId", (req, res) => {
    const decision = parseDecision(req.body?.decision);
    if (!decision) { res.status(400).json({ error: "unknown approval decision" }); return; }
    const result = input.resolveWorkerApproval(req.params.id, req.params.approvalId, decision);
    if (result === "not_found") { res.status(404).json({ error: t("找不到這位 NPC") }); return; }
    if (result === "unavailable") { res.status(409).json({ error: t("核准要求已失效或已處理") }); return; }
    res.json({ ok: true });
  });

  app.post("/api/missions/:id/approvals/:approvalId", (req, res) => {
    const decision = parseDecision(req.body?.decision);
    if (!decision) { res.status(400).json({ error: "unknown approval decision" }); return; }
    const result = input.resolveMissionApproval(req.params.id, req.params.approvalId, decision);
    if (result === "not_found") { res.status(404).json({ error: t("找不到 Department Mission") }); return; }
    if (result === "unavailable") { res.status(409).json({ error: t("核准要求已失效、已處理，或任務 session 已中止") }); return; }
    res.json({ ok: true });
  });

  app.post("/internal/claude-approval", async (req, res) => {
    const header = String(req.headers.authorization ?? "");
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || token.length > 100) { res.status(401).json({ message: "Invalid approval bridge token" }); return; }
    try {
      const result = await input.findBridgeResponse(token, req.body);
      if (!result.found) { res.status(404).json({ message: "Approval bridge is no longer active" }); return; }
      res.json(result.response);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message || "Approval bridge failed" });
    }
  });
}
