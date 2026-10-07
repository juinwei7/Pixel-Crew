// 場景「兩間房」的住客選擇：主辦公室住常駐夥伴，BOSS 交辦房住「正在做這張交辦的那群人」。
// 交辦房的住客 = 老闆交辦的臨時專屬部隊（ephemeralKind="dedicated"）＋目前進行中交辦被
// 路由到的既有部門成員（bossTaskDepartmentIds）。這樣不論交辦走「開專屬部門」或「路由給
// 既有部門」，一開 BOSS 都會切到正在做這張交辦的部門，而不是只有 dedicated 才切得過去。
// 關鍵護欄：交辦房沒人時退回主辦公室——BOSS 頁開著但目前沒有任何進行中交辦成員（交辦剛
// 送出、專屬部隊還在編制、或交辦已結束解散）的話，絕不能讓場景空成一片「NPC 全消失」。
export function bossRoomWorkers<T extends { ephemeralKind?: string | null; departmentId?: string | null }>(
  workers: T[],
  bossRoom: boolean,
  bossTaskDepartmentIds?: ReadonlySet<string>,
): T[] {
  if (bossRoom) {
    const inBossRoom = workers.filter((worker) =>
      worker.ephemeralKind === "dedicated" ||
      (worker.departmentId != null && (bossTaskDepartmentIds?.has(worker.departmentId) ?? false)),
    );
    if (inBossRoom.length > 0) return inBossRoom;
  }
  return workers.filter((worker) => worker.ephemeralKind !== "dedicated");
}
