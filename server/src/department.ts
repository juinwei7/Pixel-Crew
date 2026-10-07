import { t } from "./i18n.js";

export type Department = {
  id: string;
  name: string;
  purpose: string;
  workspacePath: string;
  leadWorkerId: string;
  memberWorkerIds: string[];
  createdAt: string;
  updatedAt: string;
};

export function normalizeDepartmentName(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 80) : "";
}

export function legacyDepartmentName(workspacePath: string): string {
  const folder = workspacePath.split(/[\\/]/).filter(Boolean).at(-1) || t("工作");
  // 這裡的 "部門" 尾綴檢查是解析既有資料夾名稱的固定字面值，不隨語言切換——
  // 只有附加上去的尾綴文字本身經過 t() 翻譯。
  return folder.endsWith("部門") ? folder : `${folder}${t("部門")}`;
}

/**
 * 路由（老闆交辦決策、AI 部門指派）能不能把工作派進這個部門。臨時團隊是為單一交辦開的短命部門，
 * 那張交辦結束、被刪除或自動循環推進下一步就整支解散——別的工作派進去，會連同成員與進行中的
 * Mission 一起消失。只有交辦自己的臨時團隊（剛為它開的、或它原本就在用的）可以收它的工作。
 */
export function routableDepartment(
  departmentId: string,
  ephemeralDepartmentIds: ReadonlySet<string>,
  ownCrewIds: readonly string[] = [],
): boolean {
  return !ephemeralDepartmentIds.has(departmentId) || ownCrewIds.includes(departmentId);
}
