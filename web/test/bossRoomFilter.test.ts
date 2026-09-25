import assert from "node:assert/strict";
import test from "node:test";
import { bossRoomWorkers } from "../src/game/bossRoomFilter.js";

const regular = { id: "a", ephemeralKind: null };
const regular2 = { id: "b", ephemeralKind: undefined };
const dedicated = { id: "c", ephemeralKind: "dedicated" };
const dedicated2 = { id: "d", ephemeralKind: "dedicated" };

test("main office shows only standing crew; boss room shows only the dedicated crew", () => {
  const all = [regular, dedicated, regular2, dedicated2];
  assert.deepEqual(bossRoomWorkers(all, false).map((w) => w.id), ["a", "b"]);
  assert.deepEqual(bossRoomWorkers(all, true).map((w) => w.id), ["c", "d"]);
});

test("empty boss room falls back to the main office instead of a blank scene", () => {
  // 真實案例：BOSS 頁開著、但交辦被路由給既有部門（沒有臨時部門成員）→ 之前整個
  // 場景空掉「NPC 全消失」。退回主辦公室後常駐夥伴照常顯示。
  const noDedicated = [regular, regular2];
  assert.deepEqual(bossRoomWorkers(noDedicated, true).map((w) => w.id), ["a", "b"]);
  assert.deepEqual(bossRoomWorkers([], true), []);
  assert.deepEqual(bossRoomWorkers([], false), []);
});
