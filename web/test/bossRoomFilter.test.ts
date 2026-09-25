import assert from "node:assert/strict";
import test from "node:test";
import { bossRoomWorkers } from "../src/game/bossRoomFilter.js";

const regular = { id: "a", ephemeralKind: null, departmentId: "sales" };
const regular2 = { id: "b", ephemeralKind: undefined, departmentId: "ops" };
const dedicated = { id: "c", ephemeralKind: "dedicated", departmentId: "boss-1" };
const dedicated2 = { id: "d", ephemeralKind: "dedicated", departmentId: "boss-1" };

test("main office hides ephemeral boss crews; boss room shows the dedicated crew", () => {
  const all = [regular, dedicated, regular2, dedicated2];
  assert.deepEqual(bossRoomWorkers(all, false).map((w) => w.id), ["a", "b"]);
  // 沒傳進行中交辦部門時，交辦房只住 dedicated 專屬部隊（維持原兩間房行為）。
  assert.deepEqual(bossRoomWorkers(all, true).map((w) => w.id), ["c", "d"]);
});

test("boss room includes the existing department a boss task was routed to", () => {
  // 使用者實際情況：交辦被路由給既有部門（例如 sales），沒有任何 dedicated 專屬部隊。
  // 一開 BOSS 就要切到「正在做這張交辦的那個部門」，而不是退回主辦公室看不出差別。
  const all = [regular, regular2];
  const routed = new Set(["sales"]);
  assert.deepEqual(bossRoomWorkers(all, true, routed).map((w) => w.id), ["a"]);
  // 主辦公室視圖不受影響——常駐部門照常全顯示。
  assert.deepEqual(bossRoomWorkers(all, false, routed).map((w) => w.id), ["a", "b"]);
});

test("boss room unions the dedicated crew with the routed existing department", () => {
  const all = [regular, regular2, dedicated];
  const routed = new Set(["ops"]);
  assert.deepEqual(bossRoomWorkers(all, true, routed).map((w) => w.id), ["b", "c"]);
});

test("empty boss room falls back to the main office instead of a blank scene", () => {
  // BOSS 頁開著、但目前沒有任何進行中交辦成員（交辦剛送出、專屬部隊還在編制、或已解散）
  // → 之前整個場景空掉「NPC 全消失」。退回主辦公室後常駐夥伴照常顯示。
  const noBossWork = [regular, regular2];
  assert.deepEqual(bossRoomWorkers(noBossWork, true).map((w) => w.id), ["a", "b"]);
  assert.deepEqual(bossRoomWorkers(noBossWork, true, new Set()).map((w) => w.id), ["a", "b"]);
  // 交辦部門集合指到沒有任何在場成員的部門時，一樣退回主辦公室不留空白。
  assert.deepEqual(bossRoomWorkers(noBossWork, true, new Set(["gone"])).map((w) => w.id), ["a", "b"]);
  assert.deepEqual(bossRoomWorkers([], true), []);
  assert.deepEqual(bossRoomWorkers([], false), []);
});
