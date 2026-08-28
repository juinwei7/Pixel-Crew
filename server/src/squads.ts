/**
 * POST /api/squads（一鍵成軍／模板小隊）的純驗證與 normalize 邏輯，
 * 自 index.ts 原封搬入、行為不變。端點殼（人數上限、provider 登入、
 * workspace 檢查、實際建立 NPC 與部門）仍在 index.ts；這裡只處理：
 * - provider 解析（非 codex 一律視為 claude）
 * - 成員數 1-6 檢查
 * - 成員 normalize：姓名裁切、role/instructions 併成 Persona、model 驗證、
 *   autoApprove 只開放 off/safe/full——invincible 等其他值一律強制轉 off
 * - 姓名必填／不重複（含與現有 NPC 比對，大小寫不敏感）
 * - 隊長 index 驗證與小隊名稱／宗旨推導
 */
import { collaborationText } from "./collaboration.js";
import { normalizeDepartmentName } from "./department.js";
import { normalizeDepartmentPurpose } from "./departmentPlan.js";
import { normalizePersona, type Persona } from "./persona.js";
import type { ProviderId } from "./providers/types.js";
import { t } from "./i18n.js";

export const SQUAD_MIN_MEMBERS = 1;
export const SQUAD_MAX_MEMBERS = 6;

export type NormalizedSquadMember = {
  name: string;
  persona: Persona | null;
  model: string | undefined;
  autoApprove: "off" | "safe" | "full";
};

/** 模板小隊只跑本地雙 provider：不是 codex 就是 claude。 */
export function parseSquadProvider(value: unknown): ProviderId {
  return value === "codex" ? "codex" : "claude";
}

/** 取出成員原始陣列；不是陣列一律視為空（會被人數檢查擋下）。 */
export function parseSquadMembers(value: unknown): unknown[] {
  return Array.isArray(value) ? value as unknown[] : [];
}

/** 成員數 1-6 檢查；違規回傳錯誤訊息，合法回傳 null。 */
export function validateSquadSize(rawMembers: unknown[]): string | null {
  if (rawMembers.length < SQUAD_MIN_MEMBERS || rawMembers.length > SQUAD_MAX_MEMBERS) {
    return t("小隊成員需為 1 到 6 位");
  }
  return null;
}

/**
 * 單一成員 normalize。model 驗證交給呼叫端（index.ts 的 validModel），
 * autoApprove 只認 safe/full，其餘（含 invincible）強制轉 off——
 * 無限制模式不能透過模板一鍵取得。
 */
export function normalizeSquadMember(
  candidate: unknown,
  provider: ProviderId,
  isValidModel: (provider: ProviderId, model: string) => boolean,
): NormalizedSquadMember {
  const value = candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : {};
  const model = typeof value.model === "string" && value.model && isValidModel(provider, value.model)
    ? value.model
    : undefined;
  const autoApprove = value.autoApprove === "safe" ? "safe" as const
    : value.autoApprove === "full" ? "full" as const
    : "off" as const;
  return {
    name: collaborationText(value.name, 80),
    persona: normalizePersona({ role: value.role, instructions: value.instructions }),
    model,
    autoApprove,
  };
}

/**
 * 姓名／職責檢查：每位隊員都要有姓名與 persona、小隊內姓名不重複、
 * 也不能與現有 NPC 同名（大小寫不敏感）。違規回傳錯誤訊息，合法回傳 null。
 */
export function validateSquadMembers(
  members: NormalizedSquadMember[],
  existingWorkerNames: Iterable<string>,
): string | null {
  const names = members.map((member) => member.name.toLocaleLowerCase());
  const existingNames = new Set([...existingWorkerNames].map((name) => name.toLocaleLowerCase()));
  if (members.some((member) => !member.name || !member.persona)
    || new Set(names).size !== names.length || names.some((name) => existingNames.has(name))) {
    return t("請確認每位隊員都有不重複的姓名與職責（可能與現有 NPC 同名）");
  }
  return null;
}

/** 隊長 index：必須是落在成員範圍內的整數（未提供時預設 0）；違規回傳 null。 */
export function parseSquadLeadIndex(value: unknown, memberCount: number): number | null {
  const leadIndex = Number(value ?? 0);
  if (!Number.isInteger(leadIndex) || leadIndex < 0 || leadIndex >= memberCount) return null;
  return leadIndex;
}

/** 小隊名稱／宗旨／部門顯示名的推導（與 index.ts 原邏輯一致）。 */
export function deriveSquadIdentity(nameInput: unknown, purposeInput: unknown): {
  squadName: string;
  purpose: string;
  departmentName: string;
} {
  const squadName = normalizeDepartmentName(nameInput);
  const purpose = normalizeDepartmentPurpose(purposeInput) || squadName || t("模板小隊");
  return { squadName, purpose, departmentName: squadName || t("{purpose}小隊", { purpose: purpose.slice(0, 20) }) };
}
