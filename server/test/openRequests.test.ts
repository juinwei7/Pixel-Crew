import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_OPEN_REQUESTS_PER_WORKER,
  appendOpenRequest,
  clearOpenRequests,
  lastSuccessfulTurnAt,
  listOpenRequests,
  openRequestsForHandoff,
  normalizeOpenRequests,
  openRequestsCoachSection,
  openRequestsHandoffSection,
  pruneResolved,
  resolveOpenRequests,
} from "../src/openRequests.js";

test("appendOpenRequest 記一筆真人請求並可列出", () => {
  const ledger: Record<string, any[]> = {};
  assert.equal(appendOpenRequest(ledger, "w1", "看那支影片", 1000, "r1"), true);
  const open = listOpenRequests(ledger, "w1");
  assert.equal(open.length, 1);
  assert.equal(open[0].text, "看那支影片");
  assert.equal(open[0].status, "open");
});

test("空白或缺 id 不入帳", () => {
  const ledger: Record<string, any[]> = {};
  assert.equal(appendOpenRequest(ledger, "w1", "   ", 1, "r1"), false);
  assert.equal(appendOpenRequest(ledger, "w1", "有內容", 1, "  "), false);
  assert.equal(listOpenRequests(ledger, "w1").length, 0);
});

test("連續相同原文去重、不同則照收", () => {
  const ledger: Record<string, any[]> = {};
  assert.equal(appendOpenRequest(ledger, "w1", "任務A", 1, "r1"), true);
  assert.equal(appendOpenRequest(ledger, "w1", "任務A", 2, "r2"), false); // 與最近 open 相同
  assert.equal(appendOpenRequest(ledger, "w1", "任務B", 3, "r3"), true);
  assert.equal(listOpenRequests(ledger, "w1").length, 2);
});

test("resolveOpenRequests 依 id 結案、離開 open 清單", () => {
  const ledger: Record<string, any[]> = {};
  appendOpenRequest(ledger, "w1", "任務A", 1, "r1");
  appendOpenRequest(ledger, "w1", "任務B", 2, "r2");
  const n = resolveOpenRequests(ledger, "w1", ["r1"], 100);
  assert.equal(n, 1);
  const open = listOpenRequests(ledger, "w1");
  assert.equal(open.length, 1);
  assert.equal(open[0].id, "r2");
  assert.equal(ledger.w1.find((e) => e.id === "r1")!.resolvedAt, 100);
});

test("resolve 不存在的 id 回 0、不誤傷", () => {
  const ledger: Record<string, any[]> = {};
  appendOpenRequest(ledger, "w1", "任務A", 1, "r1");
  assert.equal(resolveOpenRequests(ledger, "w1", ["nope"], 5), 0);
  assert.equal(listOpenRequests(ledger, "w1").length, 1);
});

test("open 超過上限時最舊者自動降級 resolved（積壓保護）", () => {
  const ledger: Record<string, any[]> = {};
  for (let i = 0; i < MAX_OPEN_REQUESTS_PER_WORKER + 3; i += 1) {
    appendOpenRequest(ledger, "w1", `任務${i}`, i, `r${i}`);
  }
  const open = listOpenRequests(ledger, "w1");
  assert.equal(open.length, MAX_OPEN_REQUESTS_PER_WORKER);
  // 最舊 3 筆應被降級
  assert.equal(open[0].text, "任務3");
});

test("normalizeOpenRequests 丟壞條目、非法 status 歸 open", () => {
  const restored = normalizeOpenRequests({
    w1: [
      { id: "r1", text: "好的", at: 1, status: "open" },
      { id: "", text: "缺id", at: 2, status: "open" }, // 丟
      { id: "r3", text: "", at: 3, status: "open" }, // 丟
      { id: "r4", text: "壞status", at: 4, status: "weird" }, // 歸 open
    ],
    bad: "not-an-array",
  });
  assert.equal(restored.w1.length, 2);
  assert.equal(restored.w1[1].status, "open");
  assert.equal(restored.bad, undefined);
});

test("normalize 往返保序、保留 resolvedAt", () => {
  const ledger: Record<string, any[]> = {};
  appendOpenRequest(ledger, "w1", "任務A", 1, "r1");
  resolveOpenRequests(ledger, "w1", ["r1"], 50);
  const round = normalizeOpenRequests(JSON.parse(JSON.stringify(ledger)));
  assert.equal(round.w1[0].status, "resolved");
  assert.equal(round.w1[0].resolvedAt, 50);
});

