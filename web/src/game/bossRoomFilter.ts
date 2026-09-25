// 場景「兩間房」的住客選擇：主辦公室住常駐夥伴，BOSS 交辦房只住老闆交辦的
// 臨時部門（ephemeralKind="dedicated"）。關鍵護欄：交辦房沒人時退回主辦公室——
// BOSS 頁開著但目前沒有臨時部門成員（任務被路由給既有部門、臨時部門已解散、
// 或交辦剛重開還沒建隊）的話，絕不能讓場景空成一片「NPC 全消失」。
export function bossRoomWorkers<T extends { ephemeralKind?: string | null }>(
  workers: T[],
  bossRoom: boolean,
): T[] {
  const dedicated = workers.filter((worker) => worker.ephemeralKind === "dedicated");
  if (bossRoom && dedicated.length > 0) return dedicated;
  return workers.filter((worker) => worker.ephemeralKind !== "dedicated");
}
