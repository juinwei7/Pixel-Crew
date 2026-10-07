import assert from "node:assert/strict";
import test from "node:test";
import type { CapabilityState } from "../src/capabilities.js";
import type { RunnerEvent } from "../src/claudeRunner.js";
import { CodexSession } from "../src/codexRunner.js";
import { isSessionPlanTool, queryToolPolicy, readOnlyMcpToolNames } from "../src/toolPolicy.js";

test("query policy permits built-in reads and explicitly annotated MCP tools", () => {
  const allowed = new Set(["mcp__my-hub__list_pending"]);
  assert.equal(queryToolPolicy("Read", allowed).allowed, true);
  assert.equal(queryToolPolicy("mcp__my-hub__list_pending", allowed).allowed, true);
});

test("query policy denies unknown MCP tools and state-changing local tools", () => {
  const allowed = new Set<string>();
  assert.deepEqual(queryToolPolicy("mcp__my-hub__close_item", allowed), {
    effect: "unknown",
    allowed: false,
    reason: "MCP 工具未提供可信的唯讀標記",
    source: "unknown",
  });
  assert.equal(queryToolPolicy("Edit", allowed).allowed, false);
  assert.equal(queryToolPolicy("Bash", allowed).allowed, false);
});

test("read-only MCP catalog requires readOnlyHint and rejects destructive tools", () => {
  const capabilities: CapabilityState = {
    slashCommands: [],
    mcpServers: [{
      name: "my hub",
      status: "connected",
      toolsStatus: "available",
      tools: [
        { name: "list_pending", readOnlyHint: true },
        { name: "ambiguous" },
        { name: "delete_item", readOnlyHint: true, destructiveHint: true },
      ],
    }],
    models: [],
    toolCount: 3,
    builtinTools: null,
    loading: false,
    source: "live",
    updatedAt: null,
    error: null,
  };
  assert.deepEqual(readOnlyMcpToolNames(capabilities), ["mcp__my_hub__list_pending"]);
});

test("Codex's synthetic plan event counts as a session plan tool, not a tool use that aborts no_tools/read-only turns", () => {
  const events: RunnerEvent[] = [];
  const session = new CodexSession((event) => events.push(event), "/repo", () => "", () => false);
  (session as unknown as { handleRpcLine(line: string, generation: number): void }).handleRpcLine(
    JSON.stringify({ method: "turn/plan/updated", params: { plan: [{ step: "讀", status: "inProgress" }] } }),
    (session as unknown as { generation: number }).generation,
  );
  const start = events.find((event) => event.type === "tool_call_start");
  assert.ok(start && start.type === "tool_call_start");
  assert.equal(isSessionPlanTool(start.name), true);
  for (const tool of ["Bash", "Write", "Edit", "Read", "mcp__todo__write"]) assert.equal(isSessionPlanTool(tool), false, tool);
});
