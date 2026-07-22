import { normalizePersona, type Persona } from "./persona.js";

export const MAX_DEPARTMENT_PURPOSE = 200;

export type PlannedDepartmentMember = Persona & { name: string };

export type DepartmentPlan = {
  summary: string;
  members: PlannedDepartmentMember[];
};

export function normalizeDepartmentPurpose(value: unknown): string {
  return String(value ?? "").trim().slice(0, MAX_DEPARTMENT_PURPOSE);
}

export function departmentPlanPrompt(input: {
  purpose: string;
  count: number;
  workspacePath: string;
  existingMembers: Array<{ name: string; role: string | null }>;
}): string {
  const existing = input.existingMembers.map((member) => ({
    name: String(member.name).slice(0, 24),
    role: member.role ? String(member.role).slice(0, 80) : null,
  }));
  return `請規劃一個 Pixel Crew AI 軟體部門。不要呼叫工具、讀取或修改檔案，也不要臆測專案內容。\n部門用途: ${JSON.stringify(input.purpose)}\nNPC 數量: ${input.count}\n工作位置: ${JSON.stringify(input.workspacePath.slice(0, 1_000))}\n該工作位置既有人員: ${JSON.stringify(existing)}\n\n要求:\n- 必須恰好產生 ${input.count} 位新 NPC。\n- 每位 NPC 的 name 使用簡短繁體中文暱稱，最多 24 字，且不可重複。\n- role 是清楚、互補且不與既有人員重複的職稱，最多 80 字。\n- instructions 使用繁體中文，具體描述專長、責任邊界、工作方式、交付品質與溝通方式，最多 600 字。\n- 角色必須能共同完成「${input.purpose}」，但不要加入虛構背景故事。\n- summary 用一句話說明配置原則。\n\n最後只能輸出：\n<department_plan>{"summary":"配置說明","members":[{"name":"名稱","role":"職務","instructions":"詳細指示"}]}</department_plan>`;
}

export function parseDepartmentPlan(output: string, expectedCount: number): DepartmentPlan | null {
  const marked = String(output).match(/<department_plan>\s*([\s\S]*?)\s*<\/department_plan>/i)?.[1];
  if (!marked) return null;
  try {
    const parsed = JSON.parse(marked) as Record<string, unknown>;
    if (!Array.isArray(parsed.members) || parsed.members.length !== expectedCount) return null;
    const members: PlannedDepartmentMember[] = [];
    const names = new Set<string>();
    const roles = new Set<string>();
    for (const item of parsed.members) {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const name = String(record.name ?? "").trim().slice(0, 24);
      const persona = normalizePersona(record);
      const nameKey = name.toLocaleLowerCase();
      const roleKey = persona?.role.toLocaleLowerCase() ?? "";
      if (!name || !persona?.role || !persona.instructions || names.has(nameKey) || roles.has(roleKey)) return null;
      names.add(nameKey);
      roles.add(roleKey);
      members.push({ name, ...persona });
    }
    return {
      summary: String(parsed.summary ?? "").trim().slice(0, 500),
      members,
    };
  } catch {
    return null;
  }
}
