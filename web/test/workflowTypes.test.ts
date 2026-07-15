import assert from "node:assert/strict";
import test from "node:test";
import { compatibleWorkflowTargets, workflowInvocation, type WorkflowTarget } from "../src/workflowTypes";

test("selects only idle same-provider NPCs in the same room", () => {
  const workers: WorkflowTarget[] = [
    { id: "a", name: "A", provider: "claude", workspacePath: "/one", busy: false },
    { id: "b", name: "B", provider: "claude", workspacePath: "/two", busy: false },
    { id: "c", name: "C", provider: "codex", workspacePath: "/one", busy: false },
    { id: "d", name: "D", provider: "claude", workspacePath: "/one", busy: true },
  ];
  assert.deepEqual(compatibleWorkflowTargets(workers, "claude", "/one").map((worker) => worker.id), ["a"]);
});

test("builds provider-specific saved workflow invocations", () => {
  assert.equal(workflowInvocation("claude", "review", " main "), "/review main");
  assert.equal(workflowInvocation("codex", "verify", ""), "$verify");
});
