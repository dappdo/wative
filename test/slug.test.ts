/**
 * The pure network-slug derivation (wative/browser/slug), lifted out of session
 * in the kernel-extraction commit. Pins the normalization and — the sharp edge —
 * `finalizeNetworkSlug`'s 4-char floor (a short base is extended with the chain
 * id to clear wative-core's measured slug minimum). Previously untested.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveNetworkSlug, finalizeNetworkSlug } from "../src/core/slug.js";

test("deriveNetworkSlug lowercases, collapses non-alnum runs to '-', trims", () => {
  assert.equal(deriveNetworkSlug("Base"), "base");
  assert.equal(deriveNetworkSlug("  My Net!! "), "my-net");
  assert.equal(deriveNetworkSlug("A__B--C"), "a-b-c");
  assert.equal(deriveNetworkSlug("---x---"), "x", "leading/trailing dashes trimmed");
});

test("finalizeNetworkSlug keeps a >=4-char base, appends chainId below the floor", () => {
  assert.equal(finalizeNetworkSlug("Base", 8453), "base", ">=4 kept verbatim");
  assert.equal(finalizeNetworkSlug("abcd", 1), "abcd", "exactly 4 kept (floor boundary)");
  assert.equal(finalizeNetworkSlug("OPx", 10), "opx-10", "3-char base -> append chainId");
  assert.equal(finalizeNetworkSlug("ab", 5), "ab-5", "2-char base -> append chainId");
});
