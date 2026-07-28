import { useEffect, useMemo, useState, type RefObject } from "react";
import { apiRequest } from "../api";
import { buildProviderWorkflowEntries } from "../commandInteraction";
import type { ProviderId } from "../types";

export type PaletteItem = { key: string; label: string; description: string; value: string; kind: "recent" | "project" };
type LibraryEntry = { name: string; description: string; argumentHint?: string };

export function useComposerPalette(config: {
  enabled: boolean;
  draft: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  provider: ProviderId;
  workspacePath: string;
  slashCommands: string[];
  history: string[];
  formRef: RefObject<HTMLFormElement | null>;
}): { items: PaletteItem[]; selected: number; setSelected(index: number | ((current: number) => number)): void; libraryLoading: boolean } {
  const { enabled, draft, open, onOpenChange, provider, workspacePath, slashCommands, history, formRef } = config;
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    if (!enabled || !open) return;
    let cancelled = false;
    setLibraryLoading(true);
    const endpoint = provider === "claude" ? "/api/commands" : "/api/skills";
    apiRequest<{ commands?: LibraryEntry[]; skills?: LibraryEntry[] }>(`${endpoint}?workspacePath=${encodeURIComponent(workspacePath)}`)
      .then((data) => {
        if (!cancelled) setLibrary(data.commands ?? data.skills ?? []);
      })
      .catch(() => !cancelled && setLibrary([]))
      .finally(() => !cancelled && setLibraryLoading(false));
    return () => { cancelled = true; };
  }, [enabled, open, provider, workspacePath]);

  useEffect(() => {
    if (enabled && open) setSelected(0);
  }, [enabled, open]);

  useEffect(() => {
    if (!enabled || !open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!formRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    window.addEventListener("pointerdown", closeOutside);
    return () => window.removeEventListener("pointerdown", closeOutside);
  }, [enabled, open, onOpenChange, formRef]);

  const query = draft.startsWith("/") || draft.startsWith("$") ? draft.slice(1).toLowerCase() : draft.toLowerCase();
  const items = useMemo<PaletteItem[]>(() => {
    if (!enabled) return [];
    const invocation = draft.startsWith("/") ? "/" : draft.startsWith("$") ? "$" : null;
    const project = buildProviderWorkflowEntries(provider, library, slashCommands).map((entry) => ({
      key: `project-${entry.key}`,
      label: entry.label,
      description: entry.description || (provider === "claude" ? "Claude 專案指令" : "Codex Repo Skill"),
      value: entry.value,
      kind: "project" as const,
    })).filter((entry) => !invocation || entry.label.startsWith(invocation));
    const recent = history.map((command, index) => ({
      key: `recent-${index}-${command}`,
      label: command,
      description: `最近使用 · ${provider === "claude" ? "Claude" : "Codex"}`,
      value: command,
      kind: "recent" as const,
    }));
    return [...project, ...recent].filter((item) => {
      if (invocation && item.kind === "recent" && !item.label.startsWith(invocation)) return false;
      return !query || item.label.toLowerCase().includes(query);
    }).slice(0, 12);
  }, [enabled, provider, slashCommands, history, query, library, draft]);

  return { items, selected, setSelected, libraryLoading };
}
