import assert from "node:assert/strict";
import test from "node:test";
import { isChunkLoadError } from "../src/components/ErrorBoundary";

// isChunkLoadError is the one piece of boundary logic that is environment-free
// and therefore unit-testable here (React error-boundary *catching* only runs
// in the browser client, which this repo's server-render test harness can't
// exercise). Getting this classifier right is what decides whether the boundary
// auto-reloads a stale chunk or shows its recovery card, so it is worth pinning.

// The whole reason the boundary exists: after an in-place update, an open tab
// clicks a lazy modal whose hashed chunk no longer exists. Different browsers
// phrase that failure differently — the detector must recognize all of them so
// the boundary can auto-reload instead of leaving a black screen.
test("recognizes dynamic-import chunk failures across browser phrasings", () => {
  const messages = [
    "Failed to fetch dynamically imported module: https://x/assets/OutboxModal-abc.js",
    "error loading dynamically imported module",
    "Importing a module script failed.",
    "Loading chunk 42 failed.",
    "Loading CSS chunk 7 failed.",
  ];
  for (const message of messages) {
    assert.equal(isChunkLoadError(new Error(message)), true, message);
  }
});

test("recognizes a ChunkLoadError by name even with an empty message", () => {
  const error = new Error("");
  error.name = "ChunkLoadError";
  assert.equal(isChunkLoadError(error), true);
});

test("does not misclassify ordinary runtime errors as chunk failures", () => {
  assert.equal(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'map')")), false);
  assert.equal(isChunkLoadError(new Error("Request failed with status 500")), false);
});

test("is null/undefined safe", () => {
  assert.equal(isChunkLoadError(null), false);
  assert.equal(isChunkLoadError(undefined), false);
  assert.equal(isChunkLoadError("just a string"), false);
});
