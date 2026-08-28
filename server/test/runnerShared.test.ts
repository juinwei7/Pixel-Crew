import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { config } from "../src/config.js";
import {
  ABORTED_MESSAGE,
  autoApproveConfirmReason,
  autoApproveEnabledReason,
  boundedValue,
  composeMessageText,
  isReadOnlyExecutionProfile,
  MAX_APPROVAL_TEXT_LENGTH,
  messageDocumentsDirectory,
  riskReasonFor,
  truncateCommand,
} from "../src/runnerShared.js";

test("boundedValue passes short values through untouched", () => {
  assert.equal(boundedValue("hi"), "hi");
  assert.deepEqual(boundedValue({ a: 1 }), { a: 1 });
});

test("boundedValue truncates oversized values and marks the cut", () => {
  const huge = "x".repeat(MAX_APPROVAL_TEXT_LENGTH + 500);
  const result = boundedValue(huge) as string;
  assert.equal(typeof result, "string");
  assert.ok(result.length < huge.length);
  assert.ok(result.endsWith("…[內容已截斷]"));
});

test("boundedValue falls back to String() when JSON.stringify throws (circular refs)", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(boundedValue(circular), "[object Object]");
});

test("truncateCommand stringifies nullish input and caps length at the same bound as boundedValue", () => {
  assert.equal(truncateCommand(undefined), "");
  assert.equal(truncateCommand(null), "");
  assert.equal(truncateCommand("npm test"), "npm test");
  const long = "a".repeat(MAX_APPROVAL_TEXT_LENGTH + 10);
  assert.equal(truncateCommand(long).length, MAX_APPROVAL_TEXT_LENGTH);
});

test("isReadOnlyExecutionProfile only flags the two read-only profiles", () => {
  assert.equal(isReadOnlyExecutionProfile("read_only_collaboration"), true);
  assert.equal(isReadOnlyExecutionProfile("read_only_query"), true);
  assert.equal(isReadOnlyExecutionProfile("normal"), false);
});

test("autoApproveEnabledReason maps each mode to its own Chinese label", () => {
  assert.equal(autoApproveEnabledReason("invincible"), "無限制模式已開啟（不設限）");
  assert.equal(autoApproveEnabledReason("full"), "完全自動核准已開啟");
  assert.equal(autoApproveEnabledReason("safe"), "安全自動核准已開啟");
});

test("autoApproveConfirmReason embeds the mode label and the still-needs-confirmation detail", () => {
  assert.equal(
    autoApproveConfirmReason("full", "遞迴或強制刪除（rm -r / -f）"),
    "完全自動核准已開啟，但此操作仍需確認（遞迴或強制刪除（rm -r / -f））",
  );
  assert.equal(
    autoApproveConfirmReason("safe", "使用 sudo 提升權限"),
    "安全自動核准已開啟，但此操作仍需確認（使用 sudo 提升權限）",
  );
  // Matches the original inline template literal's behavior when reason is missing.
  assert.equal(
    autoApproveConfirmReason("safe", undefined),
    "安全自動核准已開啟，但此操作仍需確認（undefined）",
  );
});

test("riskReasonFor only looks up a reason when a command string is present", () => {
  assert.equal(riskReasonFor(undefined), undefined);
  assert.equal(riskReasonFor(""), undefined);
  assert.equal(riskReasonFor("rm -rf /"), "遞迴或強制刪除（rm -r / -f）");
  assert.equal(riskReasonFor("npm test"), undefined);
});

test("ABORTED_MESSAGE is the shared interrupt() error text", () => {
  assert.equal(ABORTED_MESSAGE, "已中止");
});

test("messageDocumentsDirectory sits next to the sqlite db, in a message-documents folder", () => {
  assert.equal(messageDocumentsDirectory(), join(dirname(config.dbPath), "message-documents"));
});

test("composeMessageText joins the user text with the staged-document note", () => {
  assert.equal(composeMessageText("hello", []), "hello");
  const withDocs = composeMessageText("看看這份文件", [{ name: "spec.md", path: "/tmp/spec.md" }]);
  assert.match(withDocs, /^看看這份文件\n\n/);
  assert.match(withDocs, /spec\.md/);
  assert.match(withDocs, /\/tmp\/spec\.md/);
});

test("composeMessageText drops the blank line when there's no text but there are documents", () => {
  const result = composeMessageText("", [{ name: "a.txt", path: "/tmp/a.txt" }]);
  assert.ok(!result.startsWith("\n\n"));
  assert.match(result, /a\.txt/);
});
