import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

const DRAFT_PREFIX = "pixel-crew:task-composer:";

export function useComposerDraft(key: string): [string, Dispatch<SetStateAction<string>>] {
  const [draft, setDraft] = useState(() => loadDraft(key));

  useEffect(() => {
    setDraft(loadDraft(key));
  }, [key]);

  useEffect(() => {
    const timer = window.setTimeout(() => saveDraft(key, draft), 200);
    return () => window.clearTimeout(timer);
  }, [draft, key]);

  return [draft, setDraft];
}

export function writeComposerDraft(key: string, value: string): void {
  saveDraft(key, value);
}

function loadDraft(key: string): string {
  if (typeof localStorage === "undefined") return "";
  try { return localStorage.getItem(`${DRAFT_PREFIX}${key}`) ?? ""; } catch { return ""; }
}

function saveDraft(key: string, value: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (value) localStorage.setItem(`${DRAFT_PREFIX}${key}`, value);
    else localStorage.removeItem(`${DRAFT_PREFIX}${key}`);
  } catch {
    // Draft persistence is best effort.
  }
}
