/**
 * `wative/core` + `wative/core/node` passthrough contract.
 *
 * The passthrough must be TRANSPARENT: a consumer that drops its direct
 * `wative-core` dependency and reaches the library through `wative/core` /
 * `wative/core/node` sees the identical object surface. So this pins:
 *
 *  - object identity of the root bindings (`Workspace`, `newMnemonic`,
 *    `BUILTIN_NETWORKS`, `BUILTIN_ASSETS`) between `wative/core` and
 *    `wative-core` — proof nothing is wrapped or reshaped,
 *  - `ChainId` reachable as a type through `wative/core`,
 *  - `wative/core/node` mirrors `wative-core/node` (`HybridProvider` identity),
 *  - and the load-bearing side effect: importing `wative/core/node` registers
 *    the Node backend, so the root `Workspace.open(path, pw, true)` creates +
 *    opens a throwaway on-disk workspace.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as corePass from "../src/corePassthrough.js";
import type { ChainId } from "../src/corePassthrough.js";
import * as coreDirect from "wative-core";

// Importing the /node passthrough for its side effect (backend registration);
// the namespace binding also lets the HybridProvider-identity test compare it.
import * as coreNodePass from "../src/coreNodePassthrough.js";
import * as coreNodeDirect from "wative-core/node";

test("wative/core re-exports the wative-core ROOT bindings with object identity", () => {
  assert.equal(corePass.Workspace, coreDirect.Workspace, "Workspace is the same binding");
  assert.equal(corePass.newMnemonic, coreDirect.newMnemonic, "newMnemonic is the same binding");
  assert.equal(corePass.BUILTIN_NETWORKS, coreDirect.BUILTIN_NETWORKS, "BUILTIN_NETWORKS is the same binding");
  assert.equal(corePass.BUILTIN_ASSETS, coreDirect.BUILTIN_ASSETS, "BUILTIN_ASSETS is the same binding");
});

test("wative/core exposes the builtin network slugs a consumer relies on", () => {
  for (const slug of ["ethereum", "optimism", "base", "sepolia", "solana", "solana-devnet"]) {
    assert.ok(slug in corePass.BUILTIN_NETWORKS, `BUILTIN_NETWORKS has ${slug}`);
  }
});

test("ChainId is re-exported as a usable type through wative/core", () => {
  // Branded number (`Brand<number, "ChainId">`) — assignable only via assertion,
  // which is itself the proof the type imported and resolved.
  const id: ChainId = 1 as ChainId;
  assert.equal(typeof id, "number");
});

test("wative/core/node mirrors wative-core/node (HybridProvider identity)", () => {
  assert.equal(coreNodePass.HybridProvider, coreNodeDirect.HybridProvider, "HybridProvider is the same binding");
});

test("importing wative/core/node registers the backend: Workspace.open creates + opens a throwaway workspace", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wative-core-pt-"));
  try {
    const ws = await corePass.Workspace.open(dir, "pw-test-123456", true);
    assert.ok(ws, "Workspace.open returned a workspace");
    assert.equal(ws.closed, false, "the opened workspace is not closed");
    const entries = readdirSync(dir).sort();
    for (const sub of ["accounts", "asset", "config", "log", "network"]) {
      assert.ok(entries.includes(sub), `the container was written (has ${sub}/)`);
    }
    await ws.lock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
