import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// workerExtras 在 import 當下就從 config.dataDirectory 決定 npc-extras 目錄，
// 所以要先把資料目錄指到 temp dir 再動態載入模組（node:test 每個測試檔跑在
// 獨立行程，不會污染其他測試）。
const dataDir = mkdtempSync(join(tmpdir(), "cockpit-extras-"));
process.env.PIXEL_CREW_DATA_DIR = dataDir;
process.env.DB_PATH = join(dataDir, "cockpit.sqlite");

const {
  MAX_MEMORY_NOTES,
  MAX_MEMORY_NOTE_LENGTH,
  addMemoryNote,
  composeMemorySection,
  deleteExtras,
  getExtras,
  removeMemoryNote,
  setDailyBudget,
  setWorkerGoal,
} = await import("../src/workerExtras.js");

const extrasDir = join(dataDir, "npc-extras");
const extrasFile = (workerId: string) => join(extrasDir, `${workerId}.json`);

test("getExtras returns empty defaults when no file exists", () => {
  assert.deepEqual(getExtras("w-missing"), { notes: [], dailyBudgetUsd: null, goal: null });
});

test("addMemoryNote trims, collapses whitespace, persists to disk", () => {
  const result = addMemoryNote("w-add", "  使用者喜歡\n  繁體中文   回覆  ");
  assert.deepEqual(result, { ok: true, note: "使用者喜歡 繁體中文 回覆" });
  assert.deepEqual(getExtras("w-add").notes, ["使用者喜歡 繁體中文 回覆"]);
  const onDisk = JSON.parse(readFileSync(extrasFile("w-add"), "utf8"));
  assert.deepEqual(onDisk, { notes: ["使用者喜歡 繁體中文 回覆"], dailyBudgetUsd: null, goal: null });
});

test("blank note is rejected with a zh-TW error", () => {
  assert.deepEqual(addMemoryNote("w-blank", "   \n  "), { ok: false, error: "記憶內容不能是空白" });
  assert.deepEqual(addMemoryNote("w-blank", undefined), { ok: false, error: "記憶內容不能是空白" });
  assert.deepEqual(getExtras("w-blank").notes, []);
});

test("duplicate notes are rejected case-insensitively", () => {
  assert.equal(addMemoryNote("w-dup", "User prefers TypeScript").ok, true);
  assert.deepEqual(addMemoryNote("w-dup", "user PREFERS typescript"), { ok: false, error: "這則記憶已經存在" });
  assert.equal(getExtras("w-dup").notes.length, 1);
});

test("notes are clipped to the max note length", () => {
  const long = "a".repeat(MAX_MEMORY_NOTE_LENGTH + 50);
  const result = addMemoryNote("w-long", long);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.note.length, MAX_MEMORY_NOTE_LENGTH);
});

test("memory is a rolling window: oldest note falls off past the cap", () => {
  for (let i = 0; i < MAX_MEMORY_NOTES + 1; i++) {
    assert.equal(addMemoryNote("w-roll", `note-${i}`).ok, true);
  }
  const { notes } = getExtras("w-roll");
  assert.equal(notes.length, MAX_MEMORY_NOTES);
  assert.equal(notes[0], "note-1"); // note-0 已被擠掉
  assert.equal(notes.at(-1), `note-${MAX_MEMORY_NOTES}`);
});

test("removeMemoryNote deletes by index and rejects invalid indexes", () => {
  addMemoryNote("w-rm", "first");
  addMemoryNote("w-rm", "second");
  assert.equal(removeMemoryNote("w-rm", 0), true);
  assert.deepEqual(getExtras("w-rm").notes, ["second"]);
  assert.equal(removeMemoryNote("w-rm", -1), false);
  assert.equal(removeMemoryNote("w-rm", 1), false);
  assert.equal(removeMemoryNote("w-rm", 0.5), false);
  assert.deepEqual(getExtras("w-rm").notes, ["second"]);
});

test("setDailyBudget stores a 2-decimal USD cap and persists it", () => {
  assert.deepEqual(setDailyBudget("w-budget", 12.345), { ok: true, dailyBudgetUsd: 12.35 });
  assert.equal(getExtras("w-budget").dailyBudgetUsd, 12.35);
  const onDisk = JSON.parse(readFileSync(extrasFile("w-budget"), "utf8"));
  assert.equal(onDisk.dailyBudgetUsd, 12.35);
});

