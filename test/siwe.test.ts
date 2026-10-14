/**
 * `buildSiweMessage` builds the canonical EIP-4361 "Sign-In with Ethereum"
 * message body. Its exact byte layout is what a consumer shows as "what you are
 * signing", so this pins it byte-for-byte — including the two-blank-line case
 * when there is no statement (an EIP-4361 detail that is easy to get wrong) and
 * verbatim interpolation of non-ASCII fields (the builder does not normalize).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSiweMessage } from "../src/core/siwe.js";

const ADDR = "0x1111111111111111111111111111111111111111";
const BASE = {
  domain: "example.com",
  address: ADDR,
  uri: "https://example.com/login",
  version: "1",
  chainId: 1,
  nonce: "abcd1234efgh",
  issuedAt: "2024-01-01T00:00:00.000Z",
} as const;

test("buildSiweMessage: with a statement, byte-for-byte EIP-4361", () => {
  const message = buildSiweMessage({ ...BASE, statement: "I accept the Example Terms of Service." });
  assert.equal(
    message,
    [
      "example.com wants you to sign in with your Ethereum account:",
      ADDR,
      "",
      "I accept the Example Terms of Service.",
      "",
      "URI: https://example.com/login",
      "Version: 1",
      "Chain ID: 1",
      "Nonce: abcd1234efgh",
      "Issued At: 2024-01-01T00:00:00.000Z",
    ].join("\n"),
  );
});

test("buildSiweMessage: without a statement keeps the EIP-4361 double blank line", () => {
  const message = buildSiweMessage(BASE);
  assert.equal(
    message,
    [
      "example.com wants you to sign in with your Ethereum account:",
      ADDR,
      "",
      "",
      "URI: https://example.com/login",
      "Version: 1",
      "Chain ID: 1",
      "Nonce: abcd1234efgh",
      "Issued At: 2024-01-01T00:00:00.000Z",
    ].join("\n"),
  );
});

test("buildSiweMessage: an empty statement is treated as no statement", () => {
  assert.equal(buildSiweMessage({ ...BASE, statement: "" }), buildSiweMessage(BASE));
});

test("buildSiweMessage: non-ASCII fields are interpolated verbatim (no normalization)", () => {
  const statement = "Je confirme : naïve café — 日本語 — ①②③.";
  const message = buildSiweMessage({ ...BASE, domain: "ехample.com", statement });
  assert.ok(message.startsWith("ехample.com wants you to sign in"), "the IDN domain is carried verbatim");
  assert.ok(message.includes(`\n${statement}\n`), "the unicode statement is carried verbatim");
});
