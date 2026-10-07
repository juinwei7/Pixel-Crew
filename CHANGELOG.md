# Changelog

All notable changes to Pixel Crew are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- Quick Roundtable conclusions now carry trade-offs, confidence, and what would change the call, and the conclusion card offers one-click "Do it", "Stress-test", and "Escalate to War Room". Topics about the current project get up to 3 read-only lookups before the discussion instead of guesses.
- War Room verdicts include confidence, overturn conditions, and rejected options; action items can be handed to the convener in one click, and the verdict queues when the convener is busy.
- Personal autopilot gives every step a done-criterion, checks the previous step first, compares directions before choosing, warns when it is going in circles, reports one line of progress per step, and labels stops as done, needs your decision, or stuck.
- A persistent working / needs-you / idle strip, nameplate activity badges, and a livelier office: station-specific screens and poses, idle moments, department-wide celebrations, an annex that extends the office when it gets crowded, and 16 smaller office touches such as camera follow and per-desk queue notes.
- The model menu explains what each model is good for, in a two-line list that no longer wraps inside the collapsed box.

### Changed

- War Room peers now use 6 reserved seats outside the 20-NPC limit. When seats run out, a War Room joins a first-come queue (up to 3 waiting, 30-minute limit) and opens automatically when seats free up; the status bar shows its place in line and lets you cancel. Only a War Room that could never fit is refused. The NPC count and add button only count permanent NPCs.
- The self-update safety gate checks every commit since the last shipped build, not just the newest one, so a blocked change can no longer ride along with a harmless follow-up. Plain documentation files are judged by name only, so a README that mentions the stop rules no longer blocks an update; agent-instruction files such as CLAUDE.md are still scanned. A build is recorded as shipped only after it boots healthy, and a failed build is not retried until there is a new commit.
- Personal autopilot also flags a step that only re-launches background work and then waits, and a loop instruction the NPC answers by saying the work was already done. In the replay it catches 10 of 12 genuine stalls (4 false alarms, one of which was a real redo loop).
- NPCs save memories and consult questions by writing a UTF-8 file and sending it with `curl --data-binary`, because Git Bash's curl sends Chinese on the command line in the system code page.
- The War Room skips its rebuttal round when nobody objects in round 1 and at most one peer agrees conditionally. The challenger states its real bottom line instead of being told to oppose by default, and peers that failed round 1 are not sent a rebuttal.
- War Room peers now mark "yes, but do it this way" as GO and keep HOLD for a real "wait until we know X", so consensus is recognised and the rebuttal round is skipped when it would add nothing. In testing, a consensus topic dropped from about 90 s and $0.43 to about 55 s and $0.18 with the same disputes still ruled on.
- Personal autopilot's going-in-circles detection was recalibrated against 198 real loop decisions, where the old thresholds never fired. It now flags back-to-back empty replies, replies that only say the NPC is waiting on background work, and loop instructions that re-issue the same move in different words (owner messages are ignored). In the replay it catches 8 of 12 genuine stalls instead of 0.
- Personal autopilot no longer sends a duplicate wrap-up turn when it uses up its step budget.
- First-screen JavaScript dropped from about 474 KB to 51 KB: the app shell, office scene, and English catalog load on demand. Streaming messages are coalesced, WebSocket traffic is compressed, render updates are batched, and the scene drops to 30 fps when everyone is idle.
- Mission confirmations and the README now say what actually happens: a Review that requests changes pauses for your decision instead of auto-correcting up to two rounds.

### Fixed