test("setDailyBudget: null or empty clears the cap", () => {
  setDailyBudget("w-clear", 5);
  assert.deepEqual(setDailyBudget("w-clear", null), { ok: true, dailyBudgetUsd: null });
  setDailyBudget("w-clear", 5);
  assert.deepEqual(setDailyBudget("w-clear", ""), { ok: true, dailyBudgetUsd: null });
  assert.equal(getExtras("w-clear").dailyBudgetUsd, null);
});

test("setDailyBudget rejects zero, negatives, NaN, and amounts over 10000", () => {
  for (const bad of [0, -1, Number.NaN, "abc", 10_000.01]) {
    const result = setDailyBudget("w-badbudget", bad);
    assert.deepEqual(result, { ok: false, error: "預算上限需為 0 到 10000 之間的美元金額" });
  }
  assert.equal(getExtras("w-badbudget").dailyBudgetUsd, null);
});

test("setWorkerGoal persists a bounded normalized goal and can clear it", () => {
  assert.equal(setWorkerGoal("w-goal", "  ship\n the   release  "), "ship the release");
  assert.equal(getExtras("w-goal").goal, "ship the release");
  assert.equal(setWorkerGoal("w-goal", null), null);
  assert.equal(getExtras("w-goal").goal, null);
});

test("corrupt extras file on disk falls back to empty defaults", () => {
  mkdirSync(extrasDir, { recursive: true });
  writeFileSync(extrasFile("w-corrupt"), "not json at all", "utf8");
  assert.deepEqual(getExtras("w-corrupt"), { notes: [], dailyBudgetUsd: null, goal: null });
});

test("malformed fields in the file are sanitized on load", () => {
  mkdirSync(extrasDir, { recursive: true });
  const junkNotes = [
    "  ok note  ",
    123,
    "",
    "b".repeat(MAX_MEMORY_NOTE_LENGTH + 10),
    ...Array.from({ length: MAX_MEMORY_NOTES + 5 }, (_, i) => `filler-${i}`),
  ];
  writeFileSync(extrasFile("w-junk"), JSON.stringify({ notes: junkNotes, dailyBudgetUsd: -3 }), "utf8");
  const extras = getExtras("w-junk");
  assert.equal(extras.dailyBudgetUsd, null); // 非正數預算視為未設定
  assert.equal(extras.notes.length, MAX_MEMORY_NOTES); // 超量截斷
  assert.equal(extras.notes[0], "ok note"); // trim 過、空白與非字串被濾掉
  assert.equal(extras.notes[1], "123"); // 非字串轉字串
  assert.equal(extras.notes[2].length, MAX_MEMORY_NOTE_LENGTH); // 過長截斷
});

test("deleteExtras removes the file and the cache", () => {
  addMemoryNote("w-del", "to be deleted");
  assert.equal(existsSync(extrasFile("w-del")), true);
  deleteExtras("w-del");
  assert.equal(existsSync(extrasFile("w-del")), false);
  assert.deepEqual(getExtras("w-del"), { notes: [], dailyBudgetUsd: null, goal: null });
});

test("worker ids are sanitized so they cannot traverse out of the extras dir", () => {
  const result = addMemoryNote("../evil", "escape attempt");
  assert.equal(result.ok, true);
  assert.equal(existsSync(join(extrasDir, "evil.json")), true); // 只剩合法字元
  assert.equal(existsSync(join(dataDir, "evil.json")), false);
});

test("composeMemorySection always includes the self-serve curl instruction", () => {
  const section = composeMemorySection("w-empty-section");
  assert.match(section, /【記憶工具】/);
  assert.match(section, /\/api\/workers\/w-empty-section\/memory/);
  assert.doesNotMatch(section, /【長期記憶/);
});

test("composeMemorySection lists stored notes above the instruction", () => {
  addMemoryNote("w-section", "偏好深色主題");
  addMemoryNote("w-section", "專案用 pnpm");
  const section = composeMemorySection("w-section");
  assert.match(section, /【長期記憶 \/ Memory】/);
  assert.match(section, /- 偏好深色主題/);
  assert.match(section, /- 專案用 pnpm/);
  assert.ok(section.indexOf("【長期記憶") < section.indexOf("【記憶工具】"));
});

test("composeMemorySection includes an active goal before long-term memory", () => {
  setWorkerGoal("w-goal-section", "完成登入流程");
  addMemoryNote("w-goal-section", "使用 TypeScript");
  const section = composeMemorySection("w-goal-section");
  assert.match(section, /【目前目標 \/ Active goal】完成登入流程/);
  assert.ok(section.indexOf("【目前目標") < section.indexOf("【長期記憶"));
});
