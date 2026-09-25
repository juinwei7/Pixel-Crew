import assert from "node:assert/strict";
import test from "node:test";
import { bossRoomWorkers } from "../src/game/bossRoomFilter.js";

const regular = { id: "a", ephemeralKind: null };
const regular2 = { id: "b", ephemeralKind: undefined };
const dedicated = { id: "c", ephemeralKind: "dedicated" };
const dedicated2 = { id: "d", ephemeralKind: "dedicated" };

test("main office hides ephemeral boss crews; opening BOSS keeps everyone on scene", () => {
  const all = [regular, dedicated, regular2, dedicated2];
  // 主辦公室：短命交辦部隊收起來，只留常駐夥伴。
  assert.deepEqual(bossRoomWorkers(all, false).map((w) => w.id), ["a", "b"]);
  // 開 BOSS：全員都在（原序）——其他部門不再消失，交辦部隊也一起顯示。
  assert.deepEqual(bossRoomWorkers(all, true).map((w) => w.id), ["a", "c", "b", "d"]);
});

test("opening BOSS never blanks the scene, with or without a dedicated crew", () => {
  // 有交辦部隊：常駐部門 + 交辦部隊同場，不藏任何人。
  assert.deepEqual(bossRoomWorkers([regular, dedicated, regular2], true).map((w) => w.id), ["a", "c", "b"]);
  // 沒有交辦部隊（交辦被路由給既有部門／臨時部門已解散）：常駐夥伴照常全顯示。
  assert.deepEqual(bossRoomWorkers([regular, regular2], true).map((w) => w.id), ["a", "b"]);
  assert.deepEqual(bossRoomWorkers([], true), []);
  assert.deepEqual(bossRoomWorkers([], false), []);
});
