/**
 * The pure input-shape validators (wative/browser/validators), lifted out of
 * session in the kernel-extraction commit "to be independently testable" — this
 * pins that behavior directly (it previously had no behavioral test).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { isHexData, isTokenAddressForVm, tokenAddressHint } from "../src/core/validators.js";

test("isHexData: 0x + an even number of hex digits", () => {
  assert.equal(isHexData("0x"), true, "0x alone = no data");
  assert.equal(isHexData("0xa9059cbb"), true);
  assert.equal(isHexData("0xA9"), true, "uppercase hex ok");
  assert.equal(isHexData("0xabc"), false, "odd number of digits");
  assert.equal(isHexData("a9059cbb"), false, "missing 0x prefix");
  assert.equal(isHexData("0xzz"), false, "non-hex digits");
  assert.equal(isHexData(""), false);
});

test("isTokenAddressForVm: EVM is 0x+40 hex; SVM is base58, 32-44 chars", () => {
  const evm = "0x" + "a".repeat(40);
  assert.equal(isTokenAddressForVm("evm", evm), true);
  assert.equal(isTokenAddressForVm("evm", `  ${evm}  `), true, "trims surrounding whitespace");
  assert.equal(isTokenAddressForVm("evm", "0x" + "a".repeat(39)), false, "39 hex is too short");
  assert.equal(isTokenAddressForVm("evm", "0x" + "g".repeat(40)), false, "non-hex");
  assert.equal(isTokenAddressForVm("svm", "A".repeat(43)), true, "43-char base58 is in range");
  assert.equal(isTokenAddressForVm("svm", "A".repeat(32)), true, "32 is the lower bound");
  assert.equal(isTokenAddressForVm("svm", "A".repeat(31)), false, "31 is too short");
  assert.equal(isTokenAddressForVm("svm", "A".repeat(45)), false, "45 is too long");
  assert.equal(isTokenAddressForVm("svm", "0".repeat(40)), false, "base58 excludes 0/O/I/l");
});

test("tokenAddressHint matches the vm's address shape", () => {
  assert.match(tokenAddressHint("evm"), /0x/);
  assert.match(tokenAddressHint("svm"), /base58/i);
});
