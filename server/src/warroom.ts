import { collaborationText } from "./collaboration.js";
import { t } from "./i18n.js";

// 作戰室（War Room）＝一場「有真辯論、依難度配模型、結論收斂回主控」的顧問議會。
// 這個檔只放「純邏輯」：難度分級 → 模型選擇、各輪提示（表態→反駁）、以及主持最終裁決的
// 結構化結果解析（仿 collaboration.ts 的 parseCollaborationResult，含 graceful fallback）。
// 真正的並行編排（建臨時 worker、Promise.allSettled、turn_end 偵測、預算閘門、TTL 清除）在
// index.ts 的路由裡用這裡的純函式組起來——這樣純邏輯可單元測試，副作用留在外層。

export type WarRoomDifficulty = "simple" | "medium" | "hard";

// 🏛／🔍 是編排器建立、完成後就該消失的短命 worker。集中判定，避免不同
// lifecycle hook 各自硬編字首而漏掉清理或誤寫入永久資料。
export function isEphemeralWorkerName(name: string): boolean {
  return name.startsWith("🏛") || name.startsWith("🔍");
}

// 依難度配模型：簡單用便宜、難的用強。這是議會裁決「事中省 token、只在難處花貴」的落地。
// peers 用中階、lead（最終裁決，最重要）用高階；simple 全便宜。
export function warroomModels(difficulty: WarRoomDifficulty): { peer: string; lead: string } {
  switch (difficulty) {
    case "hard": return { peer: "sonnet", lead: "opus" };
    case "medium": return { peer: "haiku", lead: "sonnet" };
    default: return { peer: "haiku", lead: "haiku" };
  }
}

// 三個對立立場，逼出真辯論而非一團和氣（議會裁決點 1）。
// 注意：name/brief 是 t() 的字典 key（原文），實際翻譯在 warroomStances() 用到的當下才查——
// 這裡維持模組載入期常數是安全的，因為它們從不被直接顯示，一律經過 warroomStances() 轉譯。
export const WARROOM_STANCES = [
  { key: "propose", name: "提案", brief: "提案方：積極提出最有價值的改進，敢想、敢賭大的。" },
  { key: "challenge", name: "挑戰", brief: "魔鬼代言人：專門反對，挑風險／成本／技術債／為何不該做，戳破過度樂觀。" },
  { key: "weigh", name: "權衡", brief: "務實權衡方：在提案與反對間找可行取捨與優先序，做裁判。" },
] as const;

export type WarRoomStanceKey = (typeof WARROOM_STANCES)[number]["key"];

export type WarRoomStance = { key: string; name: string; brief: string };

// 困難題加開的第四席：專職上網查證各方主張的數字與事實，把「有依據/沒依據」攤開。
const VERIFY_STANCE: WarRoomStance = {
  key: "verify",
  name: "查證",
  brief: "實證查核方：對其他人主張中的關鍵數字與事實，用 WebSearch 上網查證真偽，明確指出哪些有依據、哪些查無來源；自己不站方向，只認證據。",
};

function translateStance(stance: WarRoomStance): WarRoomStance {
  return { key: stance.key, name: t(stance.name), brief: t(stance.brief) };
}

// 上桌人數隨難度伸縮：簡單題 2 人快問快答就夠；中等 3 方對立；困難題加「查證」共 4 席，
// 讓重要裁決多一層事實查核。輪數由 orchestrator 決定（簡單 1 輪、其餘 2 輪）。
export function warroomStances(difficulty: WarRoomDifficulty): WarRoomStance[] {
  if (difficulty === "simple") return [WARROOM_STANCES[0], WARROOM_STANCES[1]].map(translateStance);
  if (difficulty === "hard") return [...WARROOM_STANCES, VERIFY_STANCE].map(translateStance);
  return WARROOM_STANCES.map(translateStance);
}

// 使用者自訂上桌角色（來自前端 ⚙ 面板）：清洗＋設界線，2–4 位才算有效自訂（1 位辯不起來）。
// brief 沒寫就給個中性立場，至少讓角色知道自己該從什麼視角發言。
export function sanitizeCustomStances(value: unknown): WarRoomStance[] {
  if (!Array.isArray(value)) return [];
  const stances = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    const name = collaborationText(item.name, 12);
    if (!name) return [];
    const brief = collaborationText(item.brief, 200) || t("以「{name}」的專業視角發言，立場鮮明、不打圓場。", { name });
    return [{ key: `custom-${name}`, name, brief }];
  }).slice(0, 4);
  return stances.length >= 2 ? stances : [];
}

