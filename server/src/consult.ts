/**
 * 小隊商量（Consult）的純邏輯：隊長 system prompt 的商量區塊、隊員篩選
 * （忙碌／⚡無限制模式／今日預算已滿的不參戰）、以及發問與彙整回報的文字組裝。
 * 自 index.ts 原封搬入、行為不變；warroomSend 的實際發送與 postToHost 回投
 * 仍留在 index.ts 的 runConsult。
 */
import { t } from "./i18n.js";

export type ConsultDepartment = {
  name: string;
  leadWorkerId: string;
  memberWorkerIds: string[];
};

/**
 * 小隊商量 system prompt 區塊：只注入給「有隊員的部門隊長」。
 * 非隊長、沒有部門、或隊上沒有其他在職隊員時回傳空字串。
 */
export function composeConsultSection(input: {
  workerId: string;
  port: number;
  department: ConsultDepartment | null | undefined;
  /** 依 worker id 查目前在線的 NPC 名稱；不存在回 undefined。 */
  workerName: (id: string) => string | undefined;
}): string {
  const dept = input.department;
  if (!dept || dept.leadWorkerId !== input.workerId) return "";
  const mates = dept.memberWorkerIds
    .filter((id) => id !== input.workerId)
    .map((id) => input.workerName(id))
    .filter(Boolean);
  if (!mates.length) return "";
  return [
    t("【小隊商量】你是「{name}」的隊長，隊員：{mates}。當使用者的問題需要隊員的專業意見時，先靜默執行：", { name: dept.name, mates: mates.join("、") }),
    t("curl -s -X POST http://127.0.0.1:{port}/api/workers/{workerId}/consult -H \"Content-Type: application/json\" -d \"{\\\"question\\\":\\\"要商量的問題\\\"}\"", { port: input.port, workerId: input.workerId }),
    t("然後告訴使用者你正在跟隊員商量、結束這回合。隊員意見稍後會以【隊員商量回報】訊息送回，屆時再整合成你的結論回覆使用者。簡單問題自己答就好，不要事事發起商量。"),
  ].join("\n");
}

export type ConsultCandidate = {
  name: string;
  busy: boolean;
  autoApproveMode: string;
  /** 惰性取用，維持與原邏輯相同的讀取時機（只對非忙碌、非無敵的隊員查）。 */
  dailyBudgetUsd: () => number | null;
  todayCostUsd: () => number;
};

/**
 * 依部門成員順序篩出可參戰的隊員：跳過隊長本人、已離開的、忙碌中的、
 * ⚡無限制模式的（它的回合不經任何審批，不自動應答）、今日預算已滿的。
 * 回傳可參戰的 worker id 與「未參與」名單（含原因，供 digest 用）。
 */
export function selectConsultTargets(
  leadId: string,
  memberWorkerIds: string[],
  candidate: (id: string) => ConsultCandidate | null | undefined,
): { targetIds: string[]; skipped: string[] } {
  const targetIds: string[] = [];
  const skipped: string[] = [];
  for (const id of memberWorkerIds) {
    if (id === leadId) continue;
    const mate = candidate(id);
    if (!mate) continue;
    if (mate.busy) { skipped.push(t("{name}（忙碌中）", { name: mate.name })); continue; }
    // 同一道無人看管閘：無敵隊員不自動應答商量（它的回合不經任何審批）
    if (mate.autoApproveMode === "invincible") { skipped.push(t("{name}（⚡無限制模式不自動應答）", { name: mate.name })); continue; }
    const budget = mate.dailyBudgetUsd();
    if (budget != null && mate.todayCostUsd() >= budget) { skipped.push(t("{name}（今日預算已滿）", { name: mate.name })); continue; }
    targetIds.push(id);
  }
  return { targetIds, skipped };
}

/** 發給每位隊員的提問文字（防迴圈：明講只給意見、不要再發起商量）。 */
export function composeConsultAsk(leadName: string, question: string): string {
  return t(
    "【隊長商量】隊長「{leadName}」想聽你的專業意見，請依你的角色直接給重點看法（條列 3-6 點、精簡）。不要反問、不要發起任何商量或委派，答完即可。\n\n問題：{question}",
    { leadName, question },
  );
}

/** 彙整所有隊員回覆＋未參與名單成回投隊長的 digest 文字。 */
export function composeConsultDigest(
  question: string,
  replies: Array<{ name: string; text: string }>,
  skipped: string[],
): string {
  const parts = replies.map((reply) => t("▍{name}：\n{text}", { name: reply.name, text: reply.text || t("（逾時或未回覆）") }));
  let digest = t("【隊員商量回報】你發起的商量「{question}」結果：\n\n{parts}", { question, parts: parts.join("\n\n") });
  if (skipped.length) digest += t("\n\n（未參與：{skipped}）", { skipped: skipped.join("、") });
  digest += t("\n\n請整合以上意見，給使用者你的結論。不要再發起新的商量。");
  return digest;
}
