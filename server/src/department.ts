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
  const folder = workspacePath.split(/[\\/]/).filter(Boolean).at(-1) || "工作";
  return folder.endsWith("部門") ? folder : `${folder}部門`;
}
