import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MAX_TERMINAL_PASTE_FILES,
  TERMINAL_PASTE_TTL_MS,
  pruneTerminalPastes,
  stageTerminalPasteImages,
  terminalPathToken,
} from "../src/terminalPaste.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "pixel-crew-paste-"));
}

test("a plain path is typed bare, and only awkward ones get quoted", () => {
  // Verified against the real CLIs: an unquoted path with a space is left as
  // text by both composers instead of becoming an image attachment.
  assert.equal(terminalPathToken("/home/a/data/paste-1.png", "linux"), "/home/a/data/paste-1.png");
  assert.equal(terminalPathToken("/Users/a/data info/paste-1.png", "darwin"), '"/Users/a/data info/paste-1.png"');
  assert.equal(terminalPathToken("/Users/a/it's/paste-1.png", "darwin"), `"/Users/a/it's/paste-1.png"`);
  assert.equal(terminalPathToken("/Users/a/$HOME x/p.png", "darwin"), '"/Users/a/\\$HOME x/p.png"');
});

test("Windows paths keep their separators instead of being escaped away", () => {
  assert.equal(terminalPathToken("C:\\Users\\a\\AppData\\paste-1.png", "win32"), "C:\\Users\\a\\AppData\\paste-1.png");
  assert.equal(terminalPathToken("C:\\Users\\a b\\paste-1.png", "win32"), '"C:\\Users\\a b\\paste-1.png"');
});

test("a path that could inject terminal control codes is refused", () => {
  assert.throws(() => terminalPathToken("/tmp/evil\r\npaste.png", "darwin"), /control characters/);
  assert.throws(() => terminalPathToken("/tmp/evil\u0003.png", "darwin"), /control characters/);
});

test("staged images land as private files the CLI can read back", () => {
  const directory = join(scratch(), "terminal-pastes");
  try {
    const paths = stageTerminalPasteImages([
      { name: "a.png", mimeType: "image/png", dataBase64: PNG.toString("base64") },
      { name: "b.jpg", mimeType: "image/jpeg", dataBase64: PNG.toString("base64") },
    ], directory);

    assert.equal(paths.length, 2);
    assert.match(paths[0], /paste-[0-9a-f-]+\.png$/);
    assert.match(paths[1], /paste-[0-9a-f-]+\.jpg$/);
    for (const path of paths) assert.ok(readFileSync(path).equals(PNG));
    // The generated name never needs quoting, so only the data directory can.
    for (const path of paths) assert.ok(!/[ "']/.test(path.split(/[\\/]/).pop() ?? ""));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("staging nothing touches nothing", () => {
  const directory = join(scratch(), "terminal-pastes");
  assert.deepEqual(stageTerminalPasteImages([], directory), []);
  assert.equal(existsSync(directory), false);
});

test("stale pastes are swept by age and by count, newest kept", () => {
  const directory = join(scratch(), "terminal-pastes");
  mkdirSync(directory, { recursive: true });
  const now = Date.UTC(2026, 8, 22);
  const write = (name: string, ageMs: number) => {
    const path = join(directory, name);
    writeFileSync(path, PNG);
    const seconds = (now - ageMs) / 1000;
    utimesSync(path, seconds, seconds);
    return path;
  };
  try {
    const fresh = write("paste-fresh.png", 60_000);
    const stale = write("paste-stale.png", TERMINAL_PASTE_TTL_MS + 60_000);
    const unrelated = write("notes.txt", TERMINAL_PASTE_TTL_MS + 60_000);
    // Everything beyond the newest MAX_TERMINAL_PASTE_FILES goes too, even
    // when it is still inside the TTL.
    const crowd = Array.from({ length: MAX_TERMINAL_PASTE_FILES + 5 }, (_, index) =>
      write(`paste-crowd-${index}.png`, 120_000 + index * 1_000));

    pruneTerminalPastes(directory, now);

    assert.ok(existsSync(fresh), "the newest paste survives");
    assert.equal(existsSync(stale), false, "an expired paste is removed");
    assert.ok(existsSync(unrelated), "unrelated files are left alone");
    assert.equal(existsSync(crowd.at(-1) as string), false, "the oldest of a crowd is removed");
    assert.equal(readdirSync(directory).filter((name) => name.startsWith("paste-")).length, MAX_TERMINAL_PASTE_FILES);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pruning a directory that does not exist is a no-op", () => {
  assert.doesNotThrow(() => pruneTerminalPastes(join(tmpdir(), "pixel-crew-missing-paste-dir")));
});
