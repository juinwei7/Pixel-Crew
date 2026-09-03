import type { ApprovalDecision, RunnerEvent } from "../claudeRunner.js";
import type { ProviderId } from "./types.js";

export type MessageImage = {
  name: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  dataBase64: string;
};

export type MessageDocument = {
  name: string;
  mimeType: string;
  dataBase64: string;
};

export type ExecutionProfile = "normal" | "read_only_collaboration" | "read_only_query";
export type SendOptions = {
  executionProfile?: ExecutionProfile;
  queryAllowedTools?: string[];
};

export interface AgentSession {
  readonly provider: ProviderId;
  readonly workspacePath: string;
  busy: boolean;
  name: string;
  warmup(): void;
  reloadMcp(): Promise<"reloaded" | "deferred">;
  // Marks the composed system prompt (persona + global memory) stale.
  // Checked lazily at the start of the next send(), so a background memory
  // sync never interrupts an in-progress turn — if the worker is idle when
  // the next message arrives, its process restarts first so the fresh
  // prompt is picked up. Conversation continuity survives the restart via
  // --resume / thread/resume (stop() never touches session/thread id).
  requestPromptRefresh(): void;
  send(text: string, images?: MessageImage[], documents?: MessageDocument[], options?: SendOptions): void;
  interrupt(): void;
  stop(): void;
  resolveApproval(id: string, decision: ApprovalDecision): boolean;
  handleApprovalBridge(token: string, input: unknown): Promise<unknown> | null;
  setModel(model: string | undefined): void;
  getModel(): string | undefined;
  getPersistenceState(): { sessionId: string; completedTurns: number };
}

export type EventSink = (event: RunnerEvent) => void;
