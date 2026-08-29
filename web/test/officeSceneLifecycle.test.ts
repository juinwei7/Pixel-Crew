import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("modern Office3D cleanup preserves a reusable WebGL context", () => {
  const source = readFileSync(new URL("../src/three/officeScene.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /\.forceContextLoss\s*\(/);
});
