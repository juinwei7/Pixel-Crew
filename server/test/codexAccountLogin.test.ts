import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CodexAccountLoginTracker, type CodexAccountLoginState } from "../src/codexAccountLogin.js";

function fakeChild() {
  const child = new EventEmitter() as any;
  child.pid = 4242;
  child.exitCode = null;
  child.killed = false;
  child.stdin = { write: (data: string) => { child.stdinWritten = (child.stdinWritten ?? "") + data; }, end: () => { child.stdinEnded = true; } };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { child.killed = true; };
  return child;
}

function fakeTerminate(child: any) {
  child.kill();
}

// Real ensurePrivateDirectorySync would mkdir the fake test paths on the real
// filesystem (and fail outright on something like "/data/..."). Tests only
// care that start() got as far as spawning, so directory creation is a no-op here.
const noopEnsureDir = () => {};

test("start() marks the login running, pins CODEX_HOME to the account's directory, and reports a duplicate start as already running", () => {
  const spawnedEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
  const tracker = new CodexAccountLoginTracker(
    () => {}, (bin, args, options) => { spawnedEnvs.push(options.env); return fakeChild(); },
    undefined, undefined, undefined, noopEnsureDir,
  );

  const first = tracker.start("acct-1", "/data/codex-accounts/acct-1", "oauth");
  assert.equal(first.state.status, "running");
  assert.equal(first.alreadyRunning, false);
  assert.equal(spawnedEnvs[0]?.CODEX_HOME, "/data/codex-accounts/acct-1");

  const second = tracker.start("acct-1", "/data/codex-accounts/acct-1", "oauth");
  assert.equal(second.alreadyRunning, true);
  assert.equal(spawnedEnvs.length, 1);
});

test("ensureDir failing (e.g. permission denied) reports a clean failed state instead of throwing", () => {
  let finishedState: CodexAccountLoginState | null = null;
  const tracker = new CodexAccountLoginTracker(
    (state) => { finishedState = state; },
    () => fakeChild(),
    undefined, undefined, undefined,
    () => { throw new Error("EACCES: permission denied"); },
  );

  assert.doesNotThrow(() => {
    const { state } = tracker.start("acct-1", "/root/codex-home", "oauth");
    assert.equal(state.status, "failed");
  });
  assert.equal(finishedState?.status, "failed");
  assert.match(finishedState?.message ?? "", /EACCES/);
});

test("oauth mode parses codex's fallback login URL out of stderr and reports it via onUrlFound", () => {
  let child: any;
  let foundState: CodexAccountLoginState | null = null;
  const tracker = new CodexAccountLoginTracker(
    () => {},
    () => { child = fakeChild(); return child; },
    undefined,
    undefined,
    (state) => { foundState = state; },
    noopEnsureDir,
  );

  tracker.start("acct-1", "/data/codex-accounts/acct-1", "oauth");
  child.stderr.emit("data", Buffer.from(
    "Starting local login server on http://localhost:1455.\n" +
    "If your browser did not open, navigate to this URL to authenticate:\n\n" +
    "https://auth.openai.com/oauth/authorize?client_id=abc&state=xyz\n",
  ));

  assert.equal(foundState?.loginUrl, "https://auth.openai.com/oauth/authorize?client_id=abc&state=xyz");
  assert.equal(tracker.get("acct-1")?.loginUrl, "https://auth.openai.com/oauth/authorize?client_id=abc&state=xyz");
});

// Exact stderr captured from a real `codex login` run (codex-cli 0.148.0) —
// pins the real shape, not an idealized guess: the localhost callback-server
// line comes first and must be skipped in favor of the real auth.openai.com URL.
test("parses the real stderr shape a real codex login run produces", () => {
  let child: any;
  const tracker = new CodexAccountLoginTracker(
    () => {}, () => { child = fakeChild(); return child; },
    undefined, undefined, undefined, noopEnsureDir,
  );

  tracker.start("acct-1", "/data/codex-accounts/acct-1", "oauth");
  child.stderr.emit("data", Buffer.from(
    "Starting local login server on http://localhost:1455.\n" +
    "If your browser did not open, navigate to this URL to authenticate:\n\n" +
    "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid%20profile%20email%20offline_access%20api.connectors.read%20api.connectors.invoke&code_challenge=j-JdaqJWRyiUVeAM5uzuBJAC_kXmasv4A7yeDX45vDA&code_challenge_method=S256&id_token_add_organizations=true&codex_cli_simplified_flow=true&state=faXoZnNmk_9u42Beg5Zi5eT1vXTcOA4X7xVWA_AqcKs&originator=codex_cli_rs\n\n" +
    "On a remote or headless machine? Use `codex login --device-auth` instead.\n",
  ));

  assert.equal(
    tracker.get("acct-1")?.loginUrl,
    "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid%20profile%20email%20offline_access%20api.connectors.read%20api.connectors.invoke&code_challenge=j-JdaqJWRyiUVeAM5uzuBJAC_kXmasv4A7yeDX45vDA&code_challenge_method=S256&id_token_add_organizations=true&codex_cli_simplified_flow=true&state=faXoZnNmk_9u42Beg5Zi5eT1vXTcOA4X7xVWA_AqcKs&originator=codex_cli_rs",
  );
});

