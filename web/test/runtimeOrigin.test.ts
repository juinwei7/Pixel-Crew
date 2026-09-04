import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runtimeHttpOrigin, runtimeWsOrigin } from "../src/runtimeOrigin";

describe("runtime origins", () => {
  it("uses explicit backend overrides during development", () => {
    const env = { DEV: true, VITE_SERVER_URL: " http://localhost:8787 ", VITE_WS_URL: " ws://localhost:8787 " };
    assert.equal(runtimeHttpOrigin("http://localhost:5173", env), "http://localhost:8787");
    assert.equal(runtimeWsOrigin("http://localhost:5173", env), "ws://localhost:8787");
  });

  it("always follows the served page origin in production", () => {
    const env = { DEV: false, VITE_SERVER_URL: "http://localhost:8787", VITE_WS_URL: "ws://localhost:8787" };
    assert.equal(runtimeHttpOrigin("https://pixel-crew.example", env), "https://pixel-crew.example");
    assert.equal(runtimeWsOrigin("https://pixel-crew.example", env), "wss://pixel-crew.example");
  });
});
