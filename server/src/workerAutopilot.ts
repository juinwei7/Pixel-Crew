// 個人自動循環（worker autopilot）—— 單一 NPC 做完一回合後，讓決策模型看「這位 NPC 最近
// 在做什麼」自己決定下一句指示，送回給同一位 NPC 繼續做，形成個人層級的循環。
//
// 與 BOSS 層 autopilot（autopilot.ts）的分工：BOSS 層循環「開下一張交辦」走完整部門管線，
// 這裡只是「對同一位 NPC 說下一句話」——不開 mission、不路由部門、成本輕一個數量級。
// 視野也窄一個數量級，所以 STOP 判準比 BOSS 層更嚴：寧可早停，不做灌水工作。
//
// 這裡只放純函式（prompt 組裝、輸出解析、護欄 clamp、持久化正規化）；實際的模型呼叫、
// turn_end hook 與讓路判斷在 index.ts（沿用 autopilot.ts 的 determinism split，方便單測）。
import fs from "node:fs";
import path from "node:path";
import { t } from "./i18n.js";
import type { BackoffPolicy } from "./backoffRetry.js";
import { openRequestsCoachSection, type OpenUserRequest } from "./openRequests.js";

/** 個人循環一次最多自動連做幾步——預設刻意小（燒的是單一 NPC 的 session，且視野窄易漂移）。 */
export const WORKER_AUTOPILOT_DEFAULT_STEPS = 5;
export const WORKER_AUTOPILOT_MIN_STEPS = 1;
export const WORKER_AUTOPILOT_MAX_STEPS = 20;
/** 選填時間上限（分鐘），防呆封頂 24 小時。 */
export const WORKER_AUTOPILOT_MAX_MINUTES = 1440;

export function clampWorkerAutopilotSteps(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : WORKER_AUTOPILOT_DEFAULT_STEPS;
  return Math.min(WORKER_AUTOPILOT_MAX_STEPS, Math.max(WORKER_AUTOPILOT_MIN_STEPS, n));
}

export function clampWorkerAutopilotMinutes(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const n = Math.floor(value);
  if (n <= 0) return null;
  return Math.min(WORKER_AUTOPILOT_MAX_MINUTES, n);
}

/** 決策模型呼叫失敗的退避重試（一次失敗不熄火——比照 boss 層「失敗即停」修補的語義）。
 * 30s 起跳、封頂 15 分鐘、上限 10 次；用量受限期間探測不消耗次數（見 index.ts 掃描）。 */
export const WORKER_AUTOPILOT_RETRY_POLICY: BackoffPolicy = {
  baseMs: 30_000,
  capMs: 900_000,
  maxAttempts: 10,
};

/**
 * 回覆摘要「頭尾保留」：NPC 的結論與狀態總結幾乎都在結尾，純 slice(0, n) 會把教練
 * 最需要看的部分砍掉。超長時保留開頭與結尾、中間以標記省略。
 */
export function workerAutopilotResultSummary(text: string, head = 200, tail = 600): string {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed.length <= head + tail + 24) return trimmed;
  const omitted = trimmed.length - head - tail;
  return `${trimmed.slice(0, head)}\n…（中略 ${omitted} 字）…\n${trimmed.slice(-tail)}`;
}

export type WorkerAutopilotDecision =
  | { action: "continue"; instruction: string; reason: string; rung?: string; retro?: string; resolvedRequestIds?: string[]; planUpdate?: unknown }
  | { action: "explore"; query: string; reason: string; planUpdate?: unknown }
  | { action: "stop"; reason: string; retro?: string; resolvedRequestIds?: string[]; planUpdate?: unknown };

/** 支柱 B · 探索：決策每一步最多先查幾次再定稿——花錢/延遲防呆，用盡就逼它用現有資訊決定。 */
export const WORKER_AUTOPILOT_MAX_EXPLORE_PER_STEP = 2;

export type WorkerAutopilotExploreConfidence = "high" | "medium" | "low";
/** 探索回合的結構化回報：查了什麼、查到什麼、幾分把握、出處——回灌計畫、也防「有自信的盲猜」。 */
export type WorkerAutopilotFinding = {
  query: string;
  summary: string;
  confidence: WorkerAutopilotExploreConfidence;
  sources: string[];
};

/** 最近回合的精簡摘要：instruction＝當時送給 NPC 的話，result＝它回覆的截斷片段。 */
export type WorkerAutopilotTurn = {
  instruction: string;
  result?: string;
};

/** 教練決策要的脈絡：近期真實回合＋大局目標＋換腦帶來的背景摘要。 */
export type WorkerAutopilotContext = {
  turns: WorkerAutopilotTurn[];
  originalGoal: string | null;
  carriedSummary: string | null;
};

// 從對話歷史組出上面的脈絡（純函式、可單測）。關鍵：
// ①跳過 notice 通知與 system 系統回合（換腦/交接/續跑）——不把交接摘要誤當工作結果診斷。
// ②originalGoal＝史上第一個真實(非 system/非 notice)指示＝大局目標，slice(-N) 會砍掉，另外釘住。
// ③carriedSummary＝最近一次 system 回合的產出裡「夠長的那份」＝換腦交接摘要，當背景脈絡
//   （跳過「已接手」這種短回覆，避免把它當摘要）。
type AutopilotHistoryEvent = { type: string; text?: string; notice?: boolean; system?: boolean; resultText?: string };
export function autopilotContextFromHistory(history: ReadonlyArray<AutopilotHistoryEvent>, maxTurns = 8): WorkerAutopilotContext {
  const turns: WorkerAutopilotTurn[] = [];
  let originalGoal: string | null = null;
  let carriedSummary: string | null = null;
  let current: WorkerAutopilotTurn | null = null;
  let inSystemTurn = false;
  for (const event of history) {
    if (event.type === "user_message" && !event.notice) {
      if (event.system) { current = null; inSystemTurn = true; continue; }
      const text = typeof event.text === "string" ? event.text : "";
      if (!originalGoal && text) originalGoal = text.slice(0, 800);
      current = { instruction: text.slice(0, 600) };
      turns.push(current);
      inSystemTurn = false;
    } else if (event.type === "turn_end") {
      if (inSystemTurn) {
        const summary = (event.resultText || "").trim();
        if (summary.length > 200) carriedSummary = summary.slice(0, 1800);
        inSystemTurn = false;
      } else if (current) {
        current.result = workerAutopilotResultSummary(event.resultText || "");
        current = null;
      }
    }
  }
  return { turns: turns.slice(-maxTurns), originalGoal, carriedSummary };
}

