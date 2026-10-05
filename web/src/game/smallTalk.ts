// Short, context-aware lines NPCs mutter now and then (繁中). The scene rate-
// limits them (one bubble every few seconds, office-wide); this module only
// picks what fits the moment.
import type { StationKey } from "../stations";
import type { Trait } from "./officeLife";

export type TalkContext = {
  kind: "working" | "thinking" | "waiting" | "idle" | "success";
  station?: StationKey;
  impatient?: boolean;
  tired?: boolean;
  lateNight?: boolean;
  trait?: Trait;
};

const BY_STATION: Partial<Record<StationKey, string[]>> = {
  terminal: ["這指令跑好久…", "編譯中，喝口水", "綠字好療癒", "千萬別 rm -rf"],
  code: ["這段誰寫的…喔是我", "再一個 bug 就好", "命名好難", "縮排強迫症發作"],
  books: ["資料好多", "原來如此", "這份文件好長", "筆記筆記"],
  web: ["搜尋中…", "這網站好慢", "找到了！", "開了二十個分頁"],
  check: ["測試全綠！", "再驗一次", "這個邊界條件…", "穩了"],
  board: ["卡片往右移～", "今天的待辦好多", "排個優先順序"],
  desk: ["工具箱翻一下", "這個好用", "差一個零件"],
  meeting: ["我有個想法", "+1", "先記下來"],
};
const THINKING = ["讓我想想…", "嗯…有了！", "換個角度", "等等，好像懂了"];
const WAITING = ["等你點頭～", "可以了嗎？", "老闆，簽一下", "我先舉著手"];
const IMPATIENT = ["還沒好嗎…", "手好痠", "時間在流逝…"];
const SUCCESS = ["搞定！", "收工！", "完美～", "一次過！"];
const TIRED = ["好累…", "腦袋好滿", "需要咖啡", "眼睛好酸"];
const LATE = ["該睡了吧", "又熬夜了", "月亮好圓"];
const IDLE = ["好閒喔", "今天天氣不錯", "咖啡呢？", "伸個懶腰", "有人要點飲料嗎"];
const BY_TRAIT: Partial<Record<Trait, string[]>> = {
  energetic: ["衝衝衝！", "下一個任務呢？"],
  sleepy: ["呼啊…", "好想睡"],
  nerdy: ["新版本出了耶", "這個 API 好酷"],
  tidy: ["桌面要整齊", "順手擦一下"],
  social: ["午餐吃什麼？", "週末去哪玩？"],
  chill: ["慢慢來", "放輕鬆～"],
};

function pick(lines: string[] | undefined): string | null {
  return lines && lines.length ? lines[Math.floor(Math.random() * lines.length)] : null;
}

/** A line for this moment, or null if nothing fits. */
export function talkLine(c: TalkContext): string | null {
  if (c.kind === "success") return pick(SUCCESS);
  if (c.kind === "waiting") return pick(c.impatient ? IMPATIENT : WAITING);
  if (c.tired && Math.random() < 0.5) return pick(TIRED);
  if (c.lateNight && Math.random() < 0.4) return pick(LATE);
  if (c.kind === "thinking") return pick(THINKING);
  if (c.kind === "working") return pick(c.station ? BY_STATION[c.station] : undefined) ?? pick(THINKING);
  return Math.random() < 0.4 ? pick(c.trait ? BY_TRAIT[c.trait] : undefined) ?? pick(IDLE) : pick(IDLE);
}
