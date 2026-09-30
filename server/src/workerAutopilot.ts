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

export type WorkerAutopilotDecision =
  | { action: "continue"; instruction: string; reason: string; rung?: string; retro?: string }
  | { action: "stop"; reason: string; retro?: string };

/** 最近回合的精簡摘要：instruction＝當時送給 NPC 的話，result＝它回覆的截斷片段。 */
export type WorkerAutopilotTurn = {
  instruction: string;
  result?: string;
};

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
  /** 前幾輪循環留下的復盤教訓（新的在前）——讓循環之間累積經驗而不是每輪歸零。 */
  retros?: string[];
}): string {
  const turns = input.turns.slice(-6);
  const turnsBlock = turns.length
    ? turns
        .map((turn, index) => {
          const result = bounded(turn.result, 700);
          return t("{n}. 指示：{instruction}{result}", {
            n: index + 1,
            instruction: bounded(turn.instruction, 500),
            result: result ? t("\n   回覆摘要：{result}", { result }) : "",
          });
        })
        .join("\n")
    : t("（沒有可用的近期回合——這是自動循環的第一步。）");

  const retros = (input.retros ?? []).map((note) => bounded(note, 300)).filter(Boolean).slice(0, 8);
  const retroBlock = retros.length
    ? `\n\nLessons carried over from this NPC's previous loops (most recent first):\n${retros.map((note) => `- ${note}`).join("\n")}`
    : "";

  const scopeRule = input.proactive
    ? `- First finish or polish the NPC's CURRENT thread of work. Once that thread is genuinely concluded, PROACTIVELY pick the next most valuable thing this NPC can do alone: optimize or refactor what it produced, verify quality and fix weaknesses, extend coverage, research an adjacent topic that clearly serves this NPC's role and workspace, or prepare groundwork for upcoming work. Never busywork, never a restatement of the previous instruction, never "keep going" filler.
- PREFER CONTINUING. The owner checked "proactive mode": while steps remain, look hard for a genuinely useful next step before considering STOP. STOP only when the next step would need the owner's private data, credentials, an irreversible decision, or spending real money — or when you truly cannot find a next step whose value you can state in one concrete sentence.`
    : `- The instruction must continue the NPC's CURRENT thread of work with a genuinely valuable, concrete next step: deepen, verify, fix, extend, or conclude what it was just doing. Never busywork, never a restatement of the previous instruction, never "keep going" filler.
- If the current thread clearly has remaining parts, or obvious immediate follow-ups (finishing a started deliverable, fixing a found problem, verifying fresh output), continue with those FIRST before considering STOP. STOP when the thread has reached a natural conclusion, when the next step needs the owner's input/decision/data, or when the work would be speculative busywork. A good STOP beats a filler step — but do not stop while clearly valuable follow-through remains.`;

  return `Worker Autopilot · Single-NPC Self-Continuation

You are the chief of staff watching over ONE worker NPC. The owner turned ON this NPC's personal loop: after each of its turns finishes, you decide the single next instruction to send back to the SAME NPC so it keeps making genuine progress — or you stop the loop.

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
- Progress self-check: using the recent turns AND the carried-over lessons, state in the "reason" field what this step advances beyond what is already done. If you cannot name real progress in one concrete sentence, switch to a different rung or angle; if none exists, STOP honestly. Never spend remaining steps on filler.
- Retro: when you STOP, or when you issue the FINAL step, also include "retro" — one line with the most useful lesson from this loop (what worked, where it got stuck, what to do differently next time). It is saved and carried into this NPC's future loops.

Worker: ${JSON.stringify(input.workerName)}${input.role ? `\nRole: ${JSON.stringify(input.role)}` : ""}
Workspace: ${JSON.stringify(input.workspaceLabel)}
Loop steps remaining after this one: ${input.stepsRemaining}

Recent turns (oldest first):
${turnsBlock}${retroBlock}

Return only one marked JSON block, no Markdown fences:
<worker_autopilot_next>{"action":"continue","instruction":"the single next instruction for this NPC","reason":"one line: what this step advances beyond what is already done","rung":"one line: which rung the work stands on right now","retro":"only on the FINAL step: one-line lesson for future loops"}</worker_autopilot_next>
or
<worker_autopilot_next>{"action":"stop","reason":"one line: why stopping now is right","retro":"one line: the most useful lesson from this loop"}</worker_autopilot_next>`;
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
  if (value.action === "stop") {
    return { ok: true, decision: { action: "stop", reason, ...(retro ? { retro } : {}) } };
  }
  if (value.action !== "continue") {
    return { ok: false, reason: `"action" must be exactly "continue" or "stop", got ${JSON.stringify(value.action)}.` };
  }
  const instruction = stripWorkerAutopilotPrefix(bounded(value.instruction, 4_000));
  // 沒有可執行指示的 "continue" 一律當成 stop——寧可安全停下，也不要送空話進 NPC 的 session。
  if (!instruction) return { ok: true, decision: { action: "stop", reason: reason || "No concrete next instruction was produced.", ...(retro ? { retro } : {}) } };
  const rung = bounded(value.rung, 300);
  return { ok: true, decision: { action: "continue", instruction, reason, ...(rung ? { rung } : {}), ...(retro ? { retro } : {}) } };
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
  };
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
