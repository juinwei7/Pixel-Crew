/** A bounded, deliberately approximate preflight for multi-agent Boss work. */
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

export type ExecutionBudgetOverrides = Partial<Pick<ExecutionBudget, "maxAgents" | "maxStages" | "maxMissionSteps">>;

const EXECUTION_BUDGETS: Record<ExecutionProfile, ExecutionBudget> = {
  quick: {
    profile: "quick", label: "快速", maxAgents: 2, maxStages: 1, maxMissionSteps: 2,
    estimatedAgentTurns: { min: 2, max: 5 }, estimatedDurationMinutes: { min: 2, max: 10 },
    claudeUsd: { min: 0.02, max: 0.15 }, codexQuota5hPercent: { min: 1, max: 4 },
  },
  standard: {
    profile: "standard", label: "標準", maxAgents: 4, maxStages: 3, maxMissionSteps: 3,
    estimatedAgentTurns: { min: 6, max: 16 }, estimatedDurationMinutes: { min: 10, max: 35 },
    claudeUsd: { min: 0.1, max: 0.7 }, codexQuota5hPercent: { min: 4, max: 12 },
  },
  deep: {
    profile: "deep", label: "深度", maxAgents: 6, maxStages: 5, maxMissionSteps: 4,
    estimatedAgentTurns: { min: 16, max: 36 }, estimatedDurationMinutes: { min: 30, max: 90 },
    claudeUsd: { min: 0.4, max: 2 }, codexQuota5hPercent: { min: 12, max: 30 },
  },
};

export function normalizeExecutionProfile(value: unknown): ExecutionProfile {
  return value === "quick" || value === "deep" ? value : "standard";
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

export function executionBudgetFor(value: unknown, overrides: ExecutionBudgetOverrides = {}): ExecutionBudget {
  const budget = EXECUTION_BUDGETS[normalizeExecutionProfile(value)];
  return {
    ...budget,
    maxAgents: boundedInteger(overrides.maxAgents, budget.maxAgents, 1, budget.maxAgents),
    maxStages: boundedInteger(overrides.maxStages, budget.maxStages, 1, budget.maxStages),
    maxMissionSteps: boundedInteger(overrides.maxMissionSteps, budget.maxMissionSteps, 2, budget.maxMissionSteps),
    estimatedAgentTurns: { ...budget.estimatedAgentTurns },
    estimatedDurationMinutes: { ...budget.estimatedDurationMinutes },
    claudeUsd: { ...budget.claudeUsd },
    codexQuota5hPercent: { ...budget.codexQuota5hPercent },
  };
}
