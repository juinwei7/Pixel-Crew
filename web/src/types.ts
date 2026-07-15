import type { StationKey } from "./stations";

export type ProviderId = "claude" | "codex";
export type ApprovalDecision = "allow_once" | "allow_session" | "deny";

export type ApprovalRequest = {
  id: string;
  activityId: string | null;
  category: "command" | "file_change" | "tool" | "permissions";
  title: string;
  input: unknown;
  command?: string;
  cwd?: string;
  reason?: string;
  decisions: ApprovalDecision[];
};

export type RunnerEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string; input: unknown }
  | { type: "tool_call_output_delta"; id: string; delta: string }
  | { type: "tool_call_result"; id: string; output: unknown; isError: boolean }
  | { type: "approval_requested"; request: ApprovalRequest }
  | { type: "approval_resolved"; id: string; decision: ApprovalDecision }
  | {
      type: "turn_end";
      resultText: string;
      costUsd: number;
      durationMs: number;
      isError: boolean;
      permissionDenials: unknown[];
    }
  | {
      type: "meta";
      model: string;
      slashCommands: string[];
      mcpServers: Array<{ name: string; status: string }>;
      toolCount: number;
    }
  | { type: "user_message"; text: string }
  | { type: "error"; message: string };

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
  status: "running" | "done" | "error";
  items: TurnItem[];
  costUsd?: number;
  durationMs?: number;
};

export type CharacterActivity = "idle" | "walking" | "working" | "thinking";
export type CharacterMood = "neutral" | "success" | "error";

export type CharacterState = {
  activity: CharacterActivity;
  mood: CharacterMood;
  station: StationKey;
  speech: string;
  bump: number;
};

export type WorkerMeta = {
  model: string;
  slashCommands: string[];
  mcpServers: Array<{ name: string; status: string }>;
  toolCount: number;
};

export type SubagentState = {
  id: string;
  name: string;
  task: string;
  background: boolean;
};

export type CapabilityState = {
  slashCommands: string[];
  mcpServers: Array<{ name: string; status: string }>;
  models: Array<{ id: string; label: string; description?: string }>;
  toolCount: number | null;
  loading: boolean;
  source: "empty" | "cache" | "live";
  updatedAt: string | null;
  error: string | null;
};

export type ProviderAuthState = {
  provider: ProviderId;
  displayName: string;
  status: "checking" | "authenticated" | "unauthenticated" | "cli_missing" | "error";
  loginCommand: string;
  checkedAt: string | null;
  error: string | null;
};

export type WorkerState = {
  id: string;
  name: string;
  model: string | null;
  busy: boolean;
  colorIndex: number;
  avatarId: string | null;
  provider: ProviderId;
  workspacePath: string;
  turns: Turn[];
  character: CharacterState;
  subagents: SubagentState[];
  meta: WorkerMeta | null;
  /** Reducer bookkeeping (kept in state so snapshot replay works). */
  keyCounter: number;
  openTextKey: string | null;
  openThinkingKey: string | null;
};
