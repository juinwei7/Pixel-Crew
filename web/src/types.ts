import type { StationKey } from "./stations";

export type ProviderId = "claude" | "codex";

export type McpLoginResult = {
  provider: ProviderId;
  workspacePath: string;
  name: string;
  ok: boolean;
  status: "succeeded" | "failed" | "timeout" | "cancelled";
  message: string | null;
};

// 跨線協定型別的唯一權威在 server/src/protocol.ts —— 這裡只做 type-only
// re-export（Vite 編譯時擦除，零 runtime 依賴），不要再手抄一份。
import type {
  ApprovalDecision,
  ApprovalRequest,
  AutoApproveMode,
  McpScope,
  McpServerState,
  McpToolInfo,
  McpTransport,
  RunnerEvent,
} from "../../server/src/protocol";

export type {
  ApprovalDecision,
  ApprovalRequest,
  AutoApproveMode,
  McpScope,
  McpServerState,
  McpToolInfo,
  McpTransport,
  RunnerEvent,
};

export type MessageImagePayload = {
  name: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  dataBase64: string;
};

export type MessageDocumentPayload = {
  name: string;
  mimeType: string;
  dataBase64: string;
};

export type CommandSubmission = {
  text: string;
  images: MessageImagePayload[];
  documents: MessageDocumentPayload[];
  clientMessageId?: string;
  idempotencyKey?: string;
};

export type ToolCallItem = {
  kind: "tool_call";
  key: string;
  id: string;
  name: string;
  input: unknown;
  output?: unknown;
  isError: boolean;
  status: "running" | "done";
};

export type TextItem = {
  kind: "assistant_text" | "thinking" | "system_error";
  key: string;
  text: string;
};

export type ApprovalItem = {
  kind: "approval";
  key: string;
  request: ApprovalRequest;
  status: "pending" | "resolved";
  decision?: ApprovalDecision;
};

export type TurnItem = ToolCallItem | TextItem | ApprovalItem;

export type Turn = {
  key: string;
  command: string;
  departmentFollowUpMissionId?: string;
  status: "running" | "done" | "error";
  items: TurnItem[];
  costUsd?: number;
  durationMs?: number;
  contextTokens?: number;
};

export type UpdateInfo = {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  checkedAt: string | null;
};

export type CharacterActivity = "idle" | "walking" | "working" | "thinking";
export type CharacterMood = "neutral" | "success" | "error";

export type CharacterState = {
  activity: CharacterActivity;
  mood: CharacterMood;
  station: StationKey;
  speech: string;
  speechAt?: number; // speech 對應事件的 server 時間戳（epoch ms）；重整重播也保留真實時間
  webQuery?: string; // 上網查時的查詢字/網址＝工作小窗抓真實瀏覽器截圖用
  bump: number;
};

export type WorkerMeta = {
  model: string;
  slashCommands: string[];
  mcpServers: McpServerState[];
  toolCount: number;
  builtinTools: string[];
};

export type SubagentState = {
  id: string;
  name: string;
  task: string;
  background: boolean;
};

export type { CapabilityState } from "../../server/src/protocol";

export type ProviderAuthState = {
  provider: ProviderId;
  displayName: string;
  status: "checking" | "authenticated" | "unauthenticated" | "cli_missing" | "error";
  loginCommand: string;
  checkedAt: string | null;
  error: string | null;
  debug: string | null;
};

// A named Codex or Claude account — the provider-agnostic 帳號管理 subsystem.
// Codex accounts support an "api-key" login mode; Claude accounts are
// browser-OAuth-only and pass through the "awaiting_code" status while
// waiting for the owner to paste back the verification code.
export type ProviderAccount = {
  id: string;
  provider: ProviderId;
  label: string;
  homeDir: string;
  createdAt: string;
  updatedAt: string;
};

export type AccountWithAuth = ProviderAccount & { auth: ProviderAuthState | null };

export type CodexAccountLoginMode = "oauth" | "api-key";

