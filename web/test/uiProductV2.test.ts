import assert from "node:assert/strict";
import test from "node:test";
import { deriveCommandHistory } from "../src/commandHistory";
import { filterCrew, workerAttention } from "../src/crew";
import { emptyWorker } from "../src/workerState";

function worker(id: string, provider: "claude" | "codex" = "claude", room = "/room") {
  return emptyWorker(id, id, null, false, 0, provider, room, null);
}

test("derives deduplicated command history only from the selected provider and room", () => {
  const first = worker("first");
  first.turns = [
    { key: "1", command: "npm test", status: "done", items: [] },
    { key: "2", command: "npm test", status: "done", items: [] },
  ];
  const codex = worker("codex", "codex");
  codex.turns = [{ key: "3", command: "review", status: "done", items: [] }];
  assert.deepEqual(deriveCommandHistory([first, codex], "claude", "/room"), ["npm test"]);
  assert.deepEqual(deriveCommandHistory([first, codex], "codex", "/room"), ["review"]);
});

test("crew attention prioritizes approvals and filters without reordering", () => {
  const idle = worker("idle");
  const approval = worker("approval");
  approval.busy = true;
  approval.turns = [{
    key: "turn",
    command: "deploy",
    status: "running",
    items: [{
      kind: "approval",
      key: "approval-item",
      status: "pending",
      request: { id: "request", activityId: null, category: "command", title: "允許？", input: {}, decisions: ["allow_once", "deny"] },
    }],
  }];
  assert.equal(workerAttention(approval), "approval");
  assert.deepEqual(filterCrew([idle, approval], "attention", "", "/room").map((item) => item.id), ["approval"]);
  assert.deepEqual(filterCrew([idle, approval], "all", "", "/room").map((item) => item.id), ["idle", "approval"]);
});

test("a selected worker can be pinned without changing filtered result order", () => {
  const first = worker("first");
  const second = worker("second", "codex");
  const third = worker("third", "codex");
  assert.deepEqual(filterCrew([first, second, third], "codex", "", "/room").map((item) => item.id), ["second", "third"]);
  assert.equal(filterCrew([first, second, third], "codex", "", "/room").some((item) => item.id === first.id), false);
});
