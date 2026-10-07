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

// ── 格式修復重問（交互審查 #18）───────────────────────────────────────────
// 自動循環三個決策（下一步／代答／解卡）以前一次格式抖動就把整條循環關掉，下一步那條還把它
// 標成「自動循環正常結束」。比照決策模型、顧問與個人循環：把被拒的具體原因附回去重問一次，
// 兩次都壞才算失敗，並讓呼叫端以失敗（不是正常結束）收場。

/** 三個自動循環決策區塊的標記名。 */
export type AutopilotDecisionTag = "autopilot_next" | "autopilot_answer" | "autopilot_resolve";

export function autopilotRepairPrompt(basePrompt: string, failure: string, tag: AutopilotDecisionTag): string {
  return `${basePrompt}

Your previous reply was rejected: ${failure}
Reply again with ONLY the single marked <${tag}> JSON block — no other text before or after it.`;
}

export type AutopilotDecisionOutcome<T> = { ok: true; decision: T } | { ok: false; failure: string };

/** 跑一次決策，格式壞掉就帶原因重問一次；兩次都壞回 ok:false 與最後一次的原因。
 *  模型呼叫本身丟的錯照常往外丟，由呼叫端走既有的「決策模型無法給出下一步」路徑。 */
export async function decideWithFormatRepair<T>(input: {
  prompt: string;
  tag: AutopilotDecisionTag;
  run: (prompt: string) => Promise<string>;
  parse: (text: string) => T | null;
  explain: (text: string) => string | null;
}): Promise<AutopilotDecisionOutcome<T>> {
  const first = await input.run(input.prompt);
  const decision = input.parse(first);
  if (decision) return { ok: true, decision };
  const failure = input.explain(first) ?? "The response did not match the required format.";
  const second = await input.run(autopilotRepairPrompt(input.prompt, failure, input.tag));
  const repaired = input.parse(second);
  if (repaired) return { ok: true, decision: repaired };
  return { ok: false, failure: input.explain(second) ?? failure };
}

// ── 循環觸發標記的重新武裝與讓出重播（交互審查 #19）─────────────────────────
// hook 用「已觸發」集合確保同一個終態只推進一次；但交辦回到進行中後標記沒人清，下一次終態
// 就被當成重複而略過。全域鎖讓出的觸發也只是丟掉——completed／needs_input 之後不會再有事件
// 把交辦送回 hook，開關亮著、循環卻無聲熄火。

/** 交辦回到進行中（老闆回覆、解卡、重派、追問、重新交辦）＝上一個終態已過去，觸發標記要作廢，
 *  下一次終態才進得了 hook。終態與 needs_input 不清——那正是要防重複觸發的狀態。 */
export function autopilotTriggerRearms(status: string): boolean {
  return status === "discovering" || status === "ready" || status === "running" || status === "synthesizing";
}

/** 因全域鎖被讓出的觸發：鎖一釋放就整批重播（重播時又被讓出的留給下一次釋放）。 */
export class DeferredAutopilotTriggers {
  private readonly taskIds = new Set<string>();

  defer(taskId: string): void {
    this.taskIds.add(taskId);
  }

  /** 取出目前全部待重播的交辦並清空；重播途中新讓出的會落進下一批，不會在同一輪打轉。 */
  drain(): string[] {
    const pending = [...this.taskIds];
    this.taskIds.clear();
    return pending;
  }

  get size(): number {
    return this.taskIds.size;
  }
}
