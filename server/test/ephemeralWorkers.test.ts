import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isLegacyEphemeralWorkerName } from "../src/warroom.js";

/* 短命 worker（作戰室成員、研究員）以前是用名字的 emoji 字首當協定：
   server 這樣命名，server 與前端再各自比對字首。那有兩個問題——使用者把
   NPC 改個名字協定就失效，而且前端被迫把那顆 emoji 顯示在介面上。
   現在改成 worker 上的 ephemeralKind 欄位。 */

const indexSource = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
const brainSwapSource = readFileSync(fileURLToPath(new URL("../src/brainSwap.ts", import.meta.url)), "utf8");

test("the legacy name check only recognises rows written by older versions", () => {
  // 仍然需要它：SQLite 裡可能留著舊版寫進去的殘骸，那些列沒有新欄位。
  assert.equal(isLegacyEphemeralWorkerName("\u{1F3DB}主持"), true);
  assert.equal(isLegacyEphemeralWorkerName("\u{1F50D}研究員"), true);
  assert.equal(isLegacyEphemeralWorkerName("一號機"), false);
  assert.equal(isLegacyEphemeralWorkerName("主持"), false);
});

test("live code decides by ephemeralKind, never by the name prefix", () => {
  for (const [name, source] of [["index.ts", indexSource], ["brainSwap.ts", brainSwapSource]] as const) {
    // 只准在「讀 SQLite 舊資料」的地方用名字判斷，其餘一律看欄位。
    const nameChecks = source.split("\n").filter((line) => /startsWith\(["'`]\\u\{1F3DB\}|startsWith\(["'`]\\u\{1F50D\}|codePointAt\(0\) === 0x1f3db/i.test(line));
    assert.deepEqual(nameChecks, [], `${name} 仍在用名字字首判斷短命 worker`);
  }
});

test("every non-persisted orchestrator worker declares its kind", () => {
  // persist: false 就是「編排器建立、跑完要消失」的那種；沒有 ephemeralKind
  // 的話 brainSwap、撞限續跑、system prompt 都會把它當成一般 NPC 對待。
  const offenders = indexSource
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => line.includes("createWorker(") && line.includes("persist: false"))
    .filter(({ line }) => !line.includes("ephemeralKind:"))
    .map(({ number, line }) => `index.ts:${number} ${line.trim().slice(0, 70)}`);
  assert.deepEqual(offenders, [], `補上 ephemeralKind：\n${offenders.join("\n")}`);
});
