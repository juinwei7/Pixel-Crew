import type {
  CharacterState,
  RunnerEvent,
  Turn,
  TurnItem,
  WorkerState,
} from "./types";
import { shortToolName, stationForTool } from "./stations";
import { t } from "./i18n";

// 把工具呼叫美化成好讀的中文短句（帶真實細節），取代直接吐英文工具名。3D/2D 小窗與對話泡共用。
function friendlyToolSpeech(name: string, input: unknown): string {
  const n = name.toLowerCase();
  const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const base = (p: unknown) => { const s = str(p); const parts = s.split(/[\\/]/); return parts[parts.length - 1] || s; };
  if (n === "bash" || n === "powershell" || n === "pwsh") {
    let c = str(o.command).replace(/\s+/g, " ").trim();
    // 短短的顯示額度要留給真正的指令：去掉開頭的切目錄前綴、把長路徑縮成 …\最後兩段
    c = c.replace(/^(?:Set-Location|Push-Location|cd)\s+(?:"[^"]*"|'[^']*'|[^\s;]+)\s*;\s*/i, "");
    c = c.replace(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"';|]+/g, (m) => { const parts = m.split(/[\\/]/); return parts.length > 2 ? `…\\${parts.slice(-2).join("\\")}` : m; });
    return c ? t("執行指令：{cmd}", { cmd: c.slice(0, 60) }) : t("執行指令");
  }
  if (n === "edit" || n === "write" || n === "notebookedit") { const f = base(o.file_path ?? o.path ?? o.notebook_path); return f ? t("編輯 {file}", { file: f }) : t("編輯程式碼"); }
  if (n === "read") { const f = base(o.file_path ?? o.path); return f ? t("讀取 {file}", { file: f }) : t("讀取檔案"); }
  if (n === "websearch" || n === "webfetch") { const q = str(o.query ?? o.q ?? o.url); return q ? t("上網查：{q}", { q: q.slice(0, 40) }) : t("上網搜尋"); }
  if (n === "grep") { const p = str(o.pattern); return p ? t("搜尋：{p}", { p: p.slice(0, 40) }) : t("搜尋程式碼"); }
  if (n === "glob") { const p = str(o.pattern); return p ? t("找檔案：{p}", { p: p.slice(0, 40) }) : t("找檔案"); }
  if (n === "task" || n.includes("agent")) return t("派發子任務…");
  if (n === "todowrite" || n === "todoread") return t("整理待辦清單…");
  if (n.includes("__")) return t("呼叫 {tool}…", { tool: shortToolName(name) });
  return t("使用 {tool}…", { tool: shortToolName(name) });
}

// 從 WebSearch/WebFetch(及 firecrawl 等)的工具輸入撈出查詢字或網址，給工作小窗抓真實截圖用。
function webQueryFromInput(input: unknown): string | undefined {
  if (typeof input === "string") return input.trim() || undefined;
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  const cand = o.query ?? o.q ?? o.url ?? o.search ?? o.prompt ?? o.text;
  const s = typeof cand === "string" ? cand.trim() : "";
  return s || undefined;
}

function readableFailureDetail(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return String(value ?? "").trim();
  const detail = value as Record<string, unknown>;
  const tool = detail.tool_name ?? detail.toolName ?? detail.name;
  const reason = detail.reason ?? detail.message ?? detail.error;
  if (tool || reason) {
    return [tool ? t("工具 {name}", { name: String(tool) }) : t("權限遭拒"), reason ? String(reason) : t("未獲授權")]
      .filter(Boolean)
      .join("：");
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function turnFailureReason(event: Extract<RunnerEvent, { type: "turn_end" }>): string {
  const details: string[] = [];
  const result = event.resultText.trim();
  if (result) details.push(result);
  for (const denial of event.permissionDenials) {
    const readable = readableFailureDetail(denial);
    if (readable) details.push(t("權限問題：{detail}", { detail: readable }));
  }
  return [...new Set(details)].join("\n") || t("Agent 回合失敗，但 CLI 沒有提供詳細原因；請重試或查看啟動 Pixel Crew 的終端輸出。");
}

function isAgentTool(name: string): boolean {
  return shortToolName(name).toLowerCase() === "agent";
}

function subagentInfo(input: unknown): { name: string; task: string } {
  const detail = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const description = String(detail.description ?? "").trim();
  const type = String(detail.subagent_type ?? detail.subagentType ?? "").trim();
  const prompt = String(detail.prompt ?? "").trim();
  const rawName = description || type || t("子代理");
  const characters = Array.from(rawName);
  return {
    name: characters.length > 20 ? `${characters.slice(0, 19).join("")}…` : rawName,
    task: description || (prompt.length > 80 ? `${prompt.slice(0, 79)}…` : prompt) || type || t("協助處理任務"),
  };
}

function isAsyncAgentResult(output: unknown): boolean {
  const text = readableFailureDetail(output);
  return /async agent launched successfully|agentId:\s*[a-z0-9]+/i.test(text);
}

export const INITIAL_CHARACTER: CharacterState = {
  activity: "idle",
  mood: "neutral",
  station: "home",
  speech: "",
  bump: 0,
};

export function emptyWorker(
  id: string,
  name: string,
  model: string | null,
  busy: boolean,
  colorIndex: number,
  provider: WorkerState["provider"],
  workspacePath: string,
  avatarId: string | null = null,
  persona: WorkerState["persona"] = null,
  avatarKind: WorkerState["avatarKind"] = avatarId ? "custom" : "preset",
  avatarPresetId = "classic",
  handoff: WorkerState["handoff"] = null,
  autoApproveMode: WorkerState["autoApproveMode"] = "off",
): WorkerState {
  return {
    id,
    name,
    model,
    busy,
    colorIndex,
    avatarId,
    avatarKind,
    avatarPresetId,
    provider,
    workspacePath,
    persona,
    autoApproveMode,
    handoff,
    turns: [],
    character: INITIAL_CHARACTER,
    subagents: [],
    meta: null,
    keyCounter: 0,
    openTextKey: null,
    openThinkingKey: null,
  };
}

/** Pure reducer — snapshot restore just replays the event history. */
export function applyRunnerEvent(w: WorkerState, event: RunnerEvent): WorkerState {
  const next: WorkerState = {
    ...w,
    turns: [...w.turns],
    character: { ...w.character },
    // Keep Fast Refresh and any older in-memory snapshots compatible with the
    // field introduced for temporary Agent NPCs.
    subagents: [...(w.subagents ?? [])],
  };

  const nextKey = () => `k${next.keyCounter++}`;

  const currentTurn = (): Turn | null => {
    const last = next.turns[next.turns.length - 1];
    return last && last.status === "running" ? { ...last, items: [...last.items] } : null;
  };
  const currentOrResumedTurn = (): Turn | null => {
    const running = currentTurn();
    if (running) return running;
    const last = next.turns[next.turns.length - 1];
    if (!last || last.status !== "done") return null;
    const resumed: Turn = { ...last, status: "running", items: [...last.items] };
    next.turns[next.turns.length - 1] = resumed;
    next.busy = true;
    return resumed;
  };
  const putTurn = (turn: Turn) => {
    next.turns[next.turns.length - 1] = turn;
  };
  const appendItem = (item: TurnItem, resume = false) => {
    const turn = resume ? currentOrResumedTurn() : currentTurn();
    if (!turn) return;
    turn.items.push(item);
    putTurn(turn);
  };

  switch (event.type) {
    case "user_message": {
      next.turns.push({
        key: nextKey(),
        command: event.text,
        departmentFollowUpMissionId: event.departmentFollowUpMissionId,
        status: "running",
        items: [],
      });
      next.busy = true;
      next.openTextKey = null;
      next.openThinkingKey = null;
      next.character = {
        activity: "thinking",
        mood: "neutral",
        station: "home",
        speech: "",
        speechAt: event.at,
        bump: next.character.bump + 1,
      };
      break;
    }
    case "text_delta": {
      const turn = currentOrResumedTurn();
      if (turn) {
        const idx = next.openTextKey
          ? turn.items.findIndex((i) => i.key === next.openTextKey)
          : -1;
        if (idx >= 0 && turn.items[idx].kind === "assistant_text") {
          turn.items[idx] = {
            ...turn.items[idx],
            text: (turn.items[idx] as TurnItem & { text: string }).text + event.text,
          } as TurnItem;
        } else {
          const key = nextKey();
          next.openTextKey = key;
          turn.items.push({ kind: "assistant_text", key, text: event.text });
        }
        putTurn(turn);
      }
      next.character.activity = "idle";
      next.character.mood = "neutral";
      next.character.speech = w.character.speech + event.text;
      next.character.speechAt = event.at ?? next.character.speechAt;
      break;
    }
    case "thinking_delta": {
      const turn = currentOrResumedTurn();
      if (turn) {
        const idx = next.openThinkingKey
          ? turn.items.findIndex((i) => i.key === next.openThinkingKey)
          : -1;
        if (idx >= 0 && turn.items[idx].kind === "thinking") {
          turn.items[idx] = {
            ...turn.items[idx],
            text: (turn.items[idx] as TurnItem & { text: string }).text + event.text,
          } as TurnItem;
        } else {
          const key = nextKey();
          next.openThinkingKey = key;
          turn.items.push({ kind: "thinking", key, text: event.text });
        }
        putTurn(turn);
      }
      next.character.activity = "thinking";
      break;
    }
    case "tool_call_start": {
      next.openTextKey = null;
      next.openThinkingKey = null;
      appendItem({
        kind: "tool_call",
        key: nextKey(),
        id: event.id,
        name: event.name,
        input: event.input,
        isError: false,
        status: "running",
      }, true);
      if (isAgentTool(event.name)) {
        const info = subagentInfo(event.input);
        next.subagents = [
          ...next.subagents.filter((agent) => agent.id !== event.id),
          { id: event.id, name: info.name, task: info.task, background: false },
        ];
      }
      const startStation = stationForTool(event.name, event.input);
      next.character = {
        activity: "working",
        mood: "neutral",
        station: startStation,
        speech: friendlyToolSpeech(event.name, event.input),
        speechAt: event.at,
        webQuery: startStation === "web" ? webQueryFromInput(event.input) : undefined,
        bump: next.character.bump + 1,
      };
      break;
    }
    case "tool_call_output_delta": {
      const turn = currentOrResumedTurn();
      if (turn) {
        const idx = turn.items.findIndex((item) => item.kind === "tool_call" && item.id === event.id);
        const item = idx >= 0 ? turn.items[idx] : null;
        if (item?.kind === "tool_call") {
          const current = typeof item.output === "string" ? item.output : "";
          turn.items[idx] = { ...item, output: `${current}${event.delta}`.slice(-200_000) };
          putTurn(turn);
        }
      }
      break;
    }
    case "approval_requested": {
      appendItem({
        kind: "approval",
        key: nextKey(),
        request: event.request,
        status: "pending",
      }, true);
      next.character.activity = "thinking";
      next.character.mood = "neutral";
      next.character.speech = t("等待核准…");
      next.character.speechAt = event.at ?? next.character.speechAt;
      break;
    }
    case "approval_resolved": {
      const turn = currentOrResumedTurn();
      if (turn) {
        const idx = turn.items.findIndex(
          (item) => item.kind === "approval" && item.request.id === event.id,
        );
        if (idx >= 0 && turn.items[idx].kind === "approval") {
          turn.items[idx] = { ...turn.items[idx], status: "resolved", decision: event.decision };
          putTurn(turn);
        }
      }
      next.character.activity = "working";
      next.character.speech = event.decision === "deny" ? t("已拒絕操作") : t("繼續執行…");
      next.character.speechAt = event.at ?? next.character.speechAt;
      break;
    }
    case "tool_call_result": {
      const turn = currentTurn();
      let completedAgent = false;
      if (turn) {
        const idx = turn.items.findIndex(
          (i) => i.kind === "tool_call" && (i as { id?: string }).id === event.id,
        );
        if (idx >= 0) {
          completedAgent = isAgentTool(turn.items[idx].kind === "tool_call" ? turn.items[idx].name : "");
          turn.items[idx] = {
            ...turn.items[idx],
            output: event.output,
            isError: event.isError,
            status: "done",
          } as TurnItem;
          putTurn(turn);
        }
      }
      if (completedAgent) {
        if (!event.isError && isAsyncAgentResult(event.output)) {
          next.subagents = next.subagents.map((agent) =>
            agent.id === event.id ? { ...agent, background: true } : agent,
          );
        } else {
          next.subagents = next.subagents.filter((agent) => agent.id !== event.id);
        }
      }
      next.character.activity = "idle";
      next.character.mood = event.isError ? "error" : "success";
      next.character.bump = next.character.bump + 1;
      break;
    }
    case "turn_end": {
      const turn = currentTurn();
      if (turn) {
        turn.items = turn.items.map((item) =>
          item.kind === "approval" && item.status === "pending"
            ? { ...item, status: "resolved", decision: "deny" as const }
            : item,
        );
        turn.status = event.isError ? "error" : "done";
        turn.costUsd = event.costUsd;
        turn.durationMs = event.durationMs;
        turn.contextTokens = event.contextTokens;
        if (event.isError) {
          turn.items.push({
            kind: "system_error",
            key: nextKey(),
            text: turnFailureReason(event),
          });
        } else {
          // The CLI result is authoritative. In practice the final turn event
          // can reach the UI before its buffered text deltas; those late deltas
          // cannot be attached after the turn is closed. Preserve the complete
          // answer here, while avoiding duplication in the normal ordered path.
          const result = event.resultText.trim();
          if (result) {
            let lastTextIndex = -1;
            for (let index = turn.items.length - 1; index >= 0; index--) {
              if (turn.items[index].kind === "assistant_text") {
                lastTextIndex = index;
                break;
              }
            }
            const lastItem = lastTextIndex >= 0 ? turn.items[lastTextIndex] : null;
            const lastText = lastItem?.kind === "assistant_text" ? lastItem.text.trim() : "";
            if (lastText !== result) {
              if (lastText && result.startsWith(lastText)) {
                turn.items[lastTextIndex] = {
                  ...turn.items[lastTextIndex],
                  text: result,
                } as TurnItem;
              } else {
                turn.items.push({ kind: "assistant_text", key: nextKey(), text: result });
              }
            }
          }
        }
        putTurn(turn);
      }
      next.busy = false;
      next.openTextKey = null;
      next.openThinkingKey = null;
      next.subagents = [];
      next.character = {
        ...next.character,
        activity: "idle",
        mood: event.isError ? "error" : "success",
        station: "home",
        bump: next.character.bump + 1,
      };
      break;
    }
    case "meta": {
      next.meta = {
        model: event.model,
        slashCommands: event.slashCommands,
        mcpServers: event.mcpServers,
        toolCount: event.toolCount,
        builtinTools: event.builtinTools,
      };
      break;
    }
    case "error": {
      let turn = currentTurn();
      let turnIndex = next.turns.length - 1;
      if (!turn) {
        turnIndex = -1;
        for (let index = next.turns.length - 1; index >= 0; index--) {
          if (next.turns[index].status === "error") {
            turnIndex = index;
            break;
          }
        }
        const failed = next.turns[turnIndex];
        if (failed) turn = { ...failed, items: [...failed.items] };
      }
      if (turn) {
        turn.status = "error";
        turn.items = turn.items.map((item) =>
          item.kind === "approval" && item.status === "pending"
            ? { ...item, status: "resolved", decision: "deny" as const }
            : item,
        );
        turn.items.push({ kind: "system_error", key: nextKey(), text: event.message });
        next.turns[turnIndex] = turn;
      }
      next.busy = false;
      next.subagents = [];
      next.character = {
        ...next.character,
        activity: "idle",
        mood: "error",
        speech: event.message,
        speechAt: event.at,
        bump: next.character.bump + 1,
      };
      break;
    }
  }

  return next;
}
