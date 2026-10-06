import type { RunnerEvent } from "./claudeRunner.js";
import { collaborationText } from "./collaboration.js";
import { recentConversation } from "./handoff.js";
import { t } from "./i18n.js";
import type { ProviderId } from "./providers/types.js";

// 作戰室（War Room）＝一場「有真辯論、依難度配模型、結論收斂回主控」的顧問議會。
// 這個檔只放「純邏輯」：難度分級 → 模型選擇、各輪提示（表態→反駁）、以及主持最終裁決的
// 結構化結果解析（仿 collaboration.ts 的 parseCollaborationResult，含 graceful fallback）。
// 真正的並行編排（建臨時 worker、Promise.allSettled、turn_end 偵測、預算閘門、TTL 清除）在
// index.ts 的路由裡用這裡的純函式組起來——這樣純邏輯可單元測試，副作用留在外層。

export type WarRoomDifficulty = "simple" | "medium" | "hard";

// 編排器建立、完成後就該消失的短命 worker（作戰室成員、研究員）。
export type EphemeralWorkerKind = "warroom" | "research" | "dedicated";

// 舊版是用名字的 emoji 字首（🏛／🔍）判斷這件事：server 這樣命名，server 與
// 前端再各自比對字首。那等於把協定藏在顯示字串裡——使用者一改名就失效，
// 前端也被迫在介面上顯示 emoji。現在改成 worker 上的明確欄位，這個函式只
// 留給「舊版寫進 SQLite 的殘骸」用：那些列沒有新欄位，只能靠名字認。
const LEGACY_EPHEMERAL_PREFIXES = ["\u{1F3DB}", "\u{1F50D}"];

