import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// @ts-expect-error The release packager is intentionally plain JavaScript.
import { readPeMachine } from "../../scripts/windows/package-app.mjs";

const startScript = fileURLToPath(new URL("../../scripts/windows/start-pixel-crew.ps1", import.meta.url));

function peHeader(machine: number): Buffer {
  const buffer = Buffer.alloc(128);
  buffer.write("MZ", 0, "ascii");
  buffer.writeUInt32LE(64, 0x3c);
  buffer.write("PE\0\0", 64, "binary");
  buffer.writeUInt16LE(machine, 68);
  return buffer;
}

test("Windows packager accepts only a structurally valid PE machine header", () => {
  assert.equal(readPeMachine(peHeader(0x8664)), 0x8664);
  assert.equal(readPeMachine(peHeader(0xaa64)), 0xaa64);
  assert.throws(() => readPeMachine(Buffer.from("not a PE file")), /valid PE executable/);

  const invalidSignature = peHeader(0x8664);
  invalidSignature.write("NOPE", 64, "ascii");
  assert.throws(() => readPeMachine(invalidSignature), /invalid PE header/);
});

test("Windows launcher prefers the bundled runtime and exposes it on PATH", () => {
  const source = readFileSync(startScript, "utf8");
  assert.match(source, /runtime["\\]/i);
  assert.match(source, /Test-Path \$BundledNode/);
  assert.match(source, /\$env:Path = "\$BundledRuntime;\$env:Path"/);
  assert.match(source, /Start-Process -FilePath \$NodeExe/);
});
