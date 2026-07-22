import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NpcRadialMenu } from "../src/components/NpcRadialMenu";
import { emptyWorker } from "../src/workerState";

const noop = () => {};

function render(worker: ReturnType<typeof emptyWorker>, canRemove: boolean) {
  return renderToStaticMarkup(
    <NpcRadialMenu
      worker={worker}
      canRemove={canRemove}
      onRename={async () => null}
      onAvatar={noop}
      onPersona={noop}
      onRoom={noop}
      onRemove={noop}
      onClose={noop}
      direction="left"
    />,
  );
}

test("fans out one arc button per action, each with an icon and a label", () => {
  const worker = emptyWorker("w1", "小助手", null, false, 0, "claude", "/repo");
  const html = render(worker, true);
  assert.match(html, /npc-radial--left/);
  for (const label of ["重新命名", "個性 / 職務", "像素角色", "切換房間", "移除人員"]) {
    assert.match(html, new RegExp(`aria-label="${label}"`));
  }
  assert.doesNotMatch(html, /找 NPC 協作|部門 Mission/);
  const circles = html.match(/npc-radial__item/g) ?? [];
  assert.doesNotMatch(html, /交給部門/);
  assert.equal(html.match(/class="npc-radial__item[^"]*"/g)?.length, 5, `expected 5 arc buttons, markup had: ${circles.length}`);
  // Every button carries an inline SVG icon and its arc position.
  assert.equal(html.match(/<svg/g)?.length, 5);
  assert.match(html, /--tx:/);
  assert.match(html, /--ty:/);
});

test("hides the remove button when this is the only NPC, and re-spreads the arc", () => {
  const worker = emptyWorker("w1", "小助手", null, false, 0, "claude", "/repo");
  const html = render(worker, false);
  assert.doesNotMatch(html, /移除人員/);
  assert.equal(html.match(/class="npc-radial__item[^"]*"/g)?.length, 4);
});

test("a busy NPC still renders the plain ring — the remove confirm only appears after a click", () => {
  const busy = emptyWorker("w1", "小助手", null, true, 0, "claude", "/repo");
  const html = render(busy, true);
  assert.match(html, /移除人員/);
  assert.doesNotMatch(html, /確定移除/);
  assert.doesNotMatch(html, /npc-radial__panel/);
});

test("the arc starts collapsed so the CSS transition can fan it out after mount", () => {
  const worker = emptyWorker("w1", "小助手", null, false, 0, "claude", "/repo");
  const html = render(worker, true);
  // SSR markup is the pre-animation frame: container not yet --open.
  assert.match(html, /class="npc-radial npc-radial--left"/);
  assert.doesNotMatch(html, /npc-radial--open/);
});
