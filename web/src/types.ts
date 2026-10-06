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

export type GlobalMemoryNoteDto = {
  id: string;
  note: string;
  sourceWorkerId: string | null;
  sourceWorkerName: string | null;
  createdAt: string;
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
  // 自動循環停下來要 owner 拍板的「循環問你」通知回合：autopilotAsk 讓日誌渲染醒目問題卡，
  // askOptions 是從停止理由抽出的 A/B/C／甲乙丙丁 一鍵回答選項（可能為空＝只有敘述沒有選項）。
  autopilotAsk?: boolean;
  askOptions?: string[];
  // 跨 NPC 檢視（全部搜尋）才會帶：這筆回合屬於哪位 NPC。一鍵回答要發回「發問的那位」而不是
  // 當前選取的 NPC，否則在全部搜尋裡回答會誤送到別人。單一 NPC 日誌裡不帶＝沿用當前 NPC。
  workerId?: string;
  // system:true＝系統自動產生的訊息（換腦冷卻／蒸餾心法／換腦完成等），不是真工作活動。
  // 注意：日誌 feed 「不」據此隱藏回合——換腦接手回合雖標 system，卻承載接手後的真實工作，藏掉會讓
  // 換腦後主窗空白。防止換腦卡把真實結果擠出「保留最近」視窗的工作在 server 端（snapshotHistory 的
  // real-turn floor：裁切初始 snapshot 時換腦系統卡不佔真實結果名額）。此旗標前端僅供標示/排序之用。
  system?: boolean;
};

export type UpdateInfo = {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  oneClickAvailable: boolean;
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
  /** 這次 bump 是哪一層的結束：tool＝單一工具呼叫回來；turn＝整個回合結束（含 error）。場景據此分層慶祝。 */
  outcome?: "tool" | "turn";
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
  /** 開出來的時間（事件 at）；背景子代理跨回合留座，靠它設上限防殘影。 */
  startedAt?: number;
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

export type ExecutionProfile = "quick" | "standard" | "deep";
export type ExecutionBudget = {
  profile: ExecutionProfile;
  label: string;
  maxAgents: number;
  maxStages: number;
  maxMissionSteps: number;
  estimatedAgentTurns: { min: number; max: number };
  estimatedDurationMinutes: { min: number; max: number };
  claudeUsd: { min: number; max: number };
  codexQuota5hPercent: { min: number; max: number };
};

// 專家顧問：把一個粗略念頭展開成「你可能沒想到」的專業方向；挑一個直接接 Boss Task。
export type AdvisorProposal = {
  id: string;
  title: string;
  summary: string;
  insight: string;
  approach: string;
  considerations: string[];
  objective: string;
};

export type AdvisorResult =
  | { status: "proposals"; domain: string; proposals: AdvisorProposal[] }
  | { status: "need_focus"; question: string };

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
  executionProfile?: ExecutionProfile;
  executionBudget?: ExecutionBudget;
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

// 跨裝置排隊佇列的一筆（server 為單一真相；手機/電腦共用、背景也會被 server drain）。
export type QueuedCommandDto = {
  id: string;
  workerId: string;
  message: string;
  images: unknown[];
  documents: unknown[];
  createdAt: string;
};

export type WorkerState = {
  id: string;
  name: string;
  model: string | null;
  busy: boolean;
  /** server 端排隊佇列（不再存瀏覽器；由 snapshot 與 queue_updated 廣播帶入）。 */
  queue: QueuedCommandDto[];
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
  resumeCandidate?: { workerId: string; taskText: string; sessionId: string; interruptedAt: string; resetAt: string | null } | null;
  /** 編排器建立、跑完就消失的短命 NPC（作戰室成員、研究員、老闆交辦專屬部門）。
      場景據此把作戰室成員拉到會議桌圍坐、把 "dedicated"（老闆交辦臨時部門）圈進
      自己的獨立房間。以前是比對名字的 emoji 字首，現在由 server 明講。 */
  ephemeralKind?: "warroom" | "research" | "dedicated" | null;
  /** 個人自動循環：有值＝開著（server 端 workerAutopilot），null/undefined＝關。 */
  autopilot?: { stepsRemaining: number; deadlineAt: number | null; proactive?: boolean } | null;
  turns: Turn[];
  character: CharacterState;
  subagents: SubagentState[];
  meta: WorkerMeta | null;
  /** Reducer bookkeeping (kept in state so snapshot replay works). */
  keyCounter: number;
  openTextKey: string | null;
  openThinkingKey: string | null;
};
