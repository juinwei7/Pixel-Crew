import assert from "node:assert/strict";
import test from "node:test";
import { formatAgo, lastDoneLine, shortSummary } from "../src/lastDone";
import type { Turn, WorkerState } from "../src/types";

const NOW = 1_800_000_000_000;

function turn(command: string, status: Turn["status"] = "done", extra: Partial<Turn> = {}): Turn {
  return { key: command, command, status, items: [{ kind: "assistant_text", key: "a", text: "ok" }], ...extra };
}

function worker(turns: Turn[], speechAt: number | undefined = NOW - 12 * 60_000, busy = false): Pick<WorkerState, "busy" | "turns" | "character"> {
  return { busy, turns, character: { activity: "idle", mood: "success", station: "home", speech: "", speechAt, bump: 0 } };
}

test("formatAgo: just now, minutes, hours, days", () => {
  assert.equal(formatAgo(0), "剛剛");
  assert.equal(formatAgo(59), "剛剛");
  assert.equal(formatAgo(12 * 60 + 30), "12 分前");
  assert.equal(formatAgo(3 * 3600 + 5), "3 小時前");
  assert.equal(formatAgo(2 * 86_400), "2 天前");
  assert.equal(formatAgo(-5), "剛剛");
});

test("shortSummary keeps the first line, ~12 CJK chars (wider budget for plain ASCII)", () => {
  assert.equal(shortSummary("寫完 README"), "寫完 README");
  assert.equal(shortSummary("請幫我把整個登入流程重構成新的架構並補測試"), "請幫我把整個登入流程重構…");
  assert.equal(shortSummary("\n\n  修 bug\n第二行不要"), "修 bug");
  assert.equal(shortSummary("Refactor the login flow and add tests"), "Refactor the login f…");
});

test("idle nameplate line: time since the last finished turn + its short summary", () => {
  assert.equal(lastDoneLine(worker([turn("先看一下"), turn("寫完 README")]), NOW), "12 分前・寫完 README");
});

test("no line while busy, before any work, without a timestamp, or after a failed turn", () => {
  assert.equal(lastDoneLine(worker([turn("寫完 README")], NOW, true), NOW), null);
  assert.equal(lastDoneLine(worker([]), NOW), null);
  assert.equal(lastDoneLine(worker([turn("寫完 README")], Number.NaN), NOW), null);
  assert.equal(lastDoneLine(worker([turn("寫完 README"), turn("壞掉了", "error")]), NOW), null);
});

test("notices (no items) and system turns don't count as finished work", () => {
  const notice: Turn = { key: "n", command: "循環問你：要選 A 還是 B？", status: "done", items: [], autopilotAsk: true };
  const swap = turn("換腦完成", "done", { system: true });
  assert.equal(lastDoneLine(worker([turn("寫完 README"), swap, notice]), NOW), "12 分前・寫完 README");
});
