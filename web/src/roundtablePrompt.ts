// 圓桌（Roundtable）模式：使用者要的是「直接給我一個討論後的結果」，不是派工、也不是看多個 NPC
// 互相來回辯論。真的開 N 個 agent 多輪辯論會把 token 燒爆（那正是部門派工貴的原因），所以這裡刻意
// 用「單一 NPC 扮演多個角色、一次性內部模擬一場圓桌」的做法：成本 ≈ 一次普通提問，卻仍能產出
// 「各角色意見 + 綜合結論」。輸出直接用 Markdown，讓它在 NPC 的工作日誌裡漂亮呈現，不必額外解析。
//
// R3 調整重點：
// 1. 第一行固定是「【快速圓桌】主題」：日誌卡、導覽、搜尋只顯示第一行，以前每張圓桌卡都長得一樣
//    （全是「你正在 Pixel Crew 主持一場…」），現在一眼就看得出是哪一場。
// 2. 角色要「針對這個主題真的會吵起來」的具體角色，且一定有一位反方；每位要講出自己的取捨標準。
// 3. 結論要先下判斷、講清楚取捨與犧牲，並附信心程度與「什麼情況會改變結論」。
// 4. 允許少量唯讀查閱專案現況（上限 ROUNDTABLE_READ_LIMIT 次），讓結論貼著專案事實而不是泛論。
// 5. 結果出來後的一鍵延伸（照結論執行／反方檢驗／升級作戰室）的提示詞也集中在這裡。

import { t } from "./i18n";

/** 圓桌允許的唯讀查閱次數上限（讀檔、搜尋、列目錄合計）。單回合低成本是快速圓桌的本質。 */
export const ROUNDTABLE_READ_LIMIT = 3;
/** 日誌卡標題列（第一行）放得下的主題字數；完整主題仍在提示詞本文。 */
const HEADLINE_MAX = 80;
/** 升級作戰室時附帶的初判摘要上限，避免作戰室主題被長篇結論淹沒。 */
const ESCALATE_SUMMARY_MAX = 360;

export type RoundtableKind = "roundtable" | "challenge" | "execute";

/** 第一行的標記。中英兩種都認，切換語言後舊日誌照樣辨識得到。 */
export function roundtableMarker(kind: RoundtableKind = "roundtable"): string {
  if (kind === "challenge") return t("【快速圓桌・反方檢驗】");
  if (kind === "execute") return t("【快速圓桌・照結論執行】");
  return t("【快速圓桌】");
}
const MARKERS: Record<RoundtableKind, string[]> = {
  roundtable: ["【快速圓桌】", "[Quick Roundtable]"],
  challenge: ["【快速圓桌・反方檢驗】", "[Quick Roundtable · Counter-check]"],
  execute: ["【快速圓桌・照結論執行】", "[Quick Roundtable · Execute]"],
};

/** 這則指令是哪一種圓桌（看第一行標記）；不是圓桌回 null。 */
export function roundtableCommandKind(command: string): RoundtableKind | null {
  const head = command.trimStart();
  for (const kind of ["challenge", "execute", "roundtable"] as const) {
    if ([...MARKERS[kind], roundtableMarker(kind)].some((marker) => head.startsWith(marker))) return kind;
  }
  return null;
}

/** 會產出「圓桌結論」的指令（原始圓桌與反方檢驗）；照結論執行是普通工作回合，不算。 */
export function isRoundtableCommand(command: string): boolean {
  const kind = roundtableCommandKind(command);
  return kind === "roundtable" || kind === "challenge";
}

function headline(topic: string): string {
  const firstLine = topic.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
  const chars = Array.from(firstLine);
  return chars.length > HEADLINE_MAX ? `${chars.slice(0, HEADLINE_MAX).join("")}…` : firstLine;
}

