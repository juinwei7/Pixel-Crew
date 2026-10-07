import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { discussionSubmission, toggleDiscussionMode } from "../src/discussionMode";

test("discussion controls are mutually exclusive and toggle their active mode off", () => {
  assert.equal(toggleDiscussionMode(null, "roundtable"), "roundtable");
  assert.equal(toggleDiscussionMode("roundtable", "warroom"), "warroom");
  assert.equal(toggleDiscussionMode("warroom", "roundtable"), "roundtable");
  assert.equal(toggleDiscussionMode("warroom", "warroom"), null);
});

test("only non-empty messages enter a discussion workflow", () => {
  assert.equal(discussionSubmission("roundtable", "  should we ship?  "), "roundtable");
  assert.equal(discussionSubmission("warroom", "  should we ship?  "), "warroom");
  assert.equal(discussionSubmission("roundtable", " \n "), "normal");
  assert.equal(discussionSubmission(null, "should we ship?"), "normal");
});

test("busy-NPC submits that go to the queue keep the discussion mode", () => {
  // 排隊路徑以前直接 enqueueCommand 原文：快速圓桌／作戰室的題目會被當成一般工作指示排隊。
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const start = app.indexOf("onEnqueue={active ?");
  assert.ok(start >= 0);
  const onEnqueue = app.slice(start, app.indexOf(": undefined}", start));
  assert.match(onEnqueue, /discussionSubmission\(discussionMode, submission\.text\)/);
  assert.match(onEnqueue, /roundtablePrompt\(submission\.text\)/);
  assert.match(onEnqueue, /submissionMode === "warroom"\) return Promise\.resolve\(t\(/);
});
