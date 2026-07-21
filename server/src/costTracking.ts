import type { RunnerEvent } from "./claudeRunner.js";
import type { ProviderId } from "./providers/types.js";

// Codex is billed via ChatGPT subscription quota (5h/weekly rate-limit
// windows), not per-token API pricing, so its runners always report
// costUsd: 0 — there is no dollar figure to track for that provider.
export function costMicrosForTurnEnd(
  provider: ProviderId,
  event: Extract<RunnerEvent, { type: "turn_end" }>,
): number {
  if (provider !== "claude") return 0;
  if (!Number.isFinite(event.costUsd) || event.costUsd <= 0) return 0;
  // Stored as integer micros (cost * 1e6) so the running total in
  // meta_counters (an INTEGER column) never drifts from float accumulation.
  return Math.round(event.costUsd * 1_000_000);
}
