import assert from "node:assert/strict";
import test from "node:test";
import { buildCodexArgs, CodexSession, codexAppTool, codexChildEnv, codexPersonaConfig, codexTool, codexTurnInput, parseCodexNativeCommand } from "../src/codexRunner.js";
import type { RunnerEvent } from "../src/claudeRunner.js";

/**
 * Feeds a fake server-initiated JSON-RPC request straight into the session's
 * line handler, as if Codex's app-server had sent it over stdout — without
 * spawning a real `codex` process. `child` is stubbed so resolveApproval's
 * write-back doesn't throw on a null child.
 */
function deliverServerRequest(session: CodexSession, method: string, params: unknown, id = 1): void {
  (session as unknown as { child: unknown }).child = { stdin: { write: () => {} } };
  (session as unknown as { handleRpcLine(line: string, generation: number): void }).handleRpcLine(
    JSON.stringify({ method, id, params }),
    (session as unknown as { generation: number }).generation,
  );
}

function requests(events: RunnerEvent[]) {
  return events.filter((event): event is Extract<RunnerEvent, { type: "approval_requested" }> => event.type === "approval_requested");
}

function resolved(events: RunnerEvent[]) {
  return events.filter((event): event is Extract<RunnerEvent, { type: "approval_resolved" }> => event.type === "approval_resolved");
}

test("parses only the Codex native commands implemented by Pixel Crew", () => {
  assert.deepEqual(parseCodexNativeCommand("/clear"), { type: "reset" });
  assert.deepEqual(parseCodexNativeCommand(" /new "), { type: "reset" });
  assert.deepEqual(parseCodexNativeCommand("/compact"), { type: "compact" });
  assert.deepEqual(parseCodexNativeCommand("/review focus on auth"), { type: "review", instructions: "focus on auth" });
  assert.equal(parseCodexNativeCommand("/compact later"), null);
  assert.equal(parseCodexNativeCommand("/theme"), null);
});

test("dispatches compact through app-server instead of sending it as a prompt", async () => {
  const events: RunnerEvent[] = [];
  const writes: any[] = [];
  const session = new CodexSession((event) => events.push(event), "/repo");
  const internals = session as unknown as {
    child: { stdin: { write(data: string): void } };
    ready: Promise<string>;
    generation: number;
    handleRpcLine(line: string, generation: number): void;
  };
  internals.child = { stdin: { write: (data) => writes.push(JSON.parse(data)) } };
  internals.ready = Promise.resolve("thread-1");

  session.send("/compact");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, [{ method: "thread/compact/start", id: 1, params: { threadId: "thread-1" } }]);

  internals.handleRpcLine(JSON.stringify({ id: 1, result: {} }), internals.generation);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.busy, true); // accepted is not the same as compacted

  internals.handleRpcLine(JSON.stringify({ method: "thread/compacted", params: { threadId: "thread-1" } }), internals.generation);
  assert.equal(events.some((event) => event.type === "turn_end" && event.resultText.includes("已壓縮")), true);
  assert.equal(session.busy, false);
});

test("auto-approve resolves a safe command without prompting", () => {
  const events: RunnerEvent[] = [];
  const session = new CodexSession((event) => events.push(event), "/repo", () => "", () => true);
  deliverServerRequest(session, "item/commandExecution/requestApproval", { command: "npm test", itemId: "item-1" });

  assert.equal(requests(events).length, 1);
  assert.equal(resolved(events).length, 1);
  assert.equal(resolved(events)[0].decision, "auto_allow");
  assert.equal(session.resolveApproval(requests(events)[0].request.id, "deny"), false); // already resolved, nothing pending
});

test("auto-approve still prompts for a command outside the safe allowlist", () => {
  const events: RunnerEvent[] = [];
  const session = new CodexSession((event) => events.push(event), "/repo", () => "", () => true);
  deliverServerRequest(session, "item/commandExecution/requestApproval", { command: "rm -rf /", itemId: "item-1" });

  assert.equal(requests(events).length, 1);
  assert.equal(resolved(events).length, 0);
  assert.match(requests(events)[0].request.reason ?? "", /自動核准已開啟/);
  assert.equal(session.resolveApproval(requests(events)[0].request.id, "deny"), true);
  assert.equal(resolved(events).length, 1);
  assert.equal(resolved(events)[0].decision, "deny");
});

test("auto-approve off by default — existing worker behavior is unchanged", () => {
  const events: RunnerEvent[] = [];
  const session = new CodexSession((event) => events.push(event), "/repo");
  deliverServerRequest(session, "item/commandExecution/requestApproval", { command: "npm test", itemId: "item-1" });

  assert.equal(requests(events).length, 1);
  assert.equal(resolved(events).length, 0);
  assert.deepEqual(requests(events)[0].request.decisions, ["allow_once", "allow_session", "deny"]);
});

test("safe mode never auto-approves file-change or permission requests", () => {
  const events: RunnerEvent[] = [];
  const session = new CodexSession((event) => events.push(event), "/repo", () => "", () => "safe");
  deliverServerRequest(session, "item/fileChange/requestApproval", { itemId: "item-1" });
  deliverServerRequest(session, "item/permissions/requestApproval", { itemId: "item-2", permissions: ["network"] }, 2);

  assert.equal(requests(events).length, 2);
  assert.equal(resolved(events).length, 0); // both still pending, no auto-resolution
});

test("full mode auto-approves file-change and permission requests too, using the permissions-shaped RPC reply", () => {
  const events: RunnerEvent[] = [];
  const session = new CodexSession((event) => events.push(event), "/repo", () => "", () => "full");
  const writes: unknown[] = [];
  const sessionInternals = session as unknown as {
    child: { stdin: { write(data: string): void } };
    generation: number;
    handleRpcLine(line: string, generation: number): void;
  };
  sessionInternals.child = { stdin: { write: (data: string) => writes.push(JSON.parse(data)) } };
  sessionInternals.handleRpcLine(
    JSON.stringify({ method: "item/fileChange/requestApproval", id: 1, params: { itemId: "item-1" } }),
    sessionInternals.generation,
  );
  sessionInternals.handleRpcLine(
    JSON.stringify({ method: "item/permissions/requestApproval", id: 2, params: { itemId: "item-2", permissions: ["network"] } }),
    sessionInternals.generation,
  );

  assert.equal(requests(events).length, 2);
  assert.equal(resolved(events).length, 2);
  assert.ok(resolved(events).every((event) => event.decision === "auto_allow"));
  // item/permissions/requestApproval needs a {permissions, scope} reply, not {decision}.
  assert.deepEqual(writes, [
    { decision: "accept" },
    { permissions: ["network"], scope: "turn" },
  ].map((result, index) => ({ id: index + 1, result })));
});

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

test("builds structured Codex image inputs instead of prompt placeholders", () => {
  assert.deepEqual(codexTurnInput("inspect this", ["/tmp/screenshot.png"]), [
    { type: "text", text: "inspect this" },
    { type: "localImage", path: "/tmp/screenshot.png" },
  ]);
  assert.deepEqual(codexTurnInput("", ["C:\\Temp\\shot.jpg"]), [
    { type: "localImage", path: "C:\\Temp\\shot.jpg" },
  ]);
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