export type AccountLoginState = {
  accountId: string;
  status: "running" | "awaiting_code" | "succeeded" | "failed" | "timeout" | "cancelled";
  startedAt: string;
  finishedAt: string | null;
  message: string | null;
  // Fallback OAuth URL, in case the CLI's own browser auto-open didn't
  // actually open anything — lets the owner click through without ever
  // touching a terminal.
  loginUrl: string | null;
};

// Claude's default (no-account) login. Two-phase unlike Codex's: after the
// owner authorizes in the browser, `claude auth login` waits for a code to be
// pasted back — "awaiting_code" is when the UI should show that input.
export type ClaudeLoginState = {
  accountId: string;
  status: "running" | "awaiting_code" | "succeeded" | "failed" | "timeout" | "cancelled";
  startedAt: string;
  finishedAt: string | null;
  message: string | null;
  loginUrl: string | null;
};

export type ProviderInstallState = {
  provider: ProviderId;
  status: "idle" | "running" | "succeeded" | "failed";
  phase: string;
  command: string;
  sourceUrl: string;
  startedAt: string | null;
  finishedAt: string | null;
  output: string;
  error: string | null;
};

export type UsageWindow = {
  id: string;
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
  scope: "session" | "weekly" | "model" | "rate";
};

export type ProviderUsageState = {
  provider: ProviderId;
  windows: UsageWindow[];
  loading: boolean;
  source: "empty" | "cache" | "live";
  updatedAt: string | null;
  error: string | null;
};

export type HandoffProgress = {
  id: string;
  fromProvider: ProviderId;
  toProvider: ProviderId;
  toModel: string | null;
  stage: "checking" | "summarizing" | "fallback" | "bootstrapping" | "completed" | "failed";
  message: string;
  source: "agent" | "local_fallback" | null;
  error: string | null;
};

export type PreparedHandoff = {
  handoffToken: string;
  fromProvider: ProviderId;
  toProvider: ProviderId;
  toModel: string | null;
  usage: ProviderUsageState;
  hasHistory: boolean;
  warnings: string[];
};

export type CollaborationMode = "consult" | "review";
export type CollaborationStatus = "queued" | "running" | "returning" | "completed" | "failed" | "cancelled";
export type CollaborationFinding = {
  severity: "blocking" | "warning" | "suggestion";
  title: string;
  detail: string;
  file?: string;
  line?: number;
  evidence?: string;
};
export type CollaborationResult = {
  verdict: "pass" | "changes_requested" | "advice" | "inconclusive";
  summary: string;
  findings: CollaborationFinding[];
  risks: string[];
  openQuestions: string[];
  recommendedNextAction: string;
  structured: boolean;
};
export type CollaborationTask = {
  id: string;
  sourceWorkerId: string;
  targetWorkerId: string;
  workspacePath: string;
  mode: CollaborationMode;
  objective: string;
  acceptanceCriteria: string[];
  status: CollaborationStatus;
  result: CollaborationResult | null;
  continuationResult: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  adoptedAt: string | null;
  handledAt: string | null;
};
export type PreparedCollaboration = {
  collaborationToken: string;
  mode: CollaborationMode;
  objective: string;
  acceptanceCriteria: string[];
  usage: ProviderUsageState;
  warnings: string[];
};