// 第 1 輪：各自鮮明表態。
export function warroomOpeningPrompt(input: { topic: string; stanceBrief: string }): string {
  return t(
    "你正在 Pixel Crew 參加一場「圓桌辯論」。主題：{topic}\n你的立場：{stanceBrief}\n\n請鮮明表態，用 3–5 點給出你的主張與理由（可具體到檔案／做法）。只講你這個立場，別替別人打圓場。\n防幻覺護欄：若主題涉及「即時資訊」（今日行情、最新新聞、現價…），先用 WebSearch 查證再表態；查不到就明講「缺即時數據」，嚴禁憑記憶編造具體數字（點位、價格、日期）。",
    { topic: collaborationText(input.topic, 2_000), stanceBrief: collaborationText(input.stanceBrief, 400) },
  );
}

// 第 2 輪：看到其他人的意見後反駁／補強——這一輪才是「真辯論」。
export function warroomRebuttalPrompt(input: { stanceBrief: string; othersDebate: string }): string {
  return t(
    "【第 2 輪・反駁】其他人的第 1 輪意見如下：\n{othersDebate}\n\n請以你的立場（{stanceBrief}）反駁或補強：明講你「不同意誰、為什麼」，並修正／強化你的建議。3–5 點，火力全開別客氣。",
    { othersDebate: collaborationText(input.othersDebate, 12_000), stanceBrief: collaborationText(input.stanceBrief, 400) },
  );
}

// 主持（lead）最終裁決：整合兩輪辯論，輸出結構化 JSON（給前端結果卡用），失敗有純文字退路。
export function warroomSynthesisPrompt(input: { topic: string; debate: string }): string {
  return t(
    "你是圓桌主持人，握有最終裁決權。主題：{topic}\n\n以下是三方兩輪的辯論（立場＋反駁）：\n{debate}\n\n請務實整合，完成後只輸出下列格式，不要加 Markdown code fence、不要在標籤外多寫字：\n<warroom_result>{\"verdict\":\"\",\"consensus\":[\"\"],\"disputes\":[{\"point\":\"\",\"ruling\":\"\"}],\"actions\":[{\"priority\":\"P1|P2|P3|P4\",\"title\":\"\",\"how\":\"\"}],\"metrics\":[{\"label\":\"\",\"value\":\"\",\"note\":\"\"}],\"charts\":[{\"type\":\"line|bar|donut\",\"title\":\"\",\"labels\":[\"\"],\"values\":[0],\"unit\":\"\"}]}</warroom_result>\n其中 verdict＝一段話最終結論；consensus＝共識清單；disputes＝分歧點與你的裁決；actions＝可執行下一步（含優先級與具體做法／檔案）；metrics＝關鍵數字（3–8 個）：label 名稱、value 數值（含單位，例 \"44,933\" / \"+0.48%\"）、note 補充；charts＝圖表數據（最多 3 張）：辯論中有「數據序列」時輸出——走勢/時間序列用 line、類別對比用 bar、占比/配置用 donut；labels 與 values 一一對應（values 必須是純數字）、unit 是單位。只放辯論中真實出現且有依據的數據，嚴禁編造；沒有序列數據就留空陣列。",
    { topic: collaborationText(input.topic, 2_000), debate: collaborationText(input.debate, 24_000) },
  );
}

export type WarRoomDispute = { point: string; ruling: string };
export type WarRoomAction = { priority: "P1" | "P2" | "P3" | "P4"; title: string; how: string };
// 關鍵數字：讓裁決「用數字說話」——主題涉及數據（行情、成本、效能…）時，主持必須把
// 關鍵數值抽出來，前端渲染成大字數據磚，而不是埋在整片文字裡。
export type WarRoomMetric = { label: string; value: string; note?: string };
// 圖表數據：主持把辯論中的「數據序列」抽出來，前端畫成走勢圖(line)/長條圖(bar)/圓餅圖(donut)。
export type WarRoomChart = { type: "line" | "bar" | "donut"; title: string; labels: string[]; values: number[]; unit?: string };

