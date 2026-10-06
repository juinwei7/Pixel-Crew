import assert from "node:assert/strict";
import test from "node:test";
import { ACTIVE_FPS, IDLE_FPS, INPUT_HOLD_MS, targetFps } from "../src/game/framePacing";

test("idles at 30fps when nobody is busy and nothing is being touched", () => {
  assert.equal(targetFps({ anyBusy: false, cameraMoving: false, sinceInputMs: 60_000 }), IDLE_FPS);
});

test("runs at 60fps while someone works, the camera glides, or right after input", () => {
  assert.equal(targetFps({ anyBusy: true, cameraMoving: false, sinceInputMs: 60_000 }), ACTIVE_FPS);
  assert.equal(targetFps({ anyBusy: false, cameraMoving: true, sinceInputMs: 60_000 }), ACTIVE_FPS);
  assert.equal(targetFps({ anyBusy: false, cameraMoving: false, sinceInputMs: INPUT_HOLD_MS - 1 }), ACTIVE_FPS);
  assert.equal(targetFps({ anyBusy: false, cameraMoving: false, sinceInputMs: INPUT_HOLD_MS }), IDLE_FPS);
});
