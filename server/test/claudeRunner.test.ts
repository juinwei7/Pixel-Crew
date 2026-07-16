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
    () => true, // auto-approve on
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

test("builds Claude stream-json image content blocks", () => {
  assert.deepEqual(claudeMessageContent("這是什麼？", [{ name: "shot.png", mimeType: "image/png", dataBase64: "iVBORw0KGgo=" }]), [
    { type: "text", text: "這是什麼？" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
  ]);
});
