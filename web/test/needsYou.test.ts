import assert from "node:assert/strict";
import test from "node:test";
import {
  collectNeedsYou,
  crewTier,
  endsWithQuestion,
  needsYouByWorker,
  needsYouSummary,
  nextNeedsYou,
  pendingApproval,
  progressSignature,
  settleTiers,
  sortByTier,
  STUCK_AFTER_MS,
  stuckWorkers,
  trackProgress,
} from "../src/needsYou";
import { diffNeedsYouNotifications } from "../src/notifications";
import { attentionSummary } from "../src/uxMotion";
import { workerAttention } from "../src/crew";
import { emptyWorker } from "../src/workerState";
import type { Turn, TurnItem, WorkerState } from "../src/types";

function worker(id: string, patch: Partial<WorkerState> = {}): WorkerState {
  return { ...emptyWorker(id, id.toUpperCase(), null, false, 0, "claude", "/repo"), ...patch };
}

function turn(key: string, status: Turn["status"], items: TurnItem[], extra: Partial<Turn> = {}): Turn {
  return { key, command: `cmd ${key}`, status, items, ...extra };
}

const approvalItem = (id: string): TurnItem => ({ kind: "approval", key: `a-${id}`, status: "pending", request: { id, title: "rm -rf build" } } as unknown as TurnItem);
const text = (key: string, value: string): TurnItem => ({ kind: "assistant_text", key, text: value });

const approving = worker("ap", { busy: true, turns: [turn("t1", "running", [approvalItem("r1")])] });
const deciding = worker("de", { turns: [turn("t1", "done", [text("x", "要選 A 還是 B")], { autopilotAsk: true })] });
const asking = worker("qu", { turns: [turn("t1", "done", [text("x", "做完了。\n\n要我順便部署嗎？")])] });
const failed = worker("fa", { turns: [turn("t1", "error", [])] });
const idle = worker("id", { turns: [turn("t1", "done", [text("x", "完成。")])] });

test("collects every kind and sorts by priority, then crew order", () => {
  const items = collectNeedsYou([idle, failed, asking, deciding, approving]);
  assert.deepEqual(items.map((item) => `${item.kind}:${item.workerId}`), ["approval:ap", "decision:de", "question:qu", "failed:fa"]);
  assert.equal(items[0].approvalId, "r1");
  assert.equal(items[0].detail, "rm -rf build");
  assert.equal(items[2].detail, "要我順便部署嗎？");
});

test("same-kind items keep crew order (stable)", () => {
  const a = worker("a", { busy: true, turns: [turn("t", "running", [approvalItem("1")])] });
  const b = worker("b", { busy: true, turns: [turn("t", "running", [approvalItem("2")])] });
  assert.deepEqual(collectNeedsYou([b, a]).map((item) => item.workerId), ["b", "a"]);
  assert.deepEqual(collectNeedsYou([a, b]).map((item) => item.workerId), ["a", "b"]);
});

test("seen failures and questions drop out; decisions and approvals stay until resolved", () => {
  const seen = { fa: "t1", qu: "t1", de: "t1", ap: "t1" };
  const kinds = collectNeedsYou([approving, deciding, asking, failed], { seenTurnKeys: seen }).map((item) => item.kind);
  assert.deepEqual(kinds, ["approval", "decision"]);
});

test("a notice after a failed turn doesn't hide the failure from needs-you or crew attention", () => {
  const stopped = worker("st", { turns: [turn("t1", "error", []), turn("n1", "done", [], { notice: true, command: "⛔ 自動循環已停止" })] });
  const [item] = collectNeedsYou([stopped]);
  assert.equal(item?.kind, "failed");
  assert.equal(item?.turnKey, "t1");
  assert.equal(item?.key, "failed:st:t1");
  assert.equal(collectNeedsYou([stopped], { seenTurnKeys: { st: "t1" } }).length, 0);
  assert.equal(workerAttention(stopped), "error");
  // 循環問你通知本身仍是「要你拍板」。
  const asked = worker("as", { turns: [turn("t1", "error", []), turn("n1", "done", [], { notice: true, autopilotAsk: true })] });
  assert.equal(collectNeedsYou([asked])[0]?.kind, "decision");
});

test("ephemeral NPCs only surface approvals", () => {
  const temp = worker("tmp", { ephemeralKind: "warroom", turns: [turn("t1", "error", [])] });
  const tempApproval = { ...approving, id: "tmp2", ephemeralKind: "research" as const };
  assert.deepEqual(collectNeedsYou([temp, tempApproval]).map((item) => item.kind), ["approval"]);
});

test("question detection only looks at the final line", () => {
  assert.equal(endsWithQuestion("要繼續嗎？"), true);
  assert.equal(endsWithQuestion("Shall I deploy?**"), true);
  assert.equal(endsWithQuestion("為什麼會壞？因為設定錯了。\n已修好。"), false);
  assert.equal(endsWithQuestion(""), false);
});

