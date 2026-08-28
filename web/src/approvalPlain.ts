import type { ApprovalRequest } from "./types";
import { parseMcpToolName } from "./mcpToolName";
import { t } from "./i18n";

// 審批白話化：把「工具名＋原始輸入」翻成老闆看得懂的「它想做什麼、有什麼風險」。
// 風險判定不在這裡重造——指令的危險判定由後端 dangerousCommand.ts 算好放進 riskReason。
export type PlainApproval = {
  action: string;
  target?: string;
  risk: string;
  level: "safe" | "caution" | "danger";
};

const READ_ONLY_TOOLS: Record<string, string> = {
  Read: t("讀取一個檔案的內容"),
  Glob: t("列出符合條件的檔案"),
  Grep: t("在專案裡搜尋文字"),
  WebSearch: t("上網搜尋資料"),
  WebFetch: t("抓取一個網頁的內容"),
};

const FILE_TOOL_ACTIONS: Record<string, string> = {
  Edit: t("修改一個檔案"),
  Write: t("新建或覆寫一個檔案"),
  NotebookEdit: t("編輯一個筆記本檔案"),
};

const OTHER_TOOL_ACTIONS: Record<string, string> = {
  Task: t("派出一個子代理去做事"),
  Agent: t("派出一個子代理去做事"),
  KillShell: t("終止一個背景指令"),
};

function inputField(input: unknown, keys: string[]): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  for (const key of keys) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 200);
  }
  return undefined;
}

export function describeApproval(request: ApprovalRequest): PlainApproval {
  const toolName = request.toolName ?? "";

  if (request.category === "command") {
    const firstLine = (request.command ?? "").trim().split("\n")[0]?.slice(0, 160);
    if (request.riskReason) {
      return { action: t("在終端機執行一條指令"), target: firstLine, risk: t("高風險：{reason}", { reason: request.riskReason }), level: "danger" };
    }
    return {
      action: t("在終端機執行一條指令"),
      target: firstLine,
      risk: t("不在安全白名單內，可能改動檔案或系統狀態，請看一下指令內容"),
      level: "caution",
    };
  }

  if (request.category === "file_change") {
    return {
      action: FILE_TOOL_ACTIONS[toolName] ?? t("改動檔案內容"),
      target: inputField(request.input, ["file_path", "path", "notebook_path"]),
      risk: t("會改寫這個檔案（改壞了可從版本控制或備份救回）"),
      level: "caution",
    };
  }

  if (request.category === "permissions") {
    return { action: t("要求額外的工作權限"), risk: t("核准後這個回合能做的事會變多，範圍見上方說明"), level: "caution" };
  }

  // category === "tool"
  if (READ_ONLY_TOOLS[toolName]) {
    return {
      action: READ_ONLY_TOOLS[toolName],
      target: inputField(request.input, ["file_path", "path", "url", "query", "pattern"]),
      risk: t("唯讀操作，不會改動任何東西"),
      level: "safe",
    };
  }
  if (OTHER_TOOL_ACTIONS[toolName]) {
    return { action: OTHER_TOOL_ACTIONS[toolName], risk: t("會用它自己的權限繼續動作，內容見技術細節"), level: "caution" };
  }
  if (toolName.startsWith("mcp__")) {
    const meta = parseMcpToolName(toolName);
    return {
      action: t("使用外部服務「{server}」的工具：{label}", { server: meta.mcpServer ?? "MCP", label: meta.label }),
      risk: t("外部工具，實際行為由該服務決定；不確定就先拒絕"),
      level: "caution",
    };
  }
  // 舊事件沒存 toolName 時退回 title，至少不顯示「未知工具」
  return {
    action: toolName ? t("使用工具 {name}", { name: toolName }) : request.title,
    risk: t("非唯讀工具，可能改動狀態"),
    level: "caution",
  };
}
