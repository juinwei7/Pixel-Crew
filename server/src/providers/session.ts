import type { ApprovalDecision, RunnerEvent } from "../claudeRunner.js";
import type { ProviderId } from "./types.js";

export type MessageImage = {
  name: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  dataBase64: string;
};

export interface AgentSession {
  readonly provider: ProviderId;
  readonly workspacePath: string;
  busy: boolean;
  name: string;
  warmup(): void;
  send(text: string, images?: MessageImage[]): void;
  interrupt(): void;
  stop(): void;
  resolveApproval(id: string, decision: ApprovalDecision): boolean;
  handleApprovalBridge(token: string, input: unknown): Promise<unknown> | null;
  setModel(model: string | undefined): void;
  getModel(): string | undefined;
  getPersistenceState(): { sessionId: string; completedTurns: number };
}

export type EventSink = (event: RunnerEvent) => void;
