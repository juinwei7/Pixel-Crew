import { parseDocument } from "yaml";
import { t } from "./i18n.js";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export function workflowFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(FRONTMATTER);
  if (!match) return {};
  const document = parseDocument(match[1]);
  if (document.errors.length > 0) {
    throw new Error(t("Frontmatter YAML 無效：{message}", { message: document.errors[0].message }));
  }
  const value = document.toJS();
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(t("Frontmatter 必須是 YAML object"));
  return value as Record<string, unknown>;
}

export function frontmatterText(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(frontmatterText).filter(Boolean).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value).trim();
}
