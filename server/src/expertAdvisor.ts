// Expert Advisor（專家顧問）—— Boss Task 之前的「補你知識缺口」前段。
//
// 使用者常常「有個頭、沒方向、不知怎麼往下走」。這個模組讓一個扮演資深領域顧問的
// 決策模型，把使用者一個粗略念頭，展開成幾個「以他自身專業不一定知道」的專業方向：
// 每個方向附上內行人才會提的洞見、實作路數、關鍵考量，以及一段可直接餵進既有 Boss
// Task 執行的 objective。使用者只需要「挑一個方向」，剩下交給 Boss Task 那條龍。
//
// 這裡只放「純函式」：組 prompt、解析模型輸出。實際的模型呼叫（runDetachedTurn）與
// 路由留在 index.ts——沿用 bossTask.ts 同樣的 determinism split，方便單元測試釘死。
import { t } from "./i18n.js";

export type AdvisorProposal = {
  id: string;
  /** 方向的短名。 */
  title: string;
  /** 白話說明這個方向是什麼——給非專業的使用者看得懂。 */
  summary: string;
  /** 內行人才知道、使用者八成沒想到的洞見（本模組的核心價值）。 */
  insight: string;
  /** 專業上實際會怎麼做——路數、主流工具/方法。 */
  approach: string;
  /** 使用者自己想不到的關鍵考量或風險。 */
  considerations: string[];
  /** 若使用者選這個方向，可直接餵進 Boss Task 的 objective（祈使句、可執行）。 */
  objective: string;
};

export type AdvisorResult =
  | { status: "proposals"; domain: string; proposals: AdvisorProposal[] }
  | { status: "need_focus"; question: string };

export const ADVISOR_MAX_PROPOSALS = 4;
const ADVISOR_PROPOSAL_HARD_MAX = 6;

