import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SNEEZE_CHANCE, SNEEZE_COOLDOWN_MS, maySneeze, pickMicro } from "../src/game/microLife";

const base = {
  nowMs: SNEEZE_COOLDOWN_MS * 3,
  lastSneezeAtMs: 0,
  sneezeRoll: 0.5,
  pickRoll: 0,
  wearsGlasses: true,
  sneeze: "sneeze",
  fallback: "neckRoll",
  needsGlasses: "glasses",
} as const;

test("sneeze is rare: at most 1% of micro rolls (was 5%)", () => {
  assert.ok(SNEEZE_CHANCE <= 0.01);
  assert.equal(maySneeze(SNEEZE_COOLDOWN_MS * 2, 0, SNEEZE_CHANCE - 1e-9), true);
  assert.equal(maySneeze(SNEEZE_COOLDOWN_MS * 2, 0, SNEEZE_CHANCE), false);
  assert.equal(maySneeze(SNEEZE_COOLDOWN_MS * 2, 0, 0.04), false);
});

test("the same NPC never sneezes again within the cooldown (several minutes)", () => {
  assert.ok(SNEEZE_COOLDOWN_MS >= 3 * 60_000);
  const last = 1_000_000;
  assert.equal(maySneeze(last + 1, last, 0), false);
  assert.equal(maySneeze(last + SNEEZE_COOLDOWN_MS - 1, last, 0), false);
  assert.equal(maySneeze(last + SNEEZE_COOLDOWN_MS, last, 0), true);
  // Counts from spawn too (lastSneezeAt starts at 0).
  assert.equal(maySneeze(60_000, 0, 0), false);
});

test("simulated hour: one NPC rolling every ~10 s sneezes at most 10 times, usually far fewer", () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
  let last = 0;
  let count = 0;
  for (let now = 0; now < 60 * 60_000; now += 10_000) {
    if (maySneeze(now, last, rand())) { count++; last = now; }
  }
  assert.ok(count <= Math.floor((60 * 60_000) / SNEEZE_COOLDOWN_MS));
});

test("pickMicro picks from the pool and only sneezes when allowed", () => {
  const pool = ["sip", "nod", "glasses"] as const;
  assert.equal(pickMicro(pool, { ...base, pickRoll: 0 }), "sip");
  assert.equal(pickMicro(pool, { ...base, pickRoll: 0.5 }), "nod");
  assert.equal(pickMicro(pool, { ...base, pickRoll: 0.999 }), "glasses");
  assert.equal(pickMicro(pool, { ...base, sneezeRoll: 0 }), "sneeze");
  assert.equal(pickMicro(pool, { ...base, sneezeRoll: 0, lastSneezeAtMs: base.nowMs - 1_000 }), "sip");
});

test("pushing up glasses falls back when the NPC wears none", () => {
  const pool = ["glasses"] as const;
  assert.equal(pickMicro(pool, { ...base, wearsGlasses: true }), "glasses");
  assert.equal(pickMicro(pool, { ...base, wearsGlasses: false }), "neckRoll");
});

test("the sneeze act itself stays quiet: no speech bubble, no hop, no flying papers", () => {
  const src = readFileSync(new URL("../src/game/person.ts", import.meta.url), "utf8");
  const start = src.indexOf('case "sneeze": {');
  assert.ok(start > 0);
  const block = src.slice(start, src.indexOf("case ", start + 20));
  assert.doesNotMatch(block, /this\.say\(/);
  assert.doesNotMatch(block, /this\.hop\(/);
  assert.doesNotMatch(src, /blowPapers/);
  assert.doesNotMatch(src, /Math\.random\(\) < 0\.05 \? "sneeze"/);
});