export type DepartmentMissionStatus = "planning" | "executing" | "reviewing" | "needs_attention" | "completed" | "failed" | "cancelled";
export type DepartmentMissionStep = {
  id: string;
  title: string;
  objective: string;
  kind: "execute" | "review" | "consult" | "synthesize";
  assigneeWorkerId: string;
  acceptanceCriteria: string[];
  attachmentIds?: string[];
  status: "pending" | "running" | "completed" | "failed";
  attempt: number;
  result: string | null;
  reviewResult: CollaborationResult | null;
  startedAt: string | null;
  completedAt: string | null;
  formatRepairCount?: number;
};
export type MissionDelegatedSession = {
  workerId: string;
  provider: ProviderId;
  model: string | null;
  sessionId: string;
  completedTurns: number;
};
export type MissionExecutionEvent = {
  workerId: string;
  stepId: string | null;
  event: RunnerEvent;
};
export type DepartmentMission = {
  id: string;
  departmentId?: string | null;
  workspacePath: string;
  bossWorkerId: string;
  objective: string;
  acceptanceCriteria: string[];
  attachmentIds?: string[];
  parentMissionId?: string | null;
  sourceMessageId?: string | null;
  executionMode?: "research" | "project";
  origin?: "department" | "boss";
  status: DepartmentMissionStatus;
  planSummary: string | null;
  steps: DepartmentMissionStep[];
  currentStepIndex: number | null;
  correctionCount: number;
  maxCorrections: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  attentionReason?: "plan_approval" | "review_inconclusive" | "correction_limit" | "step_failed" | "member_unavailable" | null;
  planApprovedAt?: string | null;
  ownerGuidance?: string | null;
  formatRepairCount?: number;
  delegatedSessions?: MissionDelegatedSession[];
  executionEvents?: MissionExecutionEvent[];
};
export type PreparedMission = {
  missionToken: string;
  objective: string;
  acceptanceCriteria: string[];
  maxCorrections: number;
  members: Array<{ id: string; name: string; provider: ProviderId; workspacePath: string }>;
  warnings: string[];
};
export type BossAssignmentRoute = {
  departmentId: string;
  departmentName: string;
  workspacePath: string;
  leadWorkerId: string;
  confidence: number;
  reasons: string[];
  decisionProvider: ProviderId;
  decisionModel: string;
};
export type BossAssignmentResult = {
  route: BossAssignmentRoute;
  mission: DepartmentMission;
};

export type BossAssignmentClarification = {
  clarification: {
    question: string;
    confidence: number;
    reasons: string[];
  };
};

export type BossAssignmentResponse = BossAssignmentResult | BossAssignmentClarification;

export type BossTaskMessage = {
  id: string;
  role: "boss" | "decision_model" | "system" | "report";
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
  executionMode?: "research" | "project";
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
  status: "discovering" | "ready" | "running" | "needs_input" | "needs_attention" | "synthesizing" | "completed" | "failed" | "cancelled";
  executionMode?: "research" | "project";
  messages: BossTaskMessage[];
  stages: BossTaskStage[];
  finalReport: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type Persona = {
  role: string;
  instructions: string;
};

export type Department = {
  id: string;
  name: string;
  purpose: string;
  workspacePath: string;
  leadWorkerId: string;
  memberWorkerIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type DepartmentMessageIntent = "question" | "context" | "mission_update" | "follow_up_mission" | "approval" | "decision" | "system";
export type DepartmentMessage = {
  id: string;
  threadId: string;
  role: "owner" | "department" | "system" | "report";
  intent: DepartmentMessageIntent;
  text: string;
  attachmentIds: string[];
  missionId: string | null;
  deliveryStatus: "pending" | "delivered" | "failed";
  clientMessageId: string | null;
  idempotencyKey: string | null;
  classification: {
    intent: DepartmentMessageIntent;
    confidence: number;
    reason: string;
    changeImpact: "none" | "minor" | "major";
    clarificationQuestion: string | null;
  } | null;
  createdAt: string;
};
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
export type DepartmentAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: "image" | "document";
  createdAt: string;
};
export type DepartmentThreadPayload = {
  thread: DepartmentThread;
  messages: DepartmentMessage[];
  attachments: DepartmentAttachment[];
  missions?: DepartmentMission[];
};

export type PersonaTemplate = Persona & {
  id: string;
  name: string;
};

export type WorkerState = {
  id: string;
  name: string;
  model: string | null;
  busy: boolean;
  colorIndex: number;
  avatarId: string | null;
  avatarKind: "preset" | "custom";
  avatarPresetId: string;
  provider: ProviderId;
  workspacePath: string;
  departmentId?: string | null;
  // null = shared/global default login for this worker's provider.
  accountId?: string | null;
  persona: Persona | null;
  autoApproveMode: AutoApproveMode;
  handoff: HandoffProgress | null;
  turns: Turn[];
  character: CharacterState;
  subagents: SubagentState[];
  meta: WorkerMeta | null;
  /** Reducer bookkeeping (kept in state so snapshot replay works). */
  keyCounter: number;
  openTextKey: string | null;
  openThinkingKey: string | null;
};
