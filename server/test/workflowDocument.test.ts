import assert from "node:assert/strict";
import test from "node:test";
import { commandMetadata } from "../src/commandLibrary.js";
import { workflowFrontmatter } from "../src/workflowDocument.js";

test("parses multiline YAML and typed metadata", () => {
  const content = `---
description: >-
  Review the current changes
  before release
allowed-tools:
  - Read
  - Bash
custom:
  owner: crew
---

Review everything.`;
  assert.deepEqual(commandMetadata(content), {
    description: "Review the current changes before release",
    argumentHint: "",
    allowedTools: "Read, Bash",
    model: "",
  });
  assert.deepEqual(workflowFrontmatter(content).custom, { owner: "crew" });
});

test("rejects invalid YAML frontmatter", () => {
  assert.throws(() => workflowFrontmatter("---\ndescription: [broken\n---\nbody"), /YAML 無效/);
});
