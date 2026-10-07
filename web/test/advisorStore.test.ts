import assert from "node:assert/strict";
import test from "node:test";
import { clearAdvisorErrors, getActiveAdvisorWorkspace, getAdvisorEntry, releaseAdvisorPin, resumeAdvisorRuns, runAdvisor, setAdvisorIdea, subscribeAdvisor } from "../src/advisorStore";

// Drive apiRequest (which calls global.fetch) into a chosen outcome, run the
// body, then restore fetch. "reject" reproduces a connection blip (fetch throws
// a TypeError → ApiRequestError "無法連線到 Pixel Crew Server…"); "server500" is a
// genuine backend failure; "ok" returns proposals.
async function withFetch(kind: "reject" | "server500" | "ok", body: () => Promise<void> | void): Promise<void> {
  const original = globalThis.fetch;
  if (kind === "reject") globalThis.fetch = (() => Promise.reject(new TypeError("network down"))) as typeof fetch;
  else if (kind === "server500") globalThis.fetch = (() => Promise.resolve({ ok: false, status: 500, json: async () => ({ error: "advisor exploded" }) })) as unknown as typeof fetch;
  else globalThis.fetch = (() => Promise.resolve({ ok: true, status: 200, json: async () => ({ result: { status: "ok", proposals: [{ id: "p1" }], domain: "d" } }) })) as unknown as typeof fetch;
  try { await body(); } finally { globalThis.fetch = original; }
}

// The whole point of the module-level store is that advisor state outlives
// BossTaskDesk unmounting when the owner switches NPCs. These lock the sync
// semantics useSyncExternalStore relies on and the per-workspace isolation.

test("an idea written for a workspace is still there on a later read (survives remount)", () => {
  const ws = "/repo/advisor-persist";
  setAdvisorIdea(ws, "AI 量化交易");
  // A fresh getAdvisorEntry — as a remounted component would call — sees the value.
  assert.equal(getAdvisorEntry(ws).idea, "AI 量化交易");
});

test("getAdvisorEntry returns a stable reference while unchanged (getSnapshot contract)", () => {
  const ws = "/repo/advisor-stable";
  setAdvisorIdea(ws, "seed");
  const first = getAdvisorEntry(ws);
  const second = getAdvisorEntry(ws);
  // Same object identity → useSyncExternalStore will not loop re-rendering.
  assert.equal(first, second);
});

test("workspaces keep independent advisor state", () => {
  const a = "/repo/advisor-a";
  const b = "/repo/advisor-b";
  setAdvisorIdea(a, "idea-a");
  setAdvisorIdea(b, "idea-b");
  assert.equal(getAdvisorEntry(a).idea, "idea-a");
  assert.equal(getAdvisorEntry(b).idea, "idea-b");
});

test("an unknown workspace reads a safe empty default", () => {
  const entry = getAdvisorEntry("/repo/never-touched");
  assert.equal(entry.idea, "");
  assert.equal(entry.loading, false);
  assert.deepEqual(entry.proposals, []);
});

test("a connection blip keeps resume params so a reconnect can retry; a real server error drops them", async () => {
  const blip = "/repo/advisor-blip";
  await withFetch("reject", () => runAdvisor(blip, { proactive: true }));
  // The scary banner is set, but the run is marked resumable (params retained).
  assert.match(getAdvisorEntry(blip).error ?? "", /Pixel Crew Server/);
  assert.deepEqual(getAdvisorEntry(blip).resume, { proactive: true, provider: undefined, model: undefined });

  const broken = "/repo/advisor-server-error";
  await withFetch("server500", () => runAdvisor(broken, { proactive: true }));
  // A genuine backend failure must NOT be auto-retried on every reconnect.
  assert.equal(getAdvisorEntry(broken).error, "advisor exploded");
  assert.equal(getAdvisorEntry(broken).resume, null);
});

test("clearAdvisorErrors drops the stale banner but leaves resume armed", async () => {
  const ws = "/repo/advisor-clear";
  await withFetch("reject", () => runAdvisor(ws, { proactive: true }));
  assert.ok(getAdvisorEntry(ws).error);
  clearAdvisorErrors();
  // Banner gone, but the interrupted run can still be resumed.
  assert.equal(getAdvisorEntry(ws).error, null);
  assert.deepEqual(getAdvisorEntry(ws).resume, { proactive: true, provider: undefined, model: undefined });
});

