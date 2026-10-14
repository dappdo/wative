/**
 * `selectableNetworks(slug)` — the networks a default-network PICKER should offer:
 * every workspace network whose VM the account has an address for, so a user can
 * switch the default to ANY same-VM network after creation (an account's single
 * per-VM pubkey is valid on every network of that VM). Contrasted with
 * `accountNetworks(slug)`, which stays the NARROW set the account has an Address
 * bound to (unchanged, for its existing callers).
 *
 * Pure/offline — no RPC. The cross-network balance/nonce READ that rides this is
 * exercised by the consumer's (wative-cli) fake-RPC integration tests.
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createWorkspace, createAccount, accountNetworks, selectableNetworks, networksDetail, lock } from "../src/core/session.js";

const PW = "Zq7vX9wKm2pLd4Rt-Aa3Bb5Cc";
const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

let dir: string;
let slug: string;

before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "wative-selectable-"));
  await createWorkspace(dir, PW);
  slug = await createAccount("Main", PW, MNEMONIC);
});

after(() => {
  try {
    lock();
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
});

test("selectableNetworks offers every same-VM network; an HD account (evm+svm) can select all built-ins", () => {
  const all = networksDetail() ?? [];
  const selectable = selectableNetworks(slug) ?? [];

  // A fresh HD account derives BOTH an EVM and an SVM address, and every built-in
  // network is evm or svm — so the account can select every workspace network.
  assert.ok(all.length > 0, "the workspace must carry built-in networks");
  assert.equal(selectable.length, all.length, `an HD account must be able to select every network (got ${selectable.length} of ${all.length})`);
  const allSlugs = new Set(all.map((n) => n.slug));
  for (const s of selectable) assert.ok(allSlugs.has(s.slug), `selectable ${s.slug} must be a real workspace network`);
});

test("selectableNetworks is strictly BROADER than accountNetworks, and contains every bound network", () => {
  const selectable = selectableNetworks(slug) ?? [];
  const bound = accountNetworks(slug) ?? [];

  // The account has an Address bound only to its creation networks (one per vm),
  // so `accountNetworks` is a small subset — and `selectableNetworks` must be a
  // strict superset (the whole point: switch to a network you're NOT bound to).
  assert.ok(bound.length >= 1, "the account must be bound to at least one network");
  assert.ok(selectable.length > bound.length, `selectable (${selectable.length}) must be broader than bound (${bound.length})`);
  const selectableSlugs = new Set(selectable.map((n) => n.slug));
  for (const b of bound) assert.ok(selectableSlugs.has(b.slug), `every bound network (${b.slug}) must still be selectable`);
});

test("accountNetworks stays the NARROW bound set (not all networks) — its semantics are unchanged", () => {
  const all = networksDetail() ?? [];
  const bound = accountNetworks(slug) ?? [];
  // The regression guard for the "keep accountNetworks as-is" decision: it must
  // remain the account's bound subset, never silently become the full list.
  assert.ok(bound.length < all.length, `accountNetworks must stay the bound subset (${bound.length}), not all ${all.length} networks`);
});
