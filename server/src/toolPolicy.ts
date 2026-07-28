import type { CapabilityState } from "./capabilities.js";

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

export function queryToolPolicy(toolName: string, allowedMcpTools: ReadonlySet<string>): ToolPolicyDecision {
  if (READ_ONLY_BUILTINS.has(toolName)) {
    return { effect: "read", allowed: true, reason: "內建唯讀工具", source: "builtin" };
  }
  if (allowedMcpTools.has(toolName)) {
    return { effect: "read", allowed: true, reason: "MCP 工具標示為唯讀", source: "mcp_annotation" };
  }
  return {
    effect: toolName.startsWith("mcp__") ? "unknown" : "write",
    allowed: false,
    reason: toolName.startsWith("mcp__") ? "MCP 工具未提供可信的唯讀標記" : "工具可能修改本機或系統狀態",
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
