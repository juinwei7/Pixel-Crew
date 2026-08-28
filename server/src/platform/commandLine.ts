import { t } from "../i18n.js";

export function parseCommandLine(input: string): string[] {
  const result: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && quote === '"' && ['"', "\\"].includes(input[index + 1] ?? "")) {
        token += input[++index];
      } else token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (token) {
        result.push(token);
        token = "";
      }
    } else if (char === "\\" && /[\s'"\\]/.test(input[index + 1] ?? "")) {
      token += input[++index];
    } else token += char;
  }
  if (quote) throw new Error(t("MCP 指令的引號沒有成對"));
  if (token) result.push(token);
  if (result.length === 0) throw new Error(t("MCP 指令不能是空白"));
  return result;
}
