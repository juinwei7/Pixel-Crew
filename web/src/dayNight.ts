// 日夜曲線（單一事實來源）：真實時鐘小時 → night 係數（0=白天、1=深夜）。
// 像素風窗外天空（game/scene.ts）、3D 場景光影（three/officeScene.ts）、
// 3D 背景漸層（components/Office3D.tsx）共用同一條關鍵影格曲線，改一處三邊同步。
export const DAY_NIGHT_KEYS: Array<[number, number]> = [
  [0, 1], [5, 1], [6.5, 0], [9, 0], [17, 0], [18.5, 0], [20, 1], [24, 1],
];

export function nightFactor(hourFloat: number): number {
  let prev = DAY_NIGHT_KEYS[0];
  for (const key of DAY_NIGHT_KEYS) {
    if (hourFloat <= key[0]) {
      const t = key[0] === prev[0] ? 0 : (hourFloat - prev[0]) / (key[0] - prev[0]);
      return prev[1] + (key[1] - prev[1]) * t;
    }
    prev = key;
  }
  return 1;
}

export function nightFactorNow(now: Date = new Date()): number {
  return nightFactor(now.getHours() + now.getMinutes() / 60);
}