function bounded(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function clampProposalCount(max: number | undefined): number {
  const n = Number.isFinite(max) ? Math.floor(max as number) : ADVISOR_MAX_PROPOSALS;
  return Math.min(ADVISOR_PROPOSAL_HARD_MAX, Math.max(1, n));
}

// 主動建議的「探索視角」清單：每次隨機挑一個注入 prompt，逼模型每回從不同角度切入，
// 避免多次生成一直吐同一批明顯方向（使用者反映重複性高）。由 index.ts 隨機挑選傳入。
export const ADVISOR_VARIETY_LENSES = [
  "未被滿足的利基需求（小眾但痛的問題）",
  "把兩個不相干領域結合的跨界機會",
  "用自動化／AI 省下大量重複人力的環節",
  "新工具或新平台剛出現的紅利期切入點",
  "現有做法的反直覺、逆向操作",
  "資料／資產的二次利用與變現",
  "降低風險、防呆、抗脆弱的防守型方向",
  "把一次性工作變成可重複的系統或產品",
  "服務既有客群的相鄰需求（順帶多做一件事）",
  "低成本快速驗證、先跑 MVP 的實驗型方向",
];

export function expertAdvisorPrompt(input: {
  idea: string;
  workspacePath: string;
  maxProposals?: number;
  /** 主動模式：使用者沒給念頭，改用工作區脈絡推領域、一律提案（不反問）。 */
  proactive?: boolean;
  /** 主動模式的隨機探索視角，注入 prompt 促成每次不同方向、降低重複。 */
  varietyHint?: string;
}): string {
  const maxProposals = clampProposalCount(input.maxProposals);
  const idea = bounded(input.idea, 4_000);
  // 沒念頭（或明確要求主動）就走主動模式：從工作區脈絡主動端方向，永不 need_focus。
  const proactive = Boolean(input.proactive) || idea.length === 0;
  const varietyHint = bounded(input.varietyHint, 200);

  const intro = proactive
    ? `You are a senior domain expert and consultant. The owner has NOT given a specific idea — they want you to PROACTIVELY surface professional directions worth pursuing that they most likely do NOT know exist ("you don't know what you don't know"), so they can simply pick one. Infer a plausible domain/theme from their workspace context below; if the workspace is uninformative, choose broadly useful, high-leverage directions a capable owner could act on.`
    : `You are a senior domain expert and consultant. The owner has a rough idea but limited expertise in its field, and does not know how to proceed. Your job is to surface professional directions the owner most likely does NOT know exist — the "you don't know what you don't know" gap — so the owner can simply pick one, not invent it.`;
  const varietyRule = proactive && varietyHint
    ? `\n- For THIS run, bias your exploration toward this angle so repeated runs surface genuinely different territory: ${JSON.stringify(varietyHint)}. Deliberately AVOID the most obvious, generic, first-thing-everyone-suggests directions; prefer fresh, specific, non-repetitive ideas.`
    : "";
  const domainRule = proactive
    ? `- Infer the domain/theme from the owner's workspace context. In this proactive mode ALWAYS propose — never return need_focus.
- If the workspace gives no clear domain signal, do NOT invent one narrow domain and fill the list with variations of it (that makes every run look the same). Each proposal must come from a GENUINELY DIFFERENT field, so the list spans diverse territory — pick whatever fits across unrelated areas (e.g. software/automation, content, operations, finance, health, education, hardware, services) rather than several angles on one guessed niche. Set the top-level "domain" to a short label describing that breadth (for example "跨領域高槓桿方向"), not a single niche you guessed.${varietyRule}`
    : `- First infer the domain of the idea. If the idea is so empty or generic that you cannot infer a domain OR cannot produce genuinely useful, non-obvious directions, return exactly one focusing question instead (need_focus). Prefer to propose; only ask when proposing would be guesswork.`;
  const langRule = proactive
    ? `- Write every user-facing field in Traditional Chinese unless the workspace context clearly indicates another language.`
    : `- Write every user-facing field (title, summary, insight, approach, considerations, objective, and any question) in the SAME language as the owner's idea.`;
  const ideaLine = proactive ? `Owner's idea: (none — proactive suggestion mode; infer from workspace)` : `Owner's idea: ${JSON.stringify(idea)}`;
  const needFocusBlock = proactive ? "" : `
need_focus form (only when proposing would be guesswork):
<expert_advisor>
{"status":"need_focus","question":"one focusing question in the owner's language"}
</expert_advisor>
`;

  return `Expert Advisor · Direction Discovery Before Execution

${intro}

Rules:
- Do not use tools, files, shell commands, MCP, web access, or background agents. Reason from your own expert knowledge only.
${domainRule}
- Produce up to ${maxProposals} DISTINCT directions. Fewer is fine; never pad with filler or near-duplicates.
- Each proposal must earn its place by teaching the owner something: the "insight" field must state a non-obvious, expert-level point the owner probably has not considered — not a restatement of the idea.
- "approach" states how a professional would actually do it (methods, mainstream tools, sequence), concisely.
- "considerations" lists concrete pitfalls, trade-offs, or risks a non-expert would miss.
- "objective" is a ready-to-run imperative brief that could be handed to an execution team as-is if the owner picks this direction. Make it self-contained and bounded.
${langRule}
- Be honest: do not invent facts, fake precision, or promise outcomes you cannot justify from general expertise.
- Return only one marked JSON block and no Markdown fences.

${ideaLine}
Owner workspace: ${JSON.stringify(input.workspacePath)}
${needFocusBlock}
proposals form:
<expert_advisor>
{"status":"proposals","domain":"the field you inferred","proposals":[{"id":"stable-id","title":"short direction name","summary":"plain-language what this is","insight":"non-obvious expert point the owner likely doesn't know","approach":"how a pro would actually do it","considerations":["pitfall or trade-off"],"objective":"self-contained imperative brief to hand to an execution team"}]}
</expert_advisor>`;
}

type AdvisorParseResult =
  | { ok: true; result: AdvisorResult }
  | { ok: false; reason: string };

function evaluateAdvisorResult(text: string, maxProposals?: number): AdvisorParseResult {
  const cap = clampProposalCount(maxProposals);
  const match = text.match(/<expert_advisor>\s*([\s\S]*?)\s*<\/expert_advisor>/i);
  if (!match) return { ok: false, reason: "Missing an <expert_advisor>...</expert_advisor> block." };
  let raw: unknown;
  try { raw = JSON.parse(match[1]); } catch (cause) {
    return { ok: false, reason: `The JSON inside <expert_advisor> did not parse: ${(cause as Error).message}.` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "The <expert_advisor> content must be a single JSON object." };
  }
  const value = raw as Record<string, unknown>;

  if (value.status === "need_focus") {
    const question = bounded(value.question, 1_000);
    if (!question) return { ok: false, reason: "need_focus form is missing a non-empty \"question\"." };
    return { ok: true, result: { status: "need_focus", question } };
  }

  if (value.status !== "proposals") {
    return { ok: false, reason: `"status" must be exactly "need_focus" or "proposals", got ${JSON.stringify(value.status)}.` };
  }
  const domain = bounded(value.domain, 200);
  if (!Array.isArray(value.proposals) || value.proposals.length < 1) {
    return { ok: false, reason: "proposals form needs a non-empty \"proposals\" array." };
  }
  if (value.proposals.length > cap) {
    return { ok: false, reason: `proposals form must contain at most ${cap} entries.` };
  }
  const ids = new Set<string>();
  const proposals: AdvisorProposal[] = [];
  for (const [index, rawProposal] of value.proposals.entries()) {
    if (!rawProposal || typeof rawProposal !== "object" || Array.isArray(rawProposal)) {
      return { ok: false, reason: `Proposal ${index + 1} must be a JSON object.` };
    }
    const proposal = rawProposal as Record<string, unknown>;
    const id = bounded(proposal.id, 100) || `p${index + 1}`;
    const title = bounded(proposal.title, 200);
    const summary = bounded(proposal.summary, 1_000);
    const insight = bounded(proposal.insight, 1_000);
    const approach = bounded(proposal.approach, 1_500);
    const considerations = Array.isArray(proposal.considerations)
      ? proposal.considerations.map((item) => bounded(item, 500)).filter(Boolean).slice(0, 8)
      : [];
    const objective = bounded(proposal.objective, 2_000);
    if (ids.has(id)) return { ok: false, reason: `Proposal ${index + 1} reuses id ${JSON.stringify(id)} — every proposal id must be unique.` };
    if (!title) return { ok: false, reason: `Proposal ${index + 1} is missing a non-empty "title".` };
    if (!insight) return { ok: false, reason: `Proposal ${JSON.stringify(id)} is missing a non-empty "insight" — the whole point is to teach the owner something non-obvious.` };
    if (!objective) return { ok: false, reason: `Proposal ${JSON.stringify(id)} is missing a non-empty "objective" that could be handed to an execution team.` };
    ids.add(id);
    proposals.push({ id, title, summary, insight, approach, considerations, objective });
  }
  return { ok: true, result: { status: "proposals", domain, proposals } };
}

export function parseAdvisorResult(text: string, maxProposals?: number): AdvisorResult | null {
  const result = evaluateAdvisorResult(text, maxProposals);
  return result.ok ? result.result : null;
}

// Re-evaluates the same text to explain a parse failure in prose, so a repair
// prompt can tell the model exactly what to fix (mirrors bossTask.ts).
export function explainAdvisorFailure(text: string, maxProposals?: number): string | null {
  const result = evaluateAdvisorResult(text, maxProposals);
  return result.ok ? null : result.reason;
}

// Turns a chosen proposal into the objective string handed to the existing Boss
// Task pipeline. Kept here (not in the route) so it is unit-testable and the
// exact hand-off text is pinned.
export function advisorObjectiveForBossTask(proposal: AdvisorProposal): string {
  return proposal.objective;
}

// A short, human-readable summary of the whole advisor result, used when the
// owner wants the proposals echoed into a log/thread.
export function advisorProposalsDigest(result: Extract<AdvisorResult, { status: "proposals" }>): string {
  const lines = result.proposals.map((proposal, index) => t(
    "{n}. {title}\n   洞見：{insight}",
    { n: index + 1, title: proposal.title, insight: proposal.insight },
  ));
  return t("【專家顧問·{domain}】以下是你可能沒想到的方向：\n\n{body}", {
    domain: result.domain || t("一般"),
    body: lines.join("\n\n"),
  });
}
