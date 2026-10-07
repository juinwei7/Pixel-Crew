import assert from "node:assert/strict";
import test from "node:test";
import {
  CameraDirector,
  FOCUS_MS,
  FOLLOW_MAX_SPEED,
  centerPanOn,
  clampPan,
  clearViewRect,
  easeInOutCubic,
  edgeMarkers,
  isOffscreen,
  nameInitials,
  type Pt,
} from "../src/game/cameraFocus";

const still = () => false;

function run(director: CameraDirector, start: Pt, target: (id: string) => Pt | null, frames: number, dt = 16): Pt[] {
  const out: Pt[] = [];
  let pan = start;
  for (let i = 0; i < frames; i++) {
    const next = director.step(dt, pan, (id) => target(id));
    if (next) pan = next;
    out.push(pan);
  }
  return out;
}

test("ease-in-out is clamped and symmetric", () => {
  assert.equal(easeInOutCubic(-1), 0);
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(1), 1);
  assert.equal(easeInOutCubic(2), 1);
  assert.ok(Math.abs(easeInOutCubic(0.5) - 0.5) < 1e-9);
});

test("centerPanOn puts the NPC on the anchor and respects the existing pan bounds", () => {
  const view = { scale: 2, screenW: 1000, screenH: 600, baseX: 100, baseY: 50, contentW: 400, contentH: 250 };
  const pan = centerPanOn({ ...view, worldX: 200, worldY: 125 });
  // world.position = base + pan; the NPC lands at world.position + world * scale = screen center.
  assert.equal(view.baseX + pan.x + 200 * 2, 500);
  assert.equal(view.baseY + pan.y + 125 * 2, 300);
  const anchored = centerPanOn({ ...view, worldX: 200, worldY: 125, anchor: { x: 400, y: 200 } });
  assert.equal(view.baseX + anchored.x + 400, 400);
  // Far corner: clamped exactly like scene.applyView (keep 140px of room on screen).
  const far = centerPanOn({ ...view, worldX: -300, worldY: 0 });
  assert.deepEqual(far, clampPan({ x: 1000, y: 250 }, { ...view }));
  assert.equal(far.x, 1000 - 140 - 100);
});

test("focusOn glides to the NPC in ~300ms and then stops emitting", () => {
  const director = new CameraDirector({ reducedMotion: still });
  director.focusOn("a");
  const goal = { x: 300, y: -120 };
  const frames = run(director, { x: 0, y: 0 }, () => goal, Math.ceil(FOCUS_MS / 16) + 3);
  const landed = frames[Math.ceil(FOCUS_MS / 16)];
  assert.deepEqual(landed, goal);
  // Monotonic: never overshoots on the way.
  for (let i = 1; i < frames.length; i++) assert.ok(frames[i].x >= frames[i - 1].x && frames[i].x <= goal.x);
  // Midway it's actually moving (not a jump).
  assert.ok(frames[3].x > 0 && frames[3].x < goal.x);
  assert.equal(director.step(16, goal, () => goal), null);
  assert.equal(director.active, false);
});

test("focusOn lands on a moving target and survives external pan changes mid-glide", () => {
  const director = new CameraDirector({ reducedMotion: still });
  director.focusOn("a");
  let goalX = 100;
  let pan: Pt = { x: 0, y: 0 };
  const frames = Math.ceil(FOCUS_MS / 16);
  for (let i = 0; i < frames; i++) {
    goalX += 2;
    if (i === 5) pan = { x: pan.x - 40, y: pan.y }; // user zoomed: pan jumped
    const next = director.step(16, pan, () => ({ x: goalX, y: 0 }));
    if (next) pan = next;
  }
  assert.ok(Math.abs(pan.x - goalX) < 1e-9);
  assert.equal(director.active, false);
});

test("prefers-reduced-motion: focusOn jumps in a single frame", () => {
  const director = new CameraDirector({ reducedMotion: () => true });
  director.focusOn("a");
  assert.deepEqual(director.step(16, { x: 0, y: 0 }, () => ({ x: 80, y: 40 })), { x: 80, y: 40 });
  assert.equal(director.step(16, { x: 80, y: 40 }, () => ({ x: 80, y: 40 })), null);
});

