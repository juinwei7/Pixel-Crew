import type { ProviderId } from "./types";

export type WorkflowTarget = {
  id: string;
  name: string;
  provider: ProviderId;
  workspacePath: string;
  busy: boolean;
};

export type WorkflowRevisions = Record<ProviderId, number>;

export function compatibleWorkflowTargets(
  workers: WorkflowTarget[],
  provider: ProviderId,
  workspacePath: string,
): WorkflowTarget[] {
  return workers.filter((worker) => (
    worker.provider === provider && worker.workspacePath === workspacePath && !worker.busy
  ));
}

export function workflowInvocation(provider: ProviderId, name: string, input: string): string {
  const prefix = provider === "claude" ? "/" : "$";
  const suffix = input.trim();
  return `${prefix}${name}${suffix ? ` ${suffix}` : ""}`;
}
