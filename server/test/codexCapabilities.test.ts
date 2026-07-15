import assert from "node:assert/strict";
import test from "node:test";
import { parseCodexMcpList, parseCodexModels } from "../src/codexCapabilities.js";

test("parses Codex MCP configuration without exposing transport secrets", () => {
  assert.deepEqual(
    parseCodexMcpList(JSON.stringify([
      { name: "docs", enabled: true, transport: { type: "stdio", env: { TOKEN: "secret" } } },
      { name: "browser", enabled: false, transport: { type: "stdio" } },
    ])),
    [
      { name: "docs", status: "enabled" },
      { name: "browser", status: "disabled" },
    ],
  );
});

test("keeps visible Codex models in catalog priority order", () => {
  assert.deepEqual(
    parseCodexModels(JSON.stringify({ models: [
      { slug: "hidden", display_name: "Hidden", visibility: "hide", priority: 0 },
      { slug: "fast", display_name: "Fast", visibility: "list", priority: 2 },
      { slug: "smart", display_name: "Smart", visibility: "list", priority: 1 },
    ] })),
    [
      { id: "smart", label: "Smart", description: undefined },
      { id: "fast", label: "Fast", description: undefined },
    ],
  );
});