test("api-key mode never reports a login URL (there's no browser flow to fall back from)", () => {
  let child: any;
  let urlFoundCalls = 0;
  const tracker = new CodexAccountLoginTracker(
    () => {},
    () => { child = fakeChild(); return child; },
    undefined,
    undefined,
    () => { urlFoundCalls++; },
    noopEnsureDir,
  );

  tracker.start("acct-1", "/data/codex-accounts/acct-1", "api-key", "sk-test");
  child.stderr.emit("data", Buffer.from("https://auth.openai.com/oauth/authorize?client_id=abc\n"));

  assert.equal(urlFoundCalls, 0);
  assert.equal(tracker.get("acct-1")?.loginUrl, null);
});

test("api-key mode writes the key to stdin and ends it, without prompting a browser", () => {
  let child: any;
  const tracker = new CodexAccountLoginTracker(
    () => {}, () => { child = fakeChild(); return child; },
    undefined, undefined, undefined, noopEnsureDir,
  );

  tracker.start("acct-1", "/data/codex-accounts/acct-1", "api-key", "sk-test-123");
  assert.equal(child.stdinWritten, "sk-test-123");
  assert.equal(child.stdinEnded, true);
});

test("a successful CLI exit reports succeeded with the captured stdout", () => {
  let finishedState: CodexAccountLoginState | null = null;
  let child: any;
  const tracker = new CodexAccountLoginTracker(
    (state) => { finishedState = state; }, () => { child = fakeChild(); return child; },
    undefined, undefined, undefined, noopEnsureDir,
  );

  tracker.start("acct-1", "/data/codex-accounts/acct-1", "oauth");
  child.stdout.emit("data", Buffer.from("Login successful\n"));
  child.emit("close", 0);

  assert.equal(finishedState?.status, "succeeded");
  assert.match(finishedState?.message ?? "", /Login successful/);
  assert.equal(tracker.get("acct-1")?.status, "succeeded");
});

test("a non-zero exit reports failed with the stderr tail", () => {
  let finishedState: CodexAccountLoginState | null = null;
  let child: any;
  const tracker = new CodexAccountLoginTracker(
    (state) => { finishedState = state; }, () => { child = fakeChild(); return child; },
    undefined, undefined, undefined, noopEnsureDir,
  );

  tracker.start("acct-1", "/data/codex-accounts/acct-1", "oauth");
  child.stderr.emit("data", Buffer.from("no browser available\n"));
  child.emit("close", 1);

  assert.equal(finishedState?.status, "failed");
  assert.match(finishedState?.message ?? "", /no browser available/);
});

test("cancel() kills the in-flight login, reports cancelled, and ignores a late close event", () => {
  let finishedCount = 0;
  let lastState: CodexAccountLoginState | null = null;
  let child: any;
  const tracker = new CodexAccountLoginTracker(
    (state) => { finishedCount++; lastState = state; },
    () => { child = fakeChild(); return child; },
    5 * 60_000,
    fakeTerminate,
    undefined,
    noopEnsureDir,
  );

  tracker.start("acct-1", "/data/codex-accounts/acct-1", "oauth");
  assert.equal(tracker.cancel("acct-1"), true);
  assert.equal(child.killed, true);
  assert.equal(lastState?.status, "cancelled");

  child.emit("close", null);
  assert.equal(finishedCount, 1);
  assert.equal(tracker.get("acct-1")?.status, "cancelled");
});

test("cancel() on an unknown login is a no-op", () => {
  const tracker = new CodexAccountLoginTracker(() => {}, () => fakeChild());
  assert.equal(tracker.cancel("missing"), false);
});

test("the safety-net timeout kills a stuck login and reports timeout", async () => {
  let finishedState: CodexAccountLoginState | null = null;
  let child: any;
  const tracker = new CodexAccountLoginTracker(
    (state) => { finishedState = state; },
    () => { child = fakeChild(); return child; },
    10,
    fakeTerminate,
    undefined,
    noopEnsureDir,
  );

  tracker.start("acct-1", "/data/codex-accounts/acct-1", "oauth");
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(finishedState?.status, "timeout");
  assert.equal(child.killed, true);
});
