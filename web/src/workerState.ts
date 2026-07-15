import type {
  CharacterState,
  RunnerEvent,
  Turn,
  TurnItem,
  WorkerState,
} from "./types";
import { shortToolName, stationForTool } from "./stations";

function readableFailureDetail(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return String(value ?? "").trim();
  const detail = value as Record<string, unknown>;
  const tool = detail.tool_name ?? detail.toolName ?? detail.name;
  const reason = detail.reason ?? detail.message ?? detail.error;
  if (tool || reason) {
    return [tool ? `工具 ${String(tool)}` : "權限遭拒", reason ? String(reason) : "未獲授權"]
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
    if (readable) details.push(`權限問題：${readable}`);
  }
  return [...new Set(details)].join("\n") || "Agent 回合失敗，但 CLI 沒有提供詳細原因；請重試或查看啟動 Pixel Crew 的終端輸出。";
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
): WorkerState {
  return {
    id,
    name,
    model,
    busy,
    colorIndex,
    provider,
    workspacePath,
    turns: [],
    character: INITIAL_CHARACTER,
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
  };

  const nextKey = () => `k${next.keyCounter++}`;

  const currentTurn = (): Turn | null => {
    const last = next.turns[next.turns.length - 1];
    return last && last.status === "running" ? { ...last, items: [...last.items] } : null;
  };
  const putTurn = (turn: Turn) => {
    next.turns[next.turns.length - 1] = turn;
  };
  const appendItem = (item: TurnItem) => {
    const turn = currentTurn();
    if (!turn) return;
    turn.items.push(item);
    putTurn(turn);
  };

  switch (event.type) {
    case "user_message": {
      next.turns.push({
        key: nextKey(),
        command: event.text,
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
        bump: next.character.bump + 1,
      };
      break;
    }
    case "text_delta": {
      const turn = currentTurn();
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
      break;
    }
    case "thinking_delta": {
      const turn = currentTurn();
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
      });
      next.character = {
        activity: "working",
        mood: "neutral",
        station: stationForTool(event.name, event.input),
        speech: `使用 ${shortToolName(event.name)}…`,
        bump: next.character.bump + 1,
      };
      break;
    }
    case "tool_call_result": {
      const turn = currentTurn();
      if (turn) {
        const idx = turn.items.findIndex(
          (i) => i.kind === "tool_call" && (i as { id?: string }).id === event.id,
        );
        if (idx >= 0) {
          turn.items[idx] = {
            ...turn.items[idx],
            output: event.output,
            isError: event.isError,
            status: "done",
          } as TurnItem;
          putTurn(turn);
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
        turn.status = event.isError ? "error" : "done";
        turn.costUsd = event.costUsd;
        turn.durationMs = event.durationMs;
        if (event.isError) {
          turn.items.push({
            kind: "system_error",
            key: nextKey(),
            text: turnFailureReason(event),
          });
        }
        putTurn(turn);
      }
      next.busy = false;
      next.openTextKey = null;
      next.openThinkingKey = null;
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
        turn.items.push({ kind: "system_error", key: nextKey(), text: event.message });
        next.turns[turnIndex] = turn;
      }
      next.busy = false;
      next.character = {
        ...next.character,
        activity: "idle",
        mood: "error",
        speech: event.message,
        bump: next.character.bump + 1,
      };
      break;
    }
  }

  return next;
}
