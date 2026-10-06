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

/** 教練對「上一步完成標準」的驗收判定：達成／部分／未達。 */
export type WorkerAutopilotCriterionVerdict = "met" | "partial" | "missed";
/** 停止類型：done＝目標達成無事待決、ask＝要 owner 的資料／偏好／授權、stuck＝多角度都撞牆需 owner 指方向。 */
export type WorkerAutopilotStopKind = "done" | "ask" | "stuck";

/**
 * 「問 owner」的性質：choice＝可逆的選項分岔（owner 授權：循環開著時教練自己分析選最佳、繼續跑）；
 * authorization＝花錢／不可逆／對外送出（必須 owner 本人點頭，循環暫停等回覆）；
 * owner_data＝只有 owner 有的資料（帳密、私人資訊），查不到也猜不得（暫停等回覆）。
 */
export type WorkerAutopilotAskGate = "choice" | "authorization" | "owner_data";

/** 教練替 owner 做的選擇（可逆分岔），留紀錄讓 owner 回來能一眼看懂、想改直接回一句。 */
export type WorkerAutopilotChoice = { question: string; options: string[]; picked: string; why: string };

export type WorkerAutopilotDecision =
  | { action: "continue"; instruction: string; reason: string; rung?: string; doneWhen?: string; prevMet?: WorkerAutopilotCriterionVerdict; retro?: string; resolvedRequestIds?: string[]; planUpdate?: unknown; choice?: WorkerAutopilotChoice }
  | { action: "explore"; query: string; reason: string; planUpdate?: unknown }
  | { action: "stop"; reason: string; kind?: WorkerAutopilotStopKind; gate?: WorkerAutopilotAskGate; prevMet?: WorkerAutopilotCriterionVerdict; retro?: string; resolvedRequestIds?: string[]; planUpdate?: unknown };

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
  /** 這則指示附帶的完成標準（從尾端「完成標準：」行取出）——另存，免得長指示截斷時被砍掉。 */
  doneWhen?: string;
};

/**
 * owner 開循環當下最近一則真人指示（非 notice／system／循環自己送的指示）＝這輪循環的目標原文。
 * 以前用「史上第一則真實指示」，常是好幾天前、早就不相干的舊任務。
 */
export function latestOwnerInstruction(history: ReadonlyArray<{ type: string; text?: string; notice?: boolean; system?: boolean; autopilot?: boolean }>): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const event = history[i];
    if (event.type !== "user_message" || event.notice || event.system || event.autopilot) continue;
    const text = typeof event.text === "string" ? event.text.trim() : "";
    if (text && !text.startsWith("🔁")) return text.slice(0, 800);
  }
  return null;
}

// ── 空轉偵測（伺服器實測，不靠模型自述）────────────────────────────────────
// 每個循環步驟有沒有「實際產出」：改了檔、commit、或查了資料（上網／派子代理）。研究類步驟不算空轉
//——循環在想下一步方向時常需要先查。連續 WORKER_AUTOPILOT_IDLE_STOP 步都沒有就由 server 停下，
// 量化依據：47 輪真實紀錄中「連 2 步沒產出」後續步驟多半仍無產出，約佔總成本兩成。
export const WORKER_AUTOPILOT_IDLE_STOP = 2;
export type WorkerAutopilotStepActivity = { owner: boolean; startAt: number | null; endAt: number | null; wrote: boolean; researched: boolean; finished: boolean };
const WRITE_TOOLS = /^(write|edit|multiedit|notebookedit|apply_patch|file_change|filechange)$/i;
const RESEARCH_TOOLS = /^(websearch|webfetch|web_search|agent|task)$/i;
const COMMIT_COMMAND = /\bgit\b[^\n|;&]*\bcommit\b/;

type ActivityHistoryEvent = { type: string; text?: string; notice?: boolean; system?: boolean; autopilot?: boolean; name?: string; input?: unknown; at?: number };
/** 從歷史切出最近的循環步驟（owner 插話也記一筆 owner=true，空轉連數遇到它就中斷）。 */
export function workerAutopilotStepActivity(history: ReadonlyArray<ActivityHistoryEvent>, max = 6): WorkerAutopilotStepActivity[] {
  const steps: WorkerAutopilotStepActivity[] = [];
  let current: WorkerAutopilotStepActivity | null = null;
  for (const event of history) {
    if (event.type === "user_message") {
      if (event.notice) continue;
      if (event.system) { current = null; continue; }
      const auto = event.autopilot === true || (typeof event.text === "string" && event.text.startsWith("🔁"));
      current = { owner: !auto, startAt: typeof event.at === "number" ? event.at : null, endAt: null, wrote: false, researched: false, finished: false };
      steps.push(current);
    } else if (event.type === "tool_call_start" && current) {
      const name = typeof event.name === "string" ? event.name.replace(/^.*__/, "") : "";
      if (WRITE_TOOLS.test(name)) current.wrote = true;
      else if (RESEARCH_TOOLS.test(name)) current.researched = true;
      else if (/^bash$/i.test(name)) {
        const command = event.input && typeof event.input === "object" ? (event.input as { command?: unknown }).command : undefined;
        if (typeof command === "string" && COMMIT_COMMAND.test(command)) current.wrote = true;
      }
    } else if (event.type === "turn_end" && current) {
      current.endAt = typeof event.at === "number" ? event.at : null;
      current.finished = true;
      current = null;
    }
  }
  return steps.slice(-max);
}

