import type { ProviderId } from "./providers/types.js";
import type { AssignmentDecisionCandidate } from "./assignmentDecision.js";
import { t } from "./i18n.js";
import { executionBudgetFor, type ExecutionBudget, type ExecutionProfile } from "./executionBudget.js";

export type BossTaskStatus =
  | "discovering"
  | "ready"
  | "running"
  | "needs_input"
  | "needs_attention"
  | "synthesizing"
  | "completed"
  | "failed"
  | "cancelled";

export type BossTaskMessageRole = "boss" | "decision_model" | "system" | "report";
export type BossExecutionMode = "research" | "project";
export type { ExecutionBudget, ExecutionProfile } from "./executionBudget.js";

export type BossTaskMessage = {
  id: string;
  role: BossTaskMessageRole;
  text: string;
  attachmentIds?: string[];
  clientMessageId?: string | null;
  idempotencyKey?: string | null;
  createdAt: string;
};

export type BossTaskStage = {
  id: string;
  departmentId: string;
  departmentName: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  status: "pending" | "running" | "completed" | "needs_attention" | "failed" | "cancelled";
  missionId: string | null;
  report: string | null;
  executionMode?: BossExecutionMode;
};

export type BossTask = {
  id: string;
  title: string;
  archivedAt: string | null;
  workspacePath: string;
  decisionProvider: ProviderId;
  decisionModel: string;
  objective: string;
  acceptanceCriteria: string[];
  attachmentIds?: string[];
  clientMessageId?: string | null;
  idempotencyKey?: string | null;
  status: BossTaskStatus;
  executionMode?: BossExecutionMode;
  executionProfile?: ExecutionProfile;
  executionBudget?: ExecutionBudget;
  messages: BossTaskMessage[];
  historyClearedAt?: string | null;
  stages: BossTaskStage[];
  finalReport: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type BossTaskDecision =
  | {
      status: "clarification";
      question: string;
      rationale: string[];
    }
  | {
      status: "ready";
      executionMode: BossExecutionMode;
      summary: string;
      rationale: string[];
      stages: Array<{
        id: string;
        departmentId: string;
        title: string;
        objective: string;
        acceptanceCriteria: string[];
        dependsOn: string[];
      }>;
    };

function bounded(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function bossTaskDecisionPrompt(input: {
  task: Pick<BossTask, "objective" | "acceptanceCriteria" | "workspacePath" | "messages" | "executionProfile" | "executionBudget">;
  candidates: AssignmentDecisionCandidate[];
}): string {
  const clarificationLimit = 3;
  const budget = input.task.executionBudget ?? executionBudgetFor(input.task.executionProfile);
  const clarificationCount = input.task.messages.filter((message) => message.role === "decision_model").length;
  const clarificationRemaining = Math.max(0, clarificationLimit - clarificationCount);
  const catalog = input.candidates.map((candidate) => ({
    departmentId: candidate.departmentId,
    name: candidate.departmentName,
    purpose: candidate.purpose,
    workspacePath: candidate.workspacePath,
    leadWorkerId: candidate.leadWorkerId,
    positions: candidate.members.map((member) => ({
      workerId: member.workerId,
      name: member.name,
      role: member.role,
      instructions: member.instructions,
      provider: member.provider,
    })),
  }));
  const conversation = input.task.messages
    .filter((message) => message.role === "boss" || message.role === "decision_model")
    .slice(-12)
    .map((message) => ({ role: message.role, text: bounded(message.text, 2_000) }));

  return `Boss Task · Discovery and Department Orchestration

You are the Boss's decision model. Determine whether the request is sufficiently specific to assign safely, then either ask one blocking clarification question or produce a multi-department execution graph.

Execution boundary selected by the owner: ${budget.label} (${budget.profile}). This is a hard ceiling: use no more than ${budget.maxStages} department stage(s). Each stage will be limited to ${budget.maxAgents} participating NPC(s) and ${budget.maxMissionSteps} planned work step(s). Prefer a smaller plan; do not evade the ceiling by inventing extra stages.

Rules:
- Do not use tools, files, shell commands, MCP, web access, or background agents.
- Use only exact department ids from the catalog.
- Do not assign work when scope, target users, expected outcome, authority, security boundary, or acceptance boundary is materially ambiguous.
- Broad product requests such as "build an ERP" normally require discovery before execution.
- Clarification is exceptional, not a required step. Make reasonable, reversible departmental assumptions when the outcome can already be executed safely.
- Treat an imperative as a one-time request to execute now unless the Boss explicitly asks for recurrence, scheduling, or a future time.
- Pixel Crew Department Missions are the execution and communication channel. Never ask whether to use Slack, email, system notifications, or another external channel unless the Boss explicitly requested that integration.
- If the Boss requests an action from every employee or all departments, include every eligible department whose members can perform it; do not ask for another delivery channel.
- Ask exactly one concise, high-impact question at a time. Compare its information need with the entire conversation and do not rephrase or repeat an answered question.
- This task has ${clarificationRemaining} clarification question(s) remaining out of ${clarificationLimit}. ${clarificationRemaining === 0 ? "You MUST return ready using the safest bounded assumptions supported by the conversation. Do not return clarification." : "Only use one if execution would otherwise be unsafe or materially undefined."}
- Minor implementation details may be delegated to the appropriate department.
- Classify the work as executionMode "research" when the primary deliverable is an answer: advisory analysis, investigation, comparison, diagnosis, or decision support. Use "project" when the work creates or changes a product, repository, external state, or durable delivery artifact.
- Research uses exactly one department stage. That one stage owns evidence gathering, contrary evidence, risk analysis, and the owner-facing conclusion. Never split research, verification, and integration into separate Boss stages.
- Project graphs use one stage per materially distinct department responsibility. A department id may appear only once; that department owns its internal decomposition.
- Do not create files, code, backtests, or durable artifacts for research unless the Boss explicitly asked for those deliverables.
- Use multiple departments when their distinct responsibilities materially contribute.
- Stages must be bounded, have unique ids, and form an acyclic dependency graph.
- Include independent verification when an eligible QA/review specialty exists and the work creates or changes a product.
- Return only one marked JSON block and no Markdown fences.

Original objective: ${JSON.stringify(bounded(input.task.objective, 4_000))}
Acceptance criteria: ${JSON.stringify(input.task.acceptanceCriteria.slice(0, 8).map((item) => bounded(item, 500)))}
Boss workspace: ${JSON.stringify(input.task.workspacePath)}
Persistent discovery conversation: ${JSON.stringify(conversation)}
Eligible department catalog: ${JSON.stringify(catalog)}

Clarification form:
<boss_task_decision>
{"status":"clarification","question":"one blocking question","rationale":["why this blocks safe assignment"]}
</boss_task_decision>

Ready form:
<boss_task_decision>
{"status":"ready","executionMode":"research|project","summary":"execution approach","rationale":["routing reason"],"stages":[{"id":"stable-stage-id","departmentId":"exact catalog id","title":"stage title","objective":"bounded department deliverable","acceptanceCriteria":["observable outcome"],"dependsOn":[]}]}
</boss_task_decision>`;
}

export function bossTaskClarificationBudget(task: Pick<BossTask, "messages">, limit = 3): {
  used: number;
  remaining: number;
} {
  const used = task.messages.filter((message) => message.role === "decision_model").length;
  return { used, remaining: Math.max(0, limit - used) };
}

export function applyBossTaskRecordPatch(
  task: BossTask,
  patch: { title?: unknown; archived?: unknown },
  now = new Date().toISOString(),
): string | null {
  const hasTitle = Object.prototype.hasOwnProperty.call(patch, "title");
  const hasArchived = Object.prototype.hasOwnProperty.call(patch, "archived");
  const title = hasTitle ? bounded(patch.title, 120) : task.title;
  if (hasTitle && !title) return t("任務標題不能空白");
  if (hasArchived && typeof patch.archived !== "boolean") return t("封存狀態格式錯誤");
  if (patch.archived === true && !["completed", "failed", "cancelled"].includes(task.status)) {
    return t("進行中或等待處理的任務不能封存");
  }
  if (hasTitle) task.title = title;
  if (hasArchived) task.archivedAt = patch.archived ? now : null;
  return null;
}

type BossTaskDecisionResult =
  | { ok: true; decision: BossTaskDecision }
  | { ok: false; reason: string };

function evaluateBossTaskDecision(
  text: string,
  candidates: AssignmentDecisionCandidate[],
  boundary: ExecutionProfile | ExecutionBudget = "standard",
): BossTaskDecisionResult {
  const match = text.match(/<boss_task_decision>\s*([\s\S]*?)\s*<\/boss_task_decision>/i);
  if (!match) return { ok: false, reason: "Missing a <boss_task_decision>...</boss_task_decision> block." };
  let raw: unknown;
  try { raw = JSON.parse(match[1]); } catch (cause) {
    return { ok: false, reason: `The JSON inside <boss_task_decision> did not parse: ${(cause as Error).message}.` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "The <boss_task_decision> content must be a single JSON object." };
  const value = raw as Record<string, unknown>;
  const rationale = Array.isArray(value.rationale)
    ? value.rationale.map((item) => bounded(item, 500)).filter(Boolean).slice(0, 5)
    : [];
  if (value.status === "clarification") {
    const question = bounded(value.question, 1_000);
    if (!question) return { ok: false, reason: "Clarification form is missing a non-empty \"question\"." };
    if (rationale.length === 0) return { ok: false, reason: "Clarification form needs a non-empty \"rationale\" array." };
    return { ok: true, decision: { status: "clarification", question, rationale } };
  }
  if (value.status !== "ready") return { ok: false, reason: `"status" must be exactly "clarification" or "ready", got ${JSON.stringify(value.status)}.` };
  if (value.executionMode !== "research" && value.executionMode !== "project") {
    return { ok: false, reason: 'Ready form needs "executionMode" set to exactly "research" or "project".' };
  }
  const executionMode: BossExecutionMode = value.executionMode;
  const summary = bounded(value.summary, 1_000);
  if (!summary) return { ok: false, reason: "Ready form is missing a non-empty \"summary\"." };
  const maxStages = typeof boundary === "string" ? executionBudgetFor(boundary).maxStages : boundary.maxStages;
  if (!Array.isArray(value.stages) || value.stages.length < 1 || value.stages.length > maxStages) return { ok: false, reason: `Ready form needs a "stages" array with 1 to ${maxStages} entries for the selected execution boundary.` };
  if (executionMode === "research" && value.stages.length !== 1) {
    return { ok: false, reason: "Research execution requires exactly one department stage containing evidence, risk analysis, and the owner-facing conclusion." };
  }
  const departmentIds = new Set(candidates.map((candidate) => candidate.departmentId));
  const stages: Extract<BossTaskDecision, { status: "ready" }>["stages"] = [];
  const ids = new Set<string>();
  const assignedDepartments = new Set<string>();
  for (const [index, rawStage] of value.stages.entries()) {
    if (!rawStage || typeof rawStage !== "object" || Array.isArray(rawStage)) return { ok: false, reason: `Stage ${index + 1} must be a JSON object.` };
    const stage = rawStage as Record<string, unknown>;
    const id = bounded(stage.id, 100);
    const departmentId = bounded(stage.departmentId, 200);
    const title = bounded(stage.title, 200);
    const objective = bounded(stage.objective, 2_000);
    const acceptanceCriteria = Array.isArray(stage.acceptanceCriteria)
      ? stage.acceptanceCriteria.map((item) => bounded(item, 500)).filter(Boolean).slice(0, 8)
      : [];
    const dependsOn = Array.isArray(stage.dependsOn)
      ? stage.dependsOn.map((item) => bounded(item, 100)).filter(Boolean).slice(0, 8)
      : [];
    if (!id) return { ok: false, reason: `Stage ${index + 1} is missing a non-empty "id".` };
    if (ids.has(id)) return { ok: false, reason: `Stage ${index + 1} reuses id ${JSON.stringify(id)} — every stage id must be unique.` };
    if (!departmentIds.has(departmentId)) return { ok: false, reason: `Stage ${JSON.stringify(id)} used departmentId ${JSON.stringify(departmentId)}, which is not in the eligible department catalog. Valid ids: ${[...departmentIds].join(", ")}.` };
    if (assignedDepartments.has(departmentId)) return { ok: false, reason: `Department ${JSON.stringify(departmentId)} may appear only once in a Boss execution graph; its Mission owns internal decomposition.` };
    if (!title) return { ok: false, reason: `Stage ${JSON.stringify(id)} is missing a non-empty "title".` };
    if (!objective) return { ok: false, reason: `Stage ${JSON.stringify(id)} is missing a non-empty "objective".` };
    if (acceptanceCriteria.length === 0) return { ok: false, reason: `Stage ${JSON.stringify(id)} needs at least one non-empty "acceptanceCriteria" entry.` };
    ids.add(id);
    assignedDepartments.add(departmentId);
    stages.push({ id, departmentId, title, objective, acceptanceCriteria, dependsOn });
  }
  if (executionMode === "research" && stages[0].dependsOn.length > 0) {
    return { ok: false, reason: "The single research stage cannot depend on another Boss stage." };
  }
  for (const stage of stages) {
    if (stage.dependsOn.includes(stage.id)) return { ok: false, reason: `Stage ${JSON.stringify(stage.id)} cannot depend on itself.` };
    const unknownDependency = stage.dependsOn.find((id) => !ids.has(id));
    if (unknownDependency) return { ok: false, reason: `Stage ${JSON.stringify(stage.id)} depends on unknown stage id ${JSON.stringify(unknownDependency)}.` };
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const cyclePath: string[] = [];
  const visit = (id: string): boolean => {
    if (visiting.has(id)) { cyclePath.push(id); return false; }
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) if (!visit(dependency)) { cyclePath.push(id); return false; }
    visiting.delete(id);
    visited.add(id);
    return true;
  };
  for (const stage of stages) {
    if (!visit(stage.id)) return { ok: false, reason: `The stage dependency graph has a cycle involving: ${[...new Set(cyclePath)].join(" -> ")}.` };
  }
  return { ok: true, decision: { status: "ready", executionMode, summary, rationale, stages } };
}

export function parseBossTaskDecision(
  text: string,
  candidates: AssignmentDecisionCandidate[],
  boundary: ExecutionProfile | ExecutionBudget = "standard",
): BossTaskDecision | null {
  const result = evaluateBossTaskDecision(text, candidates, boundary);
  return result.ok ? result.decision : null;
}

// Re-evaluates the same text to explain a parse failure in prose, so a
// repair prompt can tell a weaker decision model exactly what to fix
// instead of just "your previous response was invalid".
export function explainBossTaskDecisionFailure(
  text: string,
  candidates: AssignmentDecisionCandidate[],
  boundary: ExecutionProfile | ExecutionBudget = "standard",
): string | null {
  const result = evaluateBossTaskDecision(text, candidates, boundary);
  return result.ok ? null : result.reason;
}

export function bossTaskFinalReport(task: BossTask): string {
  const sections = task.stages.map((stage) => t("## {title} · {departmentName}\n\n{report}", {
    title: stage.title,
    departmentName: stage.departmentName,
    report: stage.report || t("部門未提供報告。"),
  }));
  const research = task.executionMode === "research" || task.stages[0]?.executionMode === "research";
  const acceptanceBlock = task.acceptanceCriteria.length
    ? task.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")
    : t("- 已由各部門依任務目標完成合理驗證並回報風險。");
  const closing = research
    ? t("以上為快速研究結果。你可以追問依據，或另行要求深入研究、回測或建立正式交付物。")
    : t("以上為 {count} 個部門階段的彙整結果。你可以在 Boss Task 對話中繼續詢問或交辦修改。", { count: task.stages.length });
  return t(
    "# Boss Task 最終報告\n\n## 交辦目標\n\n{objective}\n\n## {resultHeading}\n\n{sections}\n\n## 驗收與後續\n\n{acceptanceBlock}\n\n{closing}",
    {
      objective: task.objective,
      resultHeading: research ? t("研究結論") : t("跨部門執行結果"),
      sections: sections.join("\n\n"),
      acceptanceBlock,
      closing,
    },
  );
}
