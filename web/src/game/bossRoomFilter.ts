// 場景住客選擇。
// - 主辦公室（bossRoom=false）：只住常駐夥伴；老闆交辦的臨時部門
//   （ephemeralKind="dedicated"）是短命工，平常收起來不佔主場景。
// - 開 BOSS 頁（bossRoom=true）：整間辦公室的人全部留著——常駐部門 + 交辦部隊
//   一起顯示。之前這裡只留交辦部隊、把其他部門藏起來，使用者一切到 BOSS 就看到
//   「其他部門 NPC 全消失／場景空白」，那不是想要的行為。開 BOSS 只是把老闆交辦桌
//   叫出來，不該把任何人趕出場景。
export function bossRoomWorkers<T extends { ephemeralKind?: string | null }>(
  workers: T[],
  bossRoom: boolean,
): T[] {
  if (bossRoom) return workers;
  return workers.filter((worker) => worker.ephemeralKind !== "dedicated");
}