function bounded(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

// 決策模型常從「近期回合」抄走我們自己加的「🔁（自動循環·剩 N 步）」前綴，送出時模板又會
// 再加一次造成前綴重複兩次——送出前把指示開頭的所有 🔁（…）／🔁(…) 前綴剝掉。
export function stripWorkerAutopilotPrefix(instruction: string): string {
  return instruction.replace(/^(?:\s*🔁\s*(?:（[^（）]*）|\([^()]*\)))+\s*/u, "").trim();
}

// 組「下一步該對這位 NPC 說什麼」的決策 prompt。
export function workerAutopilotNextPrompt(input: {
  workerName: string;
  role: string | null;
  workspaceLabel: string;
  turns: WorkerAutopilotTurn[];
  stepsRemaining: number;
  proactive?: boolean;
  /** 史上第一個真實指示＝這位 NPC 的大局目標；slice(-N) 會把它砍掉，釘住讓每步都對準它。 */
  originalGoal?: string | null;
  /** 最近一次換腦/交接帶過來的先前工作摘要（背景脈絡，非最新結果，不可拿來當診斷對象）。 */
  carriedSummary?: string | null;
  /** 前幾輪循環留下的復盤教訓（新的在前）——讓循環之間累積經驗而不是每輪歸零。 */
  retros?: string[];
  /** server 端剛觀測到的工作區實況（唯讀）——讓教練能對照 NPC 的自述抓落差。 */
  workspaceFacts?: { outbox: string[]; recent: string[] } | null;
  /** 使用者未結案請求（真人原文）——優先於自我議程承接，教練處理完才回報結案（見 openRequests.ts）。 */
  openRequests?: OpenUserRequest[];
  /** 當前活計畫（支柱 A）——決策每回合要讀它、更新它，並在 JSON 的 "plan" 欄回傳更新後的計畫。 */
  plan?: WorkerAutopilotPlan | null;
  /** 支柱 B：這步還能不能發探索（未超出每步上限）。true 才在 schema 提供 explore 動作。 */
  canExplore?: boolean;
  /** 本步已做過的探索結果（真的查回來的真相）——注入決策，讓定稿基於實情而非猜測。 */
  explorationFindings?: WorkerAutopilotFinding[];
}): string {
  const turns = input.turns.slice(-6);
  const turnsBlock = turns.length
    ? turns
        .map((turn, index) => {
          // 最新一則是診斷下一步的主要依據——給它大額度看清實質內容，較舊的僅留脈絡。
          const isLatest = index === turns.length - 1;
          const result = bounded(turn.result, isLatest ? 3000 : 600);
          const label = isLatest ? t("\n   最新回覆（完整據此診斷）：{result}", { result }) : t("\n   回覆摘要：{result}", { result });
          return t("{n}. 指示：{instruction}{result}", {
            n: index + 1,
            instruction: bounded(turn.instruction, isLatest ? 800 : 400),
            result: result ? label : "",
          });
        })
        .join("\n")
    : t("（沒有可用的近期回合——這是自動循環的第一步。）");

  const retros = (input.retros ?? []).map((note) => bounded(note, 300)).filter(Boolean).slice(0, 8);
  const retroBlock = retros.length
    ? `\n\nLessons carried over from this NPC's previous loops (most recent first):\n${retros.map((note) => `- ${note}`).join("\n")}`
    : "";

  const facts = input.workspaceFacts;
  const factList = (names: string[]): string => {
    const cleaned = names.map((name) => bounded(name, 80)).filter(Boolean).slice(0, 12);
    return cleaned.length ? cleaned.join(", ") : "(empty)";
  };
  const factsBlock = facts
    ? `\n\nWorkspace facts (server-observed just now, read-only — trust these over the NPC's claims):\n- outbox/ deliverables: ${factList(facts.outbox)}\n- recently modified in workspace: ${factList(facts.recent)}`
    : "";
  const factsRule = facts
    ? `\n- Cross-check the NPC's claims against the workspace facts below: a claimed deliverable missing from outbox/, or files it never mentioned changing, is exactly the kind of mismatch your diagnosis should open with.`
    : "";

  const openBlock = openRequestsCoachSection(input.openRequests ?? []);

  const findings = (input.explorationFindings ?? []).slice(0, WORKER_AUTOPILOT_MAX_EXPLORE_PER_STEP + 1);
  const findingsBlock = findings.length
    ? `\n\nExploration done THIS step (real investigation results — decide from these, not from guesses; weigh each by its confidence and sources):\n${findings
        .map((f) => `  - Q: ${bounded(f.query, 300)}\n    Found (${f.confidence}): ${bounded(f.summary, 600)}\n    Sources: ${f.sources.map((s) => bounded(s, 120)).filter(Boolean).slice(0, 5).join(", ") || "(none given — treat as low confidence)"}`)
        .join("\n")}`
    : "";
  const exploreRule = input.canExplore
    ? `\n- EXPLORE BEFORE GUESSING (you have real tools this loop): when a good next step depends on CURRENT REALITY you do not actually know — a fact, live web info, what a file/test actually says, whether something still works — do NOT guess from memory. Return action "explore" with a precise "query" of exactly what to find out; a read-only investigator will really check (web / read files / run read-only commands like tests) and report back, then you decide for real. Explore only what genuinely blocks a good decision — not what you can already answer, and not as a stalling tactic.`
    : (findings.length
      ? `\n- EXPLORATION BUDGET FOR THIS STEP IS USED UP: decide now (continue or stop) using the exploration results above plus the plan — do NOT ask to explore again this step.`
      : "");

  const planBlock = input.plan ? workerAutopilotPlanBlock(input.plan) : "";
  const planRule = `\n- MAINTAIN THE LIVING PLAN: the "Living plan" block (below, when shown) is the single evolving source of truth across rounds — it already folds in the original goal and past lessons, so do NOT keep a second mental plan. Read it, then return an UPDATED plan in the "plan" field of your JSON: fold what the LATEST turn established into "tried" (with its outcome), confirm or refute "hypotheses", re-rank "toTry", and refresh "blockers". Never re-list something already in "tried" as a fresh "toTry" — that is exactly the circling to avoid. If no plan block is shown yet, create the initial plan from the original goal. Keep every list tight: a working plan, not a transcript.`;

  const goal = bounded(input.originalGoal, 800);
  const goalBlock = goal
    ? `\n\nOriginal goal (this NPC's very first real instruction — the big-picture aim every step must still serve; the recent turns are only how far it has got):\n${goal}`
    : "";
  const carried = bounded(input.carriedSummary, 1800);
  const carriedBlock = carried
    ? `\n\nEarlier-work summary carried over from a context swap / handoff — BACKGROUND ONLY: this is a digest of what happened before the context was swapped, to give you the earlier arc the recent turns no longer show. It is NOT the latest result: never diagnose it, never "continue" it, never treat a "LLM 交接／自動換腦" system line as a work turn.\n${carried}`
    : "";
  const carriedRule = carried
    ? `\n- Earlier-work summary present: use it only as background for the bigger arc. The thing you diagnose and build on is still the latest REAL turn in "Recent turns" — never the carried summary and never a swap/handoff system message.`
    : "";

  const scopeRule = input.proactive
    ? `- GOAL-ANCHORED, not keep-busy: the owner turned on proactive mode to keep the project ADVANCING TOWARD ITS GOAL and arriving at a clear final decision — NOT to generate motion. Every step must measurably move the ORIGINAL GOAL (see its block) forward: deepen, verify-ONCE, harden, or conclude the thing the owner actually wants. Drifting to an adjacent/tangential GOAL, or re-doing / re-verifying something already shipped or already verified, is busywork — forbidden.
- DIFFERENT ANGLE, SAME GOAL — act as the owner's second brain: changing the GOAL is drift and is forbidden, but changing the APPROACH is exactly what you should do when the obvious path stalls. If the recent turns show the work going in circles — repeating a move, re-reading the same material, re-stating the same plan, or stuck on one blocked approach — do NOT loop that same path again and do NOT stop prematurely. Pick a genuinely DIFFERENT angle on the SAME original goal: a new entry point, a different method, a smaller decomposable sub-step, another source or line of attack. Real forward motion from a fresh angle is the whole point — laps and premature stops are both failures.
- KEEP EVOLVING — producing the deliverable is NOT "done": this loop exists to make the work AND its own understanding climb, not to reach a finish line and stop. When the current objective lands, that is a trigger to find the next GENUINELY HIGHER rung that still serves the original goal — deepen it, harden it against real failure modes, verify it against reality, generalize it, or leverage it toward the bigger aim. Evolution means verifiable upward progress (new capability, deeper understanding, higher leverage); it is NOT lateral polishing, NOT re-verifying work already verified, NOT drifting to another goal — those stay forbidden. If you genuinely cannot find a higher rung reachable this turn, that is a real stop (see below), not a reason to manufacture filler.
- DECIDE FOR THE OWNER whatever you can get right by thinking + investigating: you are the owner's second brain, not an assistant who raises a hand at every fork. If a fork can be settled by reasoning it through or by investigating (explore, or the NPC reading / searching / testing), then DECIDE it and continue — do NOT bounce an answerable question back to the owner. Which approach, which version, how to structure, resolving an ambiguity, picking between two paths: these are yours to settle.
- STOP only for what you genuinely cannot settle alone — and even then, stop WELL: (a) information or a preference that ONLY the owner holds and no investigation can recover (their private data, a credential, a taste only in their head); or (b) an action that spends money, is irreversible, or sends something outward (deploy, external send, deletion). For these, first do ALL the thinking and investigating, THEN stop with the "reason" written as a concrete recommendation the owner can confirm in one word — never a bare "waiting for you". Everything else: keep climbing, do not stop merely because the first approach got hard.`
    : `- The instruction must continue the NPC's CURRENT thread of work with a genuinely valuable, concrete next step: deepen, verify, fix, extend, or conclude what it was just doing. Never busywork, never a restatement of the previous instruction, never "keep going" filler.
- If the current thread clearly has remaining parts, or obvious immediate follow-ups (finishing a started deliverable, fixing a found problem, verifying fresh output), continue with those FIRST before considering STOP. STOP when the thread has reached a natural conclusion, when the next step needs the owner's input/decision/data, or when the work would be speculative busywork. A good STOP beats a filler step — but do not stop while clearly valuable follow-through remains.`;

  return `Worker Autopilot · Single-NPC Self-Continuation

You are a veteran expert in this NPC's line of work, acting as its coach. The owner turned ON this NPC's personal loop: after each of its turns finishes, you decide the single next instruction to send back to the SAME NPC so it keeps making genuine progress — or you stop the loop. Coach like a senior mentor reviewing a junior's work, not a taskmaster relaying orders.

This is NOT the department pipeline: no new departments, no missions, no other NPCs. Just the next message to this one NPC.

Rules:
- Do not use tools, files, shell, MCP, web, or background agents. Reason only from the context below.
- Propose exactly ONE next instruction, or STOP.
${scopeRule}
- This NPC only sees its own conversation — scope the instruction to what it can do alone in its workspace, in one turn.
- Working files: drafts and intermediate files stay in the workspace — never tell the NPC to put work-in-progress into outbox/. Only a finished, final deliverable (typically at the loop's last step) goes into outbox/.${input.stepsRemaining <= 0 ? `\n- FINAL STEP: this is the loop's last step. The instruction MUST tell the NPC to wrap up — close out the current thread (no new work that cannot finish in this one turn) and end its reply with a short wrap-up report for the owner: current status, what got done during this loop, what remains, and any risks.` : ""}
- Write the instruction in the same language the owner has been using with this NPC (Traditional Chinese unless the recent turns clearly show otherwise).
- Be honest: do not invent progress or manufacture a goal just to keep the loop alive.
- LADDER, not laps: first judge in one line which rung the work currently stands on (e.g. produced → verified → hardened → generalized → leveraged into a bigger goal), and put that judgment in the "rung" field. Then aim the instruction ONE RUNG HIGHER than where it stands — deepen, verify, harden, generalize, or build on the result — never a lateral repeat of the same rung.
- COACH like an expert, don't just command: open the instruction with a one-sentence expert diagnosis of the latest result — the specific weakness, gap, or risk a seasoned professional in this field would flag first — then direct the next move with the concrete standard to hit (what "done well" looks like). The NPC should learn WHY from the diagnosis, not just obey WHAT. Skip flattery; if the work is genuinely solid, say so in one phrase and raise the bar instead.
- ANCHOR IN THE LATEST REPLY, don't run generic: the "最新回覆（完整據此診斷）" block is the full latest result — read it and make the diagnosis quote or point at something CONCRETE in it (a specific claim, number, file, gap, or contradiction). A diagnosis that could be pasted onto any turn is a failure; if you cannot cite a specific from the latest reply, you have not read it closely enough.
- KEEP THE BIG PICTURE: read the "Original goal" block and make sure the next step still bends toward it — the recent turns are just the latest leg, not the whole journey. A step that polishes a detail while drifting from the original goal is a failure.${carriedRule}${planRule}${exploreRule}
- ASK ONLY WHAT YOU TRULY CANNOT SETTLE — and ask it well: do NOT stop for a fork you could resolve by thinking or investigating; decide that yourself and keep going. Stop for the owner only when progress needs (a) data/a preference only the owner holds that no investigation can recover, or (b) a money / irreversible / outward action. When you do stop for one of these, write the "reason" AS a prepared recommendation: name the fork in one line, give your recommended option (plus 1–2 alternatives) with what each implies, phrased so the owner confirms in a single letter or word. Think about how to ask so the owner barely has to type.
- NEVER PRESUME CONSENT FOR MONEY OR IRREVERSIBLE ACTIONS: you ARE authorized to decide and act on the owner's behalf for anything reversible you can get right by thinking or investigating — that is the job. But an action that spends money, cannot be undone, or sends something outward (deploy, cold-install, external send, deletion) needs the owner's OWN words — a past "yes / 好" to one thing does not authorize a different money/irreversible action. For those, stop with a prepared recommendation rather than proceeding on an assumption.
- Progress self-check: using the recent turns AND the carried-over lessons, state in the "reason" field what this step advances beyond what is already done. If you cannot name real progress in one concrete sentence, switch to a different rung or angle; if none exists, STOP honestly. Never spend remaining steps on filler.${factsRule}
- Retro: when you STOP, or when you issue the FINAL step, also include "retro" — one line with the most useful lesson from this loop (what worked, where it got stuck, what to do differently next time). It is saved and carried into this NPC's future loops.

Worker: ${JSON.stringify(input.workerName)}${input.role ? `\nRole: ${JSON.stringify(input.role)}` : ""}
Workspace: ${JSON.stringify(input.workspaceLabel)}
Loop steps remaining after this one: ${input.stepsRemaining}${goalBlock}${carriedBlock}${planBlock}${findingsBlock}

Recent turns (oldest first):
${turnsBlock}${retroBlock}${factsBlock}${openBlock}

Return only one marked JSON block, no Markdown fences. The "plan" field is the UPDATED living plan (single source of truth) — always include it, on both continue and stop:
<worker_autopilot_next>{"action":"continue","instruction":"the single next instruction for this NPC","reason":"one line: what this step advances beyond what is already done","rung":"one line: which rung the work stands on right now","plan":{"goal":"root anchor — keep stable","hypotheses":["open questions / bets"],"tried":[{"text":"what has been done","outcome":"result or lesson"}],"toTry":[{"text":"next candidate","need":"capability e.g. 讀碼/上網/跑測試/某專長"}],"blockers":["stuck points"]},"resolvedRequestIds":["ids of any OPEN USER REQUESTS now genuinely completed — omit or leave empty if none / still in progress"],"retro":"only on the FINAL step: one-line lesson for future loops"}</worker_autopilot_next>
or
<worker_autopilot_next>{"action":"stop","reason":"one line: why stopping now is right","plan":{"goal":"root anchor","hypotheses":[],"tried":[{"text":"...","outcome":"..."}],"toTry":[],"blockers":[]},"resolvedRequestIds":["ids of any OPEN USER REQUESTS now genuinely completed — empty if none"],"retro":"one line: the most useful lesson from this loop"}</worker_autopilot_next>${input.canExplore ? `
or (when you must check current reality before deciding well):
<worker_autopilot_next>{"action":"explore","query":"precisely what to find out — a question a read-only investigator can answer with web search, reading files, or running read-only commands","reason":"one line: why this fact blocks a good decision right now","plan":{"goal":"root anchor","hypotheses":[],"tried":[],"toTry":[],"blockers":[]}}</worker_autopilot_next>` : ""}`;
}

type WorkerAutopilotParse =
  | { ok: true; decision: WorkerAutopilotDecision }
  | { ok: false; reason: string };

function evaluateWorkerAutopilotDecision(text: string): WorkerAutopilotParse {
  const match = text.match(/<worker_autopilot_next>\s*([\s\S]*?)\s*<\/worker_autopilot_next>/i);
  if (!match) return { ok: false, reason: "Missing a <worker_autopilot_next>...</worker_autopilot_next> block." };
  let raw: unknown;
  try { raw = JSON.parse(match[1]); } catch (cause) {
    return { ok: false, reason: `The JSON inside <worker_autopilot_next> did not parse: ${(cause as Error).message}.` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "The <worker_autopilot_next> content must be a single JSON object." };
  }
  const value = raw as Record<string, unknown>;
  // 去掉結尾句號——理由會被塞進「…{reason}。」模板，不修剪會出現「。。」。
  const reason = bounded(value.reason, 500).replace(/[。．.\s]+$/u, "");
  const retro = bounded(value.retro, 500);
  // 教練回報「已真正處理完」的使用者請求 id（resolve 語義 (a)）——只收非空字串、上限 20。
  const resolvedIds = Array.isArray(value.resolvedRequestIds)
    ? value.resolvedRequestIds.map((id) => bounded(id, 200)).filter(Boolean).slice(0, 20)
    : [];
  const resolved = resolvedIds.length ? { resolvedRequestIds: resolvedIds } : {};
  // 活計畫（支柱 A）：原樣帶出模型回傳的 plan（物件才收），交由呼叫端用 mergeWorkerAutopilotPlan 正規化落盤。
  const planUpdate = value.plan && typeof value.plan === "object" && !Array.isArray(value.plan) ? { planUpdate: value.plan } : {};
  if (value.action === "explore") {
    // 支柱 B：需要先查證才能好好決定。沒給具體查詢內容的 explore 不可執行——退回安全停止。
    const query = bounded(value.query, 500);
    if (query) return { ok: true, decision: { action: "explore", query, reason, ...planUpdate } };
    return { ok: true, decision: { action: "stop", reason: reason || "Exploration requested without a concrete query.", ...(retro ? { retro } : {}), ...resolved, ...planUpdate } };
  }
  if (value.action === "stop") {
    return { ok: true, decision: { action: "stop", reason, ...(retro ? { retro } : {}), ...resolved, ...planUpdate } };
  }
  if (value.action !== "continue") {
    return { ok: false, reason: `"action" must be exactly "continue" or "stop", got ${JSON.stringify(value.action)}.` };
  }
  const instruction = stripWorkerAutopilotPrefix(bounded(value.instruction, 4_000));
  // 沒有可執行指示的 "continue" 一律當成 stop——寧可安全停下，也不要送空話進 NPC 的 session。
  if (!instruction) return { ok: true, decision: { action: "stop", reason: reason || "No concrete next instruction was produced.", ...(retro ? { retro } : {}), ...resolved, ...planUpdate } };
  const rung = bounded(value.rung, 300);
  return { ok: true, decision: { action: "continue", instruction, reason, ...(rung ? { rung } : {}), ...(retro ? { retro } : {}), ...resolved, ...planUpdate } };
}

// ── 進步護欄（機制三的程式面）──────────────────────────────────────────────
// 決策模型若給出「跟最近幾步實質相同」的指示，代表它答不出還能推進什麼——prompt 已要求
// 這種情況換策略或誠實停止，這裡再結構性兜底：同層重複一律轉成 stop，不燒 NPC 的步數。
// 只做比對用的正規化：剝前綴、去掉所有空白（中文指示常見全半形空白差異）、統一小寫。
function normalizedInstruction(text: string): string {
  return stripWorkerAutopilotPrefix(text).replace(/\s+/gu, "").toLowerCase();
}

export function workerAutopilotProgressGuard(
  decision: WorkerAutopilotDecision,
  turns: WorkerAutopilotTurn[],
): WorkerAutopilotDecision {
  if (decision.action !== "continue") return decision;
  const next = normalizedInstruction(decision.instruction);
  const repeated = turns.slice(-3).some((turn) => normalizedInstruction(turn.instruction) === next);
  if (!repeated) return decision;
  return {
    action: "stop",
    reason: t("下一步與最近的指示重複、說不出實質推進，改為誠實停止"),
    ...(decision.retro ? { retro: decision.retro } : {}),
    ...(decision.resolvedRequestIds?.length ? { resolvedRequestIds: decision.resolvedRequestIds } : {}),
  };
}

// ── 支柱 B · 探索回合（兩段式的第二段：真的去查）────────────────────────────
// 這個 prompt 跑在 read_only_query + allowSafeShell 回合：可真的上網（WebSearch/WebFetch）、
// 讀檔（Read/Grep/Glob）、跑唯讀安全指令（npm test/tsc/git status…）。它只「查」不「做」，
// 查完回結構化 findings 回灌決策。刻意要求標信心度與出處——防「查到半截證據的有自信盲猜」。
export function workerAutopilotExplorePrompt(input: {
  workerName: string;
  workspaceLabel: string;
  query: string;
  originalGoal?: string | null;
}): string {
  const goal = bounded(input.originalGoal, 600);
  return `Autopilot Exploration · read-only investigator

You are a read-only investigator helping an autopilot coach decide the next step for NPC ${JSON.stringify(input.workerName)} (workspace ${JSON.stringify(input.workspaceLabel)}).${goal ? `\nThe overall goal being pursued: ${goal}` : ""}

Investigate ONLY this question and report what is actually true right now:
${bounded(input.query, 500)}

You may ONLY read reality, never change it: web search / fetch, read files, grep/glob, and read-only shell (e.g. running tests, "git status/diff/log", "ls", "cat", "tsc"). You cannot and must not write files, send anything out, install, or run destructive commands — those are blocked.

Rules:
- Actually check. Use the tools; do not answer from memory. If a web fact, prefer a real search; if a code fact, actually read the file or run the read-only command.
- Report only what you verified. Separate what you found from what you could not determine.
- Be honest about confidence and cite where each finding came from (URL, file path, or command). Partial/weak evidence must be marked low confidence — a half-answer presented as certain is worse than "could not determine".

Return only one marked JSON block, no Markdown fences:
<exploration_findings>{"summary":"what is actually true, concise — the answer the coach needs","confidence":"high | medium | low","sources":["url / file path / command you actually used"]}</exploration_findings>`;
}

function clampConfidence(value: unknown): WorkerAutopilotExploreConfidence {
  return value === "high" || value === "low" ? value : "medium";
}

/** 解析探索回合的結構化回報；解析不出就回 low 信心、摘要取原文片段——絕不把失敗當成高信心事實。 */
export function parseExplorationFindings(text: string, query: string): WorkerAutopilotFinding {
  const q = bounded(query, 500);
  const match = text.match(/<exploration_findings>\s*([\s\S]*?)\s*<\/exploration_findings>/i);
  if (match) {
    try {
      const raw = JSON.parse(match[1]) as Record<string, unknown>;
      const sources = Array.isArray(raw.sources)
        ? raw.sources.map((s) => bounded(s, 200)).filter(Boolean).slice(0, 8)
        : [];
      const summary = bounded(raw.summary, 1200);
      if (summary) return { query: q, summary, confidence: clampConfidence(raw.confidence), sources };
    } catch { /* 落到下面的降級 */ }
  }
  // 沒有合規區塊：降級為 low 信心、取回覆片段當摘要（寧可標低信心，也不要假裝查到了）。
  const fallback = workerAutopilotResultSummary(text, 150, 450);
  return { query: q, summary: fallback || t("（探索未回傳可用結果）"), confidence: "low", sources: [] };
}

/** 格式修復重問（一次）：把上一次回覆被拒的具體原因附回去，只再要一次標記 JSON 區塊。 */
export function workerAutopilotRepairPrompt(basePrompt: string, failure: string): string {
  return `${basePrompt}

Your previous reply was rejected: ${failure}
Reply again with ONLY the single marked <worker_autopilot_next> JSON block — no other text before or after it.`;
}

// ── 保底掃描決策（純函式，index.ts 的 15s 掃與單測共用）──────────────────────
// turn_end 觸發有結構性空窗：讓路（協作／交接／Mission／換腦）結束不一定伴隨這位 NPC 的
// turn_end，循環會武裝著卻永遠不再前進——與 bossDispatchRetry 補的是同一型的洞。
// 順序關鍵：busy/讓路先於步數/時限判斷——最後一步還在跑時步數已是 0，先判步數會提早
// 發「已達上限」通知搶走 turn_end 收尾的時機。
export type WorkerAutopilotSweepView = {
  present: boolean;
  busy: boolean;
  queued: boolean;
  yielding: boolean;
  advancing: boolean;
  stepsRemaining: number;
  deadlinePassed: boolean;
  retry: { registered: boolean; due: boolean; exhausted: boolean };
};

export type WorkerAutopilotSweepAction =
  | "drop" // NPC 已消失：清登記
  | "wait" // 這輪不動：忙碌／讓路中／決策進行中／退避未到
  | "disable_steps" // 閒置且步數用盡（正常路徑由 turn_end 收，這是崩潰窗口的兜底）
  | "disable_deadline" // 閒置且超過時間上限
  | "exhausted" // 決策重試次數用盡：發降級通知並停止，不可靜默
  | "advance"; // 補觸發下一步（重試型在呼叫端先過用量探測、不受限才消耗次數）

export function workerAutopilotSweepAction(view: WorkerAutopilotSweepView): WorkerAutopilotSweepAction {
  if (!view.present) return "drop";
  if (view.busy || view.queued || view.yielding || view.advancing) return "wait";
  if (view.stepsRemaining <= 0) return "disable_steps";
  if (view.deadlinePassed) return "disable_deadline";
  if (view.retry.registered) {
    if (view.retry.exhausted) return "exhausted";
    if (!view.retry.due) return "wait";
  }
  return "advance";
}

export function parseWorkerAutopilotDecision(text: string): WorkerAutopilotDecision | null {
  const result = evaluateWorkerAutopilotDecision(text);
  return result.ok ? result.decision : null;
}

export function explainWorkerAutopilotFailure(text: string): string | null {
  const result = evaluateWorkerAutopilotDecision(text);
  return result.ok ? null : result.reason;
}

// ── 重啟持久化（比照 autopilotState.ts 的檔案式 JSON，key 是 workerId）─────────
export type PersistedWorkerAutopilotState = {
  stepsRemaining: number;
  deadlineAt: number | null;
  /** 主動模式：原任務收尾後仍主動找優化／延伸研究，STOP 門檻大幅調低。 */
  proactive: boolean;
};

/** 逐條驗證還原內容：steps 夾回合法範圍、deadline 非數字一律 null、壞條目整條丟棄。 */
export function normalizeWorkerAutopilotStates(raw: unknown): Record<string, PersistedWorkerAutopilotState> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, PersistedWorkerAutopilotState> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || typeof key !== "string" || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.stepsRemaining !== "number" || !Number.isFinite(entry.stepsRemaining) || entry.stepsRemaining < 1) continue;
    const deadlineAt = typeof entry.deadlineAt === "number" && Number.isFinite(entry.deadlineAt)
      ? Math.min(entry.deadlineAt, Date.now() + WORKER_AUTOPILOT_MAX_MINUTES * 60_000)
      : null;
    out[key] = {
      stepsRemaining: clampWorkerAutopilotSteps(entry.stepsRemaining),
      deadlineAt,
      proactive: entry.proactive === true,
    };
  }
  return out;
}

// ── 循環復盤記憶（機制一）────────────────────────────────────────────────
// 每輪循環收尾（STOP 或最後一步）時決策模型留下一行教訓，跨輪持久化、下輪決策 prompt 帶入，
// 讓循環之間累積經驗（進化），而不是每輪從零開始（重複）。
export const WORKER_AUTOPILOT_MAX_RETROS = 12;

export type WorkerAutopilotRetro = { at: number; note: string };

export function normalizeWorkerAutopilotRetros(raw: unknown): Record<string, WorkerAutopilotRetro[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, WorkerAutopilotRetro[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || !Array.isArray(value)) continue;
    const list: WorkerAutopilotRetro[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const entry = item as Record<string, unknown>;
      const note = bounded(entry.note, 500);
      if (!note) continue;
      const at = typeof entry.at === "number" && Number.isFinite(entry.at) ? entry.at : 0;
      list.push({ at, note });
    }
    if (list.length) out[key] = list.slice(-WORKER_AUTOPILOT_MAX_RETROS);
  }
  return out;
}

/** 附加一則復盤：空白略過、跟最近一則相同略過（防重複洗版）、超過上限丟最舊。回傳是否有寫入。 */
export function appendWorkerAutopilotRetro(
  retros: Record<string, WorkerAutopilotRetro[]>,
  workerId: string,
  note: unknown,
  at: number,
): boolean {
  const text = bounded(note, 500);
  if (!text) return false;
  const list = retros[workerId] ?? [];
  if (list.length && list[list.length - 1].note === text) return false;
  list.push({ at, note: text });
  retros[workerId] = list.slice(-WORKER_AUTOPILOT_MAX_RETROS);
  return true;
}

export class WorkerAutopilotRetroStore {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "worker-autopilot-retros.json");
  }

  load(): Record<string, WorkerAutopilotRetro[]> {
    try {
      return normalizeWorkerAutopilotRetros(JSON.parse(fs.readFileSync(this.file, "utf8")));
    } catch {
      return {}; // 檔案不存在或壞掉 → 當成沒有歷史復盤
    }
  }

  save(retros: Record<string, WorkerAutopilotRetro[]>): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(retros, null, 2));
    } catch (error) {
      console.error("[worker-autopilot] 無法保存循環復盤:", error);
    }
  }
}

export class WorkerAutopilotStateStore {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "worker-autopilot-state.json");
  }

  load(): Record<string, PersistedWorkerAutopilotState> {
    try {
      return normalizeWorkerAutopilotStates(JSON.parse(fs.readFileSync(this.file, "utf8")));
    } catch {
      return {}; // 檔案不存在或壞掉 → 當成全關
    }
  }

  save(states: Record<string, PersistedWorkerAutopilotState>): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(states, null, 2));
    } catch (error) {
      console.error("[worker-autopilot] 無法保存個人循環狀態:", error);
    }
  }
}

// ── 活的計畫（支柱 A · 增量 1）────────────────────────────────────────────
// 把「每回合從近幾回合重推一個下一步」的貪心單步，換成一份跨回合演進的路線圖：
// 目標→假設→已試→待試→卡點。它是「單一事實來源」——goal 當根錨、retro/lessons 灌進
// 已試、不另起爐灶並存（並存必漂移，見記憶裡 d5525f4 誤合併那類風險）。
// 增量 1 只做「計畫會演進＋結構性抓長程繞圈」，決策層仍不探索（那是增量 2 的支柱 B）。
export const WORKER_AUTOPILOT_PLAN_LIMITS = {
  goal: 800,
  hypotheses: { count: 8, len: 220 },
  tried: { count: 24, text: 220, outcome: 220 },
  toTry: { count: 12, text: 220, need: 60 },
  blockers: { count: 8, len: 220 },
} as const;

/** 已試項：做過什麼（text）＋結果/教訓（outcome）。決策憑這份「全部試過的」避免重撞同一牆。 */
export type WorkerAutopilotTried = { text: string; outcome: string };
/** 待試項：下一步候選（text）＋需要什麼能力（need，未來支柱 D 派工可直接讀，現在零成本先備好）。 */
export type WorkerAutopilotToTry = { text: string; need?: string };

export type WorkerAutopilotPlan = {
  goal: string;
  hypotheses: string[];
  tried: WorkerAutopilotTried[];
  toTry: WorkerAutopilotToTry[];
  blockers: string[];
  /** 最後更新於第幾回合——讓驗收能逐回合 diff「這回合改了什麼」。 */
  updatedRound: number;
};

function boundedList(raw: unknown, count: number, map: (item: unknown) => string | null): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const v = map(item);
    if (v) out.push(v);
    if (out.length >= count) break;
  }
  return out;
}

/** 逐欄驗證＋封頂的計畫正規化：壞欄位當空、超量截斷、去重，壞輸入回傳空計畫（可序列化、可 diff）。 */
export function normalizeWorkerAutopilotPlan(raw: unknown): WorkerAutopilotPlan {
  const empty: WorkerAutopilotPlan = { goal: "", hypotheses: [], tried: [], toTry: [], blockers: [], updatedRound: 0 };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty;
  const r = raw as Record<string, unknown>;
  const L = WORKER_AUTOPILOT_PLAN_LIMITS;

  const hypotheses = dedupe(boundedList(r.hypotheses, L.hypotheses.count, (x) => bounded(x, L.hypotheses.len) || null));
  const blockers = dedupe(boundedList(r.blockers, L.blockers.count, (x) => bounded(x, L.blockers.len) || null));

  const tried: WorkerAutopilotTried[] = [];
  if (Array.isArray(r.tried)) {
    for (const item of r.tried) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const e = item as Record<string, unknown>;
      const text = bounded(e.text, L.tried.text);
      if (!text) continue;
      if (tried.some((t) => normalizedInstruction(t.text) === normalizedInstruction(text))) continue;
      tried.push({ text, outcome: bounded(e.outcome, L.tried.outcome) });
      if (tried.length >= L.tried.count) break;
    }
  }

  const toTry: WorkerAutopilotToTry[] = [];
  if (Array.isArray(r.toTry)) {
    for (const item of r.toTry) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const e = item as Record<string, unknown>;
      const text = bounded(e.text, L.toTry.text);
      if (!text) continue;
      if (toTry.some((t) => normalizedInstruction(t.text) === normalizedInstruction(text))) continue;
      const need = bounded(e.need, L.toTry.need);
      toTry.push(need ? { text, need } : { text });
      if (toTry.length >= L.toTry.count) break;
    }
  }

  const updatedRound = typeof r.updatedRound === "number" && Number.isFinite(r.updatedRound) && r.updatedRound >= 0
    ? Math.floor(r.updatedRound)
    : 0;

  return { goal: bounded(r.goal, L.goal), hypotheses, tried, toTry, blockers, updatedRound };
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const key = normalizedInstruction(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** 計畫是否實質為空（沒目標也沒任何欄位內容）——用來決定要不要種入初始計畫。 */
export function isWorkerAutopilotPlanEmpty(plan: WorkerAutopilotPlan): boolean {
  return !plan.goal && !plan.hypotheses.length && !plan.tried.length && !plan.toTry.length && !plan.blockers.length;
}

/**
 * 種入初始計畫＝把既有的 goal 與 retro 教訓映射進五欄，而非另開一份並存狀態：
 * originalGoal→goal（根錨）、retros→tried（已試的教訓，新的在前）。這落實「單一事實來源」。
 */
export function seedWorkerAutopilotPlan(originalGoal: string | null, retros: string[]): WorkerAutopilotPlan {
  const L = WORKER_AUTOPILOT_PLAN_LIMITS;
  const tried: WorkerAutopilotTried[] = [];
  for (const note of retros) {
    const text = bounded(note, L.tried.text);
    if (!text) continue;
    if (tried.some((t) => normalizedInstruction(t.text) === normalizedInstruction(text))) continue;
    tried.push({ text, outcome: "" });
    if (tried.length >= L.tried.count) break;
  }
  return normalizeWorkerAutopilotPlan({ goal: bounded(originalGoal, L.goal), tried, updatedRound: 0 });
}

/**
 * 套用決策模型回傳的「更新後計畫」：以模型回傳為準正規化，但守住兩條防呆——
 * ①goal 根錨不被改空（模型漏填就保留舊 goal，防漂移）②updatedRound 單調遞增到本回合。
 * 回傳 {plan, changed}，changed＝與舊計畫是否有實質差異（驗收用：探索/回合有沒有真的改計畫）。
 */
export function mergeWorkerAutopilotPlan(
  previous: WorkerAutopilotPlan,
  update: unknown,
  round: number,
): { plan: WorkerAutopilotPlan; changed: boolean } {
  const next = normalizeWorkerAutopilotPlan(update);
  if (!next.goal && previous.goal) next.goal = previous.goal; // 根錨不被改空
  next.updatedRound = Math.max(previous.updatedRound, Number.isFinite(round) && round >= 0 ? Math.floor(round) : previous.updatedRound);
  const changed = !samePlanContent(previous, next);
  return { plan: next, changed };
}

function samePlanContent(a: WorkerAutopilotPlan, b: WorkerAutopilotPlan): boolean {
  const norm = (p: WorkerAutopilotPlan) => JSON.stringify({
    goal: p.goal,
    hypotheses: p.hypotheses,
    tried: p.tried,
    toTry: p.toTry,
    blockers: p.blockers,
  });
  return norm(a) === norm(b);
}

/** 把計畫渲染進決策 prompt 的區塊（空計畫回空字串，由 prompt 端指示「先建計畫」）。 */
export function workerAutopilotPlanBlock(plan: WorkerAutopilotPlan): string {
  if (isWorkerAutopilotPlanEmpty(plan)) return "";
  const line = (s: string) => `  - ${s}`;
  const parts: string[] = [];
  if (plan.goal) parts.push(`Goal (root anchor): ${plan.goal}`);
  if (plan.hypotheses.length) parts.push(`Hypotheses (open questions / bets):\n${plan.hypotheses.map(line).join("\n")}`);
  if (plan.tried.length) parts.push(`Tried (do NOT re-attempt these — this is the full memory of what has been done):\n${plan.tried.map((t) => line(t.outcome ? `${t.text} → ${t.outcome}` : t.text)).join("\n")}`);
  if (plan.toTry.length) parts.push(`To try (ranked next candidates):\n${plan.toTry.map((t) => line(t.need ? `${t.text} [needs: ${t.need}]` : t.text)).join("\n")}`);
  if (plan.blockers.length) parts.push(`Blockers (stuck points):\n${plan.blockers.map(line).join("\n")}`);
  return `\n\nLiving plan (the single evolving source of truth — updated every round; "Tried" is the complete long-range memory, not just the last few turns):\n${parts.join("\n")}`;
}

/**
 * 計畫感知進度護欄（支柱 A 的結構面，補強既有 workerAutopilotProgressGuard 的盲點）：
 * 舊護欄只比對最近 3 回合的指示，抓不到「第 1 回合試過、漂移幾回合後第 6 回合又提同一招」的長程繞圈。
 * 這裡用計畫的完整 tried 清單比對——提議的下一步若等同某個已試項，即長程繞圈，改為誠實停止。
 * 守命優先：計畫為空（還沒建）時不介入，交給既有護欄與 prompt。
 */
export function workerAutopilotPlanProgressGuard(
  decision: WorkerAutopilotDecision,
  plan: WorkerAutopilotPlan,
): WorkerAutopilotDecision {
  if (decision.action !== "continue") return decision;
  if (!plan.tried.length) return decision;
  const next = normalizedInstruction(decision.instruction);
  const circled = plan.tried.some((t) => normalizedInstruction(t.text) === next);
  if (!circled) return decision;
  return {
    action: "stop",
    reason: t("下一步等同計畫中已試過的做法（長程繞圈），改為誠實停止——該換角度或交回决定"),
    ...(decision.retro ? { retro: decision.retro } : {}),
    ...(decision.resolvedRequestIds?.length ? { resolvedRequestIds: decision.resolvedRequestIds } : {}),
  };
}

export class WorkerAutopilotPlanStore {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "worker-autopilot-plans.json");
  }

  load(): Record<string, WorkerAutopilotPlan> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
      const out: Record<string, WorkerAutopilotPlan> = {};
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!key) continue;
        const plan = normalizeWorkerAutopilotPlan(value);
        if (!isWorkerAutopilotPlanEmpty(plan)) out[key] = plan;
      }
      return out;
    } catch {
      return {}; // 檔案不存在或壞掉 → 當成沒有計畫
    }
  }

  save(plans: Record<string, WorkerAutopilotPlan>): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(plans, null, 2));
    } catch (error) {
      console.error("[worker-autopilot] 無法保存個人循環計畫:", error);
    }
  }
}
