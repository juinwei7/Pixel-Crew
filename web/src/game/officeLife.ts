// Small, local-only "office life" helpers: per-NPC personality, the office
// clock (real local time), seasonal touches and the Konami code. Nothing here talks to the server; the one bit of persistence
// (the cat's party hat) lives in sessionStorage.

/** A stable personality per NPC — biases idle habits and walking pace. */
export type Trait = "energetic" | "sleepy" | "nerdy" | "tidy" | "social" | "chill";
const TRAITS: Trait[] = ["energetic", "sleepy", "nerdy", "tidy", "social", "chill"];

/** FNV-1a: the same id always gets the same trait, across reloads. */
export function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function traitFor(id: string): Trait {
  return TRAITS[hashId(id) % TRAITS.length];
}

/** The office runs on the viewer's local time. */
export function officeNow(): Date {
  return new Date();
}

// ---------- Seasons ----------
const LNY: Record<number, [number, number]> = {
  2025: [0, 29], 2026: [1, 17], 2027: [1, 6], 2028: [0, 26], 2029: [1, 13], 2030: [1, 3], 2031: [0, 23], 2032: [1, 11],
};

function lunarNewYear(year: number): Date | null {
  const md = LNY[year];
  return md ? new Date(year, md[0], md[1]) : null;
}

export type Seasonal = { pizza: boolean; xmas: boolean; lanterns: boolean; lateNight: boolean };

/** What the calendar adds to the office right now. */
export function seasonal(now: Date = officeNow()): Seasonal {
  const lny = lunarNewYear(now.getFullYear());
  const days = lny ? (now.getTime() - lny.getTime()) / 86_400_000 : 99;
  const hour = now.getHours();
  return {
    pizza: now.getDay() === 5 && hour >= 13 && hour < 19,
    xmas: now.getMonth() === 11,
    lanterns: days >= -7 && days <= 15,
    lateNight: hour >= 23 || hour < 5,
  };
}

// ---------- Konami code ----------
const KONAMI = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];

/**
 * Listens for ↑↑↓↓←→←→BA anywhere on the page, ignoring typing in inputs,
 * textareas and editable fields. Returns an unsubscribe function.
 */
export function onKonami(fire: () => void): () => void {
  let at = 0;
  const onKey = (event: KeyboardEvent) => {
    const el = event.target as HTMLElement | null;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (key === KONAMI[at]) {
      at += 1;
      if (at === KONAMI.length) {
        at = 0;
        fire();
      }
    } else {
      at = key === KONAMI[0] ? 1 : 0;
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

// ---------- Session flags (easter eggs that stick for the session) ----------
export function sessionFlag(name: string): boolean {
  try {
    return sessionStorage.getItem(`pixel-crew:egg:${name}`) === "1";
  } catch {
    return false;
  }
}

export function setSessionFlag(name: string): void {
  try {
    sessionStorage.setItem(`pixel-crew:egg:${name}`, "1");
  } catch {
    // Private mode etc. — the egg just won't survive a reload.
  }
}