test("resumeAdvisorRuns re-runs an interrupted run and a success clears resume (no loop)", async () => {
  const ws = "/repo/advisor-resume";
  await withFetch("reject", () => runAdvisor(ws, { proactive: true }));
  assert.ok(getAdvisorEntry(ws).resume, "armed after the blip");

  await withFetch("ok", async () => {
    resumeAdvisorRuns();
    // runAdvisor flips loading synchronously before its first await.
    assert.equal(getAdvisorEntry(ws).loading, true, "resume actually kicked off a run");
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const entry = getAdvisorEntry(ws);
  assert.deepEqual(entry.proposals, [{ id: "p1" }]);
  assert.equal(entry.error, null);
  assert.equal(entry.resume, null, "resume cleared on success so it can't loop");
  assert.equal(entry.loading, false);
});

// The pin is what fixes "generation vanished after switching to another workspace":
// the Boss Desk reads the pinned workspace's advisor, not blindly the active one.

test("a run pins its workspace as soon as it starts loading (before it resolves)", async () => {
  const ws = "/repo/pin-loading";
  await withFetch("ok", async () => {
    const running = runAdvisor(ws, { proactive: true });
    // runAdvisor flips loading + pins synchronously before its first await.
    assert.equal(getActiveAdvisorWorkspace(), ws, "pinned the moment the run kicks off");
    await running;
  });
  // A completed run with proposals stays pinned so switching NPCs still shows it.
  assert.equal(getActiveAdvisorWorkspace(), ws);
});

test("a newer run in another workspace takes over the pin", async () => {
  const first = "/repo/pin-first";
  const second = "/repo/pin-second";
  await withFetch("ok", () => runAdvisor(first, { proactive: true }));
  await withFetch("ok", () => runAdvisor(second, { proactive: true }));
  assert.equal(getActiveAdvisorWorkspace(), second, "most recent generation wins the pin");
});

test("plain releaseAdvisorPin unpins but keeps the generated result", async () => {
  const ws = "/repo/pin-release";
  await withFetch("ok", () => runAdvisor(ws, { proactive: true }));
  assert.equal(getActiveAdvisorWorkspace(), ws);
  releaseAdvisorPin(ws);
  assert.equal(getActiveAdvisorWorkspace(), null, "no longer pinned → Boss Desk falls back to active workspace");
  assert.deepEqual(getAdvisorEntry(ws).proposals, [{ id: "p1" }], "returning to that workspace still shows what was generated");
});

test("releaseAdvisorPin with clearEntry (dismiss) unpins AND wipes the stale result", async () => {
  const ws = "/repo/pin-clear";
  await withFetch("ok", () => runAdvisor(ws, { proactive: true }));
  releaseAdvisorPin(ws, true);
  assert.equal(getActiveAdvisorWorkspace(), null);
  assert.deepEqual(getAdvisorEntry(ws).proposals, [], "dismiss clears the proposals");
  assert.equal(getAdvisorEntry(ws).idea, "");
});

test("releasing a workspace that is not the pinned one leaves the pin intact", async () => {
  const pinned = "/repo/pin-keep";
  const other = "/repo/pin-other";
  await withFetch("ok", () => runAdvisor(pinned, { proactive: true }));
  releaseAdvisorPin(other);
  assert.equal(getActiveAdvisorWorkspace(), pinned, "releasing a different workspace must not steal the pin");
});

test("writing an idea alone does not pin a workspace (only a run does)", () => {
  const ws = "/repo/pin-idea-only";
  setAdvisorIdea(ws, "just typing, never generated");
  assert.notEqual(getActiveAdvisorWorkspace(), ws, "typing must not hijack the Boss Desk to this workspace");
});

test("subscribers are notified on change and stop after unsubscribe", () => {
  const ws = "/repo/advisor-notify";
  let hits = 0;
  const unsubscribe = subscribeAdvisor(() => { hits += 1; });
  setAdvisorIdea(ws, "one");
  assert.equal(hits, 1);
  unsubscribe();
  setAdvisorIdea(ws, "two");
  assert.equal(hits, 1);
});
