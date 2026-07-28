export type AssignmentDecisionMember = {
  workerId: string;
  name: string;
  role: string | null;
  instructions: string | null;
  provider: "claude" | "codex";
};

export type AssignmentDecisionCandidate = {
  departmentId: string;
  departmentName: string;
  workspacePath: string;
  leadWorkerId: string;
  purpose: string;
  members: AssignmentDecisionMember[];
};

export type AssignmentDecision = {
  departmentId: string;
  confidence: number;
  reasons: string[];
  clarificationQuestion: string | null;
};

export type AssignmentClarification = {
  question: string;
  answer: string;
};

function bounded(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function normalizeAssignmentClarifications(value: unknown): AssignmentClarification[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    const question = bounded(item.question, 1_000);
    const answer = bounded(item.answer, 2_000);
    return question && answer ? [{ question, answer }] : [];
  });
}

export function assignmentDecisionPrompt(input: {
  objective: string;
  acceptanceCriteria: string[];
  preferredWorkspace: string | null;
  candidates: AssignmentDecisionCandidate[];
  clarifications?: AssignmentClarification[];
}): string {
  const catalog = input.candidates.map((candidate) => ({
    departmentId: candidate.departmentId,
    name: candidate.departmentName,
    purpose: candidate.purpose,
    workspacePath: candidate.workspacePath,
    leadWorkerId: candidate.leadWorkerId,
    members: candidate.members.map((member) => ({
      workerId: member.workerId,
      name: member.name,
      position: member.role,
      specialty: member.instructions,
      provider: member.provider,
    })),
  }));
  return `Boss Assignment · Department Decision

You are the Boss's routing decision-maker. Analyze meaning, ownership, dependencies, and the positions available in each department. Select exactly one lead department from the supplied catalog.

Rules:
- Do not use tools, shell commands, files, MCP, web access, or background agents.
- Do not invent department or worker identifiers.
- Department purpose and NPC position matter more than shared words.
- The preferred workspace is a preference, not permission to choose an unsuitable department.
- Treat the Boss's clarification answers as authoritative context and do not repeat an answered question.
- Use confidence below 0.70 and ask one concise clarification question when the objective is genuinely ambiguous.
- Return only the marked JSON block. No Markdown fences.

Objective: ${JSON.stringify(bounded(input.objective, 4_000))}
Acceptance criteria: ${JSON.stringify(input.acceptanceCriteria.slice(0, 8).map((item) => bounded(item, 500)))}
Clarification transcript: ${JSON.stringify((input.clarifications ?? []).slice(0, 3))}
Preferred workspace: ${JSON.stringify(input.preferredWorkspace)}
Eligible department catalog: ${JSON.stringify(catalog)}

<assignment_decision>
{"departmentId":"an exact catalog id","confidence":0.0,"reasons":["semantic reason","position reason"],"clarificationQuestion":null}
</assignment_decision>`;
}

export function parseAssignmentDecision(
  text: string,
  candidates: AssignmentDecisionCandidate[],
): AssignmentDecision | null {
  const match = text.match(/<assignment_decision>\s*([\s\S]*?)\s*<\/assignment_decision>/i);
  if (!match) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const departmentId = bounded(value.departmentId, 200);
  if (!candidates.some((candidate) => candidate.departmentId === departmentId)) return null;
  const confidence = typeof value.confidence === "number" && Number.isFinite(value.confidence)
    ? Math.max(0, Math.min(1, value.confidence))
    : NaN;
  if (!Number.isFinite(confidence)) return null;
  const reasons = Array.isArray(value.reasons)
    ? value.reasons.map((reason) => bounded(reason, 500)).filter(Boolean).slice(0, 5)
    : [];
  if (reasons.length === 0) return null;
  const clarificationQuestion = value.clarificationQuestion == null
    ? null
    : bounded(value.clarificationQuestion, 1_000) || null;
  return { departmentId, confidence, reasons, clarificationQuestion };
}
