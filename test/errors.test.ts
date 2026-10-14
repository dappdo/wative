/**
 * The error/redaction helpers (wative/errors). `scrubUrls` is new (strips RPC
 * endpoints — which carry a hosted provider's API key — out of the free-prose
 * result fields `readError`/`sim.error`/`warnings`). `safeMessage`/`errorCode`
 * had no direct test despite being the redaction allowlist.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { scrubUrls, safeMessage, errorCode } from "../src/core/errors.js";

test("scrubUrls collapses RPC URLs (which carry hosted-provider API keys), keeps the rest", () => {
  assert.equal(
    scrubUrls("RPC HTTP 500 from https://eth-mainnet.g.alchemy.com/v2/SUPERSECRETKEY"),
    "RPC HTTP 500 from <rpc-url>",
    "the whole URL (key included) is replaced",
  );
  assert.equal(scrubUrls("unreachable: http://localhost:8545/ timed out"), "unreachable: <rpc-url> timed out");
  assert.equal(scrubUrls("no url here"), "no url here", "text without a URL is untouched");
});

test("safeMessage never derives from the throw; a raw Error collapses to the generic line", () => {
  assert.equal(
    safeMessage(new Error("secret https://host/KEY leaked in the message")),
    safeMessage(new Error("something else entirely")),
    "two raw Errors map to the SAME generic line — the thrown text never leaks",
  );
  assert.equal(errorCode(new Error("x")), undefined, "a plain Error carries no wative code");
});
