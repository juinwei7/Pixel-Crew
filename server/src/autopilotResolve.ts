// Autopilot 自動接手（auto-resolve）—— 自動循環開啟且勾了「卡住時自動接手」時，
// 交辦底下的部門 Mission 進入 needs_attention（如 Review 無法確認通過），先讓決策模型
// 讀中斷脈絡選一個處理動作（重試／帶指示重跑／接受風險），解不了或需要人類決策就 wait
// 停下等老闆。這裡只放純函式：組 prompt、解析輸出；模型呼叫、次數護欄與實際解卡
// 留在 index.ts（沿用 autopilot.ts 的 determinism split，方便單測）。
import { t } from "./i18n.js";

/** 同一張交辦最多自動接手幾次——超過就代表這個卡點不是指示能解的，停下等人。 */
export const AUTOPILOT_RESOLVE_MAX_ATTEMPTS = 2;

export type AutopilotResolveDecision =
  | { action: "retry" | "retry_execute" | "accept_risk"; guidance: string }
  | { action: "wait"; reason: string };

function bounded(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function autopilotResolvePrompt(input: {
  objective: string;
  stageTitle: string;
  departmentName: string;
  attentionReason: string;
  missionError: string;
  stepTitle: string;
  stepKind: string;
  reviewSummary: string;
  attemptNumber: number;
  maxAttempts: number;
}): string {
  return `Autopilot · Blocked Mission Auto-Resolution

You are the boss's chief of staff. Autopilot is ON with auto-resume enabled: a department mission has stalled and the boss is away. Decide exactly ONE resolution action, or wait for the boss.

Rules:
- Do not use tools, files, shell, MCP, web, or background agents. Reason only from the context below.
- NEVER fabricate data, credentials, or approvals. If the block fundamentally needs something only the boss can provide — a real dataset or file, credentials, permissions, an irreversible or outward-facing decision, spending approval — choose "wait".
- "retry_execute": the blocker can be fixed by redoing the current work step with a concrete, bounded instruction. Put that instruction in "guidance" (Traditional Chinese, imperative, self-contained). Good examples: descope to what is achievable with the inputs that actually exist and close out honestly; fix the specific defect the review identified; produce a missing report artifact from existing results.
- "accept_risk": only when the review shows the work itself is sound and the residual risk is explicitly acceptable for an internal deliverable. State in "guidance" exactly which residual risk is being accepted and why. If the review is inconclusive because required inputs are missing, prefer "wait" or a descoping "retry_execute" — accepting risk cannot conjure missing inputs.
- "retry": only for transient-looking failures (assignee busy, provider hiccup, timeout) where the same step may simply succeed unchanged.
- This is auto-resolution attempt ${input.attemptNumber} of ${input.maxAttempts} for this task. If the context suggests a similar instruction was already tried, do not repeat it — choose "wait".
- Be honest: a good "wait" beats a speculative unblock that burns the team's budget.

Boss Task objective: ${JSON.stringify(bounded(input.objective, 2_000))}
Blocked stage: ${JSON.stringify(bounded(input.stageTitle, 200))} at department ${JSON.stringify(bounded(input.departmentName, 200))}
Stalled step: ${JSON.stringify(bounded(input.stepTitle, 200))} (kind: ${JSON.stringify(bounded(input.stepKind, 40))})
Attention reason: ${JSON.stringify(bounded(input.attentionReason, 200))}
Mission error: ${JSON.stringify(bounded(input.missionError, 1_000))}
Latest review result (may be empty): ${JSON.stringify(bounded(input.reviewSummary, 4_000))}

Return only one marked JSON block, no Markdown fences:
<autopilot_resolve>{"action":"retry_execute","guidance":"concrete bounded instruction"}</autopilot_resolve>
or <autopilot_resolve>{"action":"accept_risk","guidance":"which residual risk is accepted and why"}</autopilot_resolve>
or <autopilot_resolve>{"action":"retry"}</autopilot_resolve>
or <autopilot_resolve>{"action":"wait","reason":"one line: why the boss must decide"}</autopilot_resolve>`;
}

// ---- needs_input 代答 --------------------------------------------------------
// 決策模型在 discovery 階段問老闆 clarification（needs_input）時，自動接手模式下先讓
// 決策模型以「幕僚長」身分代答：能用安全、有界的假設回答就回答（例如問題本身給了
// 「先出範本版」的退路就選它）；真的需要老闆本人的東西（實體資料、憑證、不可逆或
// 花錢的決定）就 wait 停下等人。

export type AutopilotAnswerDecision =
  | { action: "answer"; reply: string }
  | { action: "wait"; reason: string };

export function autopilotAnswerPrompt(input: {
  objective: string;
  question: string;
  conversation: Array<{ role: string; text: string }>;
  attemptNumber: number;
  maxAttempts: number;
}): string {
  const conversation = input.conversation.slice(-8).map((message) => ({
    role: message.role,
    text: bounded(message.text, 1_000),
  }));
  return `Autopilot · Clarification Auto-Answer

You are the boss's chief of staff. Autopilot is ON with auto-resume enabled: the decision model asked the boss a clarification question, but the boss is away. Answer on the boss's behalf with the safest bounded assumption that keeps work moving, or wait for the boss.

Rules:
- Do not use tools, files, shell, MCP, web, or background agents. Reason only from the context below.
- NEVER fabricate facts only the boss can know: real data files or their contents, credentials, personal/medical/financial specifics, budgets. Do not approve spending or irreversible/outward-facing actions.
- If the question itself offers a self-serve fallback (e.g. "should we produce a fill-in template version first?"), choose that fallback — that is exactly what auto-resume is for.
- Prefer descoping to what is achievable now over waiting, as long as the result stays honest and useful; state the assumption explicitly in the reply.
- "reply" is written as the boss's answer (Traditional Chinese, concise, imperative), and should mention it is an auto-resume answer the boss can override later.
- This is auto-answer attempt ${input.attemptNumber} of ${input.maxAttempts} for this task. If the conversation shows a similar auto-answer was already given, choose "wait".
- Be honest: a good "wait" beats a speculative answer that sends the team the wrong way.

Boss Task objective: ${JSON.stringify(bounded(input.objective, 2_000))}
Pending question from the decision model: ${JSON.stringify(bounded(input.question, 2_000))}
Recent discovery conversation: ${JSON.stringify(conversation)}

Return only one marked JSON block, no Markdown fences:
<autopilot_answer>{"action":"answer","reply":"the boss-voice answer"}</autopilot_answer>
or <autopilot_answer>{"action":"wait","reason":"one line: why the boss must answer this personally"}</autopilot_answer>`;
}

type AutopilotAnswerParse =
  | { ok: true; decision: AutopilotAnswerDecision }
  | { ok: false; reason: string };

function evaluateAutopilotAnswerDecision(text: string): AutopilotAnswerParse {
  const match = text.match(/<autopilot_answer>\s*([\s\S]*?)\s*<\/autopilot_answer>/i);
  if (!match) return { ok: false, reason: "Missing an <autopilot_answer>...</autopilot_answer> block." };
  let raw: unknown;
  try { raw = JSON.parse(match[1]); } catch (cause) {
    return { ok: false, reason: `The JSON inside <autopilot_answer> did not parse: ${(cause as Error).message}.` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "The <autopilot_answer> content must be a single JSON object." };
  }
  const value = raw as Record<string, unknown>;
  const reply = bounded(value.reply, 4_000);
  const reason = bounded(value.reason, 500);
  if (value.action === "wait") return { ok: true, decision: { action: "wait", reason } };
  if (value.action === "answer") {
    // 空回答一律降級成 wait：寧可停下等人，也不要送一句空話進 discovery 對話。
    if (!reply) return { ok: true, decision: { action: "wait", reason: t("決策模型未提供具體代答內容") } };
    return { ok: true, decision: { action: "answer", reply } };
  }
  return { ok: false, reason: `"action" must be exactly "answer" or "wait", got ${JSON.stringify(value.action)}.` };
}

export function parseAutopilotAnswerDecision(text: string): AutopilotAnswerDecision | null {
  const result = evaluateAutopilotAnswerDecision(text);
  return result.ok ? result.decision : null;
}

export function explainAutopilotAnswerFailure(text: string): string | null {
  const result = evaluateAutopilotAnswerDecision(text);
  return result.ok ? null : result.reason;
}

type AutopilotResolveParse =
  | { ok: true; decision: AutopilotResolveDecision }
  | { ok: false; reason: string };

function evaluateAutopilotResolveDecision(text: string): AutopilotResolveParse {
  const match = text.match(/<autopilot_resolve>\s*([\s\S]*?)\s*<\/autopilot_resolve>/i);
  if (!match) return { ok: false, reason: "Missing an <autopilot_resolve>...</autopilot_resolve> block." };
  let raw: unknown;
  try { raw = JSON.parse(match[1]); } catch (cause) {
    return { ok: false, reason: `The JSON inside <autopilot_resolve> did not parse: ${(cause as Error).message}.` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "The <autopilot_resolve> content must be a single JSON object." };
  }
  const value = raw as Record<string, unknown>;
  // guidance 上限對齊 /api/missions/:id/resolve 的 collaborationText(…, 2_000)。
  const guidance = bounded(value.guidance, 2_000);
  const reason = bounded(value.reason, 500);
  if (value.action === "wait") return { ok: true, decision: { action: "wait", reason } };
  if (value.action === "retry") return { ok: true, decision: { action: "retry", guidance: "" } };
  if (value.action === "retry_execute" || value.action === "accept_risk") {
    // 沒有具體指示的重跑／沒有寫明風險的放行，一律降級成 wait——寧可停下等人，
    // 也不要盲目重跑燒預算或無聲吞掉風險。
    if (!guidance) return { ok: true, decision: { action: "wait", reason: t("決策模型未提供具體處理指示") } };
    return { ok: true, decision: { action: value.action, guidance } };
  }
  return { ok: false, reason: `"action" must be exactly "retry", "retry_execute", "accept_risk", or "wait", got ${JSON.stringify(value.action)}.` };
}

export function parseAutopilotResolveDecision(text: string): AutopilotResolveDecision | null {
  const result = evaluateAutopilotResolveDecision(text);
  return result.ok ? result.decision : null;
}

export function explainAutopilotResolveFailure(text: string): string | null {
  const result = evaluateAutopilotResolveDecision(text);
  return result.ok ? null : result.reason;
}
