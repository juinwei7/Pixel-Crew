// 部門任務的即時活動流：把 mission.executionEvents 整理成「NPC 發言＋工具小窗＋狀態列」，
// 讓使用者看得到部門內部在討論什麼、做什麼。DepartmentMissionDialog 與 BossTaskDesk 共用，
// 兩邊呈現一致。發言（text_delta）先合併成一段再顯示；只濾掉 thinking/delta/meta 雜訊。
import { t } from "../i18n";
import type { MissionExecutionEvent, RunnerEvent, ToolCallItem, WorkerState } from "../types";
import { RichText } from "./RichText";
import { ToolGroup, ToolRow } from "./QuestLog";

type MissionActivityTone = "ok" | "error" | "pending" | "neutral";

const MISSION_ACTIVITY_TONE_ICON: Record<MissionActivityTone, string> = { ok: "✓", error: "✕", pending: "…", neutral: "•" };

function missionActivityLabel({ event }: MissionExecutionEvent): string {
  if (event.type === "user_message") return event.text;
  if (event.type === "tool_call_start") return t("開始使用工具：{name}", { name: event.name });
  if (event.type === "tool_call_result") return event.isError ? t("工具執行失敗") : t("工具執行完成");
  if (event.type === "approval_requested") return t("等待核准：{title}", { title: event.request.title });
  if (event.type === "approval_resolved") return event.decision === "deny" ? t("核准已拒絕") : t("核准已允許");
  if (event.type === "turn_end") return event.isError ? t("本輪工作失敗") : t("本輪工作完成");
  if (event.type === "error") return t("錯誤：{message}", { message: event.message });
  return t("任務狀態已更新");
}

function missionActivityTone(event: RunnerEvent): MissionActivityTone {
  if (event.type === "error") return "error";
  if (event.type === "turn_end") return event.isError ? "error" : "ok";
  if (event.type === "approval_requested") return "pending";
  if (event.type === "approval_resolved") return event.decision === "deny" ? "error" : "ok";
  return "neutral";
}

type MissionActivityGroup =
  | { kind: "tools"; key: string; workerId: string; items: ToolCallItem[] }
  | { kind: "text"; key: string; workerId: string; text: string }
  | { kind: "event"; key: string; workerId: string; label: string; tone: MissionActivityTone };

// Coalesce consecutive tool calls into one ToolGroup, and consecutive text_delta from
// the same worker into one speech block, so the feed reads as a conversation rather
// than dozens of near-duplicate rows.
export function groupMissionActivity(events: MissionExecutionEvent[]): MissionActivityGroup[] {
  const groups: MissionActivityGroup[] = [];
  const pending = new Map<string, ToolCallItem>();
  events.forEach(({ workerId, event }, index) => {
    if (event.type === "tool_call_start") {
      const pendingKey = `${workerId}\0${event.id}`;
      const item: ToolCallItem = { kind: "tool_call", key: pendingKey, id: event.id, name: event.name, input: event.input, isError: false, status: "running" };
      pending.set(pendingKey, item);
      const last = groups[groups.length - 1];
      if (last?.kind === "tools" && last.workerId === workerId) last.items.push(item);
      else groups.push({ kind: "tools", key: `tools-${index}`, workerId, items: [item] });
      return;
    }
    if (event.type === "tool_call_result") {
      const item = pending.get(`${workerId}\0${event.id}`);
      if (item) {
        item.output = event.output;
        item.isError = event.isError;
        item.status = "done";
        return;
      }
    }
    if (event.type === "text_delta") {
      if (!event.text) return;
      const last = groups[groups.length - 1];
      if (last?.kind === "text" && last.workerId === workerId) last.text += event.text;
      else groups.push({ kind: "text", key: `text-${index}`, workerId, text: event.text });
      return;
    }
    groups.push({
      kind: "event",
      key: `event-${index}`,
      workerId,
      label: missionActivityLabel({ workerId, stepId: null, event }),
      tone: missionActivityTone(event),
    });
  });
  return groups;
}

// Filters the raw stream, coalesces, and caps to the last `limit` groups so a long
// turn is never sliced mid-sentence.
export function missionActivityGroups(events: MissionExecutionEvent[] | undefined, limit = 60): MissionActivityGroup[] {
  return groupMissionActivity(
    (events ?? []).filter(({ event }) => !["thinking_delta", "tool_call_output_delta", "meta"].includes(event.type)),
  ).slice(-limit);
}

export function MissionActivityFeed({ events, workers, limit = 60 }: {
  events: MissionExecutionEvent[] | undefined;
  workers: WorkerState[];
  limit?: number;
}) {
  const groups = missionActivityGroups(events, limit);
  if (groups.length === 0) return null;
  return <div className="mission-card__activity-list">
    {groups.map((group) => {
      const workerName = workers.find((candidate) => candidate.id === group.workerId)?.name ?? t("部門成員");
      if (group.kind === "tools") {
        return <div key={group.key} className="mission-activity-row">
          <span className="mission-activity-row__who">{workerName}</span>
          <div className="mission-activity-row__body">
            {group.items.length > 1 ? <ToolGroup items={group.items} summary /> : <ToolRow item={group.items[0]} />}
          </div>
        </div>;
      }
      if (group.kind === "text") {
        return <div key={group.key} className="mission-activity-row mission-activity-row--speech">
          <span className="mission-activity-row__who">{workerName}</span>
          <div className="mission-activity-row__body mission-activity-row__speech"><RichText text={group.text} compact /></div>
        </div>;
      }
      return <div key={group.key} className={`mission-activity-row mission-activity-row--${group.tone}`}>
        <span className="mission-activity-row__who">{workerName}</span>
        <span className="mission-activity-row__icon">{MISSION_ACTIVITY_TONE_ICON[group.tone]}</span>
        <span className="mission-activity-row__label">{group.label}</span>
      </div>;
    })}
  </div>;
}
