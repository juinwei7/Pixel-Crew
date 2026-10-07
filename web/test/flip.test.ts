import assert from "node:assert/strict";
import test from "node:test";
import {
  captureRects,
  createFreshTracker,
  flipDelta,
  indicatorBox,
  indicatorStyle,
  isNegligible,
  playFlip,
  shouldCapture,
  type FlipRect,
} from "../src/flip";

type Call = { keyframes: Keyframe[]; options: KeyframeAnimationOptions };

class FakeEl {
  calls: Call[] = [];
  cancelled = 0;
  private running: Array<{ id: string; cancel(): void }>;
  constructor(private key: string, private rect: FlipRect, inFlight = false) {
    this.running = inFlight ? [{ id: "r2-flip", cancel: () => { this.cancelled += 1; } }] : [];
  }
  getAttribute(name: string) { return name === "data-flip-key" ? this.key : null; }
  getBoundingClientRect() { return this.rect; }
  animate(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    this.calls.push({ keyframes, options });
    return {} as Animation;
  }
  getAnimations() { return this.running as unknown as Animation[]; }
}

const makeEl = (key: string, rect: FlipRect, opts: { inFlight?: boolean } = {}) => new FakeEl(key, rect, opts.inFlight);

const container = (els: unknown[]) => ({ querySelectorAll: () => els });
const r = (left: number, top: number): FlipRect => ({ left, top, width: 100, height: 40 });

test("flipDelta is the offset from the new position back to the old one", () => {
  assert.deepEqual(flipDelta(r(10, 200), r(250, 40)), { dx: -240, dy: 160 });
  assert.equal(isNegligible({ dx: 0.2, dy: -0.4 }), true);
  assert.equal(isNegligible({ dx: 0, dy: 3 }), false);
});

test("shouldCapture only fires on a real layout change after the first commit", () => {
  assert.equal(shouldCapture(null, "a"), false, "first render has nothing to animate from");
  assert.equal(shouldCapture("a", "a"), false, "a 5s refresh that changed nothing must not animate");
  assert.equal(shouldCapture("a", "b"), true);
});

test("captureRects keys every flip element by data-flip-key", () => {
  const a = makeEl("a", r(0, 0));
  const b = makeEl("b", r(120, 0));
  const rects = captureRects(container([a, b]));
  assert.deepEqual([...rects.keys()], ["a", "b"]);
  assert.deepEqual(rects.get("b"), r(120, 0));
});

test("playFlip translates moved cards from their old spot, fades new ones, skips still ones", () => {
  const moved = makeEl("moved", r(0, 0));
  const still = makeEl("still", r(0, 100));
  const fresh = makeEl("fresh", r(0, 200));
  const first = new Map([["moved", r(240, 60)], ["still", r(0, 100)]]);
  const played = playFlip(container([moved, still, fresh]), first, { reduced: false, duration: 300 });
  assert.equal(played, 2);
  assert.equal(moved.calls.length, 1);
  assert.deepEqual(moved.calls[0].keyframes, [{ translate: "240px 60px" }, { translate: "0px 0px" }]);
  assert.equal(moved.calls[0].options.duration, 300);
  assert.equal(still.calls.length, 0);
  assert.deepEqual(fresh.calls[0].keyframes, [{ opacity: 0 }, { opacity: 1 }]);
});

test("playFlip uses the independent translate property, never transform", () => {
  const moved = makeEl("m", r(0, 0));
  playFlip(container([moved]), new Map([["m", r(10, 10)]]), { reduced: false });
  for (const frame of moved.calls[0].keyframes) assert.equal("transform" in frame, false);
});

test("playFlip cancels an in-flight flip before measuring and does nothing under reduced motion", () => {
  const moved = makeEl("m", r(0, 0), { inFlight: true });
  playFlip(container([moved]), new Map([["m", r(50, 0)]]), { reduced: false });
  assert.equal(moved.cancelled, 1);

  const calm = makeEl("m", r(0, 0));
  assert.equal(playFlip(container([calm]), new Map([["m", r(50, 0)]]), { reduced: true }), 0);
  assert.equal(calm.calls.length, 0);
});

test("fresh tracker: baseline on first sight and on scope change, later arrivals are fresh", () => {
  const tracker = createFreshTracker();
  assert.deepEqual([...tracker.observe("task-1", ["m1", "m2"])], []);
  assert.deepEqual([...tracker.observe("task-1", ["m1", "m2", "m3"])], ["m3"]);
  // 重渲染（StrictMode 雙跑）結果一致，且新鍵一直標著。
  assert.deepEqual([...tracker.observe("task-1", ["m1", "m2", "m3"])], ["m3"]);
  // 換到另一張任務：全部當基準，不播。
  assert.deepEqual([...tracker.observe("task-2", ["x1", "x2"])], []);
  assert.deepEqual([...tracker.observe("task-2", ["x1", "x2", "x3"])], ["x3"]);
});

test("indicatorBox measures the active tab in offset space and ignores hidden tabs", () => {
  assert.equal(indicatorBox(null), null);
  assert.equal(indicatorBox({ offsetLeft: 0, offsetTop: 0, offsetWidth: 0, offsetHeight: 0 }), null);
  const box = indicatorBox({ offsetLeft: 96, offsetTop: 0, offsetWidth: 88, offsetHeight: 30 });
  assert.deepEqual(box, { left: 96, top: 0, width: 88, height: 30 });
  assert.deepEqual(indicatorStyle(box!), { translate: "96px 0px", width: "88px", height: "30px" });
});
