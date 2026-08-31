import assert from "node:assert/strict";
import test from "node:test";
import { configuredDefaultModels, FALLBACK_DEFAULT_MODELS } from "../src/defaultModels.js";

test("reads configured Claude and Codex default models without exposing other settings", () => {
  const models = configuredDefaultModels("/home/test", (path) => {
    if (path.endsWith(".codex/config.toml")) return 'model = "gpt-5.6-terra"\nservice_tier = "default"';
    if (path.endsWith(".claude/settings.json")) return JSON.stringify({ model: "sonnet", effortLevel: "high" });
    throw new Error("missing");
  });
  assert.deepEqual(models, { claude: "sonnet", codex: "gpt-5.6-terra" });
});

test("uses documented baselines when a local provider config does not exist", () => {
  assert.deepEqual(configuredDefaultModels("/empty", () => { throw new Error("missing"); }), FALLBACK_DEFAULT_MODELS);
});

test("reads Codex's config.toml from an explicit codexHome instead of ~/.codex, once Codex no longer necessarily lives there", () => {
  const models = configuredDefaultModels("/home/test", (path) => {
    if (path === "/data/codex-home/config.toml") return 'model = "gpt-5.6-terra"';
    if (path.endsWith(".codex/config.toml")) throw new Error("must not read the ambient path once codexHome is given");
    if (path.endsWith(".claude/settings.json")) return JSON.stringify({ model: "sonnet" });
    throw new Error("missing");
  }, "/data/codex-home");
  assert.deepEqual(models, { claude: "sonnet", codex: "gpt-5.6-terra" });
});
