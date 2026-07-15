export type StationKey =
  | "home"
  | "board"
  | "books"
  | "code"
  | "terminal"
  | "web"
  | "check"
  | "desk";

export function stationForTool(name: string, input: unknown): StationKey {
  const n = name.toLowerCase();
  const blob = `${n} ${safeStringify(input).toLowerCase()}`;

  if (n === "bash") return "terminal";
  if (n === "edit" || n === "write" || n === "notebookedit") return "code";
  if (n === "read") return "books";
  if (n === "websearch" || n === "webfetch") return "web";
  if (blob.includes("verify")) return "check";
  if (blob.includes("issue") || blob.includes("task")) return "board";
  return "desk";
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return "";
  }
}

export function shortToolName(name: string): string {
  const parts = name.split("__");
  return parts[parts.length - 1] ?? name;
}
