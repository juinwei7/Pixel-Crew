import { parseDocument } from "yaml";
import { t } from "./i18n";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;

export type ParsedWorkflowDocument = {
  attributes: Record<string, unknown>;
  body: string;
  error: string | null;
};

export function parseWorkflowDocument(content: string): ParsedWorkflowDocument {
  const match = content.match(FRONTMATTER);
  if (!match) return { attributes: {}, body: content, error: null };
  const document = parseDocument(match[1]);
  if (document.errors.length > 0) {
    return { attributes: {}, body: match[2].replace(/^\r?\n/, ""), error: document.errors[0].message };
  }
  const value = document.toJS();
  if (value != null && (typeof value !== "object" || Array.isArray(value))) {
    return { attributes: {}, body: match[2].replace(/^\r?\n/, ""), error: t("Frontmatter 必須是 YAML object") };
  }
  return {
    attributes: (value ?? {}) as Record<string, unknown>,
    body: match[2].replace(/^\r?\n/, ""),
    error: null,
  };
}

export function workflowText(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(workflowText).filter(Boolean).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function updateWorkflowDocument(
  content: string,
  updates: Record<string, string | undefined>,
  nextBody?: string,
): string {
  const parsed = parseWorkflowDocument(content);
  if (parsed.error) throw new Error(parsed.error);
  const match = content.match(FRONTMATTER);
  const document = parseDocument(match?.[1] ?? "{}");
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    if (value === "") document.delete(key);
    else document.set(key, value);
  }
  const yaml = document.toString({ lineWidth: 0 });
  return `---\n${yaml}---\n\n${nextBody ?? parsed.body}`;
}
