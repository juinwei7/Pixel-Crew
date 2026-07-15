import assert from "node:assert/strict";
import test from "node:test";
import { apiRequest, ApiRequestError } from "../src/api";

test("normalizes server and offline API failures", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "worker busy" }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    });
    await assert.rejects(() => apiRequest("/test"), (error: unknown) => (
      error instanceof ApiRequestError && error.status === 409 && error.message === "worker busy"
    ));

    globalThis.fetch = async () => { throw new Error("offline"); };
    await assert.rejects(() => apiRequest("/test"), /無法連線到 Pixel Crew Server/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("serializes JSON request bodies", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let requestBody = "";
    globalThis.fetch = async (_input, init) => {
      requestBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    };
    await apiRequest("/test", { method: "POST", body: { hello: "crew" } });
    assert.equal(requestBody, JSON.stringify({ hello: "crew" }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
