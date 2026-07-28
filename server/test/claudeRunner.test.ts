import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { approvalBridgeLaunch, claudeMessageContent, ClaudeSession, type RunnerEvent } from "../src/claudeRunner.js";

test("approval MCP bridge starts outside the Pixel Crew working directory", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pixel-crew-approval-cwd-"));
  try {
    const { args } = approvalBridgeLaunch();
    assert.match(args[1] ?? "", /^file:\/\//);
    const message = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const result = spawnSync(process.execPath, args, {
      cwd,
      input: `${message}\n`,
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout.trim());
    assert.equal(response.result.tools[0].name, "approval_prompt");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("allow-for-session returns only scoped Claude permission suggestions as in-memory rules", async () => {
  const events: RunnerEvent[] = [];
  const session = new ClaudeSession((event) => events.push(event), "/repo");
  session.busy = true; // the bridge only serves prompts during an active turn
  const token = (session as unknown as { approvalToken: string }).approvalToken;
  const requests = () => events.filter((event) => event.type === "approval_requested");

  // First Bash call prompts, and now offers the "allow for session" option.
  const first = session.handleApprovalBridge(token, {
    tool_name: "Bash",
    input: { command: "npm test" },
    permission_suggestions: [{
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "npm test" }],
      behavior: "allow",
      destination: "localSettings",
    }],
  });
  assert.ok(first instanceof Promise);
  assert.equal(requests().length, 1);
  const request = (requests()[0] as Extract<RunnerEvent, { type: "approval_requested" }>).request;
  assert.deepEqual(request.decisions, ["allow_once", "allow_session", "deny"]);

  session.resolveApproval(request.id, "allow_session");
  assert.deepEqual(await first, {
    behavior: "allow",
    updatedInput: { command: "npm test" },
    updatedPermissions: [{
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "npm test" }],
      behavior: "allow",
      destination: "session",
    }],
  });

  // Pixel Crew itself never turns that grant into blanket Bash access. Claude
  // Code applies the returned scoped rule and decides whether to ask again.
  const second = session.handleApprovalBridge(token, { tool_name: "Bash", input: { command: "rm -rf /" } });
  assert.ok(second instanceof Promise);
  assert.equal(requests().length, 2);
  const secondRequest = (requests()[1] as Extract<RunnerEvent, { type: "approval_requested" }>).request;
  assert.deepEqual(secondRequest.decisions, ["allow_once", "deny"]);
  session.resolveApproval(secondRequest.id, "deny");
  await second;
  session.stop();
});

test("rejects bare or cross-tool permission suggestions", () => {
  const events: RunnerEvent[] = [];
  const session = new ClaudeSession((event) => events.push(event), "/repo");
  session.busy = true;
  const token = (session as unknown as { approvalToken: string }).approvalToken;
  session.handleApprovalBridge(token, {
    tool_name: "Bash",
    input: { command: "ls" },
    permission_suggestions: [{
      type: "addRules",
      rules: [{ toolName: "Bash" }, { toolName: "Write", ruleContent: "/repo/**" }],
      behavior: "allow",
      destination: "userSettings",
    }],
  });
  const request = events.find((event): event is Extract<RunnerEvent, { type: "approval_requested" }> => event.type === "approval_requested")!.request;
  assert.deepEqual(request.decisions, ["allow_once", "deny"]);
  assert.equal(session.resolveApproval(request.id, "allow_session"), false);
  session.resolveApproval(request.id, "deny");
  session.stop();
});

test("auto-approve resolves allowlisted tool calls without prompting, but still prompts for dangerous or unknown actions", async () => {
  const events: RunnerEvent[] = [];
  const session = new ClaudeSession(
    (event) => events.push(event),
    "/repo",
    () => [],
    () => "",
    () => "safe", // narrow allowlist — anything not on it still prompts
  );
  session.busy = true;
  const token = (session as unknown as { approvalToken: string }).approvalToken;
  const requests = () => events.filter((event): event is Extract<RunnerEvent, { type: "approval_requested" }> => event.type === "approval_requested");
  const resolved = () => events.filter((event): event is Extract<RunnerEvent, { type: "approval_resolved" }> => event.type === "approval_resolved");

  // A safe Bash call resolves immediately — no pending approval left to answer.
  const safe = await session.handleApprovalBridge(token, { tool_name: "Bash", input: { command: "npm test" } });
  assert.deepEqual(safe, { behavior: "allow", updatedInput: { command: "npm test" } });
  assert.equal(requests().length, 1);
  assert.equal(resolved().length, 1);
  assert.equal(resolved()[0].decision, "auto_allow");
  assert.equal(session.resolveApproval(requests()[0].request.id, "deny"), false); // already resolved

  // A dangerous command still blocks on a real approval despite auto-approve.
  const dangerousPromise = session.handleApprovalBridge(token, { tool_name: "Bash", input: { command: "rm -rf /" } });
  assert.equal(requests().length, 2);
  assert.equal(resolved().length, 1); // no auto-resolution this time
  const dangerousRequest = requests()[1].request;
  assert.match(dangerousRequest.reason ?? "", /仍需確認.*遞迴或強制刪除/);
  session.resolveApproval(dangerousRequest.id, "deny");
  assert.deepEqual(await dangerousPromise, { behavior: "deny", message: "使用者拒絕這項操作" });

  const unknownPromise = session.handleApprovalBridge(token, { tool_name: "mcp__gmail__send_message", input: { to: "x@example.com" } });
  const unknownRequest = requests()[2].request;
  assert.match(unknownRequest.reason ?? "", /仍需確認/);
  session.resolveApproval(unknownRequest.id, "deny");
  assert.deepEqual(await unknownPromise, { behavior: "deny", message: "使用者拒絕這項操作" });
  session.stop();
});

