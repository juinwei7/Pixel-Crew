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
  // 決策模型判定「單一部門、單一動作、無需多步規劃與獨立查證」的瑣碎階段時設 true：
  // 該階段的 Mission 走單步直執行快速道（跳過規劃 LLM 與 review），省掉整輪來回。
  directExecute?: boolean;
  // 決策模型判定「簡單、低風險的多步交付（例如寫一組相關文件），需要規劃但不需獨立查證」時設 true：
  // 該階段的 Mission 照常規劃步驟，但系統會在解析計畫後「結構性剝掉所有 review 步驟」——不靠規劃模型自律。
  noReview?: boolean;
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
      // 沒有合適的既有部門時，決策模型改為要求「開一支專屬部門」：系統會 AI 規劃成員、
      // 建立部門，再重跑一次決策把工作交給它（自己創建部門 → 討論 → 執行）。
      status: "create_department";
      departmentPurpose: string;
      memberCount: number;
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
        directExecute?: boolean;
        noReview?: boolean;
      }>;
    };

function bounded(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function bossTaskDecisionPrompt(input: {
  task: Pick<BossTask, "objective" | "acceptanceCriteria" | "workspacePath" | "messages" | "executionProfile" | "executionBudget" | "attachmentIds">;
  candidates: AssignmentDecisionCandidate[];
}): string {
  const clarificationLimit = 3;
  const budget = input.task.executionBudget ?? executionBudgetFor(input.task.executionProfile);
  const clarificationCount = input.task.messages.filter((message) => message.role === "decision_model").length;
  const clarificationRemaining = Math.max(0, clarificationLimit - clarificationCount);
  // 精簡目錄：路由只需部門用途與職務名稱，不需每位成員的完整指示（很長）或 workerId。
  // stage 只引用 departmentId，成員細節由部門 Mission 內部決定，別塞進這顆決策 prompt。
  const catalog = input.candidates.map((candidate) => ({
    departmentId: candidate.departmentId,
    name: candidate.departmentName,
    purpose: candidate.purpose,
    workspacePath: candidate.workspacePath,
    roles: candidate.members.map((member) => member.role).filter((role): role is string => Boolean(role)),
    memberCount: candidate.members.length,
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
- If NONE of the catalog departments' purposes genuinely fit this objective's domain, do NOT force-fit it into an unrelated department. Instead return create_department with a concise department purpose and how many NPCs (2-4) it needs; the system will create that dedicated department and then re-plan the routing. Prefer an existing department only when its purpose truly covers the work; prefer creating a dedicated team over a bad fit.
- Do not assign work when scope, target users, expected outcome, authority, security boundary, or acceptance boundary is materially ambiguous.
- Required-input preflight: before planning, identify the concrete inputs this objective depends on (data files, datasets, credentials, access to systems). Count the "Attachments provided" number below as available input. If a required input is not attached, not plausibly already in the workspace, and not something the assigned team can produce itself, spend your clarification asking for it NOW — a missing input discovered mid-execution wastes the whole run. If no clarifications remain, scope the plan to what actually exists and make the first stage verify inputs before any heavy work.
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
- Set a stage's "directExecute": true ONLY when that stage is a single, unambiguous, low-risk action or a direct factual/analytical answer that needs no multi-step plan and no independent verification — e.g. answer a factual/arithmetic question, write or edit one small file, a quick lookup or summary. That stage then runs in ONE execute turn with no separate planning round and no review, which is much faster. Omit it (defaults false) whenever the work has multiple sub-steps, produces a substantial artifact, changes important state, or genuinely benefits from QA. When in doubt, omit it.
- Set a stage's "noReview": true when the work is simple, low-risk authoring or file/data creation that genuinely needs multiple ordered steps (so NOT a single directExecute), but does NOT need an independent verification step — e.g. writing a set of related documents, straightforward multi-file content, plain data entry. The department still plans the steps, but runs no separate review step (faster). Reserve reviews (leave noReview false) for program logic, configuration, calculations, or deliverables whose incorrectness would cause a real failure. directExecute and noReview are independent: directExecute is for a single action; noReview is for simple-but-multi-step work.
- Return only one marked JSON block and no Markdown fences.

Original objective: ${JSON.stringify(bounded(input.task.objective, 4_000))}
Acceptance criteria: ${JSON.stringify(input.task.acceptanceCriteria.slice(0, 8).map((item) => bounded(item, 500)))}
Attachments provided by the Boss: ${(input.task.attachmentIds ?? []).length} file(s)
Boss workspace: ${JSON.stringify(input.task.workspacePath)}
Persistent discovery conversation: ${JSON.stringify(conversation)}
Eligible department catalog: ${JSON.stringify(catalog)}

Clarification form:
<boss_task_decision>
{"status":"clarification","question":"one blocking question","rationale":["why this blocks safe assignment"]}
</boss_task_decision>

Create-department form (only when no catalog department fits — the system creates it, then re-plans):
<boss_task_decision>
{"status":"create_department","departmentPurpose":"concise purpose of the dedicated team this objective needs","memberCount":3,"rationale":["why no existing department fits and this team is the right shape"]}
</boss_task_decision>

Ready form:
<boss_task_decision>
{"status":"ready","executionMode":"research|project","summary":"execution approach","rationale":["routing reason"],"stages":[{"id":"stable-stage-id","departmentId":"exact catalog id","title":"stage title","objective":"bounded department deliverable","acceptanceCriteria":["observable outcome"],"dependsOn":[],"directExecute":false,"noReview":false}]}
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
  if (value.status === "create_department") {
    const departmentPurpose = bounded(value.departmentPurpose, 200);
    if (!departmentPurpose) return { ok: false, reason: "create_department form is missing a non-empty \"departmentPurpose\"." };
    const rawCount = typeof value.memberCount === "number" && Number.isFinite(value.memberCount) ? Math.floor(value.memberCount) : 3;
    const memberCount = Math.min(4, Math.max(2, rawCount));
    return { ok: true, decision: { status: "create_department", departmentPurpose, memberCount, rationale } };
  }
  if (value.status !== "ready") return { ok: false, reason: `"status" must be exactly "clarification", "create_department", or "ready", got ${JSON.stringify(value.status)}.` };
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
    const directExecute = stage.directExecute === true;
    const noReview = stage.noReview === true;
    stages.push({ id, departmentId, title, objective, acceptanceCriteria, dependsOn, ...(directExecute ? { directExecute: true } : {}), ...(noReview ? { noReview: true } : {}) });
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

// 驗收核對：逐條把「驗收條件」對照各部門交付的報告，標記達成 / 未達成 / 無法驗證。
export type AcceptanceStatus = "met" | "unmet" | "unverifiable";
export type BossTaskAcceptanceVerdict = {
  criterion: string;
  status: AcceptanceStatus;
  evidence: string;
};

// 給決策模型的「逐條驗收」判斷 prompt：只讀各部門的最終報告文字，逐條裁決，不動任何檔案。
export function bossTaskAcceptancePrompt(task: Pick<BossTask, "objective" | "acceptanceCriteria" | "stages">): string {
  const criteria = task.acceptanceCriteria.slice(0, 8).map((item) => bounded(item, 500)).filter(Boolean);
  const reports = task.stages.map((stage, index) => ({
    stage: index + 1,
    department: stage.departmentName,
    title: stage.title,
    report: bounded(stage.report ?? "", 8_000),
  }));
  return `Boss Task · Acceptance Verification

You are the Boss's decision model. The cross-department work is finished. Judge each acceptance criterion strictly against ONLY the department reports below — do not assume, do not use tools, files, shell, MCP, or web access, and do not invent evidence.

For each criterion decide exactly one status:
- "met": the reports contain concrete evidence the criterion is satisfied.
- "unmet": the reports show it was NOT satisfied, or explicitly contradict it.
- "unverifiable": the reports do not contain enough information to decide either way. Prefer this over guessing.

Keep "evidence" to one short sentence quoting or paraphrasing the specific report content that justifies the status (or, for unverifiable, what is missing). Judge only the criteria listed; keep their order and 1-based index.

Original objective: ${JSON.stringify(bounded(task.objective, 2_000))}
Acceptance criteria (1-based): ${JSON.stringify(criteria)}
Department reports: ${JSON.stringify(reports)}

Return only this one marked JSON block, no Markdown fences:
<boss_task_acceptance>
{"verdicts":[{"index":1,"status":"met|unmet|unverifiable","evidence":"one short sentence"}]}
</boss_task_acceptance>`;
}

// 解析逐條驗收結果，對齊 criteria 的順序與長度；缺漏或無效一律退回 unverifiable（永不拋錯，供保底降級）。
export function parseBossTaskAcceptanceVerdicts(text: string, criteria: string[]): BossTaskAcceptanceVerdict[] {
  const list = criteria.map((item) => bounded(item, 500)).filter(Boolean);
  const byIndex = new Map<number, { status: AcceptanceStatus; evidence: string }>();
  const match = typeof text === "string" ? text.match(/<boss_task_acceptance>\s*([\s\S]*?)\s*<\/boss_task_acceptance>/i) : null;
  if (match) {
    try {
      const raw = JSON.parse(match[1]) as { verdicts?: unknown };
      const verdicts = Array.isArray(raw?.verdicts) ? raw.verdicts : [];
      for (const entry of verdicts) {
        if (!entry || typeof entry !== "object") continue;
        const row = entry as Record<string, unknown>;
        const index = typeof row.index === "number" && Number.isFinite(row.index) ? Math.floor(row.index) : NaN;
        if (!Number.isInteger(index) || index < 1 || index > list.length) continue;
        const status: AcceptanceStatus = row.status === "met" || row.status === "unmet" ? row.status : "unverifiable";
        if (!byIndex.has(index)) byIndex.set(index, { status, evidence: bounded(row.evidence, 300) });
      }
    } catch {
      // 解析失敗：整體降級為 unverifiable。
    }
  }
  return list.map((criterion, i) => {
    const verdict = byIndex.get(i + 1);
    return { criterion, status: verdict?.status ?? "unverifiable", evidence: verdict?.evidence ?? "" };
  });
}

function acceptanceTableCell(text: string): string {
  const cleaned = text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
  return cleaned || "—";
}

// 組出報告中的「驗收核對」區塊：有逐條裁決就渲染成表格＋達成統計；無裁決但有條件則誠實標示未能自動核對。
function bossTaskAcceptanceBlock(task: BossTask, verdicts?: BossTaskAcceptanceVerdict[]): string {
  if (!task.acceptanceCriteria.length) {
    return t("- 已由各部門依任務目標完成合理驗證並回報風險。");
  }
  if (!verdicts || verdicts.length === 0) {
    const bullets = task.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n");
    return `${t("以下為原始驗收條件；本次未能自動逐條核對，請自行確認：")}\n${bullets}`;
  }
  const label: Record<AcceptanceStatus, string> = {
    met: t("✅ 達成"),
    unmet: t("❌ 未達成"),
    unverifiable: t("➖ 無法驗證"),
  };
  const met = verdicts.filter((verdict) => verdict.status === "met").length;
  const unmet = verdicts.filter((verdict) => verdict.status === "unmet").length;
  const summary = t("逐條核對驗收條件：{total} 項中 {met} 項達成、{unmet} 項未達成。", {
    total: verdicts.length,
    met,
    unmet,
  });
  const header = `| ${t("狀態")} | ${t("驗收條件")} | ${t("依據")} |\n| --- | --- | --- |`;
  const rows = verdicts
    .map((verdict) => `| ${label[verdict.status]} | ${acceptanceTableCell(verdict.criterion)} | ${acceptanceTableCell(verdict.evidence)} |`)
    .join("\n");
  return `${summary}\n\n${header}\n${rows}`;
}

export function bossTaskFinalReport(task: BossTask, verdicts?: BossTaskAcceptanceVerdict[]): string {
  const sections = task.stages.map((stage) => t("## {title} · {departmentName}\n\n{report}", {
    title: stage.title,
    departmentName: stage.departmentName,
    report: stage.report || t("部門未提供報告。"),
  }));
  const research = task.executionMode === "research" || task.stages[0]?.executionMode === "research";
  const acceptanceBlock = bossTaskAcceptanceBlock(task, verdicts);
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