function clip(text: string, max: number): string {
  const chars = Array.from(text.trim());
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

/** 共用的成本與查閱邊界：不派工、不改東西，最多 N 次唯讀查閱。 */
function budgetRules(): string {
  return `${t("重要限制（為了省時省 token）：這是一次性的內部模擬討論，在這一則回覆內完成。不要派工、不要開其他 Agent；除了下面允許的少量唯讀查閱，不要呼叫任何工具。")}\n` +
    `${t("專案脈絡：先用你在這段對話裡已知的專案狀況。只有當結論取決於專案現況時，才可做最多 {n} 次唯讀查閱（讀檔、搜尋、列目錄合計）；不得寫檔、不得執行會改變狀態的指令、不碰 Git 寫入或設定。查不到就寫明你的假設，不要為了查證拉長。", { n: ROUNDTABLE_READ_LIMIT })}`;
}

/** 上桌規則：角色要具體、真的會吵起來，且一定有反方；每位要講出自己的取捨標準。 */
function roleRules(): string {
  return `${t("上桌規則：依這個主題挑 2–4 個「真的會意見相左」的具體角色（例如「負責半夜值班的維運」比「工程」好），其中一位必須是反方，專門反駁最可能的結論。")}` +
    `${t("每位講出主張、自己最在意的取捨標準、一個具體理由（能引用專案事實更好）。觀點該衝突就衝突，不要每個人都說「看情況」。")}`;
}

export function roundtablePrompt(topic: string): string {
  const trimmed = topic.trim();
  return `${roundtableMarker()}${headline(trimmed)}\n\n` +
    `${t("你正在 Pixel Crew 主持一場「圓桌討論」。使用者要的是討論後的「結果」，不是過程，也不是要你去派工。")}\n` +
    `${budgetRules()}\n\n` +
    `${t("討論主題：{topic}", { topic: trimmed })}\n\n` +
    `${roleRules()}\n` +
    `${t("最後你以主持人身分下判斷：先講做／不做／選哪個，再講用了哪個取捨標準、犧牲了什麼。使用者最在意「結論」，要具體、能直接照做，不要打太極。")}\n\n` +
    `${t("請完全照以下 Markdown 結構回覆，精簡為主：")}\n` +
    `## ${t("圓桌意見")}\n` +
    `- **${t("角色（立場）")}**：${t("主張；在意：取捨標準；理由")}\n` +
    `${t("（列 2–4 個角色，至少一位反方）")}\n\n` +
    `## ${t("結論")}\n` +
    `${t("第一句直接下判斷；再用一兩句講取捨標準與犧牲了什麼。")}\n\n` +
    `## ${t("信心")}\n` +
    `${t("高／中／低（擇一）— 一句理由。若信心低，或這是代價高、難以撤回的決定，請在這裡建議「升級作戰室」。")}\n\n` +
    `## ${t("什麼情況會改變結論")}\n` +
    `- ${t("1–3 個具體、可觀察的訊號")}\n\n` +
    `## ${t("下一步")}\n` +
    `- ${t("1–3 個可直接照做的行動，第一個今天就能動手")}`;
}

/** 「反方檢驗」：同一位 NPC 再花一回合，專門攻擊剛才的結論。仍是單回合、同樣的查閱上限。 */
export function roundtableChallengePrompt(topic: string, conclusion: string): string {
  const trimmed = topic.trim();
  return `${roundtableMarker("challenge")}${headline(trimmed)}\n\n` +
    `${t("對剛才那場快速圓桌的結論做一次反方壓力測試。你現在是最強的反對者，目標是找出它會失敗的方式，而不是附和。")}\n` +
    `${budgetRules()}\n\n` +
    `${t("討論主題：{topic}", { topic: trimmed })}\n` +
    (conclusion.trim() ? `${t("待檢驗的結論：{conclusion}", { conclusion: clip(conclusion, ESCALATE_SUMMARY_MAX) })}\n` : "") +
    `\n${t("請完全照以下 Markdown 結構回覆，精簡為主：")}\n` +
    `## ${t("最強反對論點")}\n` +
    `- ${t("1–3 點，每點附「如果發生會怎樣」")}\n\n` +
    `## ${t("結論")}\n` +
    `${t("第一句寫「維持」或「修正」；修正就直接給新的結論。")}\n\n` +
    `## ${t("信心")}\n` +
    `${t("高／中／低（擇一）— 一句理由。")}\n\n` +
    `## ${t("什麼情況會改變結論")}\n` +
    `- ${t("1–3 個具體、可觀察的訊號")}\n\n` +
    `## ${t("下一步")}\n` +
    `- ${t("1–3 個可直接照做的行動")}`;
}

/** 「照結論執行」：轉成一般工作回合，可以動手；但遇到改變結論的訊號要先停下來回報。 */
export function roundtableExecutePrompt(topic: string, result: { conclusion: string; nextSteps: string[]; changeTriggers: string[] }): string {
  const steps = result.nextSteps.slice(0, 3);
  const triggers = result.changeTriggers.slice(0, 3);
  return `${roundtableMarker("execute")}${headline(topic)}\n\n` +
    `${t("照剛才快速圓桌的結論開始執行，這次可以正常動手做事。")}\n` +
    (result.conclusion.trim() ? `${t("結論：{conclusion}", { conclusion: clip(result.conclusion, ESCALATE_SUMMARY_MAX) })}\n` : "") +
    (steps.length ? `${t("依序處理：")}\n${steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n` : "") +
    (triggers.length
      ? `${t("執行中若發現下列任一情況成立，先停下來回報，不要硬做：")}\n${triggers.map((item) => `- ${item}`).join("\n")}\n`
      : "") +
    `${t("做完回報實際做了什麼、驗證結果，以及還沒做的部分。")}`;
}

/** 升級作戰室的主題：原題在前（作戰室歷史以它當標題），附上快速圓桌的初判讓作戰室重點檢驗。 */
export function roundtableEscalationTopic(topic: string, result: { conclusion: string; confidence: string | null }): string {
  const trimmed = topic.trim();
  if (!result.conclusion.trim()) return trimmed;
  const confidence = result.confidence ? t("（信心：{level}）", { level: result.confidence }) : "";
  return `${trimmed}\n\n${t("快速圓桌初判：{conclusion}{confidence}。請重點檢驗這個初判是否站得住。", {
    conclusion: clip(result.conclusion, ESCALATE_SUMMARY_MAX),
    confidence,
  })}`;
}

/** 從圓桌指令還原完整主題（升級作戰室、反方檢驗要用原題，而不是被截短的標題列）。 */
export function roundtableTopicFromCommand(command: string): string {
  const label = t("討論主題：{topic}", { topic: "\u0000" }).split("\u0000")[0];
  const start = command.indexOf(label);
  if (start >= 0) {
    const rest = command.slice(start + label.length);
    // 主題之後一定接一個空行再接固定段落；以第一個「空行＋已知段落開頭」為界。
    // 錨點取「翻譯後」句子的開頭，中英文介面都對得上。
    const lead = (text: string) => Array.from(text.split("\u0000")[0]).slice(0, 12).join("");
    const anchors = [lead(roleRules()), lead(t("待檢驗的結論：{conclusion}", { conclusion: "\u0000" })), lead(t("請完全照以下 Markdown 結構回覆，精簡為主："))];
    let end = rest.length;
    for (const anchor of anchors) {
      const at = rest.indexOf(`\n${anchor}`);
      if (at >= 0 && at < end) end = at;
    }
    const topic = rest.slice(0, end).trim();
    if (topic) return topic;
  }
  // 退路：用標題列（去掉標記）。
  const firstLine = command.trimStart().split(/\r?\n/)[0] ?? "";
  const kind = roundtableCommandKind(firstLine);
  if (!kind) return firstLine.trim();
  const marker = [...MARKERS[kind], roundtableMarker(kind)].find((item) => firstLine.startsWith(item)) ?? "";
  return firstLine.slice(marker.length).trim();
}
