import assert from "node:assert/strict";
import test from "node:test";
import { avatarPresetPalette, avatarPresetRows, normalizeAvatarPresetId } from "../src/game/avatarPresets";
import { FRONT_IDLE_0, SHIRT_COLORS } from "../src/game/person";

test("normalizes unknown official avatar ids to classic", () => {
  assert.equal(normalizeAvatarPresetId("signal"), "signal");
  assert.equal(normalizeAvatarPresetId("unknown"), "classic");
});

test("official avatars keep the sprite dimensions while adding distinct details", () => {
  const classic = avatarPresetRows(FRONT_IDLE_0, "classic");
  for (const presetId of ["cyber", "signal", "spark", "ops"]) {
    const rows = avatarPresetRows(FRONT_IDLE_0, presetId);
    assert.equal(rows.length, classic.length);
    assert.deepEqual(rows.map((row) => row.length), classic.map((row) => row.length));
    assert.notDeepEqual(rows, classic);
  }
});

test("classic follows worker color while official specialists use fixed palettes", () => {
  const classicA = avatarPresetPalette("classic", 0, SHIRT_COLORS);
  const classicB = avatarPresetPalette("classic", 1, SHIRT_COLORS);
  const cyberA = avatarPresetPalette("cyber", 0, SHIRT_COLORS);
  const cyberB = avatarPresetPalette("cyber", 1, SHIRT_COLORS);
  assert.notEqual(classicA.B, classicB.B);
  assert.equal(cyberA.B, cyberB.B);
});
