# Discussion modes: quick roundtable and War Room

## Problem

The UI presented one action as `圓桌`, while it actually called the multi-agent
War Room endpoint. Documentation promised two distinct experiences: a cheap,
single-NPC simulated roundtable and a multi-agent debate. This obscured both
the provider requirement and the expected cost/time.

## Product decision

Keep both workflows and make their entry points explicit:

- **Quick roundtable** sends one prompt to the selected NPC. The prompt asks
  it to simulate 2–4 viewpoints in one no-tools turn and return a conclusion.
- **War Room** launches the existing 2–4 temporary Claude peers, with
  difficulty-based model selection, one or two debate rounds, and synthesis.

## Acceptance criteria

1. The composer exposes distinct, mutually exclusive controls for Quick
   roundtable and War Room.
2. Quick roundtable uses the existing one-shot `roundtablePrompt` and normal
   selected-NPC send path; it does not call `/api/warroom`.
3. War Room alone calls `/api/warroom` and clearly discloses 2–4 temporary
   Claude NPCs, 1–2 rounds, several minutes of wait, and Claude usage.
4. The meeting-table shortcut selects War Room, because it visually depicts
   multiple agents convening.
5. War Room role customisation and report history are named as War Room
   features. User-facing Chinese and English copy, plus README feature copy,
   describe the same distinction.
6. Existing roundtable prompt tests and all project tests/build remain green.

## Non-goals

- This does not add a separate provider-neutral multi-agent orchestration
  backend. The existing War Room implementation continues to use Claude.
- The quick-roundtable prompt is an agent instruction; it does not attempt to
  override the provider's native policy boundary.
