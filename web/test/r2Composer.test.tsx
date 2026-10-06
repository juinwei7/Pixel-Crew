import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { composerStatus, emptySubmitAction, restoreFailedDraft, shouldAutoFocusComposer } from "../src/commandInteraction";
import { mergeFailed, TaskComposer } from "../src/components/TaskComposer";
import { groupDeliverables, QuestLog, RENDER_CHUNK, shouldLoadEarlier, type TurnDeliverable } from "../src/components/QuestLog";
import { isRichTextReady, RichText, streamRenderDelay, STREAM_RENDER_INTERVAL_MS } from "../src/components/RichText";
import type { QueuedCommandDto, Turn } from "../src/types";

// ── 1. 空白 Enter 不中止 ─────────────────────────────────────────────────
test("an empty Enter never interrupts a running task; only the stop button does", () => {
  assert.equal(emptySubmitAction("enter", 60_000), "ignore");
  assert.equal(emptySubmitAction("auto", 60_000), "ignore");
  assert.equal(emptySubmitAction("button", 60_000), "interrupt");
  // 剛送出就連點：按鈕也先忽略，避免誤砍剛派出的任務。
  assert.equal(emptySubmitAction("button", 200), "ignore");
});

// ── 2. 手機不自動聚焦 ────────────────────────────────────────────────────
test("touch-primary devices never auto-focus the composer; desktops and SSR still do", () => {
  const touch = (query: string) => ({ matches: query.includes("pointer: coarse") });
  const desktop = () => ({ matches: false });
  assert.equal(shouldAutoFocusComposer(touch), false);
  assert.equal(shouldAutoFocusComposer(desktop), true);
  assert.equal(shouldAutoFocusComposer(undefined), true);
  assert.equal(shouldAutoFocusComposer(() => { throw new Error("no media"); }), true);
});

// ── 3. 送出失敗還原草稿 ──────────────────────────────────────────────────
test("a failed send puts the original text back without dropping anything typed meanwhile", () => {
  assert.equal(restoreFailedDraft("", "修好登入"), "修好登入");
  assert.equal(restoreFailedDraft("   ", "修好登入"), "修好登入");
  assert.equal(restoreFailedDraft("順便看一下 CI", "修好登入"), "修好登入\n順便看一下 CI");
  assert.equal(restoreFailedDraft("修好登入", "修好登入"), "修好登入");
  assert.equal(restoreFailedDraft("草稿", ""), "草稿");
});

test("failed attachments come back first, without duplicates, within the limit", () => {
  const failed = [{ id: "a" }, { id: "b" }];
  const current = [{ id: "b" }, { id: "c" }];
  assert.deepEqual(mergeFailed(failed, current, 10), [{ id: "a" }, { id: "b" }, { id: "c" }]);
  assert.deepEqual(mergeFailed(failed, current, 2), [{ id: "a" }, { id: "b" }]);
  assert.equal(mergeFailed([], current, 10), current);
});

// ── 4／6. 排隊與狀態列 ───────────────────────────────────────────────────
function dock(extra: Partial<React.ComponentProps<typeof TaskComposer>> = {}) {
  return renderToStaticMarkup(<TaskComposer
    draftKey="worker:claude:/repo"
    placeholder="下指令"
    submitLabel="執行"
    layout="dock"
    queueEnabled
    onSubmit={async () => null}
    launchTarget={{ id: "w1", name: "小助手" }}
    {...extra}
  />);
}

test("composer status reads needs-you > working > standby", () => {
  assert.equal(composerStatus({ busy: true, needsAttention: true }), "attention");
  assert.equal(composerStatus({ busy: true }), "working");
  assert.equal(composerStatus({ working: true }), "working");
  assert.equal(composerStatus({}), "idle");
  assert.match(dock(), /class="composer-status" data-state="idle"[^>]*role="status"/);
  assert.match(dock(), /待命/);
  assert.match(dock({ busy: true }), /data-state="working"/);
  assert.match(dock({ busy: true }), /工作中/);
  assert.match(dock({ busy: true, needsAttention: true }), /data-state="attention"/);
  assert.match(dock({ needsAttention: true }), /需要你/);
});

test("the status line only appears on the NPC dock composer", () => {
  assert.doesNotMatch(dock({ launchTarget: null }), /composer-status/);
  const inline = renderToStaticMarkup(<TaskComposer draftKey="dept" placeholder="x" submitLabel="交辦" onSubmit={async () => null} />);
  assert.doesNotMatch(inline, /composer-status/);
});

test("queued messages show a restrained waiting stack on the queue chip", () => {
  const queue: QueuedCommandDto[] = [1, 2, 3, 4].map((n) => ({ id: `q${n}`, message: `第 ${n} 則`, images: [], documents: [] }) as unknown as QueuedCommandDto);
  const html = dock({ busy: true, serverQueue: queue, onEnqueue: async () => null });
  assert.match(html, /class="command-composer__queue"[^>]*data-waiting="true"/);
  // 最多畫 3 條，不管排了幾則。
  const stack = /command-composer__queue-stack[^>]*>(.*?)<\/span>/.exec(html)?.[1] ?? "";
  assert.equal((stack.match(/<i>/g) ?? []).length, 3);
  assert.match(html, /等待 4/);
  const idle = dock({ busy: false, serverQueue: queue.slice(0, 1), onEnqueue: async () => null });
  assert.doesNotMatch(idle, /data-waiting/);
});

