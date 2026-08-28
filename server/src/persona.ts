/**
 * A persistent per-NPC persona: a short job title plus freeform instructions.
 * Stored per worker and re-injected into the provider CLI on every spawn, so
 * it survives /clear, model switches, and server restarts.
 */
import { t } from "./i18n.js";

export type Persona = {
  role: string;
  instructions: string;
};

export const MAX_PERSONA_ROLE = 80;
export const MAX_PERSONA_INSTRUCTIONS = 4000;

export type PersonaSuggestionMember = {
  name: string;
  role: string | null;
};

export type PersonaSuggestionInput = {
  workerName: string;
  workspacePath: string;
  members: PersonaSuggestionMember[];
};

/**
 * Coerce untrusted input (API body, DB payload) into a Persona, or null when
 * there is nothing usable. Both fields are trimmed and length-capped; a
 * persona with neither a role nor instructions collapses to null.
 */
export function normalizePersona(input: unknown): Persona | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const role = String(record.role ?? "").trim().slice(0, MAX_PERSONA_ROLE);
  const instructions = String(record.instructions ?? "").trim().slice(0, MAX_PERSONA_INSTRUCTIONS);
  if (!role && !instructions) return null;
  return { role, instructions };
}

/**
 * Render a persona into the system-prompt text handed to a provider. Uses
 * labelled sections rather than full sentences so it does not bias the model
 * toward a particular output language. Returns "" when there is no persona.
 */
export function composePersonaPrompt(persona: Persona | null): string {
  if (!persona) return "";
  const parts: string[] = [];
  if (persona.role) parts.push(t("【職務 / Role】{role}", { role: persona.role }));
  if (persona.instructions) parts.push(persona.instructions);
  return parts.join("\n\n");
}

/**
 * Ask the selected local provider for an editable persona draft. The prompt is
 * intentionally self-contained and forbids tools: suggestions should be fast,
 * read-only, and based only on the department context the user can already see.
 */
export function personaSuggestionPrompt(input: PersonaSuggestionInput): string {
  const members = input.members.map((member) => ({
    name: String(member.name).slice(0, 100),
    role: member.role ? String(member.role).slice(0, MAX_PERSONA_ROLE) : null,
  }));
  return t(
    "請替 Pixel Crew 的 NPC 草擬一份實用且可直接編輯的人設。不要呼叫工具、讀取或修改檔案，也不要臆測專案內容。\nNPC: {workerName}\n工作位置: {workspacePath}\n同部門人員（包含目前 NPC）: {members}\n\n要求:\n- 依 NPC 名稱、工作位置名稱和現有職務，補上部門尚缺且不重複的職務。\n- role 是清楚的職稱，最多 {maxRole} 字。\n- instructions 使用繁體中文，具體描述專長、責任範圍、工作方式、交付品質與溝通方式；保持精簡，不超過 600 字。\n- 不要加入無法由軟體代理執行的背景故事。\n- 若資訊不足，選擇通用且能補足軟體團隊的角色。\n\n最後只能輸出：\n<persona_suggestion>{\"role\":\"職務\",\"instructions\":\"詳細指示\"}</persona_suggestion>",
    {
      workerName: JSON.stringify(String(input.workerName).slice(0, 100)),
      workspacePath: JSON.stringify(String(input.workspacePath).slice(0, 1_000)),
      members: JSON.stringify(members),
      maxRole: MAX_PERSONA_ROLE,
    },
  );
}

/** Parse the marked JSON draft and apply the same limits as persisted personas. */
export function parsePersonaSuggestion(output: string): Persona | null {
  const marked = String(output).match(/<persona_suggestion>\s*([\s\S]*?)\s*<\/persona_suggestion>/i)?.[1];
  if (!marked) return null;
  try {
    return normalizePersona(JSON.parse(marked));
  } catch {
    return null;
  }
}

/** Serialize for the SQLite payload column. Null personas store as null. */
export function serializePersona(persona: Persona | null): string | null {
  return persona ? JSON.stringify(persona) : null;
}

/** Parse a stored persona payload back into a Persona (or null). */
export function parsePersona(payload: unknown): Persona | null {
  if (payload == null) return null;
  if (typeof payload === "string") {
    try {
      return normalizePersona(JSON.parse(payload));
    } catch {
      return null;
    }
  }
  return normalizePersona(payload);
}

export const MAX_PERSONA_TEMPLATE_NAME = 60;

/**
 * A reusable, named persona kept in a global library and applied to any NPC.
 * Provider-agnostic — the same composed prompt works for Claude and Codex.
 */
export type PersonaTemplate = Persona & {
  id: string;
  name: string;
};

/**
 * Coerce untrusted input into a PersonaTemplate. Requires a non-empty name and
 * at least a role or instructions; returns null otherwise. `id` is preserved
 * when present (update) so the caller can mint one for inserts.
 */
export function normalizePersonaTemplate(input: unknown): Omit<PersonaTemplate, "id"> & { id: string | null } | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const persona = normalizePersona(record);
  if (!persona) return null;
  const name = String(record.name ?? "").trim().slice(0, MAX_PERSONA_TEMPLATE_NAME) || persona.role;
  if (!name) return null;
  const id = record.id == null ? null : String(record.id).trim() || null;
  return { id, name, role: persona.role, instructions: persona.instructions };
}
