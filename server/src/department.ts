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
