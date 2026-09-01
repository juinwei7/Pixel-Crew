# Boss execution budget boundaries SDD

## Problem

Boss Tasks and Department Missions previously began with no owner-selected
execution boundary. The UI only showed actual Claude spend after work finished;
Codex subscription quota had no equivalent preflight view.

## Delivered scope

Each new Boss Task selects **Quick**, **Standard**, or **Deep** before it is
submitted. The server persists the selected profile and an explicit estimate,
then applies its limits to the decision graph and each launched Boss Mission.
The owner may tighten the NPC and Mission-step ceilings below the selected
profile's maximum; the server clamps every value and never accepts a higher
ceiling through a crafted request.

| Profile | Max NPCs per Mission | Max Boss stages | Max Mission plan steps | Estimated time |
| --- | ---: | ---: | ---: | --- |
| Quick | 2 | 1 | 2 | 2–10 min |
| Standard | 4 | 3 | 3 | 10–35 min |
| Deep | 6 | 5 | 4 | 30–90 min |

The displayed estimate also includes a clearly non-guaranteed Claude USD range
and Codex five-hour quota-impact range. The server, rather than the UI, rejects
a decision graph beyond the stage ceiling; it restricts a Boss Mission's
eligible NPC roster and rejects a plan beyond the step ceiling. This ensures a
model cannot silently exceed the requested boundary.

## Acceptance

1. New Boss Tasks persist profile and estimate.
2. A graph exceeding the profile stage limit is rejected by the parser.
3. A launched Boss Mission retains its selected roster and plan-step cap across
   restart, and parser validation rejects plans beyond that cap.
4. Existing unbounded Department Missions keep their previous four-step limit.
5. Server and web tests/build pass.

## Limits

Ranges are preflight planning aids, not quotes. They do not expose provider
prompts, paths, tool output, accounts, or token data. A later diagnostics
feature can calibrate ranges locally from anonymized aggregate counters.
