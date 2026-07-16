/**
 * A persistent per-NPC persona: a short job title plus freeform instructions.
 * Stored per worker and re-injected into the provider CLI on every spawn, so
 * it survives /clear, model switches, and server restarts.
 */
export type Persona = {
  role: string;
  instructions: string;
};

export const MAX_PERSONA_ROLE = 80;
export const MAX_PERSONA_INSTRUCTIONS = 4000;

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
  if (persona.role) parts.push(`【職務 / Role】${persona.role}`);
  if (persona.instructions) parts.push(persona.instructions);
  return parts.join("\n\n");
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
