import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createFrameBatcher, type FrameScheduler } from "../src/hooks/frameBatch";
import { keyboardShortcut } from "../src/hooks/useKeyboardShortcuts";
import { WorkerTabs } from "../src/components/WorkerTabs";
import { TopBar } from "../src/components/TopBar";
import { ShortcutsHelp } from "../src/components/ShortcutsHelp";
import { collectNeedsYou, needsYouByWorker } from "../src/needsYou";
import { ensureLanguage, languageReady, t } from "../src/i18n";
import { emptyWorker } from "../src/workerState";
import type { TurnItem, WorkerState } from "../src/types";

function fakeScheduler() {
  const frames = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  let id = 0;
  const scheduler: FrameScheduler = {
    requestFrame: (callback) => { frames.set(++id, callback); return id; },
    cancelFrame: (handle) => { frames.delete(handle as number); },
    setTimer: (callback) => { timers.set(++id, callback); return id; },
    clearTimer: (handle) => { timers.delete(handle as number); },
  };
  return { scheduler, frames, timers, runFrames: () => [...frames.values()].forEach((callback) => callback()), runTimers: () => [...timers.values()].forEach((callback) => callback()) };
}

test("WS frame batcher applies everything received in one frame as a single ordered batch", () => {
  const fake = fakeScheduler();
  const batches: number[][] = [];
  const batcher = createFrameBatcher<number>((items) => batches.push(items), fake.scheduler);
  batcher.push(1);
  batcher.push(2);
  batcher.push(3);
  assert.equal(fake.frames.size, 1, "one frame scheduled for the whole burst");
  assert.equal(batcher.pending, 3);
  fake.runFrames();
  assert.deepEqual(batches, [[1, 2, 3]]);
  assert.equal(fake.timers.size, 0, "fallback timer cancelled once the frame ran");
  batcher.push(4);
  fake.runTimers(); // 背景分頁：rAF 不跑，保底計時器接手
  assert.deepEqual(batches, [[1, 2, 3], [4]]);
});

test("WS frame batcher can flush early and cancel pending work", () => {
  const fake = fakeScheduler();
  const batches: string[][] = [];
  const batcher = createFrameBatcher<string>((items) => batches.push(items), fake.scheduler);
  batcher.push("a");
  batcher.flush();
  batcher.flush(); // 空的 flush 不呼叫 apply
  assert.deepEqual(batches, [["a"]]);
  batcher.push("b");
  batcher.cancel();
  fake.runFrames();
  fake.runTimers();
  assert.deepEqual(batches, [["a"]]);
});

test("N jumps to the next item, but never while typing or with modifiers", () => {
  const event = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });
  assert.equal(keyboardShortcut(event("n")), "next_attention");
  assert.equal(keyboardShortcut(event("N")), "next_attention");
  assert.equal(keyboardShortcut(event("n"), true), null);
  assert.equal(keyboardShortcut(event("n", { ctrlKey: true })), null);
  assert.equal(keyboardShortcut(event("n", { altKey: true })), null);
  assert.equal(keyboardShortcut(event("N", { shiftKey: true })), null);
  const help = renderToStaticMarkup(<ShortcutsHelp onClose={() => {}} />);
  assert.match(help, /接下一件/);
});

function crew(): WorkerState[] {
  const idle = emptyWorker("idle", "Idle", null, false, 0, "claude", "/room");
  const busy = emptyWorker("busy", "Busy", null, true, 1, "claude", "/room");
  const asking: WorkerState = {
    ...emptyWorker("ask", "Asker", null, false, 2, "codex", "/room"),
    turns: [{ key: "t1", command: "plan", status: "done", items: [{ kind: "assistant_text", key: "x", text: "要上線嗎？" } as TurnItem] }],
  };
  return [idle, busy, asking];
}

function renderRail(workers: WorkerState[], extra: Partial<React.ComponentProps<typeof WorkerTabs>> = {}) {
  return renderToStaticMarkup(<WorkerTabs
    workers={workers}
    activeId={null}
    currentRoom="/room"
    filter="all"
    collapsed={false}
    onFilter={() => {}}
    onCollapsed={() => {}}
    onSelect={() => {}}
    onReorder={() => {}}
    onCreate={() => {}}
    onClose={() => {}}
    onRename={async () => null}
    onAvatar={() => {}}
    onPersona={() => {}}
    onRoom={() => {}}
    {...extra}
  />);
}