test("full auto-approve mode allows non-Bash tools and everyday shell commands, but still blocks known-dangerous ones", async () => {
  const events: RunnerEvent[] = [];
  const session = new ClaudeSession(
    (event) => events.push(event),
    "/repo",
    () => [],
    () => "",
    () => "full",
  );
  session.busy = true;
  const token = (session as unknown as { approvalToken: string }).approvalToken;
  const requests = () => events.filter((event): event is Extract<RunnerEvent, { type: "approval_requested" }> => event.type === "approval_requested");
  const resolved = () => events.filter((event): event is Extract<RunnerEvent, { type: "approval_resolved" }> => event.type === "approval_resolved");

  // Not on the "safe" allowlist, but not dangerous either — full mode allows it.
  const gitRm = await session.handleApprovalBridge(token, { tool_name: "Bash", input: { command: "git rm -f old.txt" } });
  assert.deepEqual(gitRm, { behavior: "allow", updatedInput: { command: "git rm -f old.txt" } });

  // Arbitrary non-Bash tools (e.g. an MCP call) are also blanket-allowed.
  const mcpCall = await session.handleApprovalBridge(token, { tool_name: "mcp__gmail__send_message", input: { to: "x@example.com" } });
  assert.deepEqual(mcpCall, { behavior: "allow", updatedInput: { to: "x@example.com" } });
  assert.equal(resolved().length, 2);
  assert.ok(resolved().every((event) => event.decision === "auto_allow"));

  // The denylist is still the hard floor even in the more permissive mode.
  const dangerousPromise = session.handleApprovalBridge(token, { tool_name: "Bash", input: { command: "rm -rf /" } });
  const dangerousRequest = requests().at(-1)!.request;
  assert.match(dangerousRequest.reason ?? "", /完全自動核准已開啟，但此操作仍需確認/);
  session.resolveApproval(dangerousRequest.id, "deny");
  await dangerousPromise;
  session.stop();
});

test("auto-approve is off by default (existing worker behavior is unchanged)", async () => {
  const events: RunnerEvent[] = [];
  const session = new ClaudeSession((event) => events.push(event), "/repo");
  session.busy = true;
  const token = (session as unknown as { approvalToken: string }).approvalToken;
  const pending = session.handleApprovalBridge(token, { tool_name: "Bash", input: { command: "npm test" } });
  const request = events.find((event): event is Extract<RunnerEvent, { type: "approval_requested" }> => event.type === "approval_requested")!.request;
  assert.deepEqual(request.decisions, ["allow_once", "deny"]);
  session.resolveApproval(request.id, "allow_once");
  await pending;
  session.stop();
});

test("read-only query allows only the request-scoped MCP query catalog", async () => {
  const events: RunnerEvent[] = [];
  const session = new ClaudeSession((event) => events.push(event), "/repo");
  session.busy = true;
  const internals = session as unknown as {
    approvalToken: string;
    executionProfile: "read_only_query";
    queryAllowedTools: Set<string>;
  };
  internals.executionProfile = "read_only_query";
  internals.queryAllowedTools = new Set(["mcp__my-hub__list_pending"]);

  assert.deepEqual(await session.handleApprovalBridge(internals.approvalToken, {
    tool_name: "mcp__my-hub__list_pending",
    input: {},
  }), { behavior: "allow", updatedInput: {} });
  assert.deepEqual(await session.handleApprovalBridge(internals.approvalToken, {
    tool_name: "mcp__my-hub__close_item",
    input: { id: "1" },
  }), { behavior: "deny", message: "MCP 工具未提供可信的唯讀標記" });

  const decisions = events
    .filter((event): event is Extract<RunnerEvent, { type: "approval_resolved" }> => event.type === "approval_resolved")
    .map((event) => event.decision);
  assert.deepEqual(decisions, ["auto_allow", "deny"]);
  session.stop();
});

test("Claude defers MCP reload while busy and restarts the transport before the next turn", async () => {
  const session = new ClaudeSession(() => {}, "/repo");
  session.busy = true;
  assert.equal(await session.reloadMcp(), "deferred");

  let stops = 0;
  const writes: string[] = [];
  const internals = session as unknown as {
    stop(): void;
    ensureChild(): { stdin: { write(data: string): void } };
  };
  internals.stop = () => {
    stops++;
    session.busy = false;
  };
  internals.ensureChild = () => ({ stdin: { write: (data) => writes.push(data) } });
  session.busy = false;
  session.send("查詢新工具");

  assert.equal(stops, 1);
  assert.equal(writes.length, 1);
  assert.match(writes[0], /查詢新工具/);
});

test("builds Claude stream-json image content blocks", () => {
  assert.deepEqual(claudeMessageContent("這是什麼？", [{ name: "shot.png", mimeType: "image/png", dataBase64: "iVBORw0KGgo=" }]), [
    { type: "text", text: "這是什麼？" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
  ]);
});