- Two War Rooms opened back to back can no longer take each other's moderator seat: the seat is reserved when a session starts, so neither falls back to an unsynthesised transcript.
- Memory and consult endpoints reject garbled text (replacement characters, question-mark runs, mojibake) with a message telling the NPC how to resend, instead of storing unreadable memories.
- A foreground subagent that has finished is no longer shown as a background subagent still running. Its result ends with an `agentId:` line, which had been mistaken for a background launch.
- War Room background subagents stay at the table until they actually finish instead of being cleared when the lead's turn ends.
- Subagent-internal messages are no longer mistaken for the main NPC's turn.
- NPCs on a mission walk to the station for the tool they are actually using, and mission speech bubbles show the current step instead of old chat.
- Autopilot tells you to sign in again when the Claude login has expired, instead of reporting a generic decision-model failure.
- The self-update safety gate only scans added and removed lines of a diff, so unchanged context no longer blocks a front-end-only change.
- The bundle budget check matches the new chunk layout (entry shell, app chunk, lazily loaded English catalog).
- One-click update on Windows downloads `Pixel.Crew.exe`, the name GitHub actually gives the release asset. Copies installed from v2.5.2 or earlier still request the old name and get a 404, so they need one manual download of the new release before one-click update works again.
- A queued message is no longer lost when sending it fails: it stays queued until a send succeeds (giving up after 3 failed tries), instead of being removed first and dropped with its attachments.
- Windows department task logs, assignment lists, and mission lists no longer come back empty: workspace paths are normalized when written as well as when queried, and existing rows are migrated.
- Disbanding a dedicated team no longer deletes the mission records it ran, and leftover team members are recognised at startup by a stored marker instead of the team's (renamable) name.
- A failed automatic retry after a lost `--resume` conversation no longer takes down every worker, and a later unrelated failure in a resumed session no longer silently discards the conversation.
- The initial snapshot has a hard size ceiling again; one very long turn could make it send a worker's entire history.
- A finished mission's "department discussion" can be opened again after a reload: its activity is fetched when you expand it, since the initial snapshot leaves it out.
- Self-install only ships a clean working tree at the exact commit the safety gate reviewed; uncommitted or untracked files, or a commit landing mid-build, abort it. The trigger, the rebuild/install scripts, the gate's own range and promotion logic, and remote-access auth are now protected files, an NPC's shell command that reaches for the self-install switch or trigger needs your confirmation even under full auto-approve, and remote share guests can never trigger it.
- A pasted video link that resolves to a loopback or private address is refused before `yt-dlp` runs, the same server-side request check the web screenshot tool already used.
- A message waiting for a video to finish processing is only sent to the NPC it was written for: switching NPCs or pressing Stop cancels it, and if the video fails the draft and the error stay instead of the text going out without the video.
- Autopilot progress and stop notices no longer steal a step's output or leave it stuck as running, and a stop or usage-limit notice right after a failed turn no longer reports it as completed (with confetti) or hides it from Needs You.
- Starting a War Room no longer locks the command bar: you can keep messaging any NPC while it runs or waits for seats, and a second War Room while one is running keeps your draft.
- Messages an older version left queued in this browser are put back in that NPC's input box with a notice, instead of staying invisible and impossible to send or delete.
- Holding Enter on a hold-to-confirm button now waits the full hold instead of confirming early when key repeat kicks in.
- Updating the installed app on Windows or macOS no longer resets remote access — the passcode, guardian password, Google sign-in settings and every signed-in phone now carry over from older versions too.
- Share guests can queue a message while an NPC is busy and withdraw their own queued messages without the guardian password; reordering the queue still needs it.
- Share guests can no longer switch remote-access auto-start on or off through the settings menu; like the rest of remote access, it is owner-only.
- The self-install safety check can no longer be bypassed by marking files as binary, saving code as UTF-16, using symlinks, or editing the build/test scripts — those changes now wait for the owner.
- A self-install is only marked as the new rollback point after the installer confirms that exact install healthy, so a failed install can no longer "roll back" to the bad build.
- Automatic self-install no longer freezes the app every 15 seconds re-checking the same commit, and a second install can't start while one is still building or being verified.
- A share-guest request with a malformed URL escape no longer crashes the remote-access relay.
- A boss task no longer leaves its department's members on safe auto-approve after the task ends; the lift applies only while that task's mission runs.
- Remote share guests can no longer open a dedicated (full auto-approve) crew for a boss task.
- Cancelling or deleting a boss task while it is still planning or building its crew now sticks: it is no longer revived or dispatched, and the half-built crew is disbanded.
- Autopilot no longer sends the next task into the previous task's temporary crew, and disbanding a crew cancels its missions instead of leaving the workspace locked until restart.
- Deleting a boss task that needs your attention also cancels its paused mission, so it no longer blocks that workspace and department.
- One malformed reply no longer stops the boss autopilot: it re-asks once, and a second bad reply is reported as a failure instead of a normal finish.
- The boss autopilot no longer silently stalls with the switch on: it resumes after a task recovers, replays triggers that were waiting on another loop, and reports when it cannot start the next task.
- A crew built for a boss task that a remote share guest started or replied to uses safe auto-approve instead of full, however the crew came to be created.
- A Bash command padded past 20,000 characters is no longer judged by its harmless start: approval checks read the whole command, and one too long to show in full always asks you.
- `rg`, `git`, `eslint`, `tsc` and package-manager commands with an unquoted wildcard now ask first, since a file named like `--pre=x` would expand into a flag.
- Pressing Stop on an NPC now also stops its personal autopilot (Claude and Codex), instead of the loop sending a new step a minute later or claiming the last turn errored.
- Switching an NPC to another account now really runs it under that account, so usage goes to the right account and the conversation survives the next restart.
- Queued /clear, /clean and /goal now behave like sent ones, and queuing a roundtable topic behind a busy NPC keeps it a roundtable (war room asks you to wait instead of queuing it as a plain task).
- LLM handoffs no longer present old, already-answered messages as top-priority unfinished requests, and request text in a handoff is redacted and size-capped.
- The 'lesson learned' card after a brain swap no longer stays 'in progress' forever or turns into a spurious 'session was interrupted' error.
- The task log no longer goes blank when a single turn produces more than 2,000 events.
- Sending the full 30 MiB of images plus documents no longer fails with a generic server error; oversized messages get a clear 'too large' message.
- Moving an NPC to another workspace now stops its personal autopilot instead of driving the new repo with the old repo's goal and plan.
- Personal autopilot can no longer run an NPC in ⚡ unrestricted mode; turning it on is refused and switching an NPC to that mode stops its loop.
- Scheduled tasks now respect each NPC's daily budget instead of running past the cap (a note explains the skip once per day).
- Workers no longer read files outside their folder or fetch web pages without asking when auto-approve is off.
- Unattended read-only checks and "safe" auto-approve no longer run commands that write files or launch programs through flags like `git diff --output`, `rg --pre` or `eslint --fix`.
- Full auto-approve now stops for Windows mass deletes and disk formatting (`Remove-Item -Recurse -Force`, `rd /s`, `del /f /s /q`, `format`).
- A worker whose saved conversation is gone after a restart now starts a fresh conversation and re-sends your message, instead of failing every turn.
- Memory and team-consult calls in full auto-approve mode no longer stop at an approval card.
- Codex autopilot investigations can now run read-only commands like `git status`, `ls` and `sed -n` instead of failing.
- A Codex plan update no longer makes read-only or no-tool turns fail.
- On Windows, writes to another drive or a network path are now blocked as outside the workspace.
- The Bash write guard now also blocks `2>`, `&>`, `>|` and `~/` redirects that write outside the workspace.
- The outbox panel no longer serves files when the outbox folder itself links outside the workspace.