/**
 * 最近連續幾個「已完成、沒產出」的循環步驟。touchedFiles 讓呼叫端補實測（例如工作區有檔案在
 * 那段時間被改過——Bash 跑腳本產檔不會出現 Write 工具）。遇到有產出的步驟或 owner 插話就停止計數。
 */
export function workerAutopilotIdleStreak(steps: ReadonlyArray<WorkerAutopilotStepActivity>, touchedFiles: (step: WorkerAutopilotStepActivity) => boolean = () => false): number {
  let streak = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.owner || !step.finished) break;
    if (step.wrote || step.researched || touchedFiles(step)) break;
    streak += 1;
  }
  return streak;
}

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
      // 完成標準在指示尾端，截斷會先砍到它——先剝出來另存，指示本體再截。
      const doneWhen = extractWorkerAutopilotCriterion(text);
      current = doneWhen
        ? { instruction: stripWorkerAutopilotCriterion(text).slice(0, 600), doneWhen }
        : { instruction: text.slice(0, 600) };
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
  /** server 端量到的原地踏步訊號（workerAutopilotStallSignals）——有才注入，逼教練換角度。 */
  stallSignals?: string[];
}): string {
  const turns = input.turns.slice(-6);
  const turnsBlock = turns.length
    ? turns
        .map((turn, index) => {
          // 最新一則是診斷下一步的主要依據——給它大額度看清實質內容，較舊的僅留脈絡。
          const isLatest = index === turns.length - 1;
          const result = bounded(turn.result, isLatest ? 3000 : 600);
          const label = isLatest ? t("\n   最新回覆（完整據此診斷）：{result}", { result }) : t("\n   回覆摘要：{result}", { result });
          const criterion = bounded(turn.doneWhen, 400);
          return t("{n}. 指示：{instruction}{result}", {
            n: index + 1,
            instruction: bounded(turn.instruction, isLatest ? 800 : 400) + (criterion ? `\n   完成標準 / Done when: ${criterion}` : ""),
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

  const stall = (input.stallSignals ?? []).map((s) => bounded(s, 300)).filter(Boolean).slice(0, 4);
  const stallBlock = stall.length
    ? `\n\nSTALL SIGNALS (server-measured on the recent turns — evidence the loop may be spinning in place):\n${stall.map((s) => `- ${s}`).join("\n")}\n- Do NOT issue another variant of the same move. Take a genuinely different angle on the SAME original goal and say in "reason" what is different this time; only if every angle is truly exhausted, stop with "kind":"stuck".`
    : "";

  const planBlock = input.plan ? workerAutopilotPlanBlock(input.plan) : "";
  const planRule = `\n- MAINTAIN THE LIVING PLAN: the "Living plan" block (below, when shown) is the single evolving source of truth across rounds — it already folds in the original goal and past lessons, so do NOT keep a second mental plan. Read it, then return an UPDATED plan in the "plan" field of your JSON: fold what the LATEST turn established into "tried" (with its outcome), confirm or refute "hypotheses", re-rank "toTry", and refresh "blockers". Never re-list something already in "tried" as a fresh "toTry" — that is exactly the circling to avoid. If no plan block is shown yet, create the initial plan from the owner's goal. The plan's "goal" is the owner's goal VERBATIM — never rewrite, broaden, or merge other tasks into it (the server keeps the owner's words regardless); a new direction you open goes into "toTry" with one clause on how it serves that goal. Keep every list tight: a working plan, not a transcript.`;

  const goal = bounded(input.originalGoal, 800);
  const goalBlock = goal
    ? `\n\nOwner's goal (the owner's own words when they switched this loop on — FIXED for the whole loop; every step must serve it; the recent turns are only how far it has got):\n${goal}`
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
- DIFFERENT ANGLE, SAME GOAL — act as the owner's second brain: changing the GOAL is drift and is forbidden, but changing the APPROACH is exactly what you should do when the obvious path stalls. If the recent turns show the work going in circles — repeating a move, re-reading the same material, re-stating the same plan, or stuck on one blocked approach — do NOT loop that same path again and do NOT stop prematurely. Pick a genuinely DIFFERENT angle on the SAME original goal: a new entry point, a different method, a smaller decomposable sub-step, another source or line of attack. Real forward motion from a fresh angle is the whole point. Spinning the same lap is a failure — and so is stopping early while a genuinely valuable, reachable rung toward the goal still exists. As long as a real higher rung can be found, keep climbing from a fresh angle rather than stopping.
- KEEP EVOLVING — the step count is a SAFETY CEILING, not a quota: the owner switched the loop on so the work keeps advancing toward their goal while they are away. After each result, pick the next step that would make a real, verifiable difference to the goal — deepen it, harden it against real failure modes, verify it against reality, generalize it, find what is missing, or leverage it toward the bigger aim. Producing the first deliverable is not automatically "done" while a clearly valuable next step remains. But NEVER invent work to use up the count: lateral polishing, re-verifying what is already verified, repeated wrap-ups, and drift to another goal are padding — padding burns the owner's money for nothing and is a failure.
- DECIDE FOR THE OWNER whatever you can get right by thinking + investigating: you are the owner's second brain, not an assistant who raises a hand at every fork. If a fork can be settled by reasoning it through or by investigating (explore, or the NPC reading / searching / testing), then DECIDE it and continue — do NOT bounce an answerable question back to the owner. Which approach, which version, how to structure, resolving an ambiguity, picking between two paths: these are yours to settle.
- STOP (steps may still be left — that is fine) in these cases: (a) data that ONLY the owner holds and no investigation can recover (their private data, a credential) — a mere preference or an A/B/C fork is NOT this, see PICK FORKS YOURSELF; (b) an action that spends money, is irreversible, or sends something outward (deploy, external send, deletion); or (c) DONE FOR NOW — you looked for the next step from several different angles (deepen / harden against real failure modes / verify against reality / generalize / find what is missing / connect to the bigger aim) and none would make a real difference worth its cost. Stopping honestly at (c) is a good outcome, not a failure. For (c), the "reason" names what this loop achieved and the angles you checked, plus the single most useful direction the owner could point the next loop at. For (a) and (b), first do ALL the thinking and investigating, THEN stop with the "reason" written as a concrete recommendation the owner can confirm in one word — never a bare "waiting for you".`
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
- LADDER, not laps: first judge in one line which rung the work currently stands on (e.g. produced → verified → hardened → generalized → leveraged into a bigger goal), and put that judgment in the "rung" field. Then aim the instruction ONE RUNG HIGHER than where it stands — deepen, verify, harden, generalize, or build on the result — never a lateral repeat of the same rung. If no higher rung would make a real difference, STOP instead (see STOP) — never invent a rung just to keep going.
- COACH like an expert, don't just command: open the instruction with a one-sentence expert diagnosis of the latest result — the specific weakness, gap, or risk a seasoned professional in this field would flag first — then direct the next move with the concrete standard to hit (what "done well" looks like). The NPC should learn WHY from the diagnosis, not just obey WHAT. Skip flattery; if the work is genuinely solid, say so in one phrase and raise the bar instead.
- ANCHOR IN THE LATEST REPLY, don't run generic: the "最新回覆（完整據此診斷）" block is the full latest result — read it and make the diagnosis quote or point at something CONCRETE in it (a specific claim, number, file, gap, or contradiction). A diagnosis that could be pasted onto any turn is a failure; if you cannot cite a specific from the latest reply, you have not read it closely enough.
- KEEP THE BIG PICTURE: read the "Owner's goal" block and make sure the next step still bends toward it — the recent turns are just the latest leg, not the whole journey. A step that polishes a detail while drifting from the original goal is a failure.${carriedRule}${planRule}${exploreRule}
- PICK FORKS YOURSELF — the owner's standing order: while this loop is on, every REVERSIBLE fork (A/B/C options, which approach, which direction, a trade-off, a style or preference the owner has not stated) is YOURS to settle. Analyze the options against the owner's goal, pick the best one, and "continue" with it; put the fork in the "choice" field ({"question","options","picked","why"}) so the owner sees what you chose and can override with one reply when back. Never stop the loop just to ask which option the owner prefers.
- ASK ONLY WHAT YOU TRULY CANNOT SETTLE — and ask it well: stop for the owner only when progress needs (a) data only the owner holds that no investigation can recover (set "gate":"owner_data"), or (b) a money / irreversible / outward action (set "gate":"authorization"). The loop then PAUSES and resumes by itself as soon as the owner replies. When you do stop for one of these, write the "reason" AS a prepared recommendation: name the fork in one line, give your recommended option (plus 1–2 alternatives) with what each implies, phrased so the owner confirms in a single letter or word. Think about how to ask so the owner barely has to type.
- FINISH UNBLOCKED WORK BEFORE ASKING: if part of the goal is blocked on such a question but other parts are not, "continue" with the unblocked parts first and record the question in the plan's "blockers"; stop to ask only when nothing useful remains that does not depend on the answer.
- NEVER PRESUME CONSENT FOR MONEY OR IRREVERSIBLE ACTIONS: you ARE authorized to decide and act on the owner's behalf for anything reversible you can get right by thinking or investigating — that is the job. But an action that spends money, cannot be undone, or sends something outward (deploy, cold-install, external send, deletion) needs the owner's OWN words — a past "yes / 好" to one thing does not authorize a different money/irreversible action. For those, stop with a prepared recommendation rather than proceeding on an assumption.
- Progress self-check: using the recent turns AND the carried-over lessons, state in the "reason" field what this step advances beyond what is already done. If you cannot name real progress in one concrete sentence, switch to a different rung or angle; if none exists, STOP honestly. Never spend remaining steps on filler.${factsRule}
- Retro: when you STOP, or when you issue the FINAL step, also include "retro" — one line with the most useful lesson from this loop (what worked, where it got stuck, what to do differently next time). It is saved and carried into this NPC's future loops.
- PICK, DON'T DEFAULT: before choosing, weigh 2–3 candidate moves (the top of the plan's "toTry" plus any fresh idea) by how far each moves the ORIGINAL GOAL versus what it costs this turn, and choose the highest-leverage one. In "reason", add one clause on why it beats the runner-up.
- DONE-WHEN FOR EVERY STEP: on "continue", put in "doneWhen" one concrete, checkable acceptance criterion for THIS step (what the NPC's reply or files must show). The server appends it to the instruction the NPC sees as a "完成標準" line, so do not repeat it inside "instruction".
- CHECK THE LAST CRITERION FIRST: if the previous instruction in "Recent turns" ends with a "完成標準" / "Done when" line, judge the latest reply against it and set "prevMet" to "met", "partial", or "missed". A missed or partial criterion is what your diagnosis opens with — close that gap or re-approach it before stacking a new rung on top of it.
- STOP KIND: on "stop", set "kind" — "done" (the goal is reached and nothing is left for the owner to decide), "ask" (you need the owner's data or authorization; "reason" is the prepared A/B/C question; also set "gate"), or "stuck" (a wall you could not get around from several angles; "reason" names the angles tried and offers directions). If any decision is left for the owner, use "ask", never "done".

Worker: ${JSON.stringify(input.workerName)}${input.role ? `\nRole: ${JSON.stringify(input.role)}` : ""}
Workspace: ${JSON.stringify(input.workspaceLabel)}
Loop steps remaining after this one: ${input.stepsRemaining}${goalBlock}${carriedBlock}${planBlock}${findingsBlock}${stallBlock}

Recent turns (oldest first):
${turnsBlock}${retroBlock}${factsBlock}${openBlock}

Return only one marked JSON block, no Markdown fences. The "plan" field is the UPDATED living plan (single source of truth) — always include it, on both continue and stop:
<worker_autopilot_next>{"action":"continue","instruction":"the single next instruction for this NPC","reason":"one line: what this step advances beyond what is already done, and why it beats the runner-up","rung":"one line: which rung the work stands on right now","doneWhen":"one checkable acceptance criterion for this step","prevMet":"met | partial | missed — only if the previous instruction carried a 完成標準 line","plan":{"goal":"root anchor — keep stable","hypotheses":["open questions / bets"],"tried":[{"text":"what has been done","outcome":"result or lesson"}],"toTry":[{"text":"next candidate","need":"capability e.g. 讀碼/上網/跑測試/某專長"}],"blockers":["stuck points"]},"resolvedRequestIds":["ids of any OPEN USER REQUESTS now genuinely completed — omit or leave empty if none / still in progress"],"choice":{"question":"only when this step settles a fork on the owner's behalf — the fork in one line","options":["A …","B …"],"picked":"the option you chose","why":"one line: why it best serves the goal"},"retro":"only on the FINAL step: one-line lesson for future loops"}</worker_autopilot_next>
or
<worker_autopilot_next>{"action":"stop","kind":"done | ask | stuck","gate":"only for kind ask: authorization | owner_data","reason":"one line: why stopping now is right","prevMet":"met | partial | missed — only if the previous instruction carried a 完成標準 line","plan":{"goal":"root anchor","hypotheses":[],"tried":[{"text":"...","outcome":"..."}],"toTry":[],"blockers":[]},"resolvedRequestIds":["ids of any OPEN USER REQUESTS now genuinely completed — empty if none"],"retro":"one line: the most useful lesson from this loop"}</worker_autopilot_next>${input.canExplore ? `
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
  // 上一步完成標準的驗收判定（選填）：只收三個合法值，其他一律略過。
  const prevMet = value.prevMet === "met" || value.prevMet === "partial" || value.prevMet === "missed"
    ? { prevMet: value.prevMet as WorkerAutopilotCriterionVerdict }
    : {};
  if (value.action === "explore") {
    // 支柱 B：需要先查證才能好好決定。沒給具體查詢內容的 explore 不可執行——退回安全停止。
    const query = bounded(value.query, 500);
    if (query) return { ok: true, decision: { action: "explore", query, reason, ...planUpdate } };
    return { ok: true, decision: { action: "stop", reason: reason || "Exploration requested without a concrete query.", ...(retro ? { retro } : {}), ...resolved, ...planUpdate } };
  }
  if (value.action === "stop") {
    // 停止類型（選填）：不認得的值當沒給——呼叫端退回舊行為（有理由就當成問 owner）。
    const kind = value.kind === "done" || value.kind === "ask" || value.kind === "stuck"
      ? { kind: value.kind as WorkerAutopilotStopKind }
      : {};
    const gate = value.gate === "choice" || value.gate === "authorization" || value.gate === "owner_data"
      ? { gate: value.gate as WorkerAutopilotAskGate }
      : {};
    return { ok: true, decision: { action: "stop", reason, ...kind, ...gate, ...prevMet, ...(retro ? { retro } : {}), ...resolved, ...planUpdate } };
  }
  if (value.action !== "continue") {
    return { ok: false, reason: `"action" must be exactly "continue" or "stop", got ${JSON.stringify(value.action)}.` };
  }
  const instruction = stripWorkerAutopilotPrefix(bounded(value.instruction, 4_000));
  // 沒有可執行指示的 "continue" 一律當成 stop——寧可安全停下，也不要送空話進 NPC 的 session。
  if (!instruction) return { ok: true, decision: { action: "stop", reason: reason || "No concrete next instruction was produced.", ...(retro ? { retro } : {}), ...resolved, ...planUpdate } };
  const rung = bounded(value.rung, 300);
  const doneWhen = bounded(value.doneWhen, 400).replace(/[。．.\s]+$/u, "");
  const choice = parseWorkerAutopilotChoice(value.choice);
  return { ok: true, decision: { action: "continue", instruction, reason, ...(rung ? { rung } : {}), ...(doneWhen ? { doneWhen } : {}), ...prevMet, ...(retro ? { retro } : {}), ...resolved, ...planUpdate, ...(choice ? { choice } : {}) } };
}

// ── 進步護欄（機制三的程式面）──────────────────────────────────────────────
// 決策模型若給出「跟最近幾步實質相同」的指示，代表它答不出還能推進什麼——prompt 已要求
// 這種情況換策略或誠實停止，這裡再結構性兜底：同層重複一律轉成 stop，不燒 NPC 的步數。
// 只做比對用的正規化：剝前綴、去掉所有空白（中文指示常見全半形空白差異）、統一小寫。
function normalizedInstruction(text: string): string {
  return stripWorkerAutopilotCriterion(stripWorkerAutopilotPrefix(text)).replace(/\s+/gu, "").toLowerCase();
}

// ── 完成標準（每步的驗收條件）─────────────────────────────────────────────
// 教練每步除了指示，再給一條「這步做到什麼算完成」的可核對標準，附在送給 NPC 的指示尾端；
// 下一步教練先拿最新回覆對照這條標準判定 met/partial/missed，再決定往上爬還是補洞。
// 比對（進步護欄、計畫繞圈）前要把這段尾巴剝掉，否則同一招只因標準措辭不同就逃過偵測。
const CRITERION_TAIL = /\n+\s*(?:完成標準|Done when)\s*[:：][\s\S]*$/u;

export function stripWorkerAutopilotCriterion(text: string): string {
  return text.replace(CRITERION_TAIL, "").trim();
}

/** 把完成標準接到指示尾端（沒有標準就原樣回傳）。 */
export function workerAutopilotInstructionWithCriterion(instruction: string, doneWhen?: string): string {
  const criterion = bounded(doneWhen, 400);
  if (!criterion) return instruction;
  return `${instruction}\n\n${t("完成標準：{doneWhen}", { doneWhen: criterion.replace(/\s*\n\s*/gu, " ") })}\n${t("（回覆結尾請用一句話對照這條完成標準，說明達成與否）")}`;
}

/** 從送出的指示文字取回完成標準（標籤後的那一行）；沒有就回空字串。 */
export function extractWorkerAutopilotCriterion(text: string): string {
  const match = typeof text === "string" ? text.match(/\n+\s*(?:完成標準|Done when)\s*[:：]\s*([^\n]*)/u) : null;
  return match ? match[1].trim().slice(0, 400) : "";
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
    kind: "stuck",
    ...(decision.retro ? { retro: decision.retro } : {}),
    ...(decision.resolvedRequestIds?.length ? { resolvedRequestIds: decision.resolvedRequestIds } : {}),
  };
}

// ── 原地踏步偵測（軟訊號）──────────────────────────────────────────────────
// 進步護欄只抓「一字不差」的重複；實務上的原地踏步多半是換句話說：同一招換個措辭再下一次、
// NPC 連兩回合回差不多的東西、A→B→A 來回擺盪。這裡用字元雙字組（bigram）重疊度量測，
// 結果只當「證據」注入決策 prompt 逼教練換角度——不硬停（措辭相近未必是重複，誤殺代價高）。
// 純字串運算、零額外模型呼叫。
// 門檻依 2026-10 真實循環回放校準（34 段對話、198 個決策點）：舊的 0.75 指示門檻對中文換句話說
// （實測 0.4–0.7）一次都沒觸發；真實的踏步多半是「空回合」與「一直在等背景工作」，不是同文重講。
const STALL_RESULT_SIMILARITY = 0.85;
const STALL_INSTRUCTION_SIMILARITY = 0.6;
// 等待空轉：回覆很短、結尾只說自己在等背景工作／等人叫醒。
const STALL_WAIT_MAX_CHARS = 700;
const STALL_WAIT_TAIL_CHARS = 300;
// 「開跑→空等」：前一則回覆不短，但開頭狀態行就說自己把工作丟去背景跑（四段回報的「狀態」在最前面），
// 下一則就只剩在等——兩步合起來也是等待空轉。只看開頭，長回覆中段順口提到背景工作不算。
const STALL_WAIT_HEAD_CHARS = 160;
// 重做已完成的事：NPC 明說這步要它做的事「早就做完／不是待辦」——循環在對著做完的事繞圈。
// 只認「之前就做完」的說法；一般進度回報的「已完成 X」不算（那是這步的新產出）。
const STALL_ALREADY_DONE_PATTERN = /(早(就|已)(做完|完成|上線|修好|改好|處理)|(之前|先前|稍早|上一?輪)(就)?已(經)?(做完|上線|修好|改好)|不是(新的?)?待辦|重做(已完成|已經?做完|舊)|(was|were|had been|has been|have been) already (done|completed|implemented|fixed|shipped)|already (done|completed|implemented|fixed|shipped) (earlier|before|previously))/iu;
const STALL_WAIT_PATTERN = /(背景(執行|跑|監看|代理)|叫醒我|還在(跑|建置|進行)|正在跑|待命中|稍候|已掛(上|好)|等.{0,16}(回來|完成|通知|回報|回覆|結果|閒置)|in the background|wake me|still (running|building|in progress)|standing by|waiting (for|on) .{0,30}(finish|complete|return|report|result))/iu;
const STALL_EMPTY_REPLY = /^no response requested\.?$/iu;

function bigramSet(text: string): Set<string> {
  const out = new Set<string>();
  const chars = Array.from(text);
  for (let i = 0; i < chars.length - 1; i++) out.add(chars[i] + chars[i + 1]);
  return out;
}

/** 兩段文字的雙字組 Dice 係數（0–1）；任一方太短（<2 字）回 0。 */
export function workerAutopilotTextSimilarity(a: string, b: string): number {
  const sa = bigramSet(a);
  const sb = bigramSet(b);
  if (!sa.size || !sb.size) return 0;
  let shared = 0;
  for (const gram of sa) if (sb.has(gram)) shared += 1;
  return (2 * shared) / (sa.size + sb.size);
}

function compactForCompare(text: string | undefined): string {
  return typeof text === "string" ? text.replace(/\s+/gu, "").toLowerCase() : "";
}

/**
 * 從最近回合量出原地踏步訊號（英文句子，直接進 prompt）。沒有訊號回空陣列。
 * ①空回合：最近三則回覆中有兩則空話（No response requested.）或任兩則完全相同
 * ②最近三則回覆中任兩則高度相似（含 A→B→A 擺盪）
 * ③最近兩則回覆都只是在等背景工作（或前一則開頭就說丟去背景跑、這一則只剩在等）
 * ④最近三則「自動循環」指示中任兩則換句話說的近似重複（owner 自己的訊息不算，
 *   重貼同一段話或固定開頭會誤報）
 * ⑤最新一步是循環指示，而 NPC 回覆說這件事早就做完了（重做已完成的事）
 * 未採用：「連續把選擇丟回 owner」——回放 3 則連續都在要拍板時命中 2、誤報 3（NPC 常邊等拍板邊產出），
 *   文字層分不開，不上。
 */
export function workerAutopilotStallSignals(turns: ReadonlyArray<WorkerAutopilotTurn>): string[] {
  const signals: string[] = [];
  const recent = turns.slice(-3);
  const compactReplies = recent.map((turn) => compactForCompare(turn.result)).filter(Boolean);
  // 單獨一則空話常是回應內部通知的正常回合；要兩則以上才算空轉。
  const emptyReplies = recent.filter((turn) => STALL_EMPTY_REPLY.test((turn.result ?? "").trim())).length;
  const identicalReplies = compactReplies.some((text, i) => compactReplies.indexOf(text) !== i);
  if (emptyReplies >= 2 || identicalReplies) {
    signals.push("The NPC's recent replies are empty or word-for-word identical — the last steps produced nothing new.");
  }
  const results = compactReplies.filter((text) => text.length >= 40);
  let bestResult = 0;
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) bestResult = Math.max(bestResult, workerAutopilotTextSimilarity(results[i], results[j]));
  }
  if (!identicalReplies && bestResult >= STALL_RESULT_SIMILARITY) {
    signals.push(`Two of the NPC's last ${results.length} replies are ~${Math.round(bestResult * 100)}% the same text — the work is not moving forward.`);
  }
  const lastTwo = turns.slice(-2).map((turn) => (turn.result ?? "").trim());
  const onlyWaiting = (text: string) => Boolean(text) && text.length < STALL_WAIT_MAX_CHARS && STALL_WAIT_PATTERN.test(text.slice(-STALL_WAIT_TAIL_CHARS));
  const opensWithWaiting = (text: string) => Boolean(text) && STALL_WAIT_PATTERN.test(text.slice(0, STALL_WAIT_HEAD_CHARS));
  if (lastTwo.length === 2 && onlyWaiting(lastTwo[1]) && (onlyWaiting(lastTwo[0]) || opensWithWaiting(lastTwo[0]))) {
    signals.push("The NPC's last two replies only say it is waiting on background work — another \"check on it\" step just spins. Give it independent useful work meanwhile, or stop and let the background work finish.");
  }
  const instructions = recent
    .filter((turn) => /^\s*🔁/u.test(turn.instruction))
    .map((turn) => normalizedInstruction(turn.instruction))
    .filter((text) => text.length >= 8);
  let bestInstruction = 0;
  for (let i = 0; i < instructions.length; i++) {
    for (let j = i + 1; j < instructions.length; j++) bestInstruction = Math.max(bestInstruction, workerAutopilotTextSimilarity(instructions[i], instructions[j]));
  }
  if (bestInstruction >= STALL_INSTRUCTION_SIMILARITY) {
    signals.push(`Two of the last ${instructions.length} loop instructions overlap ~${Math.round(bestInstruction * 100)}% — the same move was re-issued in different words.`);
  }
  const last = turns[turns.length - 1];
  if (last && /^\s*🔁/u.test(last.instruction) && STALL_ALREADY_DONE_PATTERN.test(last.result ?? "")) {
    signals.push("The NPC's last reply says the work this loop step asked for was already done earlier — the loop is re-issuing finished work. Check the plan and open requests against what is already shipped; pick genuinely new work, or stop.");
  }
  return signals;
}

// ── 給 owner 看的進度與停止說明（純字串組裝）────────────────────────────────
function verdictLabel(verdict: WorkerAutopilotCriterionVerdict): string {
  if (verdict === "met") return t("上一步達標");
  if (verdict === "partial") return t("上一步部分達標");
  return t("上一步未達標");
}

/**
 * 每步一句話進度：上一步驗收結果 · 目前站在哪一階 · 這步要推進什麼 · 這步的完成標準。
 * 取代原本只有 rung 的通知——owner 掃一眼就知道循環在想什麼、有沒有真的往前。都沒有就回 null。
 */
export function workerAutopilotStepNotice(decision: { rung?: string; reason?: string; doneWhen?: string; prevMet?: WorkerAutopilotCriterionVerdict }): string | null {
  const parts: string[] = [];
  if (decision.prevMet) parts.push(verdictLabel(decision.prevMet));
  const rung = bounded(decision.rung, 300);
  if (rung) parts.push(rung);
  const reason = bounded(decision.reason, 300);
  if (reason) parts.push(t("這步：{reason}", { reason }));
  const doneWhen = bounded(decision.doneWhen, 300);
  if (doneWhen) parts.push(t("完成標準：{doneWhen}", { doneWhen }));
  return parts.length ? `🪜 ${parts.join(" · ")}` : null;
}

/**
 * 教練主動停下時給 owner 的停止註記，並決定要不要標成「循環問你」卡（ask）。
 * - done：目標達成、沒有待決事項 → 不打擾（不標 ask），附計畫裡排第一的可選下一步。
 *   防呆：若理由裡其實帶了 ≥2 個標號選項，仍當成問 owner（寧可多問一次，也不漏掉待決定）。
 * - ask：要 owner 的資料／偏好／授權 → 問題卡＋一鍵選項。
 * - stuck：多角度都撞牆 → 問題卡，附計畫裡的卡點，請 owner 指方向。
 * - 沒給 kind（舊模型輸出）→ 完全沿用舊行為：有理由就當問 owner。
 */
export function workerAutopilotStopNote(input: {
  kind?: WorkerAutopilotStopKind;
  reason: string;
  plan?: WorkerAutopilotPlan | null;
}): { note: string; ask: boolean } {
  const reason = bounded(input.reason, 500);
  const legacy = t("🅿️ 自動循環正常結束{reason}。要繼續就再打開開關或直接下指示。", { reason: reason ? t("：{reason}", { reason }) : "" });
  if (!reason || !input.kind) return { note: legacy, ask: !!reason };
  const kind = input.kind === "done" && parseAutopilotAskOptions(reason).length >= 2 ? "ask" : input.kind;
  if (kind === "done") {
    const next = bounded(input.plan?.toTry[0]?.text, 220);
    const hint = next ? `\n${t("可選的下一步：{next}（要做就直接下指示或重開開關）", { next })}` : "";
    return { note: `${t("自動循環已完成目標：{reason}。", { reason })}${hint}`, ask: false };
  }
  if (kind === "stuck") {
    const blocker = bounded(input.plan?.blockers[0], 220);
    const hint = blocker ? `\n${t("卡點：{blocker}", { blocker })}` : "";
    return { note: `${t("🅿️ 自動循環卡住而停：{reason}。給個方向或選一個選項，就能換路接著做。", { reason })}${hint}`, ask: true };
  }
  return { note: t("🅿️ 自動循環停下來等你拍板：{reason}。回覆選項或直接下指示即可接續。", { reason }), ask: true };
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

/**
 * 從「循環問 owner」的停止理由裡抽出可一鍵回答的選項標籤（A/B/C/D 或 甲/乙/丙/丁）。
 * 供 UI 渲染成按鈕——owner 點一下就回那個字母，不用打字。抽不到就回空陣列（UI 退回純文字卡）。
 */
export function parseAutopilotAskOptions(reason: string): string[] {
  const text = typeof reason === "string" ? reason : "";
  // 先找出所有「獨立出現」的候選標籤位置（A–D 或 甲乙丙丁，前後都不是英數）。
  const re = /(?:^|[^A-Za-z0-9])([A-D]|[甲乙丙丁])(?=[^A-Za-z0-9]|$)/gu;
  const marks: Array<{ label: string; at: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    marks.push({ label: m[1], at: m.index + m[0].length - 1 }); // at＝標籤字元本身的位置
  }
  // 關鍵護欄：只有「標籤後面真的跟著一段選項說明」才算真選項——否則像「把 A/B/C 三個選項列出」
  // 這種只是『提到』A/B/C 的複合詞會被誤抓成按鈕，使用者看到按鈕卻不知道各代表什麼（owner 實測回報）。
  // 判準：標籤到下一個標籤（或結尾）之間，剝掉開頭的分隔符後還剩 ≥2 個描述字元。
  const found: string[] = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].at + 1;
    const end = i + 1 < marks.length ? marks[i + 1].at : text.length;
    const desc = text.slice(start, end).replace(/^[\s)\]）】.。、,，:：;；/／|｜．·・\-—]+/u, "").trim();
    if (desc.length >= 2 && !found.includes(marks[i].label)) found.push(marks[i].label);
    if (found.length >= 4) break;
  }
  // 至少兩個「帶說明」的選項才算選項題；否則回空（卡片只顯示理由＋「直接回覆」提示）。
  return found.length >= 2 ? found : [];
}