export function isLegacyEphemeralWorkerName(name: string): boolean {
  return LEGACY_EPHEMERAL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

// 依難度配模型：簡單用便宜、難的用強。作戰室必須沿用召集 NPC 的 provider，
// 才不會在 Codex 對話裡暗中另開 Claude 用量。peers 用中階、lead（最終裁決）用高階。
export function warroomModels(provider: ProviderId, difficulty: WarRoomDifficulty): { peer: string; lead: string } {
  if (provider === "codex") {
    switch (difficulty) {
      case "hard": return { peer: "gpt-5.6-terra", lead: "gpt-5.6-sol" };
      case "medium": return { peer: "gpt-5.6-luna", lead: "gpt-5.6-terra" };
      default: return { peer: "gpt-5.6-luna", lead: "gpt-5.6-luna" };
    }
  }
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

// 議題背景：短命 peers 是全新 session，對召集 NPC 正在做什麼一無所知，只能就字面空談。
// 這裡從召集人的近期對話抽出極短的背景（召集人／專案名／最近 3 則訊息，每則截短），
// 總長封頂，只在第 1 輪與裁決時帶一次——第 2 輪同一個 session 已經記得，不重送。
const CONTEXT_ITEM_LIMIT = 200;
const CONTEXT_TOTAL_LIMIT = 900;
export type WarRoomContextInput = {
  hostName: string;
  hostRole?: string | null;
  workspacePath: string;
  events: RunnerEvent[];
};

export function warroomContextBrief(input: WarRoomContextInput): string {
  const hostName = collaborationText(input.hostName, 40) || t("召集人");
  const role = collaborationText(input.hostRole ?? "", 80);
  const project = input.workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const lines = [t("召集人：{host}{role}；專案：{project}", {
    host: hostName,
    role: role ? `（${role}）` : "",
    project: collaborationText(project, 60) || t("（未命名）"),
  })];
  const recent = recentConversation(input.events, 2).slice(-3);
  if (recent.length > 0) {
    lines.push(t("召集人最近的對話（節錄）："));
    for (const message of recent) {
      const flat = message.text.replace(/\s+/g, " ");
      const text = collaborationText(flat, CONTEXT_ITEM_LIMIT);
      if (!text) continue;
      lines.push(`- ${message.role === "user" ? t("使用者") : hostName}：${flat.length > CONTEXT_ITEM_LIMIT ? `${text}…` : text}`);
    }
  }
  return lines.join("\n").slice(0, CONTEXT_TOTAL_LIMIT);
}

function contextSection(context?: string): string {
  const bounded = collaborationText(context ?? "", CONTEXT_TOTAL_LIMIT);
  return bounded ? t("\n\n【背景】\n{context}", { context: bounded }) : "";
}

// 總體判斷信號：每位成員表態結尾標一個 GO／HOLD／NO，讓編排器不用再花一次模型呼叫就能
// 判斷「第 1 輪是否已高度共識」，共識時省掉整個反駁輪（中等難度約省 1/3 花費與時間）。
export type WarRoomPosition = "GO" | "HOLD" | "NO";

export function parseWarroomPosition(text: string): WarRoomPosition | null {
  const matches = [...String(text ?? "").matchAll(/<position>\s*(GO|HOLD|NO)\s*<\/position>/gi)];
  const last = matches.at(-1)?.[1]?.toUpperCase();
  return last === "GO" || last === "HOLD" || last === "NO" ? last : null;
}

// 第 2 輪要不要開：全員（至少 2 位）都給出相同信號才省略。保守起見——
// 任何人沒發言成功／沒標信號、或桌上有「查證」席（它要看到別人的主張才能查）都照開。
export function warroomRebuttalNeeded(stances: Array<{ key: string }>, openings: string[]): boolean {
  if (stances.some((stance) => stance.key === "verify")) return true;
  const positions = openings.map(parseWarroomPosition);
  if (positions.length < 2 || positions.some((position) => position === null)) return true;
  return !positions.every((position) => position === positions[0]);
}

// 反駁輪給每位成員看的「其他人」意見：排除自己那段——自己的主張已在同一個 session 裡，
// 再貼一次只是重複燒 input token（3 人桌每人少讀 1/3 篇幅）。
export function warroomOthersDigest(stances: Array<{ name: string }>, openings: string[], selfIndex: number): string {
  return stances
    .map((stance, index) => index === selfIndex ? "" : t("【{name}】\n{text}", { name: stance.name, text: openings[index] || t("(無)") }))
    .filter(Boolean)
    .join("\n\n");
}

// 第 1 輪：各自鮮明表態。
export function warroomOpeningPrompt(input: { topic: string; stanceBrief: string; context?: string }): string {
  return t(
    "你正在 Pixel Crew 參加一場「圓桌辯論」。主題：{topic}\n你的立場：{stanceBrief}\n\n請鮮明表態，用 3–5 點給出你的主張與理由（可具體到檔案／做法）。只講你這個立場，別替別人打圓場。\n防幻覺護欄：若主題涉及「即時資訊」（今日行情、最新新聞、現價…），先用 WebSearch 查證再表態；查不到就明講「缺即時數據」，嚴禁憑記憶編造具體數字（點位、價格、日期）。",
    { topic: collaborationText(input.topic, 2_000), stanceBrief: collaborationText(input.stanceBrief, 400) },
  ) + contextSection(input.context)
    + t("\n\n最後單獨一行標出你對主題的總體判斷：<position>GO</position>（該做／看好）、<position>HOLD</position>（有條件／再觀察）或 <position>NO</position>（不該做／看壞），三選一。");
}

// 第 2 輪：看到其他人的意見後反駁／補強——這一輪才是「真辯論」。
export function warroomRebuttalPrompt(input: { stanceBrief: string; othersDebate: string }): string {
  return t(
    "【第 2 輪・反駁】其他人的第 1 輪意見如下：\n{othersDebate}\n\n請以你的立場（{stanceBrief}）反駁或補強：明講你「不同意誰、為什麼」，並修正／強化你的建議。3–5 點，火力全開別客氣。",
    { othersDebate: collaborationText(input.othersDebate, 12_000), stanceBrief: collaborationText(input.stanceBrief, 400) },
  ) + t("\n對照你自己第 1 輪的主張：被說服而修正的點要明講，堅持的點補上更強的理由。最後一行同樣標出你現在的 <position>GO|HOLD|NO</position>。");
}

// 主持（lead）最終裁決：整合辯論，輸出結構化 JSON（給前端結果卡用），失敗有純文字退路。
// 除了結論與行動，還要「信心程度／什麼會推翻結論／被否決的選項」——讓使用者知道這個裁決
// 有多可靠、何時該重開，也看得到哪些路被考慮過又為何放棄。
export function warroomSynthesisPrompt(input: { topic: string; debate: string; context?: string; peerCount?: number; rounds?: number; earlyConsensus?: boolean }): string {
  const count = String(Math.max(1, Math.floor(input.peerCount ?? 3)));
  const shape = input.earlyConsensus
    ? t("{count} 方的表態（第 1 輪即判斷一致，已省略反駁輪）", { count })
    : input.rounds === 1
      ? t("{count} 方的一輪表態", { count })
      : t("{count} 方兩輪的辯論（立場＋反駁）", { count });
  return t(
    "你是圓桌主持人，握有最終裁決權。主題：{topic}{context}\n\n以下是{shape}：\n{debate}\n\n請務實整合；若各方一致，仍要點出挑戰方提過的主要風險，別讓共識變成盲點。完成後只輸出下列格式，不要加 Markdown code fence、不要在標籤外多寫字：\n<warroom_result>{\"verdict\":\"\",\"confidence\":\"high|medium|low\",\"consensus\":[\"\"],\"disputes\":[{\"point\":\"\",\"ruling\":\"\"}],\"rejected\":[{\"option\":\"\",\"reason\":\"\"}],\"flip_if\":[\"\"],\"actions\":[{\"priority\":\"P1|P2|P3|P4\",\"title\":\"\",\"how\":\"\"}],\"metrics\":[{\"label\":\"\",\"value\":\"\",\"note\":\"\"}],\"charts\":[{\"type\":\"line|bar|donut\",\"title\":\"\",\"labels\":[\"\"],\"values\":[0],\"unit\":\"\"}]}</warroom_result>\n其中 verdict＝一段話最終結論；confidence＝你對結論的信心（證據紮實＝high、推論合理但缺關鍵數據＝medium、多靠臆測或分歧未解＝low）；consensus＝共識清單；disputes＝分歧點與你的裁決；rejected＝被考慮過但否決的選項與原因（最多 4 個）；flip_if＝出現什麼證據或情況就該推翻這個結論（1–3 條，要具體可觀察）；actions＝可執行下一步（含優先級與具體做法／檔案）；metrics＝關鍵數字（3–8 個）：label 名稱、value 數值（含單位，例 \"44,933\" / \"+0.48%\"）、note 補充；charts＝圖表數據（最多 3 張）：辯論中有「數據序列」時輸出——走勢/時間序列用 line、類別對比用 bar、占比/配置用 donut；labels 與 values 一一對應（values 必須是純數字）、unit 是單位。只放辯論中真實出現且有依據的數據，嚴禁編造；沒有就留空陣列。",
    {
      topic: collaborationText(input.topic, 2_000),
      context: contextSection(input.context),
      shape,
      debate: collaborationText(input.debate, 24_000),
    },
  );
}

export type WarRoomDispute = { point: string; ruling: string };
export type WarRoomAction = { priority: "P1" | "P2" | "P3" | "P4"; title: string; how: string };
// 關鍵數字：讓裁決「用數字說話」——主題涉及數據（行情、成本、效能…）時，主持必須把
// 關鍵數值抽出來，前端渲染成大字數據磚，而不是埋在整片文字裡。
export type WarRoomMetric = { label: string; value: string; note?: string };
// 圖表數據：主持把辯論中的「數據序列」抽出來，前端畫成走勢圖(line)/長條圖(bar)/圓餅圖(donut)。
export type WarRoomChart = { type: "line" | "bar" | "donut"; title: string; labels: string[]; values: number[]; unit?: string };
export type WarRoomConfidence = "high" | "medium" | "low";
export type WarRoomRejected = { option: string; reason: string };

export type WarRoomResult = {
  verdict: string;
  consensus: string[];
  disputes: WarRoomDispute[];
  actions: WarRoomAction[];
  metrics: WarRoomMetric[];
  charts: WarRoomChart[];
  structured: boolean; // false＝沒解析到結構化格式，退回純文字塞在 verdict
  costUsd?: number;    // 這場作戰室實際花費（美元），由 orchestrator 累加各回合成本後填入
  // 以下為後加欄位，舊報告 JSON 沒有，一律選填。
  confidence?: WarRoomConfidence;
  flipIf?: string[];            // 什麼證據／情況會推翻結論
  rejected?: WarRoomRejected[]; // 被否決的選項與原因
  rounds?: number;              // 實際跑了幾輪（orchestrator 填）
  earlyConsensus?: boolean;     // 第 1 輪即一致而省略反駁輪（orchestrator 填）
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
            // labels/values 必須「成對」保留或丟棄：values 單獨 filter 掉非數值（模型常吐 "N/A"、"12%"）
            // 會讓後面的數值整段左移對到錯的標籤。逐格配對，任一邊無效就整格丟。
            const pairLabels = Array.isArray(item.labels) ? item.labels : [];
            const pairValues = Array.isArray(item.values) ? item.values : [];
            const rawLabels: string[] = [];
            const rawValues: number[] = [];
            for (let i = 0; i < Math.min(pairLabels.length, pairValues.length); i++) {
              const label = collaborationText(pairLabels[i], 24);
              const value = Number(pairValues[i]);
              if (!label || !Number.isFinite(value)) continue;
              rawLabels.push(label);
              rawValues.push(value);
            }
            const n = Math.min(rawLabels.length, rawValues.length, 24);
            if (!type || !title || n < 2) return []; // 少於 2 點畫不成圖，直接略過
            const unit = collaborationText(item.unit, 16);
            return [{ type, title, labels: rawLabels.slice(0, n), values: rawValues.slice(0, n), ...(unit ? { unit } : {}) }];
          }).slice(0, 3)
        : [];
      const rejected: WarRoomRejected[] = Array.isArray(value.rejected)
        ? value.rejected.flatMap((entry) => {
            if (!entry || typeof entry !== "object") return [];
            const item = entry as Record<string, unknown>;
            const option = collaborationText(item.option, 300);
            return option ? [{ option, reason: collaborationText(item.reason, 600) }] : [];
          }).slice(0, 4)
        : [];
      const flipIf = list(value.flip_if ?? value.flipIf, 400, 3);
      const confidenceRaw = String(value.confidence ?? "").trim().toLowerCase();
      const confidence = (["high", "medium", "low"] as const).find((level) => level === confidenceRaw);
      const verdict = collaborationText(value.verdict, 4_000);
      if (verdict || actions.length) {
        return {
          verdict: verdict || t("作戰室已完成裁決。"), consensus: list(value.consensus, 1_000, 12), disputes, actions, metrics, charts, structured: true,
          ...(confidence ? { confidence } : {}),
          ...(flipIf.length ? { flipIf } : {}),
          ...(rejected.length ? { rejected } : {}),
        };
      }
    } catch { /* 落到純文字退路 */ }
  }
  // 沒照格式輸出時，不整包丟掉：純文字當結論，前端仍拿得到內容（議會裁決：retry 由外層負責、須帶上限）。
  return { verdict: bounded, consensus: [], disputes: [], actions: [], metrics: [], charts: [], structured: false };
}

