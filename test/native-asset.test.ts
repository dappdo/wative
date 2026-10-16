/**
 * A CUSTOM network must materialize its native coin as a displayed asset.
 *
 * Built-in networks get their native coin from the library's asset registry, but
 * a user-added network used to get NOTHING — `ws.assets(slug)` was empty — so a
 * consumer's balance grid showed no native-currency column and read no native
 * balance (the column and the read are both driven by that catalogue). This pins:
 *
 *  1. `addNetwork` materializes the native coin on creation (EVM and SVM).
 *  2. The native coin's NAME falls back to the SYMBOL when none is supplied.
 *  3. The materialized asset is `native`, displayed, null-contract, id >= 1000.
 *  4. `catalogueFor` (the grid's source) surfaces it once the network is default.
 *  5. Built-in networks are untouched — no duplicate native, their own intact.
 *  6. An EXISTING native-less custom network self-heals on the next unlock
 *     (the migration half), without duplicating when it already has one.
 *
 * Pure/offline — no RPC; it only inspects the catalogue the grid reads.
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createWorkspace,
  createAccount,
  addNetwork,
  dropNetwork,
  setAccountDefaultNetwork,
  catalogueFor,
  networkTokensDetail,
  networksDetail,
  removeTokenById,
  unlockWorkspace,
  lock,
  workspaceNetworkChoices,
} from "../src/core/session.js";

const PW = "Zq7vX9wKm2pLd4Rt-Aa3Bb5Cc";
const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

let dir: string;
let acct: string;

function slugFor(name: string): string {
  const row = workspaceNetworkChoices().find((n) => n.name === name);
  assert.ok(row, `network "${name}" must exist after addNetwork`);
  return row!.slug;
}

before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "wative-native-asset-"));
  await createWorkspace(dir, PW);
  acct = await createAccount("Main", PW, MNEMONIC, "ethereum");
});

after(() => {
  try {
    lock();
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
});

test("addNetwork materializes an EVM custom network's native coin (name falls back to symbol)", async () => {
  const add = await addNetwork({
    name: "Zephyr Testnet",
    chainId: 987654,
    rpcUrl: "https://example.invalid/rpc",
    vm: "evm",
    currencySymbol: "ZPH",
    currencyDecimals: 18,
    // currencyName deliberately omitted — the symbol must stand in for the name.
  });
  assert.equal(add.ok, true, `addNetwork must succeed: ${add.ok ? "" : add.reason}`);

  const tokens = (await networkTokensDetail(slugFor("Zephyr Testnet"))) ?? [];
  assert.equal(tokens.length, 1, "a fresh custom network must carry exactly its native coin");
  const native = tokens[0]!;
  assert.equal(native.native, true, "the materialized asset must be the native coin");
  assert.equal(native.symbol, "ZPH");
  assert.equal(native.name, "ZPH", "the name must fall back to the symbol");
  assert.equal(native.contract, null, "the native coin has no contract");
  assert.equal(native.decimals, 18);
  assert.ok(native.id >= 1000, `a user asset id is >= 1000 (got ${native.id})`);
});

test("catalogueFor surfaces the custom network's native coin once it is the default", async () => {
  const slug = slugFor("Zephyr Testnet");
  const sw = await setAccountDefaultNetwork(acct, slug);
  assert.equal(sw.ok, true, `switch default must succeed: ${sw.ok ? "" : sw.reason}`);

  const catalogue = await catalogueFor(acct);
  assert.equal(catalogue.length, 1, "the grid catalogue must show the native column");
  assert.equal(catalogue[0]!.native, true, "the single catalogue column is the native coin");
  assert.equal(catalogue[0]!.symbol, "ZPH");

  // Restore the default so later tests start from a clean, known network.
  await setAccountDefaultNetwork(acct, "ethereum");
});

test("addNetwork materializes an SVM custom network's native coin too", async () => {
  const add = await addNetwork({
    name: "Zephyr Solana",
    chainId: 1234567,
    rpcUrl: "https://example.invalid/svm",
    vm: "svm",
    currencySymbol: "ZSOL",
    currencyName: "Zephyr SOL",
    currencyDecimals: 9,
  });
  assert.equal(add.ok, true, `addNetwork(svm) must succeed: ${add.ok ? "" : add.reason}`);

  const tokens = (await networkTokensDetail(slugFor("Zephyr Solana"))) ?? [];
  const native = tokens.find((t) => t.native);
  assert.ok(native, "the SVM custom network must carry its native coin");
  assert.equal(native!.symbol, "ZSOL");
  assert.equal(native!.name, "Zephyr SOL", "an explicit name is kept verbatim");
  assert.equal(native!.decimals, 9);
});

test("built-in networks are untouched — native intact, no duplicate", async () => {
  const eth = (await networkTokensDetail("ethereum")) ?? [];
  const natives = eth.filter((t) => t.native);
  assert.equal(natives.length, 1, "ethereum must have exactly one native coin, not a duplicate");
  assert.equal(natives[0]!.symbol, "ETH");
  assert.ok(eth.length >= 2, "ethereum must still carry its built-in tokens");
});

test("dropNetwork removes a custom network even though it now carries a native asset", async () => {
  // 🚨 The library refuses to drop a network that still has assets ("Drop the
  // asset first"). Since `addNetwork` now materializes the native coin, every
  // custom network has one — so dropNetwork must clear the assets first or every
  // custom-network removal breaks. This pins that fix.
  const add = await addNetwork({
    name: "Droppable Net",
    chainId: 424242,
    rpcUrl: "https://example.invalid/rpc",
    vm: "evm",
    currencySymbol: "DRP",
    currencyDecimals: 18,
  });
  assert.equal(add.ok, true, `addNetwork must succeed: ${add.ok ? "" : add.reason}`);
  const slug = slugFor("Droppable Net");
  // It carries exactly its native coin (the precondition the old drop choked on).
  assert.equal(((await networkTokensDetail(slug)) ?? []).filter((t) => t.native).length, 1, "the custom network must carry its native coin");

  const dropped = await dropNetwork(slug);
  assert.equal(dropped.ok, true, `dropNetwork must succeed despite the native asset: ${dropped.ok ? "" : dropped.reason}`);
  assert.ok(!(networksDetail() ?? []).some((n) => n.slug === slug), "the custom network must be gone");
});

test("an existing native-less custom network self-heals on unlock (and does not duplicate)", async () => {
  const slug = slugFor("Zephyr Testnet");

  // Simulate a network added by an OLDER build: drop its native coin so the
  // catalogue is empty, exactly the pre-fix state.
  const before = (await networkTokensDetail(slug)) ?? [];
  const nativeId = before.find((t) => t.native)!.id;
  const removed = await removeTokenById(nativeId);
  assert.equal(removed.ok, true, `drop native must succeed to set up the broken state: ${removed.ok ? "" : removed.reason}`);
  assert.equal(((await networkTokensDetail(slug)) ?? []).filter((t) => t.native).length, 0, "the network must now be native-less");

  // Lock + unlock: the reconcile pass must back-fill the missing native coin.
  lock();
  const un = await unlockWorkspace(PW);
  assert.equal(un.ok, true, `unlock must succeed: ${un.ok ? "" : un.reason}`);

  const healed = (await networkTokensDetail(slug)) ?? [];
  const natives = healed.filter((t) => t.native);
  assert.equal(natives.length, 1, "unlock must restore exactly one native coin (no duplicate)");
  assert.equal(natives[0]!.symbol, "ZPH");

  // Idempotent: a second unlock must NOT add another native coin.
  lock();
  await unlockWorkspace(PW);
  assert.equal(((await networkTokensDetail(slug)) ?? []).filter((t) => t.native).length, 1, "a second unlock must not duplicate the native coin");
});