test("pruneResolved 保留 open、只留最近幾筆 resolved、空則刪 key", () => {
  const ledger: Record<string, any[]> = {};
  for (let i = 0; i < 8; i += 1) {
    appendOpenRequest(ledger, "w1", `任務${i}`, i, `r${i}`);
    resolveOpenRequests(ledger, "w1", [`r${i}`], 100 + i);
  }
  appendOpenRequest(ledger, "w1", "仍未結案", 200, "keep");
  pruneResolved(ledger, 2);
  const list = ledger.w1;
  assert.equal(list.filter((e) => e.status === "open").length, 1);
  assert.equal(list.filter((e) => e.status === "resolved").length, 2);
  // 全 resolved 的 worker key 應被刪
  const only: Record<string, any[]> = {};
  appendOpenRequest(only, "w2", "x", 1, "rx");
  resolveOpenRequests(only, "w2", ["rx"], 2);
  pruneResolved(only, 0);
  assert.equal(only.w2, undefined);
});

test("coach 區塊：有 open 才出現、含 id 與優先承接指令；空則空字串", () => {
  const ledger: Record<string, any[]> = {};
  assert.equal(openRequestsCoachSection(listOpenRequests(ledger, "w1")), "");
  appendOpenRequest(ledger, "w1", "改善換腦", 1, "r1");
  const section = openRequestsCoachSection(listOpenRequests(ledger, "w1"));
  assert.match(section, /OPEN USER REQUESTS/);
  assert.match(section, /\[r1\]/);
  assert.match(section, /PRIORITIZE/);
  assert.match(section, /resolvedRequestIds/);
});

test("handoff 區塊：逐字原文、不得壓縮字樣；空則空字串", () => {
  const ledger: Record<string, any[]> = {};
  assert.equal(openRequestsHandoffSection(listOpenRequests(ledger, "w1")), "");
  appendOpenRequest(ledger, "w1", "把影片機制搬進來", 1, "r1");
  const section = openRequestsHandoffSection(listOpenRequests(ledger, "w1"));
  assert.match(section, /未結案使用者請求/);
  assert.match(section, /把影片機制搬進來/);
});

test("clearOpenRequests 丟掉整本帳（/clear、換工作位置、刪除 NPC），只影響該 NPC", () => {
  const ledger = {};
  appendOpenRequest(ledger, "w1", "幫我修登入", 1, "r1");
  appendOpenRequest(ledger, "w2", "幫我寫測試", 2, "r2");
  assert.equal(clearOpenRequests(ledger, "w1"), true);
  assert.deepEqual(listOpenRequests(ledger, "w1"), []);
  assert.equal(listOpenRequests(ledger, "w2").length, 1);
  assert.equal(clearOpenRequests(ledger, "w1"), false, "沒有帳就回 false，不必存檔");
});

test("lastSuccessfulTurnAt 只看成功收尾的 turn_end", () => {
  assert.equal(lastSuccessfulTurnAt([]), null);
  assert.equal(lastSuccessfulTurnAt([
    { type: "user_message", text: "a", at: 1 },
    { type: "turn_end", resultText: "", costUsd: 0, durationMs: 0, isError: false, permissionDenials: [], at: 5 },
    { type: "user_message", text: "b", at: 6 },
    { type: "turn_end", resultText: "", costUsd: 0, durationMs: 0, isError: true, permissionDenials: [], at: 9 },
  ]), 5);
});

test("交接只帶還算數的請求：沒開循環時只帶最後一次成功收尾之後的", () => {
  const open = [
    { id: "old", text: "早就回覆過的請求", at: 1, status: "open" as const },
    { id: "new", text: "上一回合中途失敗的請求", at: 10, status: "open" as const },
  ];
  // 沒開循環：帳本不會被結案，成功收尾之前的請求已在互動對話裡回覆過。
  assert.deepEqual(openRequestsForHandoff(open, { autopilotArmed: false, lastCompletedAt: 5 }).map((entry) => entry.id), ["new"]);
  // 循環開著：教練逐筆結案，帳上還 open 的都算數。
  assert.deepEqual(openRequestsForHandoff(open, { autopilotArmed: true, lastCompletedAt: 5 }).map((entry) => entry.id), ["old", "new"]);
  // 從沒成功收尾過：全部都還沒得到回覆。
  assert.deepEqual(openRequestsForHandoff(open, { autopilotArmed: false, lastCompletedAt: null }).map((entry) => entry.id), ["old", "new"]);
});
