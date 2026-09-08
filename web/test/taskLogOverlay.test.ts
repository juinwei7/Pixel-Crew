import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readStylesheet(url: URL): string {
  const source = readFileSync(url, "utf8");
  return source.replace(/@import\s+["'](.+?)["'];?/g, (_statement, specifier: string) => readStylesheet(new URL(specifier, url)));
}

// index.css is deliberately a small ordered entrypoint. Follow its local
// imports here so these layout invariants keep testing the real final cascade.
const css = readStylesheet(new URL("../src/index.css", import.meta.url));
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const blackWindow = readFileSync(new URL("../src/components/BlackWindowWorkspace.tsx", import.meta.url), "utf8");
const blackTerminal = readFileSync(new URL("../src/components/BlackWindowTerminal.tsx", import.meta.url), "utf8");

test("side panels remain overlays while map controls avoid the visible task panel", () => {
  assert.doesNotMatch(css, /--log-viewport-offset/);
  assert.doesNotMatch(css, /--crew-viewport-offset/);
  assert.doesNotMatch(css, /\.game-root--log-open[^{]*\.game-host/);
  assert.doesNotMatch(css, /\.game-root:not\(\.game-root--focus\) \.game-host/);
  assert.doesNotMatch(app, /game-root--log-open/);
  assert.doesNotMatch(app, /crewViewportOffset/);
  assert.match(css, /\.canvas-zoom\s*\{[\s\S]*?bottom:\s*16px[\s\S]*?left:\s*16px/);
  assert.match(app, /game-root--task-log-open/);
  assert.match(app, /game-root--crew-collapsed/);
  assert.match(css, /\.game-root:not\(\.game-root--task-log-open\) \.crew-rail\s*\{\s*bottom:\s*138px/);
  assert.match(css, /@media \(max-width:\s*599px\)[\s\S]*?\.canvas-zoom input\[type="range"\]\s*\{\s*display:\s*none/);
  assert.match(css, /\.game-root--focus \.canvas-zoom\s*\{[\s\S]*?display:\s*none/);
});

test("task log still owns an independently resizable panel width", () => {
  assert.match(css, /\.holo-panel[\s\S]*?width:\s*min\(var\(--log-panel-width\)/);
  assert.match(app, /"--log-panel-width": `\$\{preferences\.taskLogWidth\}px`/);
});

test("custom select controls vertically center their selected value and picker icon", () => {
  assert.match(css, /select\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?align-items:\s*center;/);
  assert.match(css, /select::picker-icon\s*\{[\s\S]*?align-self:\s*center;/);
});

test("black window mode isolates the underlying office controls from assistive technology", () => {
  assert.match(app, /aria-hidden=\{taskFocusMode \|\| blackWindowMode \|\| undefined\}/);
  assert.match(app, /inert=\{taskFocusMode \|\| blackWindowMode \? "" : undefined\}/);
  assert.match(app, /inert=\{taskFocusMode \|\| blackWindowMode\}/);
  assert.match(app, /className="app-copyright"[^>]*aria-hidden=\{blackWindowMode \|\| undefined\}[^>]*inert=\{blackWindowMode \? "" : undefined\}/);
});

test("black window CLI controls and pane switcher have descriptive semantics", () => {
  assert.match(blackWindow, /role="group" aria-label=\{t\("CLI 分頁"\)\}/);
  assert.match(blackWindow, /aria-current=\{entry\.id === selected\?\.id \? "true" : undefined\}/);
  assert.match(blackWindow, /aria-label=\{t\("中斷 CLI"\)\}/);
  assert.match(blackWindow, /t\("最小化 CLI"\)/);
  assert.match(blackWindow, /aria-label=\{closingIds\.has\(entry\.id\) \? t\("正在關閉 CLI…"\) : t\("關閉 CLI"\)\}/);
  assert.match(blackWindow, /tabIndex=\{0\}/);
  assert.match(blackWindow, /onKeyDown=\{\(event\) => adjustPaneWithKeyboard\(event, entry\)\}/);
  assert.match(blackWindow, /const observer = new ResizeObserver\(fit\)/);
  assert.match(blackWindow, /<div ref=\{canvasRef\} className="black-workspace__canvas">/);
  assert.match(blackWindow, /if \(Math\.hypot\(dx, dy\) < 4\) return/);
  assert.match(blackWindow, /viewport: canvasViewport\(\)/);
  assert.match(blackWindow, /return state\.moved \? mergeDraggedWindowGeometry\(incoming, locallyFinished, state\.id\) : incoming/);
  assert.match(blackTerminal, /<span role="status" aria-live="polite">/);
  assert.match(blackTerminal, /if \(activeRef\.current\) terminal\.focus\(\)/);
  assert.match(blackTerminal, /if \(!writable\) sendTerminal\(socketRef\.current, \{ type: "terminal_claim" \}\);\s*sendTerminal\(socketRef\.current, \{ type: "terminal_interrupt" \}\)/);
  assert.match(blackTerminal, /if \(status !== "ready" \|\| socketRef\.current\?\.readyState !== WebSocket\.OPEN\) return/);
  assert.match(blackWindow, /disabled=\{terminalStatuses\[entry\.id\] !== "ready" \|\| closingIds\.has\(entry\.id\) \|\| restartingId === entry\.id\}/);
  assert.match(blackTerminal, /const delay = Math\.min\(8_000, 800 \* 2 \*\* reconnectAttemptRef\.current\+\+\)/);
  assert.match(blackTerminal, /if \(disposed \|\| terminalEnded\) return/);
  assert.match(blackTerminal, /if \(message\.recoverable\) scheduleReconnect\(\)/);
  assert.match(blackTerminal, /\[connectionEpoch, sessionId, workspacePath\]/);
  assert.match(blackTerminal, /if \(!message\.destroyed\) onExitRef\.current\?\.\(\)/);
  assert.doesNotMatch(blackTerminal, /sendTerminal\(socketRef\.current, \{ type: "terminal_destroy"/);
  assert.match(blackTerminal, /launchCommand: launchCommandRef\.current/);
  assert.match(blackTerminal, /if \(launchCommand === undefined \|\| status !== "ready"\) return/);
  assert.match(blackTerminal, /\[launchCommand, status\]/);
  assert.match(blackTerminal, /message\.type === "terminal_agent_exit"/);
  assert.match(blackTerminal, /setAgentExitCode\(message\.code\)/);
  assert.match(blackTerminal, /message\.agentRunning === false && launchCommandRef\.current/);
  assert.match(blackTerminal, /Agent 已結束（退出碼 \{code\}）；shell 可繼續使用/);
  assert.match(blackTerminal, /launch\(command\)[\s\S]*?setAgentExitCode\(undefined\)/);
  assert.match(blackWindow, /typeof agentRunning === "boolean" && entry\.agentStarted !== agentRunning/);
  assert.match(blackWindow, /onExit=\{\(\) => update\(entry\.id, \{ agentStarted: false \}\)\}/);
  assert.match(blackWindow, /black-window__dot--\$\{terminalStatuses\[entry\.id\] \?\? "connecting"\}/);
  assert.match(blackWindow, /terminalStatuses\[entry\.id\] === "closed" \|\| terminalStatuses\[entry\.id\] === "error"/);
  assert.match(blackWindow, /key=\{`\$\{entry\.id\}:\$\{terminalEpochs\[entry\.id\] \?\? 0\}`\}/);
  assert.match(blackWindow, /if \(node\) terminalRefs\.current\.set\(entry\.id, node\); else terminalRefs\.current\.delete\(entry\.id\)/);
  assert.match(blackWindow, /setTerminalStatuses\(\(current\) => retainLiveTerminalState\(current, liveIds\)\)/);
  assert.match(blackWindow, /const delay = Math\.min\(8_000, 500 \* 2 \*\* Math\.min\(attempt - 1, 4\)\)/);
  assert.match(blackWindow, /throw new Error\("Terminal layout save failed"\)/);
  assert.match(blackWindow, /if \(!muxHydrated \|\| dragRef\.current\) return/);
  assert.match(blackWindow, /if \(event\.layout === inFlightLayoutSaveRef\.current\)/);
  assert.match(blackWindow, /if \(!pendingLayoutSaveRef\.current\) pendingLayoutSaveRef\.current = pending/);
  assert.match(blackWindow, /layoutSaveRunningRef\.current = true/);
  assert.match(blackWindow, /pendingLayoutSaveRef\.current = \{ layout: shared, serialized }/);
  assert.match(blackWindow, /if \(layoutSaveTimerRef\.current !== null\) window\.clearTimeout\(layoutSaveTimerRef\.current\);\s*layoutSaveTimerRef\.current = null;\s*dragRef\.current =/);
  assert.match(blackWindow, /if \(pending\) pendingLayoutSaveRef\.current = null/);
  assert.match(blackWindow, /if \(!pending && !state\?\.moved && pendingLayoutSaveRef\.current\) scheduleLayoutPersist\(0\)/);
  assert.match(blackWindow, /if \(!selected\?\.provider \|\| launchingIdRef\.current \|\| destroyingTerminalPromisesRef\.current\.has\(selected\.id\)\) return/);
  assert.match(blackWindow, /launchingIdRef\.current = id/);
  assert.match(blackWindow, /disabled=\{restartingId === selected\.id \|\| launchingId === selected\.id/);
  assert.match(blackWindow, /launchingId === selected\.id \? t\("啟動中…"\)/);
  assert.match(blackWindow, /terminalRefs\.current\.get\(id\)\?\.destroy\(\) \?\? destroyTerminalTab\(id\)/);
  assert.match(blackWindow, /dedupeTerminalDestroy\(destroyingTerminalPromisesRef\.current, id/);
  assert.match(blackWindow, /destroyWorkspaceTerminalTabs\(panes\.map\(\(pane\) => pane\.id\), destroyTerminalOnce\)/);
  assert.match(blackWindow, /aria-busy=\{closingIds\.has\(entry\.id\) \|\| undefined\}/);
  assert.match(blackWindow, /disabled=\{closingIds\.has\(entry\.id\) \|\| launchingId === entry\.id \|\| restartingId === entry\.id\}/);
  assert.match(blackWindow, /if \(deletingWorkspaceIdsRef\.current\.has\(workspaceId\)\) return/);
  assert.match(blackWindow, /aria-busy=\{deletingWorkspaceIds\.has\(workspace\.id\) \|\| undefined\}/);
  assert.match(blackWindow, /: state\.moved \? \{ \.\.\.current } : current/);
  assert.match(blackWindow, /aria-keyshortcuts="Alt\+ArrowUp Alt\+ArrowDown"/);
  assert.match(blackWindow, /onKeyDown=\{\(event\) => moveWorkspaceWithKeyboard\(event, workspace\.id\)\}/);
  assert.doesNotMatch(blackWindow, /<button[^>]*black-workspace__workspace-select[\s\S]*?editing \? <input/);
  assert.match(blackWindow, /editing\s*\? <div className="black-workspace__workspace-select">/);
  assert.match(blackWindow, /<button type="button" draggable className="black-workspace__workspace-select"/);
});

test("black window canvas height follows its live toolbar instead of a fixed offset", () => {
  assert.match(css, /\.black-workspace\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\)/);
  assert.match(css, /\.black-workspace__main\s*\{[^}]*position:\s*relative;/);
  assert.doesNotMatch(css, /\.black-workspace__main\s*\{[^}]*inset:\s*62px/);
});

test("a minimized black-window pane stays collapsed on narrow screens", () => {
  assert.match(css, /@media \(max-width: 820px\)[^}]*}[\s\S]*?\.black-window--minimized \{ height: 38px !important; min-height: 38px; }/);
});
