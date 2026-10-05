// Tiny event bus between the UI chrome (React) and the office scene (Pixi).
// The UI says what the user just did; the scene turns it into something you
// can see happen in the office — and vice versa. Purely visual: nothing here
// may send requests or change server state.

export type ClientPoint = { x: number; y: number }; // viewport (client) px

export type FxEvent =
  // UI -> scene: a task was just submitted to a worker. `from` is where the
  // paper plane takes off (e.g. the centre of the submit button).
  | { type: "dispatch"; workerId: string; from: ClientPoint; text: string }
  // UI -> scene: a new deliverable appeared in the outbox.
  | { type: "deliverable"; workerId: string | null; name: string }
  // scene -> UI: something was dropped onto an NPC in the office. The UI
  // decides what to do with it (prefill/attach in the composer, then the user
  // confirms) — the scene never sends anything itself.
  | { type: "drop-dispatch"; workerId: string; text: string; files: File[] }
  // scene -> UI: the user clicked an NPC that is raising its hand for approval.
  | { type: "open-approval"; workerId: string }
  // UI -> scene: link to the local server dropped / came back (e.g. during a
  // restart or cold install). The office dims and everyone dozes while down,
  // then the lights flicker back on and the crew wakes up.
  | { type: "connection"; state: "down" | "up" }
  // UI -> scene: a short celebratory/system moment the office can echo
  // (phone remote control switched on, desktop notifications enabled, ...).
  | { type: "system"; kind: "remote-on" | "remote-off" | "notify-on" | "settings-saved" };

type Handler = (event: FxEvent) => void;
const handlers = new Set<Handler>();

export function emitFx(event: FxEvent): void {
  for (const handler of handlers) {
    try {
      handler(event);
    } catch (error) {
      console.error("[fxBus]", error);
    }
  }
}

export function onFx(handler: Handler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}