export function warroomConfidenceLabel(confidence: WarRoomConfidence): string {
  return confidence === "high" ? t("高") : confidence === "medium" ? t("中") : t("低");
}

// 報告檔（.warroom/*.md）的追加段落：信心、是否提前收斂、會推翻結論的情況、被否決的選項。
// 都沒有就回空字串，舊格式報告不受影響。
export function warroomReportExtras(result: WarRoomResult): string {
  const parts: string[] = [];
  if (result.confidence) parts.push(t("**信心程度**：{level}\n\n", { level: warroomConfidenceLabel(result.confidence) }));
  if (result.earlyConsensus) parts.push(t("（第 1 輪即判斷一致，已省略反駁輪）\n\n"));
  if (result.flipIf?.length) parts.push(t("## 什麼會推翻這個結論\n{items}\n\n", { items: result.flipIf.map((item) => `- ${item}`).join("\n") }));
  if (result.rejected?.length) {
    const items = result.rejected.map((item) => `- **${item.option}**${item.reason ? `：${item.reason}` : ""}`).join("\n");
    parts.push(t("## 被否決的選項\n{items}\n\n", { items }));
  }
  return parts.join("");
}

// 回報召集 NPC 時附的一行信心提示：低信心要它動工前先跟使用者確認，別把臆測當定案。
export function warroomHostConfidenceNote(result: WarRoomResult): string {
  if (!result.confidence) return "";
  const level = warroomConfidenceLabel(result.confidence);
  return result.confidence === "low"
    ? t("裁決信心：{level}（證據不足，動工前請先跟使用者確認方向）\n\n", { level })
    : t("裁決信心：{level}\n\n", { level });
}