// ── 5. 核准卡蓋章 ────────────────────────────────────────────────────────
function approvalTurn(status: "pending" | "resolved", decision?: "allow_once" | "deny"): Turn {
  return {
    key: `approval-${status}-${decision ?? "none"}`,
    command: "部署",
    status: status === "pending" ? "running" : "done",
    items: [{
      kind: "approval",
      key: "approval",
      status,
      decision,
      request: { id: "ap-1", activityId: "a", category: "command", title: "允許執行？", input: {}, command: "npm run deploy", decisions: ["allow_once", "deny"] },
    }],
  } as Turn;
}

test("resolved approval cards carry a static stamp matching the decision; pending ones do not", () => {
  const allowed = renderToStaticMarkup(<QuestLog turns={[approvalTurn("resolved", "allow_once")]} view="activity" />);
  assert.match(allowed, /approval-card__stamp approval-card__stamp--allow/);
  assert.match(allowed, /已核准/);
  assert.doesNotMatch(allowed, /data-live/);
  const denied = renderToStaticMarkup(<QuestLog turns={[approvalTurn("resolved", "deny")]} view="activity" />);
  assert.match(denied, /approval-card__stamp--deny/);
  const pending = renderToStaticMarkup(<QuestLog turns={[approvalTurn("pending")]} onApprove={async () => null} />);
  assert.doesNotMatch(pending, /approval-card__stamp/);
});

// ── 8／10. RichText 節流與延後載入 ───────────────────────────────────────
test("streaming markdown is re-rendered at most once per interval", () => {
  assert.equal(STREAM_RENDER_INTERVAL_MS, 100);
  assert.equal(streamRenderDelay(0, 5_000), 0);
  assert.equal(streamRenderDelay(1_000, 1_030), 70);
  assert.equal(streamRenderDelay(1_000, 1_100), 0);
});

test("the markdown engine is resolved synchronously on the server so SSR output stays complete", () => {
  assert.equal(isRichTextReady(), true);
  const streaming = renderToStaticMarkup(<RichText text={"# 標題\n\n- 一\n- 二"} streaming />);
  assert.match(streaming, /<h1>標題<\/h1>/);
  assert.match(streaming, /data-streaming="true"/);
  const done = renderToStaticMarkup(<RichText text={"**完成**"} />);
  assert.match(done, /<strong>完成<\/strong>/);
  assert.doesNotMatch(done, /data-streaming/);
});

// ── 9. QuestLog 首批 30 張、往上捲再載入 ─────────────────────────────────
test("the log renders the latest 30 cards first and loads more only when scrolled near the top", () => {
  assert.equal(RENDER_CHUNK, 30);
  assert.equal(shouldLoadEarlier(0, 12), true);
  assert.equal(shouldLoadEarlier(120, 12), true);
  assert.equal(shouldLoadEarlier(600, 12), false);
  assert.equal(shouldLoadEarlier(0, 0), false);
});

// ── 11. nextAttention／turnDeliverables ─────────────────────────────────
const doneTurn = (key: string): Turn => ({ key, command: `任務 ${key}`, status: "done", items: [{ kind: "assistant_text", key: `${key}-t`, text: "好了" }] });

test("next-attention bar is a clickable jump at the top of the log", () => {
  const html = renderToStaticMarkup(<QuestLog turns={[doneTurn("a")]} nextAttention={{ id: "n1", label: "核准部署", detail: "小助手 · npm run deploy", tone: "approval", turnKey: "a" }} />);
  assert.match(html, /<button type="button" class="quest-log__next-attention" data-tone="approval"/);
  assert.match(html, /下一件需要你/);
  assert.match(html, /核准部署/);
  assert.match(html, /小助手 · npm run deploy/);
  assert.doesNotMatch(renderToStaticMarkup(<QuestLog turns={[doneTurn("a")]} />), /quest-log__next-attention/);
});

test("turn deliverables attach to their turn, defaulting to the latest one", () => {
  const deliverables: TurnDeliverable[] = [
    { id: "d1", label: "report.md", kind: "report" },
    { id: "d2", label: "設計稿", kind: "link", href: "https://example.com/design" },
    { id: "d3", label: "old.csv", kind: "file", turnKey: "a" },
  ];
  const groups = groupDeliverables(deliverables, "b");
  assert.deepEqual(groups.get("b")?.map((item) => item.id), ["d1", "d2"]);
  assert.deepEqual(groups.get("a")?.map((item) => item.id), ["d3"]);
  assert.equal(groupDeliverables(deliverables.slice(0, 1), undefined).size, 0);

  const html = renderToStaticMarkup(<QuestLog turns={[doneTurn("a"), doneTurn("b")]} turnDeliverables={deliverables} onOpenDeliverable={() => {}} />);
  // 較舊、收合中的卡片不攤開成品；最新那張攤開。閱讀模式每張都展開，兩張都有。
  assert.equal((html.match(/class="turn-deliverables"/g) ?? []).length, 1);
  const reader = renderToStaticMarkup(<QuestLog turns={[doneTurn("a"), doneTurn("b")]} focusMode turnDeliverables={deliverables} />);
  assert.equal((reader.match(/class="turn-deliverables"/g) ?? []).length, 2);
  assert.match(reader, /old\.csv/);
  assert.match(html, /本回合成品/);
  assert.match(html, /<a class="turn-deliverables__item" href="https:\/\/example.com\/design" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /<button type="button" class="turn-deliverables__item"[^>]*>.*report\.md/);
});
