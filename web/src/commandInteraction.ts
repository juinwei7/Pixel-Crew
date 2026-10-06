import { t } from "./i18n";

export type PaletteEntry = { name: string; description: string; argumentHint?: string };
export type ProviderWorkflowEntry = PaletteEntry & {
  key: string;
  label: string;
  value: string;
  invocation: "/" | "$";
};

/**
 * Merge the fetched project commands (`library`, with descriptions) with the
 * provider's full slash-command set (`slashCommands`, names only: built-ins +
 * skills + project). Project commands come first for their richer metadata;
 * the rest follow, de-duplicated by name. This keeps built-in commands like
 * /clear visible in rooms that also have their own project commands.
 */
export function mergePaletteNames(library: PaletteEntry[], slashCommands: string[]): PaletteEntry[] {
  const seen = new Set(library.map((entry) => entry.name));
  const extra = slashCommands
    .filter((name) => !seen.has(name))
    .map((name) => ({ name, description: t("Claude 指令") }));
  return [...library, ...extra];
}

/**
 * Build provider-aware workflow entries. Claude project commands and native
 * commands both use `/`; Codex deliberately keeps repo skills on `$` while
 * its native controls use `/`, matching the official Codex composer.
 */
export function buildProviderWorkflowEntries(
  provider: "claude" | "codex",
  library: PaletteEntry[],
  slashCommands: string[],
): ProviderWorkflowEntry[] {
  if (provider === "claude") {
    return mergePaletteNames(library, slashCommands).map((entry) => ({
      ...entry,
      key: `slash-${entry.name}`,
      label: `/${entry.name}`,
      value: `/${entry.name}${entry.argumentHint ? ` ${entry.argumentHint}` : " "}`,
      invocation: "/" as const,
    }));
  }

  const skills = library.map((entry) => ({
    ...entry,
    key: `skill-${entry.name}`,
    label: `$${entry.name}`,
    value: `$${entry.name}${entry.argumentHint ? ` ${entry.argumentHint}` : " "}`,
    invocation: "$" as const,
  }));
  const native = [...new Set(slashCommands)]
    .filter(Boolean)
    .map((name) => ({
      name,
      description: t("Codex 原生指令"),
      key: `slash-${name}`,
      label: `/${name}`,
      value: `/${name} `,
      invocation: "/" as const,
    }));
  return [...skills, ...native];
}

export type ComposerEnterAction = "choose" | "submit" | "ignore";

export function composerEnterAction(
  paletteOpen: boolean,
  libraryLoading: boolean,
  itemCount: number,
  shiftKey: boolean,
): ComposerEnterAction {
  if (shiftKey) return "ignore";
  if (!paletteOpen) return "submit";
  return !libraryLoading && itemCount > 0 ? "choose" : "ignore";
}

/** 送出的來源：鍵盤 Enter、按鈕（含點「中止」）、或程式自動送出（影片解析完）。 */
export type ComposerSubmitSource = "enter" | "button" | "auto";

/**
 * NPC 忙碌中、輸入框空白時的送出要不要變成「中止任務」。
 * 只有明確按下「中止」鈕才中止：空白 Enter（常見的連按兩下、或只是想換行）
 * 與自動送出一律忽略；按鈕在剛送出後 guardMs 內也忽略，避免連點誤砍任務。
 */
export function emptySubmitAction(source: ComposerSubmitSource, msSinceLastSubmit: number, guardMs = 1000): "interrupt" | "ignore" {
  if (source !== "button") return "ignore";
  return msSinceLastSubmit < guardMs ? "ignore" : "interrupt";
}

/**
 * 送出失敗時把原文放回輸入框。使用者在等待回應期間又打了新字時，不能用
 * 失敗的原文蓋掉、也不能丟掉原文：原文放前面、新打的接在後面。
 */
export function restoreFailedDraft(current: string, failed: string): string {
  if (!failed.trim()) return current;
  if (!current.trim()) return failed;
  if (current.includes(failed)) return current;
  return `${failed.replace(/\s+$/, "")}\n${current.replace(/^\s+/, "")}`;
}

type MatchMediaLike = (query: string) => { matches: boolean };

/**
 * 觸控為主的裝置（手機、平板）不要自動聚焦輸入框：一聚焦就彈出螢幕鍵盤，
 * 蓋掉半個畫面。桌機（或沒有 matchMedia 的環境，例如伺服器端渲染）照常聚焦。
 */
export function shouldAutoFocusComposer(matchMedia: MatchMediaLike | undefined = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia.bind(window) : undefined): boolean {
  if (!matchMedia) return true;
  try {
    return !matchMedia("(hover: none) and (pointer: coarse)").matches;
  } catch {
    return true;
  }
}

export type ComposerStatus = "attention" | "working" | "idle";

/** 輸入框旁狀態列：需要你 > 工作中 > 待命。 */
export function composerStatus(state: { busy?: boolean; working?: boolean; needsAttention?: boolean }): ComposerStatus {
  if (state.needsAttention) return "attention";
  if (state.busy || state.working) return "working";
  return "idle";
}
