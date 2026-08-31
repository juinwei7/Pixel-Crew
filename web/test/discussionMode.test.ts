import assert from "node:assert/strict";
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
