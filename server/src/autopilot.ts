// Autopilot（老闆交辦自動循環）—— 一個交辦任務做完後，讓決策模型看「已完成什麼＋
// 工作區脈絡」自己決定下一個該做的目標，自動再開一張交辦，形成循環，直到撞護欄或關掉。
//
// 這裡只放純函式：組「下一步」決策 prompt、解析模型輸出。實際的模型呼叫、狀態機與
// 護欄留在 index.ts（沿用 expertAdvisor.ts / bossTask.ts 的 determinism split，方便單測）。
import { t } from "./i18n.js";

/** 循環開關打開時，預設可連續自動執行幾步（撞到就自動停、等使用者再開）。 */
export const AUTOPILOT_DEFAULT_STEPS = 15;
/** 步數上限的合法範圍——防呆，避免有人送 0 或天文數字把護欄架空。 */
export const AUTOPILOT_MIN_STEPS = 1;
export const AUTOPILOT_MAX_STEPS = 50;

export function clampAutopilotSteps(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : AUTOPILOT_DEFAULT_STEPS;
  return Math.min(AUTOPILOT_MAX_STEPS, Math.max(AUTOPILOT_MIN_STEPS, n));
}

/** 選填的時間上限（分鐘）：沒填、非數字或 ≤0 都當「不設上限」回 null；上限 24 小時防呆。 */
export const AUTOPILOT_MAX_MINUTES = 1440;
export function clampAutopilotMinutes(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const n = Math.floor(value);
  if (n <= 0) return null;
  return Math.min(AUTOPILOT_MAX_MINUTES, n);
}

export type AutopilotDecision =
  | { action: "task"; objective: string; reason: string }
  | { action: "stop"; reason: string };

export type AutopilotHistoryEntry = {
  /** 已完成交辦的目標（原話）。 */
  objective: string;
  /** 該交辦最終報告的精簡摘要（可空）。 */
  report?: string;
};

function bounded(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

// 組「下一步該做什麼」的決策 prompt：餵近期已完成的交辦與工作區，讓模型自己找事做。
export function autopilotNextPrompt(input: {
  workspaceLabel: string;
  history: AutopilotHistoryEntry[];
  stepsRemaining: number;
}): string {
  const history = input.history.slice(-8);
  const historyBlock = history.length
    ? history
        .map((entry, index) => {
          const report = bounded(entry.report, 600);
          return t("{n}. 目標：{objective}{report}", {
            n: index + 1,
            objective: bounded(entry.objective, 500),
            report: report ? t("\n   結果：{report}", { report }) : "",
          });
        })
        .join("\n")
    : t("（尚無已完成的交辦——這是自動循環的第一步。）");

  return `Autopilot · Boss Task Self-Direction

You are the boss's chief of staff. The boss turned ON autopilot: after each Boss Task finishes, you decide the single most valuable NEXT task to assign, so the team keeps making progress without the boss. You are choosing work, not doing it — output a task brief the department pipeline will execute.

Rules:
- Do not use tools, files, shell, MCP, web, or background agents. Reason from the context below.
- Propose exactly ONE next task, or STOP.
- The next task must be genuinely worth doing now: build on what's done, close an obvious gap, harden/verify recent work, or open the next logical step — never busywork, never a near-duplicate of a completed task.
- The boss deliberately granted these autonomous steps — they want sustained progress and exploration, not an early exit. If the just-finished thread cannot continue without boss-only input (real data, credentials, on-site action), do NOT stop for that reason alone: pivot to a different genuinely valuable objective — turn existing deliverables into a more usable form (interactive, automated, verified), harden or test recent work, build supporting tooling, or open an adjacent area the completed tasks reveal.
- "objective" is a self-contained, bounded imperative brief that a department could execute as-is (like a Boss Task). Write it in Traditional Chinese unless the workspace context clearly indicates another language.
- STOP only when NO direction offers a genuinely valuable, non-speculative task: every candidate would be filler, a near-duplicate, or needs a human decision (permissions, credentials, irreversible/outward-facing actions, major trade-offs, spending).
- Be honest: do not invent progress or fabricate a goal just to keep the loop running. A good STOP beats a filler task — but a real pivot beats a lazy STOP.

Workspace: ${JSON.stringify(input.workspaceLabel)}
Autopilot steps remaining after this one: ${input.stepsRemaining}

Recently completed Boss Tasks (most recent last):
${historyBlock}

Return only one marked JSON block, no Markdown fences:
<autopilot_next>{"action":"task","objective":"self-contained imperative brief for the next task","reason":"one line: why this is the most valuable next step"}</autopilot_next>
or
<autopilot_next>{"action":"stop","reason":"one line: why stopping now is right"}</autopilot_next>`;
}

type AutopilotParse =
  | { ok: true; decision: AutopilotDecision }
  | { ok: false; reason: string };

function evaluateAutopilotDecision(text: string): AutopilotParse {
  const match = text.match(/<autopilot_next>\s*([\s\S]*?)\s*<\/autopilot_next>/i);
  if (!match) return { ok: false, reason: "Missing an <autopilot_next>...</autopilot_next> block." };
  let raw: unknown;
  try { raw = JSON.parse(match[1]); } catch (cause) {
    return { ok: false, reason: `The JSON inside <autopilot_next> did not parse: ${(cause as Error).message}.` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "The <autopilot_next> content must be a single JSON object." };
  }
  const value = raw as Record<string, unknown>;
  const reason = bounded(value.reason, 500);
  if (value.action === "stop") {
    return { ok: true, decision: { action: "stop", reason } };
  }
  if (value.action !== "task") {
    return { ok: false, reason: `"action" must be exactly "task" or "stop", got ${JSON.stringify(value.action)}.` };
  }
  const objective = bounded(value.objective, 4_000);
  // 沒有可執行目標的 "task" 一律當成 stop——寧可安全停下，也不要送一張空目標進交辦管線。
  if (!objective) return { ok: true, decision: { action: "stop", reason: reason || "No concrete next objective was produced." } };
  return { ok: true, decision: { action: "task", objective, reason } };
}

export function parseAutopilotDecision(text: string): AutopilotDecision | null {
  const result = evaluateAutopilotDecision(text);
  return result.ok ? result.decision : null;
}

export function explainAutopilotFailure(text: string): string | null {
  const result = evaluateAutopilotDecision(text);
  return result.ok ? null : result.reason;
}