test("follow moves slowly (speed-capped) and stops when the NPC stops", () => {
  const director = new CameraDirector({ reducedMotion: still });
  director.follow("a");
  assert.equal(director.followingId(), "a");
  const goal = { x: 1000, y: 0 };
  const frames = run(director, { x: 0, y: 0 }, () => goal, 60);
  for (let i = 1; i < frames.length; i++) {
    const moved = Math.hypot(frames[i].x - frames[i - 1].x, frames[i].y - frames[i - 1].y);
    assert.ok(moved <= (FOLLOW_MAX_SPEED * 16) / 1000 + 1e-9, `frame ${i} moved ${moved}px`);
  }
  // Long enough: settles exactly, then emits nothing (camera is still while the NPC is still).
  const settled = run(director, frames[frames.length - 1], () => goal, 600);
  assert.deepEqual(settled[settled.length - 1], goal);
  assert.equal(director.step(16, goal, () => goal), null);
  assert.equal(director.followingId(), "a");
});

test("follow ends by itself when the NPC leaves; stopFollow cancels glide and follow", () => {
  const director = new CameraDirector({ reducedMotion: still });
  director.follow("a");
  assert.equal(director.step(16, { x: 0, y: 0 }, () => null), null);
  assert.equal(director.followingId(), null);

  director.follow("a");
  director.focusOn("a");
  director.stopFollow();
  assert.equal(director.step(16, { x: 0, y: 0 }, () => ({ x: 50, y: 50 })), null);
  assert.equal(director.active, false);
});

test("focusing someone else drops the follow; focusing the followed NPC keeps it", () => {
  const director = new CameraDirector({ reducedMotion: still });
  director.follow("a");
  director.focusOn("a");
  assert.equal(director.followingId(), "a");
  director.focusOn("b");
  assert.equal(director.followingId(), null);
});

test("clearViewRect removes edge-docked panels but ignores small button rows", () => {
  const view = { left: 0, top: 0, right: 1400, bottom: 800 };
  const rail = { left: 10, top: 68, right: 240, bottom: 722 };
  const log = { left: 800, top: 0, right: 1400, bottom: 800 };
  const topBar = { left: 0, top: 0, right: 1400, bottom: 54 };
  const zoom = { left: 16, top: 740, right: 260, bottom: 784 };
  assert.deepEqual(clearViewRect(view, [rail, log, topBar, zoom]), { left: 240, top: 54, right: 800, bottom: 800 });
  // A panel covering almost everything would leave a sliver: fall back to the whole view.
  assert.deepEqual(clearViewRect(view, [{ left: 0, top: 0, right: 1350, bottom: 800 }]), view);
});

test("off-screen detection has hysteresis so a marker never flickers at the edge", () => {
  const rect = { left: 0, top: 0, right: 500, bottom: 400 };
  assert.equal(isOffscreen({ x: 250, y: 200 }, rect, false), false);
  assert.equal(isOffscreen({ x: 503, y: 200 }, rect, false), false); // just past the edge: not yet
  assert.equal(isOffscreen({ x: 510, y: 200 }, rect, false), true);
  assert.equal(isOffscreen({ x: 490, y: 200 }, rect, true), true); // back by a hair: still off
  assert.equal(isOffscreen({ x: 470, y: 200 }, rect, true), false);
});

test("edge markers sit on the inset frame, point at the NPC, avoid keepouts and each other", () => {
  const rect = { left: 0, top: 0, right: 600, bottom: 400 };
  const [right] = edgeMarkers([{ id: "r", x: 900, y: 200 }], rect, { inset: 20 });
  assert.ok(Math.abs(right.x - 580) < 1e-9);
  assert.ok(Math.abs(right.y - 200) < 1e-9);
  assert.ok(Math.abs(right.angle) < 1e-9);
  const [up] = edgeMarkers([{ id: "u", x: 300, y: -500 }], rect, { inset: 20 });
  assert.ok(Math.abs(up.y - 20) < 1e-9);
  assert.ok(Math.abs(up.angle + Math.PI / 2) < 1e-9);
  const [blocked] = edgeMarkers([{ id: "b", x: 100, y: 900 }], rect, { inset: 20, keepouts: [{ left: 0, top: 340, right: 260, bottom: 400 }] });
  assert.ok(blocked.y < 340, `pushed above the zoom bar, got ${blocked.y}`);
  const pair = edgeMarkers([{ id: "a", x: 900, y: 200 }, { id: "b", x: 900, y: 205 }], rect, { inset: 20, size: 26 });
  assert.ok(Math.abs(pair[0].y - pair[1].y) >= 26);
});

test("name initials: first CJK character, or two Latin letters", () => {
  assert.equal(nameInitials("小助手"), "小");
  assert.equal(nameInitials("Ada Lovelace"), "AL");
  assert.equal(nameInitials("codex"), "CO");
  assert.equal(nameInitials("  "), "?");
});
