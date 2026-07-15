# Global Work Energy SDD

- Status: Accepted for implementation
- Date: 2026-07-16
- Scope: account-level Claude Code and Codex usage indicators

## Product model

Work energy belongs to the local provider account, not to a room or NPC. Pixel Crew therefore renders one shared HUD at the upper center of the office. Changing rooms or workers never changes the displayed account snapshot.

## Data sources

- Claude Code: run the local `/usage` command in non-interactive JSON mode and parse its plan windows. The command reports session and weekly plan usage plus reset text.
- Codex: call `account/rateLimits/read` on a short-lived local app-server connection and normalize its primary and secondary windows.
- Provider output is treated as optional capability data. A parser failure produces an unavailable state, never an invented percentage.

## Cache and refresh

- Store the latest normalized provider snapshots in local SQLite.
- Send cached values immediately on WebSocket connection, marked as refreshing until a live read completes.
- Refresh after authentication, after completed work with a minimum cooldown, every five minutes, and on explicit user request.
- Usage is global by provider; workspace paths and worker ids are not cache keys.

## UI

- A compact `WORK ENERGY` HUD is centered in the otherwise empty top area.
- Claude and Codex appear together. Each provider's headline is the lowest remaining percentage among its account-wide non-model-specific windows.
- Clicking the HUD reveals every reported window, reset time, last update, errors, and a refresh action.
- Colors communicate state: cyan/green above 40%, amber from 15–40%, red below 15%.
- Loading preserves cached percentages and adds a quiet activity indicator.

## Safety and honesty

- Never expose credentials, raw CLI output, or account identifiers to the browser.
- Clamp percentages to 0–100 and length-bound labels and reset text.
- Model-specific limits remain detail rows and do not incorrectly reduce the provider-wide headline.
- If a provider is signed out or its CLI is missing, retain a stale cached snapshot with a clear unavailable/error status.

## Acceptance criteria

1. Usage remains unchanged when switching rooms or NPCs.
2. Cached usage appears before live refresh completes.
3. Claude `/usage` session and weekly windows parse correctly.
4. Codex primary and secondary rate-limit windows normalize correctly.
5. Manual refresh updates both providers without blocking the office.
6. Unsupported or changed provider output never displays a fabricated value.
