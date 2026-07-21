// Claude/Codex both prefix MCP tool-call names as `mcp__<server>__<tool>`.
// Shared so QuestLog's tool badges and the MCP modal's "used tools" fallback
// agree on the same parsing.
export function parseMcpToolName(name: string): { label: string; mcpServer: string | null } {
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return { label: parts.slice(2).join("__") || name, mcpServer: parts[1] ?? null };
  }
  return { label: name, mcpServer: null };
}
