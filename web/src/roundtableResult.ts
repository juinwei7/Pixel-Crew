// 快速圓桌結果解析：從 NPC 回覆的 Markdown 抽出結論、信心、改變結論的訊號與下一步，
// 給輸入框上方的「圓桌結論」小卡用（照結論執行／反方檢驗／升級作戰室）。
// 解析刻意寬鬆：NPC 不一定百分之百照格式，抓不到的欄位就留空，小卡照樣能用。

import { t } from "./i18n";
import type { Turn } from "./types";
import { isRoundtableCommand, roundtableTopicFromCommand } from "./roundtablePrompt";

export type RoundtableConfidence = "high" | "medium" | "low";

export type RoundtableResult = {
  conclusion: string;
  confidence: RoundtableConfidence | null;
  /** 信心段的原文（含理由），顯示用。 */
  confidenceNote: string;
  changeTriggers: string[];
  nextSteps: string[];
  /** NPC 自己建議升級作戰室，或信心低。 */
  suggestsWarroom: boolean;
};

type Section = "conclusion" | "confidence" | "triggers" | "next";

// 標題中英都認：英文介面時提示詞的標題是英文，切換語言後舊回覆仍是中文。
const HEADINGS: Record<Section, string[]> = {
  conclusion: ["結論", "Conclusion"],
  confidence: ["信心", "Confidence"],
  triggers: ["什麼情況會改變結論", "What would change the conclusion"],
  next: ["下一步", "Next steps", "Next Steps"],
};

function normalizeHeading(text: string): string {
  return text.replace(/[*_`#]/g, "").trim().toLowerCase();
}

function sectionOf(heading: string): Section | null {
  const normalized = normalizeHeading(heading);
  for (const section of Object.keys(HEADINGS) as Section[]) {
    const names = [...HEADINGS[section], t(HEADINGS[section][0])].map((name) => name.toLowerCase());
    if (names.some((name) => normalized === name || normalized.startsWith(`${name} `) || normalized.startsWith(`${name}（`) || normalized.startsWith(`${name}(`))) return section;
  }
  return null;
}

function splitSections(markdown: string): Partial<Record<Section, string>> {
  const out: Partial<Record<Section, string>> = {};
  let current: Section | null = null;
  let buffer: string[] = [];
  const flush = () => {
    // 同名段落以最後一次為準：有唯讀查閱時，最終答案在最後一段文字裡。
    if (current) out[current] = buffer.join("\n").trim();
    buffer = [];
  };
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^\s{0,3}#{1,4}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      current = sectionOf(heading[1]);
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();
  return out;
}

function bullets(block: string | undefined): string[] {
  if (!block) return [];
  return block.split(/\r?\n/)
    .map((line) => /^\s*(?:[-*+]|\d+[.)、])\s+(.*)$/.exec(line)?.[1]?.trim() ?? "")
    .filter((line) => line && !/^(無|none|n\/a)[。.]?$/i.test(line));
}

function plain(block: string | undefined): string {
  return (block ?? "").replace(/\*\*/g, "").replace(/\s*\n\s*/g, " ").trim();
}

export function parseConfidence(text: string): RoundtableConfidence | null {
  const head = text.replace(/\*\*/g, "").trim().slice(0, 24).toLowerCase();
  if (/^(信心)?[:：\s]*低|^low/.test(head)) return "low";
  if (/^(信心)?[:：\s]*中|^medium|^moderate/.test(head)) return "medium";
  if (/^(信心)?[:：\s]*高|^high/.test(head)) return "high";
  return null;
}

function suggestsEscalation(note: string): boolean {
  if (/(不|無)(需|必|用)要?升級|no need to escalate|not (worth|necessary to) escalat/i.test(note)) return false;
  return /升級作戰室|escalate to (the )?war ?room/i.test(note);
}

export function parseRoundtableResult(markdown: string): RoundtableResult {
  const sections = splitSections(markdown);
  const confidenceNote = plain(sections.confidence);
  const confidence = parseConfidence(confidenceNote);
  return {
    conclusion: plain(sections.conclusion),
    confidence,
    confidenceNote,
    changeTriggers: bullets(sections.triggers).slice(0, 3),
    nextSteps: bullets(sections.next).slice(0, 3),
    suggestsWarroom: confidence === "low" || suggestsEscalation(confidenceNote),
  };
}

export function confidenceLabel(confidence: RoundtableConfidence | null): string | null {
  if (confidence === "high") return t("高");
  if (confidence === "medium") return t("中");
  if (confidence === "low") return t("低");
  return null;
}

export type LatestRoundtable = { turnKey: string; topic: string; result: RoundtableResult };

/**
 * 只有「最新一回合就是已完成的圓桌、而且解析得出結論」才回傳——使用者一送別的指令，
 * 最新回合就換了，小卡自然消失，不需要額外的狀態去收。
 */
export function latestRoundtable(turns: Turn[] | undefined): LatestRoundtable | null {
  const turn = turns?.[turns.length - 1];
  if (!turn || turn.status !== "done" || !isRoundtableCommand(turn.command)) return null;
  const text = turn.items.filter((item) => item.kind === "assistant_text").map((item) => ("text" in item ? item.text : "")).join("\n");
  const result = parseRoundtableResult(text);
  if (!result.conclusion) return null;
  return { turnKey: turn.key, topic: roundtableTopicFromCommand(turn.command), result };
}