/** 教練回報的「替 owner 選了哪個」：沒給選中項就當沒有（不留半截紀錄）。 */
function parseWorkerAutopilotChoice(raw: unknown): WorkerAutopilotChoice | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const picked = bounded(value.picked, 200);
  if (!picked) return null;
  const options = Array.isArray(value.options) ? value.options.map((o) => bounded(o, 200)).filter(Boolean).slice(0, 5) : [];
  return { question: bounded(value.question, 300), options, picked, why: bounded(value.why, 300).replace(/[。．.\s]+$/u, "") };
}

/**
 * 要不要先讓教練自己選（owner 授權：循環開著時可逆的選項分岔由教練分析選最佳）。
 * 只有「問 owner」且不是花錢／不可逆／owner 私有資料才自選；沒標 gate 但理由帶 ≥2 個選項的也算選項題。
 */
export function workerAutopilotShouldAutoPick(decision: WorkerAutopilotDecision): boolean {
  if (decision.action !== "stop" || decision.kind !== "ask") return false;
  if (decision.gate === "authorization" || decision.gate === "owner_data") return false;
  return decision.gate === "choice" || parseAutopilotAskOptions(decision.reason).length >= 2;
}

/** 自選重問：把教練剛剛想問 owner 的分岔丟回去，要它自己分析選最佳並 continue；真的是花錢／不可逆才准再停。 */
export function workerAutopilotAutoPickPrompt(basePrompt: string, question: string): string {
  return `${basePrompt}

You just tried to stop and ask the owner this:
${bounded(question, 600)}

The owner's standing order for this loop: reversible forks like this are YOURS to decide — do not wait for them. Analyze each option against the owner's goal, pick the best one, and return action "continue" with the instruction that carries it out, filling the "choice" field ({"question","options","picked","why"}). Only if carrying out ANY option would itself spend money, be irreversible, or send something outward may you stop again — then set "kind":"ask" and "gate":"authorization".
Reply with ONLY the single marked <worker_autopilot_next> JSON block.`;
}

