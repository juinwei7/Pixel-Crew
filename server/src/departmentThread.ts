export type DepartmentMessageIntent =
  | "question"
  | "context"
  | "mission_update"
  | "follow_up_mission"
  | "approval"
  | "decision"
  | "system";

export type DepartmentMessageRole = "owner" | "department" | "system" | "report";
export type DepartmentMessageDeliveryStatus = "pending" | "delivered" | "failed";

export type DepartmentThread = {
  id: string;
  departmentId: string;
  activeMissionId: string | null;
  summary: string;
  historyClearedAt: string | null;
  lastMessageAt: string;
  createdAt: string;
  updatedAt: string;
};

export type DepartmentMessage = {
  id: string;
  threadId: string;
  role: DepartmentMessageRole;
  intent: DepartmentMessageIntent;
  text: string;
  attachmentIds: string[];
  missionId: string | null;
  deliveryStatus: DepartmentMessageDeliveryStatus;
  clientMessageId: string | null;
  idempotencyKey: string | null;
  classification: IntentClassification | null;
  createdAt: string;
};

export type IntentClassification = {
  intent: DepartmentMessageIntent;
  confidence: number;
  reason: string;
  changeImpact: "none" | "minor" | "major";
  clarificationQuestion: string | null;
};

export type MissionLifecycleState =
  | "draft"
  | "planning"
  | "queued"
  | "running"
  | "waiting_for_clarification"
  | "paused"
  | "replanning"
  | "completed"
  | "failed"
  | "cancelled";

const TRANSITIONS: Record<MissionLifecycleState, ReadonlySet<MissionLifecycleState>> = {
  draft: new Set(["planning", "cancelled"]),
  planning: new Set(["queued", "running", "waiting_for_clarification", "failed", "cancelled"]),
  queued: new Set(["running", "paused", "cancelled"]),
  running: new Set(["waiting_for_clarification", "paused", "replanning", "completed", "failed", "cancelled"]),
  waiting_for_clarification: new Set(["planning", "running", "replanning", "cancelled"]),
  paused: new Set(["running", "replanning", "cancelled"]),
  replanning: new Set(["planning", "queued", "running", "waiting_for_clarification", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export function canTransitionMission(from: MissionLifecycleState, to: MissionLifecycleState): boolean {
  return from === to || TRANSITIONS[from].has(to);
}

export function assertMissionTransition(from: MissionLifecycleState, to: MissionLifecycleState): void {
  if (!canTransitionMission(from, to)) throw new Error(`Illegal Mission transition: ${from} -> ${to}`);
}

function text(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

const INTENTS = new Set<DepartmentMessageIntent>([
  "question", "context", "mission_update", "follow_up_mission", "approval", "decision", "system",
]);

export function parseIntentClassification(raw: string): IntentClassification | null {
  const marked = text(raw, 20_000).match(/<department_intent>\s*([\s\S]*?)\s*<\/department_intent>/i)?.[1];
  if (!marked) return null;
  try {
    const value = JSON.parse(marked) as Record<string, unknown>;
    const intent = String(value.intent ?? "") as DepartmentMessageIntent;
    if (!INTENTS.has(intent)) return null;
    const confidence = Number(value.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
    const changeImpact = value.changeImpact === "major" ? "major" : value.changeImpact === "minor" ? "minor" : "none";
    return {
      intent,
      confidence,
      reason: text(value.reason, 1_000),
      changeImpact,
      clarificationQuestion: text(value.clarificationQuestion, 1_000) || null,
    };
  } catch {
    return null;
  }
}

export function intentClassificationPrompt(input: {
  departmentName: string;
  departmentPurpose: string;
  activeMission: { id: string; objective: string; status: string } | null;
  latestCompletedMission: { id: string; objective: string } | null;
  threadSummary: string;
  recentMessages: Array<{ role: string; text: string }>;
  message: string;
  attachmentNames: string[];
}): string {
  return `你是部門訊息意圖分類器，只分類，不執行工作，也不可使用工具。
部門: ${text(input.departmentName, 200)}
部門職責: ${text(input.departmentPurpose, 1_000)}
進行中 Mission: ${JSON.stringify(input.activeMission)}
最近完成 Mission: ${JSON.stringify(input.latestCompletedMission)}
Thread 摘要: ${text(input.threadSummary, 4_000)}
最近訊息: ${text(JSON.stringify(input.recentMessages.slice(-12)), 8_000)}
附件名稱: ${JSON.stringify(input.attachmentNames.slice(0, 8))}
使用者訊息: ${text(input.message, 4_000)}

intent 必須是 question、context、mission_update、follow_up_mission、approval、decision、system 之一。
- question: 只詢問、解釋或查明現況，不要求變更成果。
- context: 對進行中工作補充背景，不改變目標。
- mission_update: 修改進行中 Mission；changeImpact 必須是 minor 或 major。
- follow_up_mission: 已完成工作後要求修改、補做或新交付。
- approval / decision: 回答系統正在等待的核准或取捨。
- 沒有進行中 Mission 且是新的工作要求時，使用 follow_up_mission。
confidence 低於 0.7 時必須提供 clarificationQuestion，不可猜測。

只回傳：
<department_intent>{"intent":"","confidence":0,"reason":"","changeImpact":"none|minor|major","clarificationQuestion":null}</department_intent>`;
}

export function boundedDepartmentContext(input: {
  threadSummary: string;
  missionSummary: string;
  recentMessages: DepartmentMessage[];
  workingContext: string;
}): string {
  return [
    `THREAD SUMMARY:\n${text(input.threadSummary, 4_000)}`,
    `MISSION SUMMARY:\n${text(input.missionSummary, 6_000)}`,
    `RECENT MESSAGES:\n${text(JSON.stringify(input.recentMessages.slice(-12).map(({ role, intent, text: message }) => ({ role, intent, text: message }))), 10_000)}`,
    `WORKING CONTEXT:\n${text(input.workingContext, 6_000)}`,
  ].join("\n\n");
}