test("next item cycles from the current worker and starts at the top otherwise", () => {
  const items = collectNeedsYou([approving, deciding, asking]);
  assert.equal(nextNeedsYou(items, null)?.workerId, "ap");
  assert.equal(nextNeedsYou(items, "someone-else")?.workerId, "ap");
  assert.equal(nextNeedsYou(items, "ap")?.workerId, "de");
  assert.equal(nextNeedsYou(items, "qu")?.workerId, "ap");
  assert.equal(nextNeedsYou([], "ap"), null);
});

test("summary excludes stuck reminders and lists kinds", () => {
  const progress = trackProgress({}, [worker("st", { busy: true, turns: [turn("t1", "running", [])] })], 0);
  const stuckWorker = worker("st", { busy: true, turns: [turn("t1", "running", [])] });
  const items = collectNeedsYou([stuckWorker, deciding], { progress, now: STUCK_AFTER_MS + 1 });
  assert.deepEqual(items.map((item) => item.kind), ["decision", "stuck"]);
  const summary = needsYouSummary(items);
  assert.equal(summary.count, 1);
  assert.equal(summary.first?.workerId, "de");
  assert.deepEqual(summary.kinds, ["decision"]);
  assert.equal(needsYouByWorker(items).get("st")?.kind, "stuck");
});

test("progress tracking: unchanged signature keeps the old timestamp and identity", () => {
  const busy = worker("b", { busy: true, turns: [turn("t1", "running", [text("x", "abc")])] });
  const first = trackProgress({}, [busy], 100);
  assert.equal(trackProgress(first, [busy], 900), first);
  const grown = { ...busy, turns: [turn("t1", "running", [text("x", "abcdef")])] };
  assert.notEqual(progressSignature(grown), progressSignature(busy));
  const second = trackProgress(first, [grown], 900);
  assert.equal(second.b.at, 900);
  // NPC 被移除也算變動
  assert.deepEqual(trackProgress(second, [], 1000), {});
});

test("stuck: busy with no progress past the threshold, but never while waiting on approval", () => {
  const busy = worker("b", { busy: true, turns: [turn("t1", "running", [])] });
  const progress = trackProgress({}, [busy, approving], 0);
  assert.equal(stuckWorkers([busy, approving], progress, STUCK_AFTER_MS - 1).size, 0);
  const stuck = stuckWorkers([busy, approving], progress, STUCK_AFTER_MS + 5);
  assert.deepEqual([...stuck.keys()], ["b"]);
  assert.equal(stuck.get("b"), STUCK_AFTER_MS + 5);
});

test("crew tiers: needs-you, working, idle — stable within a tier", () => {
  const needs = needsYouByWorker(collectNeedsYou([approving, deciding]));
  const working = worker("wk", { busy: true });
  assert.equal(crewTier(approving, needs), 0);
  assert.equal(crewTier(deciding, needs), 0);
  assert.equal(crewTier(working, needs), 1);
  assert.equal(crewTier(idle, needs), 2);
  const list = [idle, working, deciding, worker("id2"), approving];
  const sorted = sortByTier(list, (item) => crewTier(item, needs));
  assert.deepEqual(sorted.map((item) => item.id), ["de", "ap", "wk", "id", "id2"]);
});

test("tier settling: promotion to needs-you is immediate, other changes wait for the hold", () => {
  let state = settleTiers({ settled: {}, pending: {} }, { a: 2, b: 1 }, 0, 4000);
  assert.deepEqual(state.settled, { a: 2, b: 1 });
  state = settleTiers(state, { a: 0, b: 2 }, 100, 4000);
  assert.equal(state.settled.a, 0, "needs-you jumps up right away");
  assert.equal(state.settled.b, 1, "working → idle waits");
  assert.equal(state.nextCheckAt, 4100);
  // 中途又變回原層級：等待取消
  const bounced = settleTiers(state, { a: 0, b: 1 }, 2000, 4000);
  assert.equal(bounced.settled.b, 1);
  assert.deepEqual(bounced.pending, {});
  // 持續夠久：生效
  state = settleTiers(state, { a: 0, b: 2 }, 4200, 4000);
  assert.equal(state.settled.b, 2);
  assert.equal(state.nextCheckAt, null);
});

test("crew attention, the legacy approval summary and notifications share the same approval check", () => {
  assert.equal(pendingApproval(approving)?.request.id, "r1");
  assert.equal(workerAttention(approving), "approval");
  assert.deepEqual(attentionSummary([idle, approving]), { count: 1, firstId: "ap", firstName: "AP" });
});

test("needs-you notifications fire once per new decision/question/stuck item, never on first sight", () => {
  const items = collectNeedsYou([approving, deciding, asking, failed]);
  assert.deepEqual(diffNeedsYouNotifications(null, items), []);
  const events = diffNeedsYouNotifications(new Set(), items);
  assert.deepEqual(events.map((event) => event.tag), [items[1].key, items[2].key]);
  assert.match(events[0].title, /DE 等你拍板/);
  assert.match(events[1].title, /QU 在問你/);
  assert.deepEqual(diffNeedsYouNotifications(new Set(items.map((item) => item.key)), items), []);
});