/** 循環替 owner 做了選擇時的通知（notice，不進 NPC session）。 */
export function workerAutopilotChoiceNotice(choice: WorkerAutopilotChoice): string {
  const question = choice.question ? t("（問題：{question}）", { question: choice.question }) : "";
  const why = choice.why ? t("——{why}", { why: choice.why }) : "";
  return t("🤖 循環自選：{picked}{why}{question}。想改直接回我一句，循環會照你的改。", { picked: choice.picked, why, question });
}

/** 循環暫停等 owner 的通知：開關仍開著，owner 一回覆就自動接著跑。 */
export function workerAutopilotPausedNote(reason: string, gate?: WorkerAutopilotAskGate): string {
  const why = gate === "owner_data" ? t("需要只有你有的資料") : t("這步會花錢／不可逆／對外送出，需要你本人點頭");
  return t("⏸ 自動循環暫停等你（{why}）：{reason}。回覆後循環會自動接著跑，不用重開開關。", { why, reason: bounded(reason, 500) });
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
  /** 暫停等 owner 回覆：不推進、不因時限／步數收掉（owner 回覆時由發話入口解除暫停）。 */
  paused?: boolean;
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
  if (view.paused) return "wait";
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
  /** owner 開循環當下交代的那句話（原文）＝整輪固定的目標；模型不得改寫（見 mergeWorkerAutopilotPlan）。 */
  goal?: string | null;
  /** 暫停等 owner 回覆（花錢／不可逆／私有資料）：開關仍開著、不扣步數；owner 一發話就清掉並接著跑。 */
  paused?: { question: string; options: string[]; at: number; gate?: WorkerAutopilotAskGate } | null;
};

function normalizePausedEntry(raw: unknown): { paused?: PersistedWorkerAutopilotState["paused"] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const value = raw as Record<string, unknown>;
  const question = bounded(value.question, 600);
  if (!question || typeof value.at !== "number" || !Number.isFinite(value.at)) return {};
  const options = Array.isArray(value.options) ? value.options.map((o) => bounded(o, 20)).filter(Boolean).slice(0, 4) : [];
  const gate = value.gate === "authorization" || value.gate === "owner_data" || value.gate === "choice" ? { gate: value.gate as WorkerAutopilotAskGate } : {};
  return { paused: { question, options, at: value.at, ...gate } };
}

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
      ...(typeof entry.goal === "string" && entry.goal.trim() ? { goal: entry.goal.trim().slice(0, 800) } : {}),
      ...normalizePausedEntry(entry.paused),
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
  // 根錨鎖死：goal 是 owner 開循環時的原話，模型回傳什麼都不能改寫或擴大它（以前只防改空，
  // 實測一路被吸附成「五件事併一句」的待辦大雜燴，每步對照的就不再是 owner 真正要的）。
  if (previous.goal) next.goal = previous.goal;
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
    kind: "stuck",
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