export type WarRoomResult = {
  verdict: string;
  consensus: string[];
  disputes: WarRoomDispute[];
  actions: WarRoomAction[];
  metrics: WarRoomMetric[];
  charts: WarRoomChart[];
  structured: boolean; // false＝沒解析到結構化格式，退回純文字塞在 verdict
  costUsd?: number;    // 這場作戰室實際花費（美元），由 orchestrator 累加各回合成本後填入
};

function list(value: unknown, itemLimit: number, count: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => collaborationText(item, itemLimit)).filter(Boolean).slice(0, count);
}

export function parseWarroomResult(raw: string): WarRoomResult | null {
  const bounded = collaborationText(raw, 40_000);
  if (!bounded) return null;
  const marked = bounded.match(/<warroom_result>\s*([\s\S]*?)\s*<\/warroom_result>/i)?.[1];
  const candidate = marked ?? bounded.match(/\{[\s\S]*\}/)?.[0];
  if (candidate) {
    try {
      const value = JSON.parse(candidate) as Record<string, unknown>;
      const disputes: WarRoomDispute[] = Array.isArray(value.disputes)
        ? value.disputes.flatMap((entry) => {
            if (!entry || typeof entry !== "object") return [];
            const item = entry as Record<string, unknown>;
            const point = collaborationText(item.point, 1_000);
            const ruling = collaborationText(item.ruling, 1_000);
            return point || ruling ? [{ point, ruling }] : [];
          }).slice(0, 12)
        : [];
      const actions: WarRoomAction[] = Array.isArray(value.actions)
        ? value.actions.flatMap((entry) => {
            if (!entry || typeof entry !== "object") return [];
            const item = entry as Record<string, unknown>;
            const title = collaborationText(item.title, 500);
            if (!title) return [];
            const priority = ["P1", "P2", "P3", "P4"].includes(String(item.priority))
              ? item.priority as WarRoomAction["priority"] : "P2";
            return [{ priority, title, how: collaborationText(item.how, 2_000) }];
          }).slice(0, 12)
        : [];
      const metrics: WarRoomMetric[] = Array.isArray(value.metrics)
        ? value.metrics.flatMap((entry) => {
            if (!entry || typeof entry !== "object") return [];
            const item = entry as Record<string, unknown>;
            const label = collaborationText(item.label, 60);
            const metricValue = collaborationText(item.value, 60);
            if (!label || !metricValue) return [];
            const note = collaborationText(item.note, 120);
            return [{ label, value: metricValue, ...(note ? { note } : {}) }];
          }).slice(0, 8)
        : [];
      const charts: WarRoomChart[] = Array.isArray(value.charts)
        ? value.charts.flatMap((entry) => {
            if (!entry || typeof entry !== "object") return [];
            const item = entry as Record<string, unknown>;
            const type = ["line", "bar", "donut"].includes(String(item.type)) ? item.type as WarRoomChart["type"] : null;
            const title = collaborationText(item.title, 80);
            const rawLabels = Array.isArray(item.labels) ? item.labels.map((l) => collaborationText(l, 24)) : [];
            const rawValues = Array.isArray(item.values) ? item.values.map((v) => Number(v)).filter((v) => Number.isFinite(v)) : [];
            const n = Math.min(rawLabels.length, rawValues.length, 24);
            if (!type || !title || n < 2) return []; // 少於 2 點畫不成圖，直接略過
            const unit = collaborationText(item.unit, 16);
            return [{ type, title, labels: rawLabels.slice(0, n), values: rawValues.slice(0, n), ...(unit ? { unit } : {}) }];
          }).slice(0, 3)
        : [];
      const verdict = collaborationText(value.verdict, 4_000);
      if (verdict || actions.length) {
        return { verdict: verdict || t("作戰室已完成裁決。"), consensus: list(value.consensus, 1_000, 12), disputes, actions, metrics, charts, structured: true };
      }
    } catch { /* 落到純文字退路 */ }
  }
  // 沒照格式輸出時，不整包丟掉：純文字當結論，前端仍拿得到內容（議會裁決：retry 由外層負責、須帶上限）。
  return { verdict: bounded, consensus: [], disputes: [], actions: [], metrics: [], charts: [], structured: false };
}
