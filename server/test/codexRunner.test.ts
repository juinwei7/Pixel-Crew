import assert from "node:assert/strict";
import test from "node:test";
import { buildCodexArgs, codexAppTool, codexChildEnv, codexPersonaConfig, codexTool } from "../src/codexRunner.js";

test("builds first-turn and resume Codex commands with stable option ordering", () => {
  assert.deepEqual(
    buildCodexArgs({
      sessionId: "unused",
      completedTurns: 0,
      model: "gpt-5.4",
      sandbox: "workspace-write",
      prompt: "hello",
    }),
    [
      "exec",
      "--json",
      "--color",
      "never",
      "--sandbox",
      "workspace-write",
      "--model",
      "gpt-5.4",
      "hello",
    ],
  );
  assert.deepEqual(
    buildCodexArgs({
      sessionId: "thread-123",
      completedTurns: 1,
      sandbox: "workspace-write",
      prompt: "continue",
    }),
    ["exec", "resume", "--json", "thread-123", "continue"],
  );
});

test("normalizes Codex command and MCP items to the shared tool event shape", () => {
  assert.deepEqual(
    codexTool({
      type: "command_execution",
      command: "npm test",
      aggregated_output: "ok",
      exit_code: 0,
      status: "completed",
    }),
    { name: "Bash", input: { command: "npm test" }, output: "ok", isError: false },
  );
  assert.deepEqual(
    codexTool({
      type: "mcp_tool_call",
      server: "docs",
      tool: "search",
      arguments: { query: "auth" },
      error: "offline",
      status: "failed",
    }),
    {
      name: "mcp__docs__search",
      input: { query: "auth" },
      output: "offline",
      isError: true,
    },
  );
});

test("removes host Codex runtime flags while preserving user configuration", () => {
  assert.deepEqual(
    codexChildEnv({
      PATH: "/bin",
      CODEX_HOME: "/home/user/.codex",
      CODEX_THREAD_ID: "host-thread",
      CODEX_SANDBOX_NETWORK_DISABLED: "1",
      CODEX_PERMISSION_PROFILE: "managed",
    }),
    {
      PATH: "/bin",
      CODEX_HOME: "/home/user/.codex",
    },
  );
});

test("quotes persona instruction paths for Codex config overrides", () => {
  assert.equal(
    codexPersonaConfig("/Users/test/data info/persona.md"),
    'model_instructions_file="/Users/test/data info/persona.md"',
  );
  assert.equal(
    codexPersonaConfig("C:\\Users\\test\\persona.md"),
    'model_instructions_file="C:\\\\Users\\\\test\\\\persona.md"',
  );
});

test("normalizes app-server command, MCP, and collab-agent items", () => {
  assert.deepEqual(codexAppTool({
    type: "commandExecution",
    command: "npm test",
    cwd: "/repo",
    commandActions: [{ type: "read" }],
    aggregatedOutput: "ok",
    exitCode: 0,
    status: "completed",
  }), {
    name: "Bash",
    input: { command: "npm test", cwd: "/repo", actions: [{ type: "read" }] },
    output: "ok",
    isError: false,
  });
  assert.deepEqual(codexAppTool({
    type: "mcpToolCall",
    server: "docs",
    tool: "search",
    arguments: { query: "approval" },
    result: { content: [{ type: "text", text: "found" }] },
    status: "completed",
  })?.name, "mcp__docs__search");
  assert.deepEqual(codexAppTool({
    type: "collabAgentToolCall",
    tool: "spawnAgent",
    prompt: "review this",
    receiverThreadIds: ["thread-2"],
    agentsStates: { "thread-2": "running" },
    status: "inProgress",
  })?.name, "Agent");
});
