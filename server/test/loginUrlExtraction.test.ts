import assert from "node:assert/strict";
import test from "node:test";
import { extractLoginUrl } from "../src/loginUrlExtraction.js";

// Exact stderr captured from a real `codex login` run (codex-cli 0.148.0) —
// the localhost callback-server line comes first and must be skipped in
// favor of the real auth.openai.com URL.
test("codex's plain-text shape: skips the localhost callback URL, picks the real one", () => {
  const text =
    "Starting local login server on http://localhost:1455.\n" +
    "If your browser did not open, navigate to this URL to authenticate:\n\n" +
    "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid%20profile%20email%20offline_access%20api.connectors.read%20api.connectors.invoke&code_challenge=j-JdaqJWRyiUVeAM5uzuBJAC_kXmasv4A7yeDX45vDA&code_challenge_method=S256&id_token_add_organizations=true&codex_cli_simplified_flow=true&state=faXoZnNmk_9u42Beg5Zi5eT1vXTcOA4X7xVWA_AqcKs&originator=codex_cli_rs\n\n" +
    "On a remote or headless machine? Use `codex login --device-auth` instead.\n";
  assert.equal(
    extractLoginUrl(text),
    "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid%20profile%20email%20offline_access%20api.connectors.read%20api.connectors.invoke&code_challenge=j-JdaqJWRyiUVeAM5uzuBJAC_kXmasv4A7yeDX45vDA&code_challenge_method=S256&id_token_add_organizations=true&codex_cli_simplified_flow=true&state=faXoZnNmk_9u42Beg5Zi5eT1vXTcOA4X7xVWA_AqcKs&originator=codex_cli_rs",
  );
});

test("plain-text shape: a single URL with trailing sentence punctuation is trimmed", () => {
  assert.equal(extractLoginUrl("visit https://example.com/auth?x=1."), "https://example.com/auth?x=1");
});

// Exact bytes captured from a real `claude auth login` run (Claude Code
// 2.1.206) -- the URL is wrapped in an OSC 8 terminal hyperlink (ESC ] 8 ; ;
// URL BEL label ESC ] 8 ; ; BEL) with the label being the same URL text
// repeated. A naive \S+ match would glue both copies together since no
// whitespace separates them (only the BEL control byte does).
test("claude's OSC-8-wrapped shape: extracts the target URL, not the label + escape junk", () => {
  const url = "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&state=Hpkus7CuljjBv-0ROjg6CX8cswYhezLnaR9DZh8rPIk";
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const text =
    "Opening browser to sign in\n" +
    "If the browser didn't open, visit: " + ESC + "]8;;" + url + BEL + url + ESC + "]8;;" + BEL + "\n" +
    "Paste code here if prompted > ";
  assert.equal(extractLoginUrl(text), url);
});

test("returns null when there's nothing to extract", () => {
  assert.equal(extractLoginUrl("no url here at all"), null);
});
