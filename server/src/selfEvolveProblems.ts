// 自我進化引擎 · Stage 4：自找問題（驗真才動）。
//
// 裝完健康後，引擎要自己挑下一個值得修的問題接回進化循環。鐵律（owner 定）：先重現確認是真問題
// 才花一輪去修——不在幻覺問題上空轉。這支是純核心：解析/正規化找到的問題、驗真閘門、挑下一個。
// 真正的「掃描找問題」「重現」是 agent/指令回合（effectful），結果交這裡判。
import { t } from "./i18n.js";

export type ProblemSeverity = "high" | "medium" | "low";

export type FoundProblem = {
  id: string;
  title: string;
  /** 問題所在（檔案/子系統）。 */
  area: string;
  hypothesis: string;
  /** 是否已實際重現確認（非憑猜）。 */
  reproduced: boolean;
  /** 重現證據：失敗測試名/log 片段/指令輸出。沒證據＝不算驗真。 */
  evidence: string;
  severity: ProblemSeverity;
};

function bounded(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function clampSeverity(v: unknown): ProblemSeverity {
  return v === "high" || v === "low" ? v : "medium";
}

export function normalizeFoundProblems(raw: unknown): FoundProblem[] {
  if (!Array.isArray(raw)) return [];
  const out: FoundProblem[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const e = item as Record<string, unknown>;
    const title = bounded(e.title, 300);
    if (!title) continue;
    const key = title.toLowerCase().replace(/\s+/g, "");
    if (seen.has(key)) continue; // 去重：同標題只留一個
    seen.add(key);
    out.push({
      id: bounded(e.id, 120) || `p${out.length + 1}`,
      title,
      area: bounded(e.area, 300),
      hypothesis: bounded(e.hypothesis, 600),
      reproduced: e.reproduced === true,
      evidence: bounded(e.evidence, 800),
      severity: clampSeverity(e.severity),
    });
    if (out.length >= 30) break;
  }
  return out;
}

export type ProblemGate = { act: boolean; reason: string };

/** 驗真閘門：未重現、或沒有重現證據 → 不動（防幻覺問題空轉）；已重現且有證據 → 可排進循環。 */
export function shouldActOnProblem(p: FoundProblem): ProblemGate {
  if (!p.reproduced) return { act: false, reason: t("未重現確認（可能是幻覺問題），不動") };
  if (!p.evidence) return { act: false, reason: t("缺重現證據，不動") };
  return { act: true, reason: t("已重現且有證據，可排進進化循環") };
}

const SEVERITY_RANK: Record<ProblemSeverity, number> = { high: 0, medium: 1, low: 2 };

/**
 * 挑下一個要修的問題：只在「通過驗真閘門」的裡面挑，依嚴重度(high→low)排序，同級保持原順序。
 * 沒有任何驗真問題 → null（引擎就不自找事做，誠實停在健康狀態）。
 */
export function pickNextProblem(problems: readonly FoundProblem[]): FoundProblem | null {
  const actionable = problems.filter((p) => shouldActOnProblem(p).act);
  if (!actionable.length) return null;
  return [...actionable].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])[0];
}

/** 把挑中的問題轉成「下一輪進化循環的目標」一句話。 */
export function problemToGoal(p: FoundProblem): string {
  return t("修復已重現的問題：{title}（位置：{area}）。先用其重現證據寫一個會失敗的測試，再修到綠，不得弱化既有測試。", {
    title: p.title,
    area: p.area || t("未定位"),
  });
}