## [2.5.2] - 2026-10-05

### Fixed

- Personal autopilot now runs its coach-decision call on the NPC's own assigned account and configured model, instead of always falling back to the shared login and a workspace-picked model. Previously a worker pinned to an account with quota could still stall because the behind-the-scenes decision ran on the shared login (out of credits) or picked a different, exhausted model.
- Switching an NPC's account is now one click: when the NPC already has a conversation, the UI asks for confirmation and then clears the session and switches in a single step, instead of forcing the owner to clear the session manually first.
- Cold-install updates no longer pile up duplicate browser tabs. The relaunched controller skips auto-opening a new tab (the owner's existing tab reconnects on its own); the staged installer script is also kept in sync with the repo so fixes like this actually take effect.
- Opening a lazy-loaded panel (e.g. the Outbox) in a tab left open across an in-place update no longer blanks the whole app to a black screen. A top-level error boundary now catches the stale-chunk failure and reloads once to pick up the new build automatically, instead of forcing the owner to refresh by hand; any other render crash shows a recoverable card rather than an unrecoverable blank.

## [2.5.1] - 2026-09-25

### Added

- Autopilot can now take over when an assignment stalls. With "auto-resume when stuck" checked, the decision model retries the step, re-runs it with a concrete instruction, accepts a reviewed risk, or answers its own clarification question with a safe bounded assumption — at most twice per assignment, and always deferring anything that needs the boss personally (real data, credentials, spending, irreversible calls) back to a stop.
- The autopilot switch survives restarts: its state persists server-side per workspace and is restored on boot, so an update or reboot no longer silently turns the loop off.
- Remote access can start itself with the app: a new checkbox in the Remote Access panel launches the relay on boot, so after a reboot the phone can connect without anyone touching the desktop first.
- The boss-room scene got livelier: the on-duty arrow bobs instead of sitting still, NPCs walk to the matching work station while their tool is running, and during discussion steps the current speaker's latest words float above their head like the web-search window does.

### Changed

- Autopilot's next-step decision no longer gives up early: when the finished thread is blocked on boss-only input it pivots to a different genuinely valuable objective (making deliverables more usable, hardening, tooling) and only stops when no direction offers real value.
- Boss-task discovery now takes a required-input inventory before planning: if the objective depends on a file or dataset that was not attached, it asks for it up front instead of burning a whole run to find out.

### Fixed

- Assignment plans with a formality mistake — the lead assigning the quick consult/review to itself, the closing execute to someone else, or a review to its own executor — are now corrected in place, the way the resolve dialog would, instead of pausing the whole mission; the one-shot format repair also names the exact rejection reason so the retry knows what to fix.
- Boss tasks no longer zombie after a restart: a stage whose mission record vanished is re-queued for dispatch, and a boot sweep advances every running task so the recovery actually happens without waiting for an event that will never come.
- The remote-access secret file moved out of the app directory into the data root, so updates no longer regenerate the signing key — the passcode, guardian password, and every signed-in device now survive an update instead of being reset.
- The pixel scene no longer empties out when the BOSS view is open without a dedicated crew: an empty boss room falls back to the main office instead of hiding every standing NPC.

### Security

- Share guests can no longer reach the host shell through the WebSocket path. The relay strips any client-supplied access-level header, stamps each proxied connection with the verified level, and the app refuses terminal control for share guests — closing a bypass around the HTTP-layer guardian and owner-only rules.

## [2.5.0] - 2026-09-23

### Added

- Remote access now shows a real progress bar while it downloads cloudflared for the first time, with transferred size, speed, remaining time, and a cancel button.
- On a phone the work-mode switch collapses to a single chip: swipe it left or right to move between Pixel, Professional, and Black Window, or tap it to pick one.
- The black window's CLI panes can be swiped between on a phone, one pane at a time.

### Changed

- Rebuilt the phone layout on one shared responsive layer: three breakpoints instead of twenty-four, one dialog shell behind every modal, and a single set of tap-target and spacing values. Phone screens no longer overflow sideways at any width down to 320px.
- The top bar now carries only the essentials — work mode, Assign work, usage, health — and splits the rest into two menus by what they affect: "This NPC" (workspace, provider, model, account, auto-approve, MCP) and "App settings" (language, notifications, boards, backup, restart). The two menus replace three overlapping ones that had drifted apart.
- All three work modes share one identical nav bar on a phone, so switching no longer shifts the controls.
- Professional mode switches NPCs with the same chip strip as Pixel mode instead of a dropdown, and its studio shortcuts and report index now share one row. The report gets 80px more height than before.
- Replaced every emoji used as an interface icon with one line-icon set that follows the surrounding colour and weight, instead of whatever glyph the operating system happened to supply.
- Share passwords now need at least 6 characters, the same minimum the owner passcode already had.
- Signing out of remote access also clears the guardian unlock, so the next person to sign in on that device has to enter the guardian password again.

### Fixed

- Fixed the microphone button's icon sitting against its left edge, and the round-table "..." menu opening past the right edge of a phone screen.
- Translated the last 199 interface strings that still showed Chinese in the English build — accounts, backup and restore, the boss assignment's effort limits, the black window workbench, the studio rail, the guardian prompt, and the tool-call status lines. The English interface no longer mixes the two languages.
- Fixed the first-run cloudflared download never completing. The install request used to block until the whole 19–70 MB file arrived, so it always hit the 40-second proxy timeout on a normal connection, and a dropped connection left the relay permanently stuck reporting "download in progress" until it was restarted.
- Verified the downloaded cloudflared against its declared size instead of accepting a truncated file, cleaned up the partial file, and aborted stalled downloads instead of waiting forever.
- Stopped leaving an orphaned cloudflared tunnel running when opening it timed out or when the relay exited, and reported cloudflared's own error output instead of a bare "failed to start".
- Stopped the remote-access login throttle from being bypassed by a spoofed `X-Forwarded-For` entry, and treated any forwarding header as proof a request is not a local owner request.
- Created the relay's config file, which holds the passcode in plain text, with owner-only permissions from the start instead of leaving it briefly readable by other accounts on the machine.
- Kept the remote-access window's status fresh while it is open, and capped Tailscale detection so a slow or hung `tailscale` CLI can no longer make the window time out.

## [2.4.0] - 2026-09-22

### Added

- Gave the macOS app and the Windows executable a real icon; downloads previously showed the blank generic-application icon on both platforms. The mark is the office crew itself, generated from a single source with `npm run icons`.
- Paste an image into a Black Window terminal with Cmd+V. The image is staged as a private local file and its path handed to the Claude Code or Codex composer, so it also works over remote access, where the browser and the CLI are on different machines.

### Fixed

- Parsed Claude usage lines that report no reset time instead of discarding the whole reading.

## [2.3.1] - 2026-09-09

### Changed

- Hardened the persistent Black Window workbench across terminal lifecycle recovery, pane interactions, responsive layouts, keyboard use, and screen-reader semantics.
- Rebuilt the bilingual product website with dedicated feature, download, and changelog pages.

### Fixed

- Made remote access work in source development by routing the Vite UI separately from API and WebSocket traffic, while keeping phone requests on the authenticated tunnel origin.
- Blocked Vite's filesystem route at the remote gateway so development-mode remote access cannot expose arbitrary workspace files.
- Stabilized cross-platform PTY lifecycle coverage, including Windows ConPTY sizing and delayed cleanup.

## [2.3.0] - 2026-09-04

### Added

- Added a persistent Black Window workbench for real Claude Code and Codex CLI sessions, with workspace tabs, movable/resizable/splittable panes, minimize/maximize controls, provider account and model settings, terminal font sizing, and editable local voice input.
- Added a shared local Markdown memory that is applied to Claude and Codex through their native instruction mechanisms and included in backup export and restore.

### Changed

- Improved per-account Claude and Codex work-energy reporting, including clearer reset timing and synchronized native controls.
- Refined Professional mode navigation, responsive layout, and mode-specific keyboard handling.

### Fixed

- Persist and synchronize Black Window terminal identity and layout without orphaning daemon sessions or allowing stale browser-tab updates to overwrite newer state.
- Replaced browser-native confirmation and alert prompts with accessible in-app dialogs and toasts, centralized destructive-action confirmation, and revalidated live state after asynchronous confirmations.

## [2.2.2] - 2026-09-01

### Fixed

- Improve Windows microphone capture for local voice input by enabling browser gain control, accepting quieter speech, and explaining the specific permission, device, or in-use failure.

## [2.2.1] - 2026-09-01

### Fixed

- Keep local Whisper model download progress visible instead of repeatedly reopening its confirmation dialog, including while the download request is still starting.
- Make the Windows local Whisper engine installer fall back to the inbox `tar.exe` extractor when PowerShell extraction is unavailable.

## [2.2.0] - 2026-09-01

### Added

- Shipped Windows as one double-clickable `Pixel Crew.exe`: a native control center with a recognizable Task Manager name, tray controls, clear error notifications, automatic startup, and private per-user installation without administrator rights.

## [2.1.2] - 2026-09-01

### Fixed

- Preserve existing Claude NPC conversations across the managed-account upgrade, so older session IDs resume from the Claude home that created them instead of failing during execution.

## [2.1.1] - 2026-09-01

### Fixed

- Made Focus Reader, remote access, workflow management, and supporting dialogs fit phone-sized viewports with touch-friendly controls.
- Surface local relay startup failures in Remote Access instead of reporting only a generic failure.

## [2.1.0] - 2026-09-01

### Added

- Added managed, per-NPC provider accounts for both Codex and Claude Code. Named accounts use isolated local CLI homes, support browser login (plus Codex's API-key flow), and cannot replace a worker's active native conversation without an explicit reset.
- Added Codex thread goals through `/goal`, including set, inspect, and clear operations, and added a command manager that distinguishes real built-ins from custom text-only palette entries.
- Added a Focus workbench: split the reader into up to four panes, cycle panes with `Alt+[` / `Alt+]`, and keep workspace/provider/model context visible alongside the existing read-only Git summary.
- Added a hidden Windows launcher and tray controls for open, restart, stop, and logs; background startup now records actionable diagnostics instead of leaving a persistent console window.
- Added optional local voice input for NPC composers: browser-recorded audio is transcribed by a local Whisper engine into an editable Traditional Chinese draft, with a one-time verified model download and no automatic send.

### Changed

- Improved Focus Studios, responsive reader layouts, model visibility, and the modern workspace shell.
- Hardened the local runtime against planned restarts, stalled background work, optional dialog timing, and screenshot-browser failures.
- Simplified first launch so people can begin immediately in Pixel Crew's managed workspace or choose an existing project when they need one.

### Fixed

- Removed obsolete one-click Squad templates from the product and documentation.
- Hardened remote sharing passcode handling and screenshot navigation against unsafe local/private targets.

## [2.0.1] - 2026-07-28

### Added

- Added a persistent Boss task log: assign work through one chat-first Boss Desk, with tasks, discovery questions, replies, department progress, and final reports persisting across navigation and restarts.
- Added multi-department orchestration: the decision model builds a validated dependency graph across real departments and NPC roles, passes each department its upstream reports, and returns one consolidated result to the Boss.
- Added mid-session model switching and a fresh-session flow for restarting a worker's context without losing its configuration.
- Added a live MCP configuration watcher that detects external edits to Claude/Codex MCP config files and refreshes capabilities automatically instead of requiring a manual refresh.

### Changed

- Replaced `CommandComposer` with a modularized `TaskComposer` and supporting composer hooks/helpers.

### Fixed

- Surfaced diagnostic info (resolved CLI executable, exit code, raw CLI output) when Claude/Codex authentication detection disagrees with reality, so machines where login isn't detected despite being logged in can be debugged instead of guessed at.

## [2.0.0] - 2026-07-22

### Added

- Added department management: create a department by providing a purpose, headcount, and provider, and have AI draft complementary NPC roles and personas before you pick a lead.
- Added read-only Quick Consult and Quick Review collaboration modes, each a fixed two-step handoff (expert advises or reviews, then the lead executes and finalizes) with no file writes from the consulted or reviewing NPC.
- Added Department Mission: a 2-to-5-step task chain that always starts with an execute step, requires a different NPC for each review step, and automatically retries a failed review up to two correction rounds before surfacing it for a decision.
- Added a `needs_attention` state that only interrupts for plan approval, an inconclusive review, an exhausted correction budget, a failed step, or a member becoming unavailable; every other handoff between department steps happens automatically.
- Added hard guardrails so no department workflow can auto-commit, push, merge, tag, or release, or touch CLI authentication; normal per-command approval prompts remain in effect throughout.

### Changed

- Rebuilt the marketing site (`PixelCrew/`) around the department and collaboration feature set, extracted its inline styles into a shared `assets/style.css`, and rewrote the English page to mirror the Chinese page's structure instead of maintaining a separately hand-authored layout.

## [1.0.3] - 2026-07-21

### Added

- Added a full MCP management modal with scoped add/remove, OAuth login/logout, connection details, and Codex MCP tool catalogs.
- Added validated local backup export and restore for workers, conversation history, settings, and custom avatars, including automatic pre-restore snapshots and rollback.
- Added cumulative Claude cost tracking alongside provider usage and quota information.
- Added complete NPC and workspace controls inside focus mode, including rename, provider/model settings, persona, avatar, room, and guarded removal.

### Changed

- Persisted focus mode across reloads, added keyboard focus traps and Escape handling to dialogs, and limited long task logs to recent chunks with on-demand history loading.
- Improved dangerous-command detection, Codex authentication checks, workflow refresh behavior, and MCP capability discovery.

### Fixed

- Prevented unsafe or oversized backup archives from escaping staging or exhausting local storage, and made restore shutdown reliable after client disconnects.
- Kept required first-launch workspace setup non-dismissible and aligned NPC removal confirmation across every UI entry point.

## [1.0.2] - 2026-07-20

### Added

- Added a focus workspace for long-form reading with NPC switching, report outlines, cross-NPC search, pins, Markdown export, and account usage context.
- Added full-window image and document drag-and-drop, manageable queued messages, and persistent per-session drafts and attachments.
- Added provider-scoped Codex command discovery that is available before the first conversation and remains available in new sessions.
- Added persistent NPC ordering across restarts.

### Changed

- Improved task-log readability with calmer colors, clearer typography, responsive layouts, search highlighting, and low-usage warnings.

### Fixed

- Kept composer state isolated while switching NPCs and prevented attachment drops from leaking through modal upload surfaces.
- Preserved failed-turn readable output in focus mode and guarded asynchronous persistence against stale writes.

## [1.0.1] - 2026-07-17

### Added
- Self-contained Windows x64 release ZIP with a bundled verified Node.js runtime and production dependencies.
- Stable latest-release download link for the Windows ZIP.

## [1.0.0] - 2026-07-17

First public release. / 首次公開發布。

### Added
- Multi-agent pixel office: run multiple **Claude Code** and **Codex** sessions as NPCs in one canvas, with real-time streaming of output, thinking, and tool calls.
- Per-NPC persona (role + instructions) with a reusable template library, injected through each CLI's native mechanism.
- Interactive approvals: floating approve/deny bar on the sprite, task-log approval cards, and a 3-level auto-approve mode（off / 安全 / 完全）with dangerous-command blocking.
- Radial quick menu on right-click（rename / persona / avatar / room / remove）.
- Camera controls: drag to pan, wheel & slider zoom, double-click / button reset.
- Living office: NPC mood reactions, idle socializing, office cat, milestone decorations unlocked by all-time completed turns.
- Desktop notifications for task completion and pending approvals（optional, off by default）.
- In-app update check against GitHub Releases with an update button.
- Cross-LLM handoff（Claude ⇄ Codex）with checkpoint summaries.
- NPC avatar workshop with animated GIF support; provider workflows; global work-energy HUD.
- Windows portable packaging（GitHub Actions release workflow, zip + tar.gz with SHA-256）.

[Unreleased]: https://github.com/juinwei7/Pixel-Crew/compare/v2.5.0...HEAD
[2.5.0]: https://github.com/juinwei7/Pixel-Crew/compare/v2.4.0...v2.5.0
[2.4.0]: https://github.com/juinwei7/Pixel-Crew/compare/v2.3.1...v2.4.0
[2.3.1]: https://github.com/juinwei7/Pixel-Crew/compare/v2.3.0...v2.3.1
[2.3.0]: https://github.com/juinwei7/Pixel-Crew/compare/v2.2.2...v2.3.0
[2.2.2]: https://github.com/juinwei7/Pixel-Crew/compare/v2.2.1...v2.2.2
[2.2.1]: https://github.com/juinwei7/Pixel-Crew/compare/v2.2.0...v2.2.1
[2.2.0]: https://github.com/juinwei7/Pixel-Crew/compare/v2.1.2...v2.2.0
[2.1.2]: https://github.com/juinwei7/Pixel-Crew/compare/v2.1.1...v2.1.2
[2.1.1]: https://github.com/juinwei7/Pixel-Crew/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/juinwei7/Pixel-Crew/compare/v2.0.1...v2.1.0
[2.0.1]: https://github.com/juinwei7/Pixel-Crew/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/juinwei7/Pixel-Crew/compare/v1.0.3...v2.0.0
[1.0.3]: https://github.com/juinwei7/Pixel-Crew/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/juinwei7/Pixel-Crew/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/juinwei7/Pixel-Crew/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/juinwei7/Pixel-Crew/releases/tag/v1.0.0