test("crew rail sorts needs-you, then working, then idle when the shared list is provided", () => {
  const workers = crew();
  const order = (html: string) => [...html.matchAll(/data-crew-id="([^"]+)"/g)].map((match) => match[1]);
  // 沒給 needsYou：維持原本（自訂）順序
  assert.deepEqual(order(renderRail(workers)), ["idle", "busy", "ask"]);
  const needs = needsYouByWorker(collectNeedsYou(workers));
  const html = renderRail(workers, { needsYou: needs });
  assert.deepEqual(order(html), ["ask", "busy", "idle"]);
  assert.match(html, /crew-row--needs-you/);
  assert.match(html, /crew-row__need-tag">在問你/);
});

test("a stuck NPC is visible at a glance in the crew rail", () => {
  const workers = crew();
  const html = renderRail(workers, { needsYou: new Map(), stuck: new Map([["busy", 7 * 60_000]]) });
  assert.match(html, /crew-row--stuck/);
  assert.match(html, /卡住 7 分/);
});

const topBarBase = {
  activeWorkspace: "/repo/room",
  capabilities: { slashCommands: [], mcpServers: [], models: [], toolCount: null, builtinTools: null, loading: false, source: "live" as const, updatedAt: null, error: null },
  auth: { provider: "claude" as const, displayName: "Claude Code", status: "authenticated" as const, loginCommand: "claude", checkedAt: null, error: null, debug: null },
  wsReady: true,
  modelOptions: [],
  workerCount: 1,
  runningCount: 0,
  restartPending: false,
  notificationsEnabled: false,
  onRoom() {}, onOpenMcp() {}, onOpenGlobalMemory() {}, onOpenAccounts() {}, onOpenBackup() {}, onOpenOps() {}, onOpenKanban() {}, onOpenDayReport() {}, onOpenOutbox() {}, onOpenTour() {}, onOpenRemote() {}, onRestart() {}, onProvider() {}, onModel() {}, onAutoApprove() {}, onRefreshAuth() {}, onResetUi() {}, onNotificationsToggle() {},
};

test("outbox button appears only with unread deliverables and replays the drop per arrival", () => {
  const none = renderToStaticMarkup(<TopBar {...topBarBase} />);
  assert.doesNotMatch(none, /top-bar__outbox"/);
  const html = renderToStaticMarkup(<TopBar {...topBarBase} outboxUnread={3} outboxDropSeq={2} />);
  assert.match(html, /class="top-bar__outbox"/);
  assert.match(html, /top-bar__outbox-drop/);
  assert.match(html, /成品匣：3 份新成品/);
  assert.match(html, /top-bar__menu-count">3</);
});

test("needs-you badge keeps the approval wording for approvals and says 'needs you' for mixed kinds", () => {
  const approvals = renderToStaticMarkup(<TopBar {...topBarBase} needsYou={{ count: 2, name: "A", kinds: ["approval"] }} onNeedsYou={() => {}} />);
  assert.match(approvals, /等你核准/);
  assert.doesNotMatch(approvals, /top-bar__needs-you--mixed/);
  const mixed = renderToStaticMarkup(<TopBar {...topBarBase} needsYou={{ count: 2, name: "A", kinds: ["approval", "question"] }} onNeedsYou={() => {}} />);
  assert.match(mixed, /top-bar__needs-you--mixed/);
  assert.match(mixed, />需要你</);
  assert.match(mixed, /aria-keyshortcuts="N"/);
});

test("Chinese needs no dictionary download; t() stays synchronous", async () => {
  assert.equal(languageReady(), true);
  await ensureLanguage();
  assert.equal(t("剩餘 {pct}%", { pct: 5 }), "剩餘 5%");
});

test("entry stays light: Pixi scene and English strings load on demand", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  const i18n = readFileSync(new URL("../src/i18n.ts", import.meta.url), "utf8");
  const vite = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.doesNotMatch(app, /import \{ GameCanvas \} from/);
  assert.match(app, /lazy\(\(\) => import\("\.\/components\/GameCanvas"\)/);
  assert.match(main, /await ensureLanguage\(\);[\s\S]*await import\("\.\/App"\)/);
  assert.doesNotMatch(i18n, /^import .* from "\.\/i18n\/en-/m);
  assert.match(vite, /preload-helper/);
});
