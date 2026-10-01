import type { CapabilityState } from "./capabilities.js";
import { t } from "./i18n.js";
import { autoApprovalPolicy } from "./dangerousCommand.js";

export type ToolEffect = "read" | "write" | "unknown";

export type ToolPolicyDecision = {
  effect: ToolEffect;
  allowed: boolean;
  reason: string;
  source: "builtin" | "mcp_annotation" | "unknown";
};

const READ_ONLY_BUILTINS = new Set(["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);

export function readOnlyBuiltinToolNames(): string[] {
  return [...READ_ONLY_BUILTINS];
}

/**
 * options.allowSafeShell（支柱 B · 探索唯讀 Bash）：開啟後，Bash 不再一律拒絕，改用
 * autoApprovalPolicy 的 "safe" 分類——唯讀安全指令（npm test/tsc/ls/cat/git status…）放行、
 * 危險指令（rm -rf/sudo/下載即執行…）與寫檔重導向一律拒絕。重用既有已驗分類器，不另寫判斷。
 * 只對 Bash 生效；其他寫入型工具（Write/Edit/MCP 未標唯讀）仍一律拒絕。
 */
export function queryToolPolicy(
  toolName: string,
  allowedMcpTools: ReadonlySet<string>,
  options?: { allowSafeShell?: boolean; command?: string },
): ToolPolicyDecision {
  if (READ_ONLY_BUILTINS.has(toolName)) {
    return { effect: "read", allowed: true, reason: t("內建唯讀工具"), source: "builtin" };
  }
  if (options?.allowSafeShell && toolName === "Bash") {
    const verdict = autoApprovalPolicy("Bash", options.command);
    return verdict.allowed
      ? { effect: "read", allowed: true, reason: t("唯讀安全指令"), source: "builtin" }
      : { effect: "write", allowed: false, reason: verdict.reason ?? t("指令不在唯讀／驗證安全清單"), source: "builtin" };
  }
  if (allowedMcpTools.has(toolName)) {
    return { effect: "read", allowed: true, reason: t("MCP 工具標示為唯讀"), source: "mcp_annotation" };
  }
  return {
    effect: toolName.startsWith("mcp__") ? "unknown" : "write",
    allowed: false,
    reason: toolName.startsWith("mcp__") ? t("MCP 工具未提供可信的唯讀標記") : t("工具可能修改本機或系統狀態"),
    source: "unknown",
  };
}

function sanitizeServerName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, "_");
}

export function readOnlyMcpToolNames(capabilities: CapabilityState): string[] {
  return capabilities.mcpServers.flatMap((server) =>
    (server.tools ?? [])
      .filter((tool) => tool.readOnlyHint === true && tool.destructiveHint !== true)
      .map((tool) => `mcp__${sanitizeServerName(server.name)}__${tool.name}`),
  );
}
