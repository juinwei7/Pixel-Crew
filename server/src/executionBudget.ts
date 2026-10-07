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

// 把 profile 的基準估算範圍，依縮放因子等比壓縮；四捨五入並保底，避免出現 0 或負值。
function scaleRange(range: { min: number; max: number }, factor: number, floor: number, decimals = 0): { min: number; max: number } {
  const round = (n: number) => {
    const scaled = n * factor;
    if (decimals > 0) {
      const p = 10 ** decimals;
      return Math.max(floor, Math.round(scaled * p) / p);
    }
    return Math.max(floor, Math.round(scaled));
  };
  return { min: round(range.min), max: round(range.max) };
}

export function executionBudgetFor(value: unknown, overrides: ExecutionBudgetOverrides = {}): ExecutionBudget {
  const budget = EXECUTION_BUDGETS[normalizeExecutionProfile(value)];
  const maxAgents = boundedInteger(overrides.maxAgents, budget.maxAgents, 1, budget.maxAgents);
  const maxStages = boundedInteger(overrides.maxStages, budget.maxStages, 1, budget.maxStages);
  const maxMissionSteps = boundedInteger(overrides.maxMissionSteps, budget.maxMissionSteps, 2, budget.maxMissionSteps);
  // 預估值隨「實際生效的旋鈕」縮放：profile 只定上限，把 stages／steps／agents 調小，預估就跟著降。
  // 三個旋鈕都維持預設時，三個比值皆為 1 → 縮放後與 profile 原表完全一致，不動既有預設。
  const breadth = (maxStages / budget.maxStages) * (maxMissionSteps / budget.maxMissionSteps);
  const agentRatio = maxAgents / budget.maxAgents;
  const turnsScale = breadth * (0.6 + 0.4 * agentRatio); // 回合數 ≈ 廣度 × 並行度
  const durationScale = breadth;                          // 牆鐘時間 ≈ 階段 × 步數（agent 並行不額外拉長工期）
  const costScale = turnsScale;                           // 花費 ≈ 回合數
  return {
    ...budget,
    maxAgents,
    maxStages,
    maxMissionSteps,
    estimatedAgentTurns: scaleRange(budget.estimatedAgentTurns, turnsScale, 1),
    estimatedDurationMinutes: scaleRange(budget.estimatedDurationMinutes, durationScale, 1),
    claudeUsd: scaleRange(budget.claudeUsd, costScale, 0.01, 2),
    codexQuota5hPercent: scaleRange(budget.codexQuota5hPercent, costScale, 1),
  };
}
